/**
 * Email notifications via Resend API
 * Sends daily/weekly job alerts to the user
 */

const https = require('https');

function sendEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.RESEND_API_KEY || '';
    if (!apiKey) {
      console.log('  [email] RESEND_API_KEY not set — skipping email');
      resolve({ success: false, reason: 'No API key' });
      return;
    }

    const body = JSON.stringify({
      from: process.env.EMAIL_FROM || 'Job Agent <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
    });

    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true, id: JSON.parse(data)?.id });
        } else {
          resolve({ success: false, status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendDailyDigest(jobs, recipient) {
  if (!recipient) return { success: false, reason: 'No recipient' };

  const topJobs = jobs.slice(0, 5).map(j => `
    <li style="margin-bottom:1rem">
      <a href="${j.url}" style="color:#2563eb;text-decoration:none;font-weight:600">${j.title}</a>
      <span style="color:#64748b;margin-left:.5rem">${j.company}</span>
      <div style="font-size:.85rem;color:#94a3b8;margin-top:.25rem">
        ${j.match_reasons.slice(0, 2).join(' · ')}
      </div>
      <a href="${j.url}" style="display:inline-block;margin-top:.5rem;padding:.4rem .8rem;background:#2563eb;color:white;border-radius:6px;font-size:.8rem;text-decoration:none">View Job</a>
    </li>
  `).join('');

  const html = `
<!DOCTYPE html>
<html>
<head><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
  .container { max-width: 600px; margin: 0 auto; }
  h1 { color: #60a5fa; }
  ul { list-style: none; padding: 0; }
  .footer { color: #64748b; font-size: .8rem; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #334155; }
</style></head>
<body>
  <div class="container">
    <h1>🔎 Daily Job Report</h1>
    <p>Found <strong>${jobs.length} new jobs</strong> matching your profile today:</p>
    <ul>${topJobs}</ul>
    <p style="margin-top:1.5rem">
      <a href="http://localhost:3000" style="padding:.75rem 1.5rem;background:#2563eb;color:white;border-radius:8px;text-decoration:none;font-weight:600">View All Jobs in Dashboard</a>
    </p>
    <div class="footer">
      <p>You're receiving this because you have a job search agent running.</p>
      <p>To stop these emails, update your profile settings.</p>
    </div>
  </div>
</body>
</html>`;

  return sendEmail(recipient, `Daily GCP Jobs Report - ${new Date().toLocaleDateString()}`, html);
}

async function sendWeeklyDigest(jobs, stats, recipient) {
  if (!recipient) return { success: false, reason: 'No recipient' };

  const html = `
<!DOCTYPE html>
<html>
<head><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
  .container { max-width: 600px; margin: 0 auto; }
  h1 { color: #60a5fa; }
  .stats { display: flex; gap: 1rem; margin: 1.5rem 0; }
  .stat { background: #1e293b; padding: 1rem; border-radius: 8px; text-align: center; flex: 1; }
  .stat b { color: #60a5fa; font-size: 1.5rem; display: block; }
  .stat span { font-size: .8rem; color: #94a3b8; }
  .footer { color: #64748b; font-size: .8rem; margin-top: 2rem; }
</style></head>
<body>
  <div class="container">
    <h1>📊 Weekly Job Report</h1>
    <div class="stats">
      <div class="stat"><b>${stats.total_applied || 0}</b><span>Applied</span></div>
      <div class="stat"><b>${stats.new_jobs || 0}</b><span>New Jobs</span></div>
      <div class="stat"><b>${stats.total_runs || 0}</b><span>Runs</span></div>
    </div>
    <p>You have <strong>${jobs.length} pending jobs</strong> in your dashboard.</p>
    <p style="margin-top:1.5rem">
      <a href="http://localhost:3000" style="padding:.75rem 1.5rem;background:#2563eb;color:white;border-radius:8px;text-decoration:none;font-weight:600">Open Dashboard</a>
    </p>
    <div class="footer">
      <p>Job Agent — Weekly digest</p>
    </div>
  </div>
</body>
</html>`;

  return sendEmail(recipient, `Weekly GCP Jobs Summary - ${new Date().toLocaleDateString()}`, html);
}

module.exports = { sendDailyDigest, sendWeeklyDigest };
