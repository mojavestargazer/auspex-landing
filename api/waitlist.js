// Waitlist email capture — POST stores an email, GET returns count
// (and full list if admin-authenticated). Optionally sends a
// notification email to the operator on each signup via Resend.
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

// Send a notification email via Resend whenever someone joins the
// waitlist. Fire-and-forget — the user's signup completes whether or
// not the notification succeeds. If RESEND_API_KEY isn't set, the
// function silently no-ops, so the system works either way.
async function sendNotification(entry, totalCount) {
  const apiKey = process.env.RESEND_API_KEY;
  const notifyTo = process.env.NOTIFY_EMAIL;
  if (!apiKey || !notifyTo) return;

  // Resend's "from" address must be a verified domain in your Resend
  // dashboard. Until you verify auspexterminal.com, use Resend's
  // sandbox sender (`onboarding@resend.dev`) which works without setup.
  // Once you verify your domain, change this to something like
  // "Auspex Waitlist <noreply@auspexterminal.com>".
  const fromAddr = process.env.RESEND_FROM || 'Auspex Waitlist <onboarding@resend.dev>';

  const subject = `New Auspex waitlist signup #${totalCount}`;
  const refLine = entry.ref ? `\nReferrer: ${entry.ref}` : '';
  const text = `${entry.email}${refLine}\nTotal signups: ${totalCount}\nTimestamp: ${entry.ts}`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromAddr,
        to: notifyTo,
        subject,
        text,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error('[waitlist notify] Resend returned', r.status, body);
    }
  } catch (e) {
    console.error('[waitlist notify] failed:', e);
  }
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

      // Fire notification email (silently no-ops if Resend not configured)
      sendNotification(entry, list.length);

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
