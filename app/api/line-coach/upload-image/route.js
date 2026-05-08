import { NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { requireAdmin } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { RATE_LIMITS, getRateLimitKey } from '@/lib/config';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export async function POST(request) {
  const rlKey = getRateLimitKey(request, 'admin');
  const rl = checkRateLimit(rlKey, RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs);
  const rlRes = rateLimitResponse(rl);
  if (rlRes) return rlRes;

  const authResult = requireAdmin(request);
  if (authResult instanceof Response) return authResult;

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });

  const file = form.get('file');
  const kind = String(form.get('kind') || 'item'); // 'item' | 'side'
  const name = String(form.get('name') || '');

  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: 'file field is required' }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ error: `Unsupported file type: ${file.type}` }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `File too large (max ${MAX_BYTES / 1024 / 1024}MB)` }, { status: 400 });
  }

  const ext = file.type === 'image/jpeg' ? 'jpg'
    : file.type === 'image/png' ? 'png'
    : file.type === 'image/webp' ? 'webp'
    : 'gif';
  const folder = kind === 'side' ? 'sides' : 'items';
  const slug = slugify(name) || 'unnamed';
  const path = `${folder}/${slug}-${Date.now()}.${ext}`;

  const buffer = Buffer.from(await file.arrayBuffer());
  const db = getServiceClient();

  const { error: uploadErr } = await db.storage
    .from('lc-images')
    .upload(path, buffer, { contentType: file.type, upsert: true });

  if (uploadErr) {
    console.error('Upload failed:', uploadErr.message);
    return NextResponse.json({ error: uploadErr.message }, { status: 500 });
  }

  const { data: pub } = db.storage.from('lc-images').getPublicUrl(path);
  return NextResponse.json({ url: pub.publicUrl, path });
}
