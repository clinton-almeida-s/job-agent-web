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
});

// ── Profile ───────────────────────────────────────────────────────────────────
async function loadProfile() {
  const r = await fetch(`${API}/profile`);
  const p = await r.json();
  document.getElementById('profileName').textContent = p.name || 'Job Agent';
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

  // Populate company filter
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
  const els = document.querySelectorAll('.stat b');
  els[0].textContent = s.total_jobs;
  els[1].textContent = s.new_jobs;
  els[2].textContent = s.saved_jobs;
  els[3].textContent = s.applied_jobs;
  els[4].textContent = s.skipped_jobs;
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

  // Client-side search filter
  if (search) {
    allJobs = allJobs.filter(j =>
      (j.title || '').toLowerCase().includes(search) ||
      (j.company || '').toLowerCase().includes(search) ||
      (j.description || '').toLowerCase().includes(search)
    );
  }

  renderJobs(allJobs);
  loadStats();
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
    q.innerHTML = '<div class="empty-state">No jobs found. Click "Scrape Now" to fetch fresh listings.</div>';
    return;
  }
  q.innerHTML = jobs.map((j, i) => jobCard(j, i)).join('');
}

function jobCard(job, index) {
  const reasons = (job.match_reasons || []).map(r => `<li>✅ ${r}</li>`).join('');
  const warnings = (job.warnings || []).filter(w => w).map(w => `<li class="warn">⚠️ ${w}</li>`).join('');
  const salaryBadge = job.salary ? `<span class="badge salary">💰 ${job.salary}</span>` : '';
  const remoteBadge = job.remote || job.source === 'RemoteOK' || job.source === 'Remotive' || job.source === 'WeWorkRemotely' ? `<span class="badge remote">🌐 Remote</span>` : '';
  const clHtml = job.cover_letter
    ? `<div class="cl-box">${escapeHtml(job.cover_letter.slice(0, 400))}${job.cover_letter.length > 400 ? '...' : ''}<button onclick="copyText('cl-${index}')">Copy</button></div>`
    : '';
  const statusClass = `status-${job.status || 'new'}`;
  const pct = Math.min(100, Math.round((job.score || 0) / 120 * 100));
  const scoreColor = pct >= 70 ? '#4ade80' : pct >= 40 ? '#fbbf24' : '#f87171';

  return `
  <div class="job-card" id="job-${job.id}">
    <div class="job-header">
      <div class="job-rank">#${index + 1} <span class="status-badge ${statusClass}">${(job.status || 'new').toUpperCase()}</span></div>
      <div class="job-title-block">
        <h2>${escapeHtml(job.title)}</h2>
        <div class="job-meta">${escapeHtml(job.company)} · ${escapeHtml(job.source)}</div>
        <div class="badges">
          <span class="badge source">${escapeHtml(job.source)}</span>
          ${remoteBadge}
          ${salaryBadge}
        </div>
      </div>
      <div class="score-bar-wrap">
        <div class="score-bar"><div class="score-fill" style="width:${pct}%;background:${scoreColor}"></div></div>
        <span>${job.score} pts</span>
      </div>
    </div>
    <div class="job-body">
      <div class="reasons">
        <h4>Why this matched</h4>
        <ul>${reasons}${warnings}</ul>
      </div>
      <div class="desc">
        <h4>Description</h4>
        <p>${escapeHtml((job.description || '').slice(0, 300))}${(job.description || '').length > 300 ? '... (link for full text)' : ''}</p>
      </div>
      ${clHtml}
      <div class="actions">
        <a href="${escapeHtml(job.url)}" target="_blank" class="btn-apply">🔗 View Job</a>
        <button onclick="openApply('${job.id}')">🚀 Prepare Application</button>
        <button onclick="markAction('${job.id}','saved')">💾 Save</button>
        <button onclick="markAction('${job.id}','skipped')">⏭ Skip</button>
        <button onclick="markAction('${job.id}','ignored')">🗑 Ignore</button>
      </div>
    </div>
  </div>`;
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function markAction(jobId, action) {
  await fetch(`${API}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) });
  toast(`${action.charAt(0).toUpperCase() + action.slice(1)}d job`);
  loadJobs();
}

async function bulkSave() {
  const visible = document.querySelectorAll('.job-card');
  visible.forEach(el => {
    const jobId = el.id.replace('job-', '');
    markAction(jobId, 'saved');
  });
}

async function bulkSkipLow() {
  allJobs.filter(j => j.score < 30 && (j.status === 'new')).forEach(j => markAction(j.id, 'skipped'));
}

// ── Apply Modal ───────────────────────────────────────────────────────────────
function openApply(jobId) {
  currentJobId = jobId;
  const job = allJobs.find(j => j.id === jobId);
  if (!job) return;
  const p = window._profile || {};
  document.getElementById('applyContent').innerHTML = `
    <h3>${escapeHtml(job.title)} @ ${escapeHtml(job.company)}</h3>
    <p style="color:var(--muted);margin:.5rem 0">${escapeHtml(job.description?.slice(0, 200)) || 'No description available.'}</p>
    <p style="margin:.5rem 0"><a href="${escapeHtml(job.url)}" target="_blank" style="color:var(--accent)">View full job listing →</a></p>
    <h4>Application Checklist:</h4>
    <ul class="apply-checklist">
      <li><input type="checkbox" checked disabled> Name: <span class="val">${escapeHtml(p.name || '—')}</span></li>
      <li><input type="checkbox" checked disabled> Email: <span class="val">${escapeHtml(p.email || '—')}</span></li>
      <li><input type="checkbox" checked disabled> Phone: <span class="val">${escapeHtml(p.phone || '—')}</span></li>
      <li><input type="checkbox" checked disabled> Resume: <span class="val">${escapeHtml(p.resume_path || 'not set')}</span></li>
      <li><input type="checkbox" checked disabled> Cover letter: <span class="val">${job.cover_letter ? '✓ Generated' : 'Run with ANTHROPIC_API_KEY'}</span></li>
    </ul>
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
  // Parse comma-separated fields
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
    document.getElementById('scrapeBtn').textContent = '⏳ Scraping...';
    await fetch(`${API}/scrape`, { method: 'POST' });
    setTimeout(() => { loadJobs(); document.getElementById('scrapeBtn').disabled = false; document.getElementById('scrapeBtn').textContent = '🔄 Scrape Now'; }, 2000);
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
  document.getElementById('searchInput').oninput = () => { clearTimeout(window._searchTimer); window._searchTimer = setTimeout(() => { loadJobs(); updateClearButton(); }, 300); };
  document.getElementById('bulkSave').onclick = bulkSave;
  document.getElementById('bulkSkip').onclick = bulkSkipLow;
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

window.copyText = function(id) {
  const el = document.getElementById(id);
  navigator.clipboard.writeText(el.textContent).then(() => toast('Cover letter copied!'));
};
window.markAction = markAction;
window.openApply = openApply;
window.bulkSave = bulkSave;
window.bulkSkipLow = bulkSkipLow;