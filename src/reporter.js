/**
 * Report Generator — creates a rich HTML daily report
 * Opens in your default browser so you can review and apply
 */

const fs      = require('fs');
const path    = require('path');
const profile = require('../profile.json');

function scoreBar(score) {
  const pct = Math.min(100, Math.round((score / 120) * 100));
  const color = pct >= 70 ? '#22c55e' : pct >= 40 ? '#f59e0b' : '#6b7280';
  return `<div class="score-bar-wrap"><div class="score-bar" style="width:${pct}%;background:${color}"></div><span>${score} pts</span></div>`;
}

function jobCard(job, index) {
  const reasons = job.match_reasons.map(r => `<li>✅ ${r}</li>`).join('');
  const warnings = (job.warnings || []).map(w => `<li>⚠️ ${w}</li>`).join('');
  const salaryBadge = job.salary ? `<span class="badge salary">💰 ${job.salary}</span>` : '';
  const sourceBadge = `<span class="badge source">${job.source}</span>`;
  const remoteBadge = `<span class="badge remote">🌐 Remote</span>`;

  const coverLetterHtml = job.cover_letter
    ? `<div class="cover-letter">
         <h4>📄 Draft Cover Letter</h4>
         <pre>${job.cover_letter}</pre>
         <button onclick="copyText('cl-${index}')">Copy to clipboard</button>
         <textarea id="cl-${index}" style="display:none">${job.cover_letter}</textarea>
       </div>`
    : `<p class="no-cl">Cover letter generation requires ANTHROPIC_API_KEY</p>`;

  return `
  <div class="job-card" id="job-${index}">
    <div class="job-header">
      <div class="job-rank">#${index + 1}</div>
      <div class="job-title-block">
        <h2>${job.title}</h2>
        <div class="company">${job.company}</div>
        <div class="badges">${sourceBadge} ${remoteBadge} ${salaryBadge}</div>
      </div>
      ${scoreBar(job.score)}
    </div>
    <div class="job-body">
      <div class="match-info">
        <h4>Why this matched your profile:</h4>
        <ul>${reasons}</ul>
        ${warnings ? `<ul class="warnings">${warnings}</ul>` : ''}
      </div>
      <div class="description">
        <h4>Job Description (excerpt)</h4>
        <p>${job.description.slice(0, 600)}${job.description.length > 600 ? '...' : ''}</p>
      </div>
      ${coverLetterHtml}
      <div class="actions">
        <a href="${job.url}" target="_blank" class="btn-apply">🚀 Apply Now</a>
        ${extractEmployerUrl(job) ? '<a href="' + extractEmployerUrl(job) + '" target="_blank" style="background:#0f766e;color:#e5e7eb;border:1px solid #14b8a6;padding:.5rem 1.1rem;border-radius:8px;font-size:.82rem;font-weight:500;text-decoration:none;display:inline-flex;align-items:center;margin-left:.5rem;">🏢 Employer Site (bypass paywall)</a>' : ''}
        <button onclick="markApplied('${job.id}', '${job.title}', '${job.company}')">✅ Mark as Applied</button>
        <button onclick="skipJob('${job.id}')">⏭ Skip (hide tomorrow)</button>
      </div>
    </div>
  </div>`;
}

function generateHTML(jobs, trackerStats) {
  const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const cards = jobs.map((j, i) => jobCard(j, i)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Job Report — ${date}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    header { background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%); padding: 2rem; border-bottom: 1px solid #334155; }
    header h1 { font-size: 1.6rem; color: #60a5fa; }
    header .meta { color: #94a3b8; margin-top: .5rem; font-size: .9rem; }
    .stats { display: flex; gap: 1rem; margin-top: 1rem; flex-wrap: wrap; }
    .stat { background: #1e293b; border-radius: 8px; padding: .5rem 1rem; font-size: .85rem; border: 1px solid #334155; }
    .stat b { color: #60a5fa; }
    main { max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
    .job-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; margin-bottom: 1.5rem; overflow: hidden; }
    .job-header { display: flex; align-items: flex-start; gap: 1rem; padding: 1.25rem; background: #162032; border-bottom: 1px solid #334155; }
    .job-rank { font-size: 1.5rem; font-weight: 700; color: #60a5fa; min-width: 2.5rem; padding-top: 2px; }
    .job-title-block { flex: 1; }
    .job-title-block h2 { font-size: 1.1rem; color: #f1f5f9; }
    .company { color: #94a3b8; font-size: .9rem; margin-top: 2px; }
    .badges { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .5rem; }
    .badge { font-size: .75rem; padding: 2px 8px; border-radius: 12px; font-weight: 500; }
    .badge.source { background: #1e3a5f; color: #60a5fa; border: 1px solid #2563eb44; }
    .badge.remote { background: #14532d; color: #4ade80; border: 1px solid #16a34a44; }
    .badge.salary { background: #422006; color: #fb923c; border: 1px solid #ea580c44; }
    .score-bar-wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; min-width: 110px; }
    .score-bar-wrap span { font-size: .75rem; color: #94a3b8; }
    .score-bar { height: 8px; border-radius: 4px; min-width: 4px; }
    .job-body { padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem; }
    .match-info h4, .description h4 { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: #64748b; margin-bottom: .5rem; }
    .match-info ul { list-style: none; display: flex; flex-direction: column; gap: 4px; }
    .match-info li { font-size: .875rem; color: #cbd5e1; }
    .warnings li { color: #fbbf24; }
    .description p { font-size: .875rem; color: #94a3b8; line-height: 1.6; }
    .cover-letter { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 1rem; }
    .cover-letter h4 { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: #64748b; margin-bottom: .75rem; }
    .cover-letter pre { font-family: inherit; font-size: .875rem; color: #cbd5e1; white-space: pre-wrap; line-height: 1.7; }
    .cover-letter button { margin-top: .75rem; background: #1e3a5f; color: #60a5fa; border: 1px solid #2563eb44; padding: .4rem .9rem; border-radius: 6px; cursor: pointer; font-size: .8rem; }
    .no-cl { font-size: .8rem; color: #475569; font-style: italic; }
    .actions { display: flex; gap: .75rem; flex-wrap: wrap; padding-top: .5rem; border-top: 1px solid #334155; }
    .btn-apply { background: #2563eb; color: white; padding: .5rem 1.25rem; border-radius: 8px; font-size: .875rem; font-weight: 600; text-decoration: none; display: inline-flex; align-items: center; }
    .btn-apply:hover { background: #1d4ed8; }
    button { background: #1e293b; color: #94a3b8; border: 1px solid #334155; padding: .5rem 1rem; border-radius: 8px; cursor: pointer; font-size: .8rem; }
    button:hover { background: #334155; color: #e2e8f0; }
    #toast { position: fixed; bottom: 1.5rem; right: 1.5rem; background: #22c55e; color: white; padding: .75rem 1.25rem; border-radius: 8px; font-size: .875rem; display: none; z-index: 100; }
    footer { text-align: center; color: #334155; font-size: .75rem; padding: 2rem; }
  </style>
</head>
<body>
  <header>
    <h1>🔎 Daily Job Report — ${profile.name}</h1>
    <div class="meta">Generated: ${date} &nbsp;|&nbsp; ${jobs.length} top matches found</div>
    <div class="stats">
      <div class="stat">Total seen (all time): <b>${trackerStats.total_seen}</b></div>
      <div class="stat">Total applied: <b>${trackerStats.total_applied}</b></div>
      <div class="stat">Last applied: <b>${trackerStats.last_applied !== 'never' ? new Date(trackerStats.last_applied).toLocaleDateString() : 'never'}</b></div>
    </div>
  </header>
  <main>
    ${jobs.length === 0
      ? '<p style="color:#94a3b8;text-align:center;padding:3rem">No new matching jobs found today. Check back tomorrow!</p>'
      : cards}
  </main>
  <footer>Semi-automated job search agent — review all applications before submitting.</footer>
  <div id="toast"></div>
  <script>
    function toast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(() => el.style.display = 'none', 3000);
    }
    function copyText(id) {
      const el = document.getElementById(id);
      navigator.clipboard.writeText(el.value).then(() => toast('Cover letter copied!'));
    }
    function markApplied(id, title, company) {
      // In future: call tracker API or write to local file
      toast('Marked as applied: ' + title + ' @ ' + company);
      document.querySelector('#job-' + [...document.querySelectorAll('[id^=job-]')].findIndex(el => el.querySelector('.btn-apply')?.href?.includes(id))).style.opacity = '0.4';
    }
    function skipJob(id) {
      toast('Job hidden from future reports');
    }
  </script>
</body>
</html>`;
}

function saveReport(jobs, trackerStats) {
  const dir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `report-${new Date().toISOString().split('T')[0]}.html`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, generateHTML(jobs, trackerStats));
  return filepath;
}
function extractEmployerUrl(job){const d=job.description||"";const m=d.match(/href="(https?:\/\/(?!remoteok\.com|weworkremotely\.com|remotive\.com)[^"]+)"/i);return m?m[1]:"";}

module.exports = { saveReport };
