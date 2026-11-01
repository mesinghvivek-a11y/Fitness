// POST { subscription }  -> stores the subscription for the signed-in user.
const { db, userFromRequest, validSubscription } = require('./_push');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'unauthorised' });
  const { subscription } = req.body || {};
  if (!validSubscription(subscription)) return res.status(400).json({ error: 'bad subscription' });

  const { error } = await db().from('push_subscriptions').upsert({
    user_id: user.id, endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh, auth: subscription.keys.auth,
    user_agent: (req.headers['user-agent'] || '').slice(0, 200), updated_at: new Date().toISOString(),
  }, { onConflict: 'endpoint' });
  return error ? res.status(500).json({ error: error.message }) : res.status(200).json({ ok: true });
};
