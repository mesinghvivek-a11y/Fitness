// Called by QStash at the scheduled time. Verifies the signature, then sends the Web Push.
const { Receiver } = require('@upstash/qstash');
const { sendPush, readRaw } = require('./_push');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const raw = await readRaw(req); // signature is computed over the raw body
  try {
    await new Receiver({ currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY, nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY })
      .verify({ signature: req.headers['upstash-signature'], body: raw });
  } catch { return res.status(401).end(); }

  const { subscription, payload } = JSON.parse(raw);
  try { await sendPush(subscription, payload); return res.status(200).json({ sent: true }); }
  catch (e) { return res.status(200).json({ sent: false, status: e.statusCode || 500 }); } // 200 so QStash does not retry
};
module.exports.config = { api: { bodyParser: false } }; // Next.js API route: same export
