/**
 * server.js — Web dashboard server
 * Serves dashboard and provides REST API for job review/actions
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { init: initDb, getJobs, getStats, updateApplication, getApplications,
  saveProfile, getProfile, startScrapeRun, finishScrapeRun, getNewJobCount } = require('./src/db');
const { run: runScraper } = require('./src/runner');
const config = require('./config');

const app = express();
app.use(express.json());

initDb();

// ── Stats ────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => res.json(getStats()));

// ── Jobs ─────────────────────────────────────────────────────────────────────
app.get('/api/jobs', (req, res) => {
  const status = req.query.status || 'new';
  const limit = parseInt(req.query.limit, 10) || 100;
  const source = req.query.source || null;
  const minScore = req.query.minScore != null ? parseInt(req.query.minScore, 10) : null;
  const company = req.query.company || null;
  const region = req.query.region || null;
  const jobType = req.query.jobType || null;
  const sort = req.query.sort || 'score';
  const jobs = getJobs({ status, limit, source, minScore, sort });
  let filtered = jobs;
  if (company) {
    const c = company.toLowerCase();
    filtered = filtered.filter(j => (j.company || '').toLowerCase() === c);
  }
  if (region) {
    const REGION_KEYWORDS = {
      india: ['india','mumbai','delhi','bangalore','hyderabad','chennai','pune','kolkata','ahmedabad','kochi','bengaluru','blr','inr','₹'],
      usa: ['usa','us ','united states','new york','san francisco','austin','seattle','boston','chicago','denver','atlanta','dallas','miami','los angeles','usd'],
      europe: ['europe','uk ','london','berlin','paris','amsterdam','dublin','stockholm','oslo','helsinki','zurich','geneva','milan','madrid','barcelona','lisbon','eur','eu'],
      'asia-pacific': ['china','shanghai','beijing','shenzhen','hong kong','taiwan','singapore','sydney','melbourne','tokyo','osaka','seoul','manila','jakarta','kuala lumpur','thailand','vietnam','philippines','cny','sgd','aud','jpy']
    };
    const keywords = REGION_KEYWORDS[region] || [];
    filtered = filtered.filter(j => {
      const loc = (j.location || '').toLowerCase();
      const desc = (j.description || '').toLowerCase();
      return keywords.some(kw => loc.includes(kw) || desc.includes(kw));
    });
  }
  if (jobType === 'remote') {
    filtered = filtered.filter(j => j.remote || j.source === 'RemoteOK' || j.source === 'Remotive' || j.source === 'WeWorkRemotely');
  }
  res.json(filtered);
});

// ── Applications ─────────────────────────────────────────────────────────────
app.get('/api/applications', (req, res) => {
  const status = req.query.status || null;
  res.json(getApplications({ status }));
});

// ── Actions ──────────────────────────────────────────────────────────────────
app.post('/api/apply', (req, res) => {
  const { jobId, note } = req.body;
  updateApplication(jobId, 'applied', note);
  res.json({ success: true });
});

app.post('/api/skip', (req, res) => {
  const { jobId, note } = req.body;
  updateApplication(jobId, 'skipped', note);
  res.json({ success: true });
});

app.post('/api/save', (req, res) => {
  const { jobId, note } = req.body;
  updateApplication(jobId, 'saved', note);
  res.json({ success: true });
});

app.post('/api/ignore', (req, res) => {
  const { jobId, note } = req.body;
  updateApplication(jobId, 'ignored', note);
  res.json({ success: true });
});

// ── Profile ──────────────────────────────────────────────────────────────────
app.get('/api/profile', (req, res) => {
  const profile = getProfile() || {};
  res.json(profile);
});

app.put('/api/profile', (req, res) => {
  const profile = req.body;
  saveProfile(profile);
  // Also write to profile.json for backwards compat
  const profilePath = path.join(__dirname, 'profile.json');
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  res.json({ success: true });
});

// ── Scrape trigger ───────────────────────────────────────────────────────────
app.post('/api/scrape', async (req, res) => {
  res.json({ success: true, message: 'Scrape started in background' });
  try {
    await runScraper({ noAI: !config.anthropicKey, topN: config.topN, detailEnrich: config.detailEnrich });
  } catch (e) {
    console.error('Scrape failed:', e.message);
  }
});

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static('public'));

// ── Serve dashboard (fallback) ───────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(config.port, config.host, () => {
  console.log(`\n🚀 Job Agent dashboard running at http://localhost:${config.port}\n`);
  console.log(`   Dashboard: http://localhost:${config.port}`);
  console.log(`   API:       http://localhost:${config.port}/api/stats`);
  console.log(`   Run CLI:   node main.js --no-ai\n`);
});