'use strict';
const { getSettings } = require('./settings');

const buckets = new Map(); // key -> { count, resetAt }

async function rateLimit(req, res, next) {
  try {
    const s = await getSettings();
    const windowMs = (s.rateLimitWindowSeconds || 60) * 1000;
    const max = s.rateLimitMaxRequests || 60;
    const key = (req.ip || 'unknown') + ':' + req.path.split('/').slice(0, 3).join('/');
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
    b.count++;
    if (b.count > max) {
      res.status(429).json({ success: false, message: 'Too many requests, slow down' });
      return;
    }
    next();
  } catch (e) { next(); } // never block real traffic just because the limiter itself failed
}

// periodic sweep so the map does not grow forever
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.resetAt + 60000) buckets.delete(k);
}, 60000).unref();

module.exports = { rateLimit };
