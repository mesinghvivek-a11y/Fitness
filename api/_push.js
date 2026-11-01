// Shared helpers. Files starting with "_" in /api are not exposed as routes on Vercel.
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

webpush.setVapidDetails(process.env.VAPID_SUBJECT /* mailto:you@example.com */, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

const db = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/** Only signed-in users may schedule pushes. */
async function userFromRequest(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return null;
  const { data, error } = await db().auth.getUser(token);
  return error ? null : data.user;
}

const validSubscription = (s) =>
  s && typeof s.endpoint === 'string' && s.endpoint.startsWith('https://') && s.keys && s.keys.p256dh && s.keys.auth;

function buildPayload({ setNumber, exerciseName, endsAt, restId }) {
  return {
    title: 'Break time has ended!',
    body: `Time for Set ${setNumber}: ${String(exerciseName).slice(0, 80)}`,
    tag: 'rest-timer', url: '/', endsAt, restId,
  };
}

/** TTL 120 s: a late "break is over" push is useless, so the push service may drop it. urgency high = deliver now. */
async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 120, urgency: 'high' });
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {       // subscription is gone: clean it up
      await db().from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
    }
    throw err;
  }
}

async function readRaw(req) { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString('utf8'); }

module.exports = { db, userFromRequest, validSubscription, buildPayload, sendPush, readRaw };
