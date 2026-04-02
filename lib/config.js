// Rate limit configurations for different route groups
export const RATE_LIMITS = {
  webhook: { limit: 100, windowMs: 60_000 },       // 100 req/min
  admin: { limit: 20, windowMs: 300_000 },          // 20 req/5min
  device: { limit: 60, windowMs: 60_000 },          // 60 req/min
};

export function getRateLimitKey(request, prefix) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
  return `${prefix}:${ip}`;
}
