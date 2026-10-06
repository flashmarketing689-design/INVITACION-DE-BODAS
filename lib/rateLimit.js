const buckets = new Map();

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 100) || 'unknown';
}

/** Best-effort per-instance throttling for the small serverless app. */
function allowRequest(key, limit, windowMs) {
  const now = Date.now();
  let entry = buckets.get(key);

  if (!entry || now - entry.startedAt >= windowMs) {
    entry = { startedAt: now, count: 0 };
    buckets.set(key, entry);
  }
  entry.count += 1;

  // Bound memory if many distinct client addresses hit a warm instance.
  if (buckets.size > 5000) {
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.startedAt >= windowMs) buckets.delete(bucketKey);
      if (buckets.size <= 4000) break;
    }
  }

  return entry.count <= limit;
}

module.exports = { allowRequest, clientIp };
