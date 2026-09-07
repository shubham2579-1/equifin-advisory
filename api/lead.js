// Vercel serverless function — receives the homepage consultation form
// and emails the lead via Resend (https://resend.com).
//
// Required env var (set in Vercel project settings):
//   RESEND_API_KEY  — API key from your Resend account
//
// Optional env vars:
//   LEAD_EMAIL_TO    — destination inbox (default: shubham@equifinadvisory.com)
//   LEAD_EMAIL_FROM  — verified sender (default: Resend's shared test sender —
//                      replace with an address on a domain you've verified in Resend)

const REQUIRED_FIELDS = ['name', 'company', 'email', 'phone', 'service'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_LENGTHS = {
  name: 100,
  company: 100,
  email: 254,
  phone: 20,
  service: 100,
  ticket_size: 50,
  message: 2000,
};

// Best-effort in-memory rate limit. Resets whenever the serverless instance
// cold-starts and isn't shared across concurrent instances, but it throttles
// scripted bursts hitting a single warm instance without needing an external
// store. For stronger protection under real abuse, move this to Vercel
// KV / Upstash so the counter is shared across instances.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const requestLog = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  if (requestLog.size > 5000) requestLog.clear(); // guard against unbounded memory growth
  return timestamps.length > RATE_LIMIT_MAX;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://equifinadvisory.com');
  res.setHeader('Vary', 'Origin');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const body = req.body || {};

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
  }

  // Honeypot — bots fill hidden fields humans never see. Report success
  // without sending an email or revealing that the field was checked.
  if (body._honey) {
    return res.status(200).json({ success: true });
  }

  // Time trap — a hidden timestamp set when the form rendered. Real visitors
  // take at least a couple of seconds to fill the form; scripted submissions
  // usually don't. Fail silently, same as the honeypot, so bots aren't tipped off.
  if (body._ts) {
    const elapsed = Date.now() - Number(body._ts);
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 1500) {
      return res.status(200).json({ success: true });
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (!body[field] || !String(body[field]).trim()) {
      return res.status(400).json({ success: false, error: `Missing field: ${field}` });
    }
  }

  for (const [field, max] of Object.entries(MAX_LENGTHS)) {
    if (body[field] && String(body[field]).length > max) {
      return res.status(400).json({ success: false, error: `${field} is too long (max ${max} characters)` });
    }
  }

  if (!EMAIL_RE.test(body.email)) {
    return res.status(400).json({ success: false, error: 'Invalid email address' });
  }

  const phoneDigits = String(body.phone).replace(/\D/g, '');
  if (phoneDigits.length < 10 || phoneDigits.length > 13) {
    return res.status(400).json({ success: false, error: 'Invalid phone number' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY is not configured');
    return res.status(500).json({ success: false, error: 'Server not configured' });
  }

  const to = process.env.LEAD_EMAIL_TO || 'shubham@equifinadvisory.com';
  const from = process.env.LEAD_EMAIL_FROM || 'EquiFin Website <onboarding@resend.dev>';

  const rows = [
    ['Name', body.name],
    ['Company', body.company],
    ['Email', body.email],
    ['Phone', body.phone],
    ['Service', body.service],
    ['Ticket Size', body.ticket_size || 'Not specified'],
    ['Message', body.message || '—'],
  ];

  const html = `
    <table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
      ${rows.map(([label, value]) => `<tr><td><strong>${escapeHtml(label)}</strong></td><td>${escapeHtml(value)}</td></tr>`).join('')}
    </table>
  `;

  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        reply_to: body.email,
        subject: 'New Enquiry — EquiFin Advisory Website',
        html,
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error('Resend API error:', errText);
      return res.status(502).json({ success: false, error: 'Failed to send email' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Lead submission error:', err);
    return res.status(500).json({ success: false, error: 'Unexpected error' });
  }
};
