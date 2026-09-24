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

async function sendDailyDigest(topJobs, stats, recipient) {
  if (!recipient) return { success: false, reason: 'No recipient' };

  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const lastRun = stats?.last_run?.started_at ? new Date(stats.last_run.started_at).toLocaleString('en-GB') : 'never';

  const jobRows = topJobs.slice(0, 10).map((j, i) => `
    <tr style="border-bottom:1px solid #1e293b">
      <td style="padding:.5rem .75rem;color:#60a5fa;font-weight:600;white-space:nowrap">${i + 1}</td>
      <td style="padding:.5rem .75rem">
        <a href="${j.url}" style="color:#e2e8f0;text-decoration:none;font-weight:600">${j.title}</a>
        <div style="color:#94a3b8;font-size:.8rem;margin-top:.15rem">${j.company}</div>
      </td>
      <td style="padding:.5rem .75rem;color:#94a3b8;font-size:.85rem;max-width:22rem">
        ${(j.match_reasons || []).slice(0, 2).join(' · ')}
      </td>
    </tr>
  `).join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
  .container { max-width: 640px; margin: 0 auto; }
  h1 { color: #60a5fa; font-size: 1.4rem; }
  .grid { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1.5rem 0; }
  .stat { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: .75rem 1rem; flex: 1; min-width: 100px; }
  .stat b { color: #60a5fa; font-size: 1.3rem; display: block; }
  .stat span { font-size: .78rem; color: #94a3b8; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th { text-align: left; color: #64748b; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; padding: .4rem .75rem; border-bottom: 1px solid #334155; }
  td { font-size: .875rem; }
  .footer { color: #64748b; font-size: .8rem; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #334155; }
  .cta { display: inline-block; margin-top: 1.5rem; padding:.75rem 1.5rem; background:#2563eb; color:white; border-radius:8px; text-decoration:none; font-weight:600; }
</style></head>
<body>
  <div class="container">
    <h1>📊 Job Agent Dashboard</h1>
    <p style="color:#94a3b8;margin-top:.25rem">${today} &nbsp;|&nbsp; Last run: ${lastRun}</p>

    <div class="grid">
      <div class="stat"><b>${stats?.total_jobs || 0}</b><span>Total jobs</span></div>
      <div class="stat"><b>${stats?.new_jobs || 0}</b><span>New today</span></div>
      <div class="stat"><b>${stats?.applied_jobs || 0}</b><span>Applied</span></div>
      <div class="stat"><b>${stats?.skipped_jobs || 0}</b><span>Skipped</span></div>
      <div class="stat"><b>${stats?.saved_jobs || 0}</b><span>Saved</span></div>
    </div>

    <h2 style="color:#60a5fa;font-size:1.05rem">🏆 Top ${topJobs.length} Matches</h2>
    <table>
      <thead><tr><th>#</th><th>Job</th><th>Why it matched</th></tr></thead>
      <tbody>${jobRows || '<tr><td colspan="3" style="color:#64748b;padding:1rem">No new matching jobs found today.</td></tr>'}</tbody>
    </table>

    <p style="margin-top:1.5rem">
      <a href="https://job-agent-web.clinton-s-almeida.workers.dev" class="cta">Open Dashboard</a>
    </p>
    <div class="footer">
      <p>Job Agent — daily digest. Review all applications before submitting.</p>
    </div>
  </div>
</body>
</html>`;

  return sendEmail(recipient, `Job Agent Dashboard — ${today}`, html);
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
      <a href="https://job-agent-web.clinton-s-almeida.workers.dev" style="padding:.75rem 1.5rem;background:#2563eb;color:white;border-radius:8px;text-decoration:none;font-weight:600">Open Dashboard</a>
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
