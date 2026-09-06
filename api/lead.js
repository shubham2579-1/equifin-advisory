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

const REQUIRED_FIELDS = ['name', 'company', 'email', 'phone', 'service', 'ticket_size'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const body = req.body || {};

  // Honeypot — bots fill hidden fields humans never see. Report success
  // without sending an email or revealing that the field was checked.
  if (body._honey) {
    return res.status(200).json({ success: true });
  }

  for (const field of REQUIRED_FIELDS) {
    if (!body[field] || !String(body[field]).trim()) {
      return res.status(400).json({ success: false, error: `Missing field: ${field}` });
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
    ['Ticket Size', body.ticket_size],
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
