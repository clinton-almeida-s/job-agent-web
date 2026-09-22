/**
 * Job Tracker — persists applied jobs to avoid duplicates
 * Uses a local JSON file in /data/applied.json
 */

const fs   = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'data', 'applied.json');

function load() {
  if (!fs.existsSync(STORE_PATH)) return { applied: [], seen: [] };
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return { applied: [], seen: [] };
  }
}

function save(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

/** Mark a job as seen (in today's report) */
function markSeen(jobId) {
  const store = load();
  if (!store.seen.includes(jobId)) store.seen.push(jobId);
  save(store);
}

/** Mark a job as applied (user confirmed they submitted) */
function markApplied(jobId, jobData) {
  const store = load();
  if (!store.applied.find(j => j.id === jobId)) {
    store.applied.push({ id: jobId, date: new Date().toISOString(), ...jobData });
  }
  save(store);
}

/** Filter out already-seen or applied jobs */
function filterNew(jobs) {
  const store = load();
  const usedIds = new Set([
    ...store.applied.map(j => j.id),
    ...store.seen,
  ]);
  return jobs.filter(j => !usedIds.has(j.id));
}

/** Get summary stats */
function stats() {
  const store = load();
  return {
    total_seen:    store.seen.length,
    total_applied: store.applied.length,
    last_applied:  store.applied.at(-1)?.date || 'never',
  };
}

module.exports = { markSeen, markApplied, filterNew, stats, load };
