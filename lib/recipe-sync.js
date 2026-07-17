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

// Culinary OS hub page ("🍽️ Recipe System — WILDBIRD Culinary OS").
// When NOTION_RECIPES_PAGE_ID isn't set we enumerate this page's
// children and descend into the "Layer 3 — Line Build Guides" child
// (324fd79e-1f18-81d0-aeae-fb8e03648b0f as of Jul 2026).
// NOTE: ...81d7... is Layer 1 (Franchise Recipe Manual), NOT the hub —
// the two IDs are easy to swap; verified against live Notion 2026-07-17.
const CULINARY_OS_PARENT_ID = '324fd79e-1f18-81d4-b709-eb48c4e4237e';
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

// The live Layer 3 page (verified Jul 2026) is one flat document —
// recipes are heading_2 sections ("## WILDBIRD Bowl — Standard Build"),
// not child pages. Slice the page into { title, blocks } sections so
// each behaves like a recipe page. heading_1 blocks are category
// dividers ("# 🍜 BOWL & PLATE BUILDS") and close the open section.
function splitIntoSections(blocks) {
  const sections = [];
  let current = null;
  for (const b of blocks) {
    if (b.type === 'heading_2') {
      const title = plainText(b.heading_2?.rich_text);
      current = title ? { title, blocks: [] } : null;
      if (current) sections.push(current);
      continue;
    }
    if (b.type === 'heading_1') {
      current = null;
      continue;
    }
    if (current) current.blocks.push(b);
  }
  return sections;
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

// Convert a Notion table block into step strings. Layer 3 build tables
// come as (Step, Component, Portion, Tool) or (Step, Action, Notes) —
// drop a leading row-number cell and join the remaining non-empty cells
// so either shape reads as one instruction.
async function tableSteps(tableBlock) {
  const rows = await listBlockChildren(tableBlock.id);
  const cells = rows
    .filter((r) => r.type === 'table_row')
    .map((r) => (r.table_row?.cells || []).map((c) => plainText(c)));
  const body = tableBlock.table?.has_column_header ? cells.slice(1) : cells;
  return body
    .map((row) => {
      const filled = row.filter(Boolean);
      if (filled.length > 1 && /^\d+\.?$/.test(filled[0])) filled.shift();
      return filled.join(' — ');
    })
    .filter(Boolean);
}

// Extract ordered build steps from a recipe page's blocks. Preference
// order: the longest run of numbered_list_item blocks; then the largest
// table (the live Layer 3 carries builds as tables); then bulleted
// lists; then paragraphs following a Steps/Build/Assembly heading.
async function extractSteps(blocks) {
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

  if (steps.length < 2) {
    let best = [];
    for (const b of blocks.filter((x) => x.type === 'table')) {
      const rows = await tableSteps(b);
      if (rows.length > best.length) best = rows;
    }
    if (best.length >= 2) steps = best;
  }

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

// Layer 3 section titles decorate the item name ("Sweet Potatoes —
// Service", "WILDBIRD Bowl — Standard Build", "Charro Beans Add-On");
// strip the decoration before comparing.
const TITLE_DECORATION_RE = /\s*(?:[—–-]\s*)?(standard build|service|add-?on|portion|build)\s*$/i;

function canonicalName(name) {
  let n = (name || '').trim().toLowerCase().replace(TITLE_DECORATION_RE, '');
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
    if (!recipes.length) {
      // Flat-page shape (the live Layer 3): recipes are heading sections
      // of the root page itself, with blocks already in hand.
      recipes = splitIntoSections(await listBlockChildren(rootId));
    }
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
      const blocks = recipe.blocks || await listBlockChildren(recipe.id);
      const steps = await extractSteps(blocks);
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
