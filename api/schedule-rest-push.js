// POST { subscription, endsAt, setNumber, exerciseName, replaceMessageId? }
// Schedules ONE push for `endsAt`. Vercel functions are short-lived, so a server setTimeout would be
// killed when the function returns. Instead the delay is handed to Upstash QStash, which calls
// /api/fire-rest-push at the requested time. Without QSTASH_TOKEN it falls back to setTimeout,
// which is only valid for local dev or a long-running Node server.
const { userFromRequest, validSubscription, buildPayload, sendPush } = require('./_push');

const timers = new Map(); // dev fallback only
const MAX_DELAY_MS = 30 * 60 * 1000;

async function cancelQstash(id) {
  if (!id || !process.env.QSTASH_TOKEN) return;
  await fetch(`https://qstash.upstash.io/v2/messages/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${process.env.QSTASH_TOKEN}` } }).catch(() => {});
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'unauthorised' });

  const { subscription, endsAt, setNumber, exerciseName, replaceMessageId } = req.body || {};
  const now = Date.now();
  if (!validSubscription(subscription)) return res.status(400).json({ error: 'bad subscription' });
  if (!Number.isFinite(endsAt) || endsAt < now - 5000 || endsAt - now > MAX_DELAY_MS) return res.status(400).json({ error: 'bad endsAt' });
  if (!Number.isInteger(setNumber) || setNumber < 1 || setNumber > 50 || typeof exerciseName !== 'string') return res.status(400).json({ error: 'bad set' });

  if (replaceMessageId) { // the user ticked again or changed the break: drop the earlier push
    if (timers.has(replaceMessageId)) { clearTimeout(timers.get(replaceMessageId)); timers.delete(replaceMessageId); }
    else await cancelQstash(replaceMessageId);
  }

  const payload = buildPayload({ setNumber, exerciseName, endsAt });

  if (process.env.QSTASH_TOKEN) {
    const destination = `${process.env.APP_BASE_URL}/api/fire-rest-push`;
    const r = await fetch(`https://qstash.upstash.io/v2/publish/${destination}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.QSTASH_TOKEN}`, 'Content-Type': 'application/json',
        'Upstash-Not-Before': String(Math.ceil(endsAt / 1000)), // unix seconds: delivery time
        'Upstash-Retries': '0',                                  // a retried "break over" would arrive late
      },
      body: JSON.stringify({ subscription, payload }),
    });
    if (!r.ok) return res.status(502).json({ error: 'scheduler failed' });
    const { messageId } = await r.json();
    return res.status(200).json({ messageId, endsAt });
  }

  // ---- dev / persistent-server fallback ----
  const id = `local_${now}_${Math.random().toString(36).slice(2, 8)}`;
  timers.set(id, setTimeout(() => { timers.delete(id); sendPush(subscription, payload).catch(console.error); }, Math.max(0, endsAt - now)));
  return res.status(200).json({ messageId: id, endsAt });
};
