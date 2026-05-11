#!/usr/bin/env node
//
// upload-menu-pics.mjs — bulk uploader for WILDBIRD menu photos
//
// Reads `.jpg` files from a source directory, slug-matches each to a
// row in lc_brand_config.menu_items[].name or sides[].name, resizes
// to 1600px max side (preserving aspect ratio — no crop), uploads to
// Supabase Storage's lc-images bucket, and patches the image_url on
// the matched brand-config row.
//
// USAGE
//   # Dry-run (default) — prints the match plan, NO writes:
//   node scripts/upload-menu-pics.mjs "/Users/oscarrembao/Desktop/WILDBIRD 2024 MENU PICS"
//
//   # Real run — uploads + DB patch:
//   node scripts/upload-menu-pics.mjs "/path/to/dir" --apply
//
// REQUIRED ENV
//   NEXT_PUBLIC_SUPABASE_URL    (e.g. https://epfxzpemsbeljspfwuwe.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY   (the secret service role JWT — gives admin
//                                Storage + DB access; do not commit)
//
// VARIANT SELECTION
//   For each item we prefer files in this order, taking the first that
//   exists: MAIN → CLOSEUP/CLOSE UP → OVERHEAD → SIDE → first match.
//
// ALIASES (file prefix → DB row name)
//   See FILE_TO_DB_NAME below. Approved 1:1 by user.
//
// IDEMPOTENT BEHAVIOR
//   Same source file uploaded twice produces the same storage path
//   (slug + content hash suffix), so re-runs overwrite cleanly without
//   leaving duplicates.

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

const SOURCE_DIR = process.argv[2];
const APPLY = process.argv.includes('--apply');

if (!SOURCE_DIR) {
  console.error('Usage: node scripts/upload-menu-pics.mjs <source-dir> [--apply]');
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing env: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  console.error('Find these in Vercel → line-coach project → Settings → Env Variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const BUCKET = 'lc-images';

// File-prefix → exact DB row name. Mirrors the aliases approved before
// running. Keys are uppercase normalized (collapsed whitespace, no
// punctuation) to match how filenames are normalized below.
const FILE_TO_DB_NAME = {
  // Menu items (menu_items[].name)
  'HALF BIRD':              'Half Bird',
  'WHOLE BIRD':             'Whole Bird', // also used for "Whole Bird (A La Carte)" — see WHOLE_BIRD_ALSO_FOR_ALA_CARTE
  'MARKET PLATE BREAST':    'Boneless Breast Market Plate',
  'MARKET PLATE TINGA':     'Chicken Tinga Market Plate',
  'MARKET PLATE VEGGIE':    'Veggie Market Plate',
  'TACOS DORADOS':          'Tacos Dorados',
  'MEX BURRITO':            'Burrito Mexicano',
  'TOSTADA BOWL':           'Tostada Bowl',
  'SUPERFOOD ENSALADA':     'Superfood Ensalada',
  'HARVEST BOWL':           'Harvest Bowl',

  // Sides (sides[].name)
  'SPANISH RICE':           'Spanish Rice',
  'SWEET POTATOES':         'Sweet Potatoes',
  'BROCCOLI':               'Broccoli',
  'CHARRO BEANS':           'Charro Beans',
  'MAC SALAD':              'Mac Salad',
  'MEX STREET CORN':        'Mexican Street Corn',
  'GUAC':                   'Chips and Guac',
  'BRUSSELS':               'Brussel Sprouts',
  'GREEN POZOLE':           'Green Chicken Pozole',
  'MAC AND CHEESE':         'Uptown Mac & Cheese',
};

// Reuse the Whole Bird photo for the A La Carte variant too (no
// separate file exists).
const WHOLE_BIRD_ALSO_FOR_ALA_CARTE = true;

// Preferred camera-angle suffix order. Case + whitespace tolerant.
const VARIANT_PREFERENCE = ['MAIN', 'CLOSEUP', 'CLOSE UP', 'OVERHEAD', 'SIDE'];

// Resize cap. Aspect ratio preserved via fit: 'inside'. JPEG quality
// trades file size for clarity; 85 keeps photos well under 500KB
// while staying crisp at any display size we render.
const MAX_SIDE_PX = 1600;
const JPEG_QUALITY = 85;

function normalizePrefix(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toUpperCase();
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Parse "ITEM NAME - VARIANT.jpg" into { prefix, variant }.
function parseFilename(filename) {
  const base = filename.replace(/\.jpe?g$/i, '');
  // Filenames sometimes have weird " -SIDE" with no space; tolerate.
  const m = base.match(/^(.*?)\s*-\s*(.+)$/);
  if (!m) return null;
  return {
    prefix: normalizePrefix(m[1]),
    variant: normalizePrefix(m[2]),
  };
}

async function listSourceFiles(dir) {
  const entries = await fs.readdir(dir);
  return entries.filter((f) => f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.jpeg'));
}

function bestFileForPrefix(allFiles, prefix) {
  const candidates = allFiles
    .map((f) => ({ file: f, parsed: parseFilename(f) }))
    .filter((x) => x.parsed && x.parsed.prefix === prefix);
  if (candidates.length === 0) return null;
  // Rank by VARIANT_PREFERENCE index (lower wins); fallback to alpha.
  candidates.sort((a, b) => {
    const ai = VARIANT_PREFERENCE.findIndex((v) => normalizePrefix(v) === a.parsed.variant);
    const bi = VARIANT_PREFERENCE.findIndex((v) => normalizePrefix(v) === b.parsed.variant);
    const aw = ai === -1 ? 999 : ai;
    const bw = bi === -1 ? 999 : bi;
    if (aw !== bw) return aw - bw;
    return a.parsed.variant.localeCompare(b.parsed.variant);
  });
  return candidates[0].file;
}

async function resizeToJpeg(filepath) {
  const buf = await fs.readFile(filepath);
  return sharp(buf)
    .rotate() // honor EXIF orientation
    .resize({ width: MAX_SIDE_PX, height: MAX_SIDE_PX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

async function uploadToStorage(slug, buffer) {
  // Hash suffix makes the storage path stable + cache-busts when the
  // source file changes. {slug}-{hash8}.jpg
  const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 8);
  const key = `menu-pics/${slug}-${hash}.jpg`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(key, buffer, {
      contentType: 'image/jpeg',
      cacheControl: '31536000',
      upsert: true,
    });
  if (error) throw new Error(`upload ${key}: ${error.message}`);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(key);
  return data.publicUrl;
}

async function patchBrandConfig(menuUpdates, sideUpdates) {
  // Read current config once, mutate in memory, single write back.
  // Avoids race with admin editing the config simultaneously, but
  // since this is a one-shot script that's acceptable.
  const { data: row, error: readErr } = await supabase
    .from('lc_brand_config')
    .select('menu_items, sides')
    .eq('id', 1)
    .maybeSingle();
  if (readErr) throw readErr;

  const menuItems = (row?.menu_items || []).map((mi) => {
    const url = menuUpdates.get(mi.name);
    return url ? { ...mi, image_url: url } : mi;
  });
  const sides = (row?.sides || []).map((s) => {
    const url = sideUpdates.get(s.name);
    return url ? { ...s, image_url: url } : s;
  });

  const { error: writeErr } = await supabase
    .from('lc_brand_config')
    .update({
      menu_items: menuItems,
      sides: sides,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);
  if (writeErr) throw writeErr;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (will upload + write DB)' : 'DRY-RUN (no writes)'}`);
  console.log(`Source: ${SOURCE_DIR}`);
  console.log('');

  const files = await listSourceFiles(SOURCE_DIR);
  console.log(`Found ${files.length} .jpg files in source.`);

  // Read brand config so we know which menu/side rows actually exist.
  const { data: row, error } = await supabase
    .from('lc_brand_config')
    .select('menu_items, sides')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  const menuNames = new Set((row?.menu_items || []).map((m) => m.name));
  const sideNames = new Set((row?.sides || []).map((s) => s.name));

  // Build the plan.
  const plan = []; // { dbName, kind, file, slug }
  const usedFiles = new Set();
  for (const [filePrefix, dbName] of Object.entries(FILE_TO_DB_NAME)) {
    const best = bestFileForPrefix(files, filePrefix);
    if (!best) continue;
    let kind = null;
    if (menuNames.has(dbName)) kind = 'menu';
    else if (sideNames.has(dbName)) kind = 'side';
    else {
      console.warn(`! Mapped DB name "${dbName}" not found in brand config — skipping ${best}`);
      continue;
    }
    plan.push({ dbName, kind, file: best, slug: slugify(dbName) });
    usedFiles.add(best);
  }
  // Special case: also point "Whole Bird (A La Carte)" at the WHOLE BIRD file.
  if (WHOLE_BIRD_ALSO_FOR_ALA_CARTE) {
    const wholeBirdFile = bestFileForPrefix(files, 'WHOLE BIRD');
    if (wholeBirdFile && menuNames.has('Whole Bird (A La Carte)')) {
      plan.push({
        dbName: 'Whole Bird (A La Carte)',
        kind: 'menu',
        file: wholeBirdFile,
        slug: slugify('Whole Bird (A La Carte)'),
      });
      // wholeBirdFile is already in usedFiles from the earlier mapping.
    }
  }

  // Print the plan.
  console.log('');
  console.log('Plan (file → DB row):');
  for (const p of plan) {
    console.log(`  ✓ ${p.kind.padEnd(4)}  ${p.file.padEnd(46)}  →  ${p.dbName}`);
  }

  // Unmatched files (in directory, no DB target).
  const unmatched = files.filter((f) => !usedFiles.has(f));
  console.log('');
  console.log(`Unmatched files (no DB target — skipped): ${unmatched.length}`);
  for (const f of unmatched) console.log(`  - ${f}`);

  // DB rows without a photo source.
  const dbWithPhoto = new Set(plan.map((p) => p.dbName));
  const menuMissing = [...menuNames].filter((n) => !dbWithPhoto.has(n));
  const sideMissing = [...sideNames].filter((n) => !dbWithPhoto.has(n));
  console.log('');
  console.log(`DB rows without a photo (existing image_url unchanged): ${menuMissing.length + sideMissing.length}`);
  for (const n of menuMissing) console.log(`  - menu  ${n}`);
  for (const n of sideMissing) console.log(`  - side  ${n}`);

  if (!APPLY) {
    console.log('');
    console.log('Dry-run complete. Re-run with --apply to perform uploads + DB write.');
    return;
  }

  // Apply.
  console.log('');
  console.log('Applying…');
  const menuUpdates = new Map();
  const sideUpdates = new Map();
  let ok = 0;
  let fail = 0;
  for (const p of plan) {
    const fullPath = path.join(SOURCE_DIR, p.file);
    try {
      const buf = await resizeToJpeg(fullPath);
      const url = await uploadToStorage(p.slug, buf);
      if (p.kind === 'menu') menuUpdates.set(p.dbName, url);
      else sideUpdates.set(p.dbName, url);
      const kb = Math.round(buf.length / 1024);
      console.log(`  ✓ ${p.dbName.padEnd(34)} ${kb}KB  ${url}`);
      ok += 1;
    } catch (e) {
      console.error(`  ✗ ${p.dbName}: ${e.message}`);
      fail += 1;
    }
  }

  console.log('');
  console.log(`Patching lc_brand_config (menu: ${menuUpdates.size}, sides: ${sideUpdates.size}) …`);
  await patchBrandConfig(menuUpdates, sideUpdates);
  console.log('Brand config updated.');
  console.log('');
  console.log(`Summary: ${ok} uploaded, ${fail} failed.`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
