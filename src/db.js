/**
 * Database layer — SQLite persistence for jobs, applications, profile, scrape runs
 * Uses better-sqlite3 for synchronous access; falls back to JSON if unavailable
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');
let db = null;
let useFallback = false;
let fallbackData = { profile: {}, jobs: [], applications: [], scrapeRuns: [] };

function init() {
  // Always use JSON fallback for reliability across platforms (avoids native binary issues)
  if (useFallback && fallbackData.profile) return null;
  useFallback = true;
  loadFallback();
  // Ensure profile row exists
  if (!fallbackData.profile || !fallbackData.profile.name) {
    fallbackData.profile = {};
    saveFallback();
  }
  return null;
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT,
      email TEXT,
      phone TEXT,
      linkedin TEXT,
      location TEXT,
      resume_path TEXT,
      experience_years INTEGER,
      current_role TEXT,
      current_company TEXT,
      skills TEXT,
      target_titles TEXT,
      required_keywords TEXT,
      bonus_keywords TEXT,
      certifications TEXT,
      deal_breakers TEXT,
      preferred_work_type TEXT,
      preferred_locations TEXT,
      preferred_employment TEXT,
      salary_min INR REAL,
      salary_max INR REAL,
      salary_currency TEXT,
      summary TEXT,
      cover_letter_style TEXT,
      tone TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT,
      company TEXT,
      location TEXT,
      remote INTEGER DEFAULT 0,
      description TEXT,
      tags TEXT,
      salary TEXT,
      salary_min_inr REAL,
      url TEXT,
      posted_at TEXT,
      score REAL,
      match_reasons TEXT,
      warnings TEXT,
      status TEXT DEFAULT 'new',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
    CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(score DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_posted ON jobs(posted_at DESC);

    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      saved_at TEXT,
      applied_at TEXT,
      skipped_at TEXT,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_applications_job ON applications(job_id);
    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      total_fetched INTEGER DEFAULT 0,
      total_new INTEGER DEFAULT 0,
      total_matched INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running'
    );
  `);

  // Insert default profile row if empty
  const row = db.prepare('SELECT id FROM profile').get();
  if (!row) {
    db.prepare(`
      INSERT INTO profile (id, name, email, phone, linkedin, location, resume_path,
        experience_years, current_role, current_company, skills, target_titles,
        required_keywords, bonus_keywords, certifications, deal_breakers,
        preferred_work_type, preferred_locations, preferred_employment,
        salary_min, salary_currency, summary, cover_letter_style, tone, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      1, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null, null, null
    );
  }
}

// ── Fallback: JSON-based storage ─────────────────────────────────────────────

function loadFallback() {
  const jsonPath = DB_PATH + '.json';
  if (fs.existsSync(jsonPath)) {
    try {
      fallbackData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch { /* empty */ }
  }
}

function saveFallback() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH + '.json', JSON.stringify(fallbackData, null, 2));
}

// ── Profile helpers ──────────────────────────────────────────────────────────

function getProfile() {
  if (db) {
    const row = db.prepare('SELECT * FROM profile WHERE id = 1').get();
    return row ? parseProfile(row) : null;
  }
  return fallbackData.profile || null;
}

function saveProfile(profile) {
  if (db) {
    db.prepare(`
      UPDATE profile SET
        name = ?, email = ?, phone = ?, linkedin = ?, location = ?, resume_path = ?,
        experience_years = ?, current_role = ?, current_company = ?,
        skills = ?, target_titles = ?, required_keywords = ?, bonus_keywords = ?,
        certifications = ?, deal_breakers = ?, preferred_work_type = ?,
        preferred_locations = ?, preferred_employment = ?,
        salary_min = ?, salary_max = ?, salary_currency = ?,
        summary = ?, cover_letter_style = ?, tone = ?, updated_at = datetime('now')
      WHERE id = 1
    `).run(
      profile.name, profile.email, profile.phone, profile.linkedin, profile.location, profile.resume_path,
      profile.experience_years, profile.current_role, profile.current_company,
      JSON.stringify(profile.skills || []), JSON.stringify(profile.target_titles || []),
      JSON.stringify(profile.required_keywords || []), JSON.stringify(profile.bonus_keywords || []),
      JSON.stringify(profile.certifications || []), JSON.stringify(profile.deal_breakers || []),
      JSON.stringify(profile.preferred_work_type || []), JSON.stringify(profile.preferred_locations || []),
      JSON.stringify(profile.preferred_employment || []),
      profile.salary_min_inr || null, profile.salary_max_inr || null, profile.salary_currency || 'INR',
      profile.summary, profile.cover_letter_style, profile.tone
    );
  } else {
    fallbackData.profile = profile;
    saveFallback();
  }
}

function parseProfile(row) {
  return {
    name: row.name, email: row.email, phone: row.phone, linkedin: row.linkedin,
    location: row.location, resume_path: row.resume_path,
    experience_years: row.experience_years, current_role: row.current_role,
    current_company: row.current_company,
    skills: parseArr(row.skills), target_titles: parseArr(row.target_titles),
    required_keywords: parseArr(row.required_keywords),
    bonus_keywords: parseArr(row.bonus_keywords),
    certifications: parseArr(row.certifications),
    deal_breakers: parseArr(row.deal_breakers),
    preferred_work_type: parseArr(row.preferred_work_type),
    preferred_locations: parseArr(row.preferred_locations),
    preferred_employment: parseArr(row.preferred_employment),
    salary_min_inr: row.salary_min, salary_max_inr: row.salary_max,
    salary_currency: row.salary_currency,
    summary: row.summary, cover_letter_style: row.cover_letter_style,
    tone: row.tone
  };
}

// ── Job helpers ──────────────────────────────────────────────────────────────

function upsertJob(job) {
  if (db) {
    db.prepare(`
      INSERT INTO jobs (id, source, title, company, location, remote, description, tags, salary, salary_min_inr, url, posted_at, score, match_reasons, warnings, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        score = excluded.score, match_reasons = excluded.match_reasons,
        warnings = excluded.warnings, status = excluded.status,
        posted_at = excluded.posted_at
    `).run(
      job.id, job.source, job.title, job.company, job.location,
      job.remote ? 1 : 0, job.description || '', job.tags || '',
      job.salary || '', job.salary_min_inr || null, job.url || '',
      job.posted_at || new Date().toISOString(),
      job.score || 0,
      JSON.stringify(job.match_reasons || []),
      JSON.stringify(job.warnings || [])
    );
  } else {
    const existing = fallbackData.jobs.find(j => j.id === job.id);
    if (existing) {
      Object.assign(existing, job, { status: job.status || 'new' });
    } else {
      fallbackData.jobs.push({ ...job, status: job.status || 'new' });
    }
    saveFallback();
  }
}

function getJobs(filter = {}) {
  if (db) {
    let sql = 'SELECT * FROM jobs';
    const conditions = [];
    const params = [];
    if (filter.status) { conditions.push('status = ?'); params.push(filter.status); }
    if (filter.source) { conditions.push('source = ?'); params.push(filter.source); }
    if (filter.minScore != null) { conditions.push('score >= ?'); params.push(filter.minScore); }
    if (filter.limit) { conditions.push('LIMIT ?'); params.push(filter.limit); }
    if (filter.sort === 'posted') { conditions.push('ORDER BY posted_at DESC'); }
    else { conditions.push('ORDER BY score DESC'); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ') + ' ' + (filter.limit ? 'LIMIT ?' : 'ORDER BY score DESC');
    if (filter.limit && !conditions.length) sql += ' ORDER BY score DESC LIMIT ?';
    if (filter.limit) params.push(filter.limit);
    return db.prepare(sql).all(...params).map(normalizeJob);
  }
  let result = [...fallbackData.jobs];
  if (filter.status) result = result.filter(j => j.status === filter.status);
  if (filter.source) result = result.filter(j => j.source === filter.source);
  if (filter.minScore != null) result = result.filter(j => j.score >= filter.minScore);
  result.sort((a, b) => b.score - a.score);
  if (filter.limit) result = result.slice(0, filter.limit);
  return result;
}

function getNewJobCount() {
  if (db) {
    return db.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'new'").get().count;
  }
  return fallbackData.jobs.filter(j => j.status === 'new').length;
}

function normalizeJob(row) {
  return {
    ...row,
    status: row.status || 'new',
    match_reasons: parseArr(row.match_reasons),
    warnings: parseArr(row.warnings),
    remote: !!row.remote,
    salary_min_inr: parseFloat(row.salary_min_inr) || 0
  };
}

// ── Application helpers ──────────────────────────────────────────────────────

function updateApplication(jobId, action, note) {
  if (db) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO applications (id, job_id, status, saved_at, applied_at, skipped_at, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, saved_at = COALESCE(saved_at, excluded.saved_at),
        applied_at = COALESCE(applied_at, excluded.applied_at),
        skipped_at = COALESCE(skipped_at, excluded.skipped_at),
        note = COALESCE(note, excluded.note)
    `).run(`app-${jobId}`, jobId, action,
      action === 'saved' ? now : null,
      action === 'applied' ? now : null,
      action === 'skipped' ? now : null,
      note || null
    );
    // Also update job status
    db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(action === 'applied' ? 'applied' : action === 'skipped' ? 'skipped' : 'new', jobId);
  } else {
    const app = fallbackData.applications.find(a => a.id === `app-${jobId}`);
    if (app) {
      app.status = action;
      if (action === 'saved') app.saved_at = new Date().toISOString();
      if (action === 'applied') app.applied_at = new Date().toISOString();
      if (action === 'skipped') app.skipped_at = new Date().toISOString();
      if (note) app.note = note;
    } else {
      fallbackData.applications.push({
        id: `app-${jobId}`, job_id: jobId, status: action,
        saved_at: action === 'saved' ? new Date().toISOString() : null,
        applied_at: action === 'applied' ? new Date().toISOString() : null,
        skipped_at: action === 'skipped' ? new Date().toISOString() : null,
        note
      });
    }
    // Update job status
    const job = fallbackData.jobs.find(j => j.id === jobId);
    if (job) job.status = action === 'applied' ? 'applied' : action === 'skipped' ? 'skipped' : 'new';
    saveFallback();
  }
}

function getApplications(filter = {}) {
  if (db) {
    let sql = `SELECT a.*, j.title, j.company, j.source, j.url, j.score
               FROM applications a JOIN jobs j ON a.job_id = j.id`;
    const conditions = [];
    const params = [];
    if (filter.status) { conditions.push('a.status = ?'); params.push(filter.status); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY a.created_at DESC';
    return db.prepare(sql).all(...params);
  }
  let result = [...fallbackData.applications];
  if (filter.status) result = result.filter(a => a.status === filter.status);
  result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return result;
}

// ── Scrape run tracking ──────────────────────────────────────────────────────

function startScrapeRun() {
  if (db) {
    const stmt = db.prepare("INSERT INTO scrape_runs (started_at, status) VALUES (datetime('now'), 'running')");
    const info = stmt.run();
    return info.lastInsertRowid;
  } else {
    const id = fallbackData.scrapeRuns.length + 1;
    fallbackData.scrapeRuns.push({ id, started_at: new Date().toISOString(), status: 'running', total_fetched: 0, total_new: 0, total_matched: 0 });
    saveFallback();
    return id;
  }
}

function finishScrapeRun(runId, stats) {
  if (db) {
    db.prepare(`
      UPDATE scrape_runs SET
        ended_at = datetime('now'), status = 'completed',
        total_fetched = ?, total_new = ?, total_matched = ?
      WHERE id = ?
    `).run(stats.totalFetched, stats.totalNew, stats.totalMatched, runId);
  } else {
    const run = fallbackData.scrapeRuns.find(r => r.id === runId);
    if (run) {
      run.ended_at = new Date().toISOString();
      run.status = 'completed';
      run.total_fetched = stats.totalFetched;
      run.total_new = stats.totalNew;
      run.total_matched = stats.totalMatched;
      saveFallback();
    }
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────

function getStats() {
  if (db) {
    return {
      total_jobs: db.prepare("SELECT COUNT(*) as c FROM jobs").get().c,
      new_jobs: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'new'").get().c,
      saved_jobs: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'saved'").get().c,
      applied_jobs: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'applied'").get().c,
      skipped_jobs: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'skipped'").get().c,
      total_runs: db.prepare("SELECT COUNT(*) as c FROM scrape_runs").get().c,
      last_run: db.prepare("SELECT started_at, total_fetched FROM scrape_runs ORDER BY id DESC LIMIT 1").get(),
    };
  }
  return {
    total_jobs: fallbackData.jobs.length,
    new_jobs: fallbackData.jobs.filter(j => j.status === 'new').length,
    saved_jobs: fallbackData.jobs.filter(j => j.status === 'saved').length,
    applied_jobs: fallbackData.jobs.filter(j => j.status === 'applied').length,
    skipped_jobs: fallbackData.jobs.filter(j => j.status === 'skipped').length,
    total_runs: fallbackData.scrapeRuns.length,
    last_run: fallbackData.scrapeRuns.at(-1),
  };
}

// ── Utility ──────────────────────────────────────────────────────────────────

function parseArr(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return val.split(',').map(s => s.trim()); }
}

function close() {
  if (db) { db.close(); db = null; }
}

module.exports = {
  init, close,
  getProfile, saveProfile,
  upsertJob, getJobs, getNewJobCount,
  updateApplication, getApplications,
  startScrapeRun, finishScrapeRun,
  getStats, useFallback
};
