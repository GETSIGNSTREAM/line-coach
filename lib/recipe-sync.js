import Anthropic from '@anthropic-ai/sdk';
import { getConfig, updateConfig, normalizeSteps } from './line-coach.js';

// ── Recipe OS (Notion) → menu_items[].build_steps ───────
// Learn mode's content pipeline. The WILDBIRD Culinary OS in Notion is
// the source of truth for line build steps (Layer 3 "Line Build Guides";
// Layer 1 is the Franchise Recipe Manual). This module reads it via the
// Notion REST API, matches recipes to Line Coach menu items by name,
// extracts ordered steps, translates them to Mexican Spanish with
// Claude, and overwrites each matched item's build_steps.
//
// Sync is Notion-READ-ONLY and manual (admin "Sync from Notion" button →
// POST /api/line-coach/recipe-sync). Hand edits in the admin steps
// editor are a between-syncs override; the next sync overwrites them.
//
// Env: NOTION_API_KEY (internal integration secret — the Culinary OS
// page must be shared with the integration or every call 404s), and
// optionally NOTION_RECIPES_PAGE_ID to point at the build-guides page /
// database directly.

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// Culinary OS parent page. When NOTION_RECIPES_PAGE_ID isn't set we
// enumerate this page's children and descend into the "Line Build
// Guides" (Layer 3) child, which holds one child page per entree.
const CULINARY_OS_PARENT_ID = '324fd79e-1f18-81d7-b758-c249c9499623';
const BUILD_GUIDES_TITLE_RE = /(line\s*build|build\s*guide|layer\s*3)/i;

// Headings that mark the steps section when a recipe page uses
// paragraphs instead of numbered lists.
const STEPS_HEADING_RE = /^(steps|build|assembly|method|instructions|procedure)/i;

// Governance-locked renames (wildbird-culinary-os): stale titles on
// either side still match. Applied before case-insensitive comparison;
// never written back anywhere.
const NAME_ALIASES = {
  'arroz rojo': 'spanish rice',
  'chipotle tinga': 'chicken tinga',
  'salsa tatemada': 'charred tomato salsa',
  'market plate': 'protein plate',
};

const MAX_STEP_CHARS = 200;
const MAX_STEPS = 20;

// ── Notion REST helpers ─────────────────────────────────

async function notionFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.message || `${res.status} ${res.statusText}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function listBlockChildren(blockId) {
  const blocks = [];
  let cursor;
  do {
    const page = await notionFetch(
      `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`
    );
    blocks.push(...(page.results || []));
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return blocks;
}

function plainText(richText) {
  return (richText || []).map((t) => t.plain_text || '').join('').trim();
}

function pageTitle(page) {
  const props = page.properties || {};
  for (const prop of Object.values(props)) {
    if (prop.type === 'title') return plainText(prop.title);
  }
  return '';
}

// Enumerate recipe pages under an ID that may be a database OR a plain
// page of child pages — the Recipe OS mixes both shapes, and we can't
// inspect it until the integration is shared.
async function fetchRecipePages(id) {
  try {
    const pages = [];
    let cursor;
    do {
      const res = await notionFetch(`/databases/${id}/query`, {
        method: 'POST',
        body: cursor ? { start_cursor: cursor } : {},
      });
      pages.push(...(res.results || []).map((p) => ({ id: p.id, title: pageTitle(p) })));
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
    return pages;
  } catch (err) {
    if (err.status !== 404 && err.status !== 400) throw err;
  }
  const blocks = await listBlockChildren(id);
  return blocks
    .filter((b) => b.type === 'child_page')
    .map((b) => ({ id: b.id, title: (b.child_page?.title || '').trim() }));
}

// Resolve the page holding the recipes: explicit env id wins; otherwise
// find the Line Build Guides (Layer 3) child of the Culinary OS parent.
async function resolveRecipesRootId() {
  if (process.env.NOTION_RECIPES_PAGE_ID) return process.env.NOTION_RECIPES_PAGE_ID;
  const children = await listBlockChildren(CULINARY_OS_PARENT_ID);
  const guides = children.find(
    (b) => (b.type === 'child_page' && BUILD_GUIDES_TITLE_RE.test(b.child_page?.title || ''))
      || (b.type === 'child_database' && BUILD_GUIDES_TITLE_RE.test(b.child_database?.title || ''))
  );
  if (!guides) {
    throw new Error('Could not find a "Line Build Guides" child under the Culinary OS page — set NOTION_RECIPES_PAGE_ID to the build-guides page or database id');
  }
  return guides.id;
}

// Extract ordered build steps from a recipe page's blocks. Preference
// order: the longest run of numbered_list_item blocks; then bulleted
// lists; then paragraphs following a Steps/Build/Assembly heading.
function extractSteps(blocks) {
  const runs = { numbered_list_item: [], bulleted_list_item: [] };
  for (const type of Object.keys(runs)) {
    let current = [];
    for (const b of blocks) {
      if (b.type === type) {
        const text = plainText(b[type]?.rich_text);
        if (text) current.push(text);
      } else if (current.length) {
        runs[type].push(current);
        current = [];
      }
    }
    if (current.length) runs[type].push(current);
  }
  const longest = (arr) => arr.reduce((best, run) => (run.length > best.length ? run : best), []);
  let steps = longest(runs.numbered_list_item);
  if (steps.length < 2) steps = longest(runs.bulleted_list_item).length >= 2 ? longest(runs.bulleted_list_item) : steps;

  if (steps.length < 2) {
    // Paragraphs after a steps-ish heading, until the next heading.
    const collected = [];
    let inSection = false;
    for (const b of blocks) {
      if (b.type?.startsWith('heading_')) {
        inSection = STEPS_HEADING_RE.test(plainText(b[b.type]?.rich_text));
        continue;
      }
      if (inSection && b.type === 'paragraph') {
        const text = plainText(b.paragraph?.rich_text);
        if (text) collected.push(text);
      }
    }
    if (collected.length >= 2) steps = collected;
  }

  return steps
    .map((s) => s.slice(0, MAX_STEP_CHARS))
    .slice(0, MAX_STEPS);
}

// ── Matching ────────────────────────────────────────────

function canonicalName(name) {
  let n = (name || '').trim().toLowerCase();
  for (const [from, to] of Object.entries(NAME_ALIASES)) {
    if (n.includes(from)) n = n.replace(from, to);
  }
  return n;
}

function matchRecipeToItem(title, menuItems) {
  const exact = menuItems.find((m) => m.name === title);
  if (exact) return exact;
  const canon = canonicalName(title);
  return menuItems.find((m) => canonicalName(m.name) === canon) || null;
}

// ── Translation (same plumbing as lib/feedback-tips.js) ─

const TRANSLATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['steps'],
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['en', 'es'],
        properties: {
          en: { type: 'string', description: 'The step in English, lightly cleaned up, imperative voice' },
          es: { type: 'string', description: 'The same step in Mexican Spanish (kitchen-floor register, tú form)' },
        },
      },
    },
  },
};

async function translateSteps(client, model, itemName, steps) {
  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    system: 'You translate kitchen build steps for WILDBIRD, a fast-casual rotisserie chicken restaurant. Given the ordered English build steps for one menu item, return each step with a Mexican Spanish translation (kitchen-floor register, tú form — match the tone of "Verifica la temperatura interna del pollo"). Keep the order and count identical; keep English text as-is apart from trimming; never add, merge, or drop steps.',
    output_config: { format: { type: 'json_schema', schema: TRANSLATE_SCHEMA } },
    messages: [{
      role: 'user',
      content: `Menu item: ${itemName}\n\nBuild steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    }],
  });
  if (response.stop_reason === 'max_tokens' || response.stop_reason === 'refusal') {
    throw new Error(`Translation failed (${response.stop_reason}) for ${itemName}`);
  }
  const text = response.content.find((b) => b.type === 'text')?.text || '';
  const parsed = JSON.parse(text);
  const out = normalizeSteps(parsed.steps);
  // Count mismatch → fall back to untranslated English rather than
  // risking misaligned steps.
  if (out.length !== steps.length) return steps.map((s) => ({ en: s, es: '' }));
  return out;
}

// ── Entry point ─────────────────────────────────────────

export async function syncRecipesFromNotion({ dry = false } = {}) {
  if (!process.env.NOTION_API_KEY) {
    return { status: 'error', error: 'NOTION_API_KEY not configured' };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { status: 'error', error: 'ANTHROPIC_API_KEY not configured (needed for Spanish translation)' };
  }

  let recipes;
  try {
    const rootId = await resolveRecipesRootId();
    recipes = await fetchRecipePages(rootId);
  } catch (err) {
    return { status: 'error', error: `Notion: ${err.message}` };
  }
  if (!recipes.length) {
    return { status: 'error', error: 'No recipe pages found — check that the Culinary OS page is shared with the integration and NOTION_RECIPES_PAGE_ID points at the build guides' };
  }

  const { data: cfg } = await getConfig('hollywood'); // menu_items are brand-wide; any store works
  const menuItems = (cfg?.menu_items || []).map((m) => ({ ...m }));

  const model = process.env.LC_RECIPE_SYNC_MODEL || 'claude-opus-4-8';
  const client = new Anthropic();
  const syncedAt = new Date().toISOString();

  const unmatched = [];
  const noSteps = [];
  const errors = [];
  let matched = 0;
  let translated = 0;

  for (const recipe of recipes) {
    const item = matchRecipeToItem(recipe.title, menuItems);
    if (!item) {
      unmatched.push(recipe.title);
      continue;
    }
    try {
      const blocks = await listBlockChildren(recipe.id);
      const steps = extractSteps(blocks);
      if (steps.length === 0) {
        noSteps.push(recipe.title);
        continue;
      }
      const bilingual = await translateSteps(client, model, item.name, steps);
      if (bilingual.some((s) => s.es)) translated += 1;
      item.build_steps = bilingual;
      item.build_steps_synced_at = syncedAt;
      matched += 1;
    } catch (err) {
      errors.push(`${recipe.title}: ${err.message}`);
    }
  }

  const itemsWithoutRecipe = menuItems
    .filter((m) => !m.build_steps)
    .map((m) => m.name);

  if (!dry && matched > 0) {
    const { error } = await updateConfig('hollywood', { menu_items: menuItems });
    if (error) {
      return { status: 'error', error: `Failed to save menu items: ${error.message || error}` };
    }
  }

  return {
    status: 'ok',
    ran_at: syncedAt,
    dry,
    recipes_found: recipes.length,
    matched,
    translated,
    unmatched_recipes: unmatched,
    items_without_recipe: itemsWithoutRecipe,
    no_steps: noSteps,
    errors,
  };
}
