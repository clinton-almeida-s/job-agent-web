/**
 * app.js — Dashboard client-side logic
 */
const API = '/api';
let allJobs = [];
let currentJobId = null;

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadProfile();
  await loadStats();
  await loadSources();
  await loadJobs();
  bindEvents();
  startUtcClock();
});

// ── UTC Clock ─────────────────────────────────────────────────────────────────
function startUtcClock() {
  function tick() {
    const d = new Date();
    const h = String(d.getUTCHours()).padStart(2, '0');
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    const s = String(d.getUTCSeconds()).padStart(2, '0');
    const el = document.getElementById('utcTime');
    if (el) el.textContent = h + ':' + m + ':' + s + ' UTC';
  }
  tick();
  setInterval(tick, 1000);
}

// ── Profile ───────────────────────────────────────────────────────────────────
async function loadProfile() {
  const r = await fetch(`${API}/profile`);
  const p = await r.json();
  window._profile = p;
}

async function loadSources() {
  const r = await fetch(`${API}/jobs?limit=5000`);
  const jobs = await r.json();
  const sources = [...new Set(jobs.map(j => j.source))].sort();
  const sel = document.getElementById('sourceFilter');
  sources.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    sel.appendChild(opt);
  });

  const companies = [...new Set(jobs.map(j => j.company))].sort();
  const companySel = document.getElementById('companyFilter');
  companies.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    companySel.appendChild(opt);
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
  const s = await (await fetch(`${API}/stats`)).json();
  const cells = document.querySelectorAll('.stat-strip .stat-cell');
  if (cells[0]) cells[0].querySelector('.num').textContent = s.total_jobs;
  if (cells[1]) cells[1].querySelector('.num').textContent = s.new_jobs;
  if (cells[2]) cells[2].querySelector('.num').textContent = s.saved_jobs;
  if (cells[3]) cells[3].querySelector('.num').textContent = s.applied_jobs;
  if (cells[4]) cells[4].querySelector('.num').textContent = s.skipped_jobs;
  if (cells[5]) cells[5].querySelector('.num').textContent = s.ignored_jobs || 0;
  const tm = document.getElementById('topbarMatched');
  const tt = document.getElementById('topbarTotal');
  if (tm) tm.textContent = (s.matched_jobs || s.new_jobs) + ' matched';
  if (tt) tt.textContent = s.total_jobs + ' total';
}

// ── Jobs ──────────────────────────────────────────────────────────────────────
async function loadJobs() {
  const status = document.getElementById('statusFilter').value;
  const company = document.getElementById('companyFilter').value;
  const region = document.getElementById('regionFilter').value;
  const jobType = document.getElementById('jobTypeFilter').value;
  const source = document.getElementById('sourceFilter').value;
  const sort = document.getElementById('sortFilter').value;
  const search = document.getElementById('searchInput').value.toLowerCase();

  let params = new URLSearchParams({ status, sort, limit: 500 });
  if (company) params.set('company', company);
  if (region) params.set('region', region);
  if (jobType) params.set('jobType', jobType);
  if (source) params.set('source', source);
  const r = await fetch(`${API}/jobs?${params}`);
  allJobs = await r.json();

  if (search) {
    allJobs = allJobs.filter(j =>
      (j.title || '').toLowerCase().includes(search) ||
      (j.company || '').toLowerCase().includes(search) ||
      (j.description || '').toLowerCase().includes(search)
    );
  }

  renderJobs(allJobs);
  await loadStats();
  updateClearButton();
}

function updateClearButton() {
  const hasFilter = document.getElementById('companyFilter').value ||
                    document.getElementById('regionFilter').value ||
                    document.getElementById('jobTypeFilter').value ||
                    document.getElementById('searchInput').value;
  document.getElementById('clearFilters').style.display = hasFilter ? '' : 'none';
}

function renderJobs(jobs) {
  const q = document.getElementById('jobQueue');
  if (jobs.length === 0) {
    q.innerHTML = '<div class="empty-state"><div class="icon">⎓</div><p>No jobs found. Click "Scrape Now" to fetch fresh listings.</p></div>';
    return;
  }
  q.innerHTML = jobs.map((j, i) => jobRow(j, i)).join('');
}

function jobRow(job, index) {
  const salaryBadge = job.salary ? `<span class="job-tag salary">${escapeHtml(job.salary)}</span>` : '';
  const remoteBadge = job.remote || job.source === 'RemoteOK' || job.source === 'Remotive' || job.source === 'WeWorkRemotely'
    ? `<span class="job-tag remote">Remote</span>` : '';
  const status = job.status || 'new';
  const statusClass = `status-${status}`; // statusClass for status-badge class
  const rowClass = status === 'applied' ? 'applied' : status === 'saved' ? 'saved'
    : status === 'skipped' ? 'skipped' : status === 'ignored' ? 'ignored' : '';
  const pct = Math.min(100, Math.round((job.score || 0) / 120 * 100));
  const scoreClass = pct >= 70 ? 'high' : pct >= 40 ? 'mid' : 'low';
  const location = job.location || job.region || '—';
  const sourceLabel = job.source || '';

  const actionsHtml = `
    <a href="${escapeHtml(job.url)}" target="_blank" class="action-link view" aria-label="View job details">View</a>
    <a href="javascript:void(0)" onclick="openApply('${job.id}')" class="action-link apply" aria-label="Apply to this job">Apply</a>
    <a href="javascript:void(0)" onclick="markAction('${job.id}','saved')" class="action-link save" aria-label="Save this job">Save</a>
    <a href="javascript:void(0)" onclick="markAction('${job.id}','skipped')" class="action-link skip" aria-label="Move to skipped">Skip</a>
    <a href="javascript:void(0)" onclick="markAction('${job.id}','ignored')" class="action-link ignore" aria-label="Move to ignored">Ignore</a>
  `;

  return `
  <div class="job-row ${rowClass}" id="job-${job.id}">
    <div class="job-info">
      <div class="job-title">
        ${escapeHtml(job.title)}
        <span class="status-tag ${statusClass}">${status}</span>
      </div>
      <div class="job-company">${escapeHtml(job.company || '')} &middot; ${escapeHtml(sourceLabel)}</div>
      <div class="job-tags">${remoteBadge}${salaryBadge}</div>
    </div>
    <div class="job-details">
      <div class="location">${escapeHtml(location)}</div>
      <div class="source">${escapeHtml(sourceLabel)}</div>
    </div>
    <div class="job-score">
      <div class="score-bar-track"><div class="score-bar-fill ${scoreClass}" style="width:${pct}%"></div></div>
      <span class="score-val">${job.score ?? 0} pts</span>
    </div>
    <div class="job-actions">${actionsHtml}</div>
  </div>`;
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function markAction(jobId, action) {
  const endpointMap = { applied: 'apply', skipped: 'skip', saved: 'save', ignored: 'ignore', new: 'new' };
  const endpoint = endpointMap[action] || action;
  let payload = { jobId };
  if (action === 'skipped' || action === 'ignored') {
    const job = allJobs.find(j => j.id === jobId);
    if (job && job.title) payload.title = job.title;
  }
  try {
    const resp = await fetch(`${API}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + text);
    JSON.parse(text);
    toast(`${action.charAt(0).toUpperCase() + action.slice(1)}d job`);
    await loadJobs();
  } catch (err) {
    toast('Error: ' + err.message);
  }
}

// ── Apply Modal ───────────────────────────────────────────────────────────────
function openApply(jobId) {
  currentJobId = jobId;
  const job = allJobs.find(j => j.id === jobId);
  if (!job) return;
  const p = window._profile || {};
  document.getElementById('applyContent').innerHTML = `
    <div style="padding:1.5rem">
      <h3 style="font-size:14px;font-weight:600;margin-bottom:.25rem">${escapeHtml(job.title)} @ ${escapeHtml(job.company)}</h3>
      <p style="color:var(--muted);margin:.5rem 0;font-size:13px">${escapeHtml(job.description?.slice(0, 200)) || 'No description available.'}</p>
      <p style="margin:.5rem 0;font-size:13px"><a href="${escapeHtml(job.url)}" target="_blank" style="color:var(--accent)">View full job listing →</a></p>
      <h4 style="font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:1rem 0 .5rem">Application Checklist:</h4>
      <ul class="apply-checklist">
        <li><input type="checkbox" checked disabled> Name: <span class="val">${escapeHtml(p.name || '—')}</span></li>
        <li><input type="checkbox" checked disabled> Email: <span class="val">${escapeHtml(p.email || '—')}</span></li>
        <li><input type="checkbox" checked disabled> Phone: <span class="val">${escapeHtml(p.phone || '—')}</span></li>
        <li><input type="checkbox" checked disabled> Resume: <span class="val">${escapeHtml(p.resume_path || 'not set')}</span></li>
        <li><input type="checkbox" checked disabled> Cover letter: <span class="val">${job.cover_letter ? '✓ Generated' : 'Run with ANTHROPIC_API_KEY'}</span></li>
      </ul>
    </div>
  `;
  document.getElementById('applyUrlBtn').href = job.url;
  document.getElementById('markAppliedBtn').onclick = async () => {
    await markAction(jobId, 'applied');
    document.getElementById('applyModal').style.display = 'none';
    toast('Marked as applied!');
  };
  document.getElementById('applyModal').style.display = 'flex';
}

// ── Profile Modal ─────────────────────────────────────────────────────────────
document.getElementById('profileBtn').onclick = async () => {
  const p = await (await fetch(`${API}/profile`)).json();
  window._profile = p;
  Object.keys(p).forEach(k => {
    const el = document.getElementById('p_' + k);
    if (el) el.value = Array.isArray(p[k]) ? p[k].join(', ') : (p[k] || '');
  });
  document.getElementById('profileModal').style.display = 'flex';
};

document.getElementById('profileForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const p = {};
  fd.forEach((v, k) => { p[k] = v; });
  for (const key of ['skills', 'target_titles', 'required_keywords', 'bonus_keywords', 'deal_breakers', 'preferred_work_type', 'preferred_locations', 'preferred_employment']) {
    p[key] = (p[key] || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  p.experience_years = parseInt(p.experience_years) || 0;
  p.salary_min_lakhs = parseFloat(p.salary_min_lakhs) || 35;
  p.target_salary = { currency: p.salary_currency || 'INR', min_lakhs: p.salary_min_lakhs };
  await fetch(`${API}/profile`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  document.getElementById('profileModal').style.display = 'none';
  toast('Profile saved!');
  loadProfile();
};

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('scrapeBtn').onclick = async () => {
    document.getElementById('scrapeBtn').disabled = true;
    document.getElementById('scrapeBtn').textContent = 'Scraping...';
    await fetch(`${API}/scrape`, { method: 'POST' });
    setTimeout(() => {
      loadJobs();
      document.getElementById('scrapeBtn').disabled = false;
      document.getElementById('scrapeBtn').textContent = 'Scrape Now';
    }, 2000);
  };
  document.getElementById('clearFilters').onclick = () => {
    document.getElementById('companyFilter').value = '';
    document.getElementById('regionFilter').value = '';
    document.getElementById('jobTypeFilter').value = '';
    document.getElementById('searchInput').value = '';
    loadJobs();
  };

  function onFilterChange() { loadJobs(); updateClearButton(); }
  document.getElementById('statusFilter').onchange = loadJobs;
  document.getElementById('companyFilter').onchange = onFilterChange;
  document.getElementById('regionFilter').onchange = onFilterChange;
  document.getElementById('jobTypeFilter').onchange = onFilterChange;
  document.getElementById('sourceFilter').onchange = loadJobs;
  document.getElementById('sortFilter').onchange = loadJobs;
  document.getElementById('searchInput').oninput = () => {
    clearTimeout(window._searchTimer);
    window._searchTimer = setTimeout(() => { loadJobs(); updateClearButton(); }, 300);
  };
  document.getElementById('closeProfileBtn').onclick = () => document.getElementById('profileModal').style.display = 'none';
  document.getElementById('cancelProfileBtn').onclick = () => document.getElementById('profileModal').style.display = 'none';
  document.getElementById('closeApplyBtn').onclick = () => document.getElementById('applyModal').style.display = 'none';
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 2500);
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

window.markAction = markAction;
window.openApply = openApply;
