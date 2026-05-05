// Waitlist email capture — POST stores an email, GET returns count
// (and full list if admin-authenticated via ?token=ADMIN_TOKEN).
//
// Storage: single Redis key with array of {email, ts, ref, ua}. Capped
// at 10K entries to bound costs.

import { Redis } from '@upstash/redis';

const WAITLIST_KEY = 'auspex:waitlist';
const MAX_ENTRIES = 10_000;

function buildRedis() {
  const findEnv = (suffix) => {
    for (const k of Object.keys(process.env)) {
      if (k === suffix || k.endsWith('_' + suffix)) {
        const v = process.env[k];
        if (v) return v;
      }
    }
    return null;
  };
  const url   = findEnv('KV_REST_API_URL')   || findEnv('UPSTASH_REDIS_REST_URL');
  const token = findEnv('KV_REST_API_TOKEN') || findEnv('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function isValidEmail(s) {
  return typeof s === 'string'
    && s.length >= 5
    && s.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export default async function handler(req, res) {
  const redis = buildRedis();
  if (!redis) {
    return res.status(503).json({
      error: 'Waitlist storage not configured',
      hint: 'Provision Upstash Redis via Vercel Marketplace.',
    });
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = {}; }
    }
    if (!body || typeof body !== 'object') body = {};

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    try {
      const existing = await redis.get(WAITLIST_KEY);
      const list = Array.isArray(existing) ? existing : [];

      if (list.some(e => e && e.email === email)) {
        return res.status(409).json({ status: 'already-registered' });
      }

      if (list.length >= MAX_ENTRIES) {
        return res.status(503).json({ error: 'Waitlist temporarily full' });
      }

      const entry = {
        email,
        ts: new Date().toISOString(),
        ref: req.headers.referer || null,
        ua:  req.headers['user-agent'] || null,
      };
      list.push(entry);

      await redis.set(WAITLIST_KEY, list);

      return res.status(200).json({ status: 'registered', count: list.length });
    } catch (e) {
      console.error('[waitlist] write failed:', e);
      return res.status(500).json({ error: 'Failed to register' });
    }
  }

  if (req.method === 'GET') {
    try {
      const existing = await redis.get(WAITLIST_KEY);
      const list = Array.isArray(existing) ? existing : [];

      // Admin endpoint — returns full list. Gate behind ADMIN_TOKEN
      // env var so the public can't enumerate the waitlist by guessing
      // the URL. Without the token, only return aggregate stats.
      const adminToken = process.env.ADMIN_TOKEN;
      const providedToken = req.query && req.query.token;
      if (adminToken && providedToken === adminToken) {
        return res.status(200).json({
          count: list.length,
          entries: list,
        });
      }

      return res.status(200).json({
        count: list.length,
        firstSignup: list.length > 0 ? list[0].ts : null,
        latestSignup: list.length > 0 ? list[list.length - 1].ts : null,
      });
    } catch (e) {
      console.error('[waitlist] read failed:', e);
      return res.status(500).json({ error: 'Failed to read waitlist' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
