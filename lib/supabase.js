import { createClient } from '@supabase/supabase-js';

let _supabase = null;
let _supabaseAdmin = null;

// Support both Supabase-Vercel integration names and our custom names
function getUrl() {
  return process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
}

function getAnonKey() {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
}

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
}

export function getPublicClient() {
  if (!_supabase) {
    const url = getUrl();
    const key = getAnonKey();
    if (!url || !key) throw new Error('Missing Supabase public credentials');
    _supabase = createClient(url, key);
  }
  return _supabase;
}

export function getServiceClient() {
  if (!_supabaseAdmin) {
    const url = getUrl();
    const key = getServiceKey();
    if (!url || !key) {
      console.warn('Missing Supabase service key — falling back to public client');
      return getPublicClient();
    }
    _supabaseAdmin = createClient(url, key);
  }
  return _supabaseAdmin;
}

export async function withRetry(fn, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (result.error) {
        if (result.error.code && result.error.code >= 400 && result.error.code < 500) {
          return result;
        }
        lastError = result.error;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 500));
          continue;
        }
      }
      return result;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 500));
      }
    }
  }
  return { data: null, error: lastError };
}
