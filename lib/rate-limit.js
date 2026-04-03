const stores = new Map();

/**
 * In-memory sliding-window rate limiter.
 * @param {string} key — unique identifier (e.g. IP + route)
 * @param {number} limit — max requests allowed
 * @param {number} windowMs — time window in milliseconds
 * @returns {{ allowed: boolean, remaining: number, resetMs: number }}
 */
export function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();

  if (!stores.has(key)) {
    stores.set(key, []);
  }

  const timestamps = stores.get(key);

  // Remove expired entries
  while (timestamps.length > 0 && timestamps[0] <= now - windowMs) {
    timestamps.shift();
  }

  if (timestamps.length >= limit) {
    const resetMs = timestamps[0] + windowMs - now;
    return { allowed: false, remaining: 0, resetMs };
  }

  timestamps.push(now);
  return { allowed: true, remaining: limit - timestamps.length, resetMs: 0 };
}

/**
 * Express-style rate limit Response helper.
 */
export function rateLimitResponse(result) {
  if (!result.allowed) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(result.resetMs / 1000)),
      },
    });
  }
  return null;
}

// Periodic cleanup to prevent memory leaks (every 5 minutes)
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of stores.entries()) {
      while (timestamps.length > 0 && timestamps[0] <= now - 600_000) {
        timestamps.shift();
      }
      if (timestamps.length === 0) stores.delete(key);
    }
  }, 300_000);
}
