// POST { messageId } -> removes a pending rest push (set un-ticked, break skipped, exercise saved).
const { userFromRequest } = require('./_push');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (!(await userFromRequest(req))) return res.status(401).end();
  const { messageId } = req.body || {};
  if (typeof messageId === 'string' && process.env.QSTASH_TOKEN && !messageId.startsWith('local_')) {
    await fetch(`https://qstash.upstash.io/v2/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${process.env.QSTASH_TOKEN}` } }).catch(() => {});
  }
  res.status(200).json({ ok: true });
};
