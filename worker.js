/**
 * Cloudflare Worker — Job Agent
 * Runs the scraper on a daily cron and serves the dashboard API
 */

// Default boards — sync with data/boards.json manually or via config API
const DEFAULT_BOARDS = [
  'Cloudflare', 'Stripe', 'Datadog', 'Databricks', 'MongoDB', 'Elastic', 'Okta', 'Block',
  'Roku', 'Roblox', 'Pinterest', 'Coinbase', 'Robinhood', 'Brex', 'Dropbox', 'Asana',
  'Intercom', 'Mixpanel', 'Amplitude', 'Monzo', 'Chime', 'GoCardless', 'Fastly', 'Netlify',
  'Twilio', 'Lyft', 'Airbnb', 'Discord', 'Twitch', 'Reddit', 'Instacart',
  'Figma', 'Vercel', 'NewRelic', 'SumoLogic', 'PagerDuty',
  'Baidu', 'DiDi', 'Coupang', 'Mercari',
  'SpaceX', 'RocketLab', 'Relativity', 'BlackSky',
  'Engine', 'CFM', 'Alliance', 'Space', 'General',
  'Airtable', 'Amwell', 'Zocdoc', 'Coursera', 'Udemy', 'Duolingo', 'Kayak', 'BuzzFeed', 'Gemini',
  'Groww', 'TCS', 'IndiGo', 'Zenoti'
];

function getWorkerBoards(kv) {
  // Read boards from KV (updated via /api/config endpoint) or fall back to defaults
  return loadData(kv, 'boards_config').then(function(cfg) {
    return cfg.greenhouse && cfg.greenhouse.length > 0 ? cfg.greenhouse : DEFAULT_BOARDS;
  }).catch(function() {
    return DEFAULT_BOARDS;
  });
}

async function loadData(kv, key) {
  try {
    const data = await kv.get(key, 'json');
    return data || {};
  } catch { return {}; }
}

async function saveData(kv, key, data) {
  await kv.put(key, JSON.stringify(data));
}

// ── Scraper ──────────────────────────────────────────────────────────────────

async function fetchUrl(url, ua) {
  if (!ua) ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': ua } });
    return { status: resp.status, body: await resp.text() };
  } catch { return { status: 0, body: '' }; }
}

function cleanText(str) {
  if (!str) return '';
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncateDesc(str, maxLen) {
  if (!str) return '';
  return cleanText(str).slice(0, maxLen || 500);
}

function parseSalaryMin(salaryStr) {
  if (!salaryStr) return 0;
  const s = salaryStr.trim();
  const inrMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:LPA|L\s*PA|Lakhs?)/i);
  if (inrMatch) return parseFloat(inrMatch[1]) * 100000;
  const plainMatch = s.match(/(\d+)/);
  if (plainMatch) {
    const num = parseFloat(plainMatch[1]);
    if (num < 100) return num * 100000;
    return num;
  }
  return 0;
}

function parseRssXml(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const extract = function(tag) {
      const r = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\/' + tag + '>', 'i');
      const m = itemXml.match(r);
      if (!m) return '';
      let content = m[1].trim();
      if (content.startsWith('<![CDATA[')) {
        content = content.replace(/^<!\[CDATA\[(.*)\]\]>$/s, '$1');
      }
      return content;
    };
    const tags = {};
    for (const tag of ['title', 'link', 'description', 'pubDate', 'company', 'location', 'salary', 'tags']) {
      tags[tag] = extract(tag);
    }
    items.push(tags);
  }
  return items;
}

async function scrapeRemoteOK(kv) {
  const { status, body } = await fetchUrl('https://remoteok.com/api');
  if (status !== 200) return [];
  try {
    const jobs = JSON.parse(body).filter(function(j) { return j.position && j.position.length > 3; });
    return jobs.map(function(j) {
      return {
        id: 'remoteok-' + j.id, source: 'RemoteOK', title: j.position || '',
        company: j.company || '', location: 'Remote', remote: true,
        description: truncateDesc(j.description || '', 300),
        tags: (j.tags || []).join(', '), salary: j.salary || '',
        salary_min_inr: parseSalaryMin(j.salary || ''),
        url: j.url || 'https://remoteok.com/remote-jobs/' + j.slug,
        posted_at: j.date || new Date().toISOString(),
        score: 0, match_reasons: [], warnings: []
      };
    });
  } catch { return []; }
}

async function scrapeRemotive(keyword, kv) {
  const url = 'https://remotive.com/api/remote-jobs?search=' + encodeURIComponent(keyword) + '&limit=50';
  const { status, body } = await fetchUrl(url);
  if (status !== 200) return [];
  try {
    const parsed = JSON.parse(body);
    const jobs = parsed.jobs || [];
    return jobs.map(function(j) {
      return {
        id: 'remotive-' + j.id, source: 'Remotive',
        title: j.title || '', company: j.company_name || '',
        location: j.candidate_required_location || 'Remote', remote: true,
        description: truncateDesc(j.description || '', 300),
        tags: (j.tags || []).join(', '), salary: j.salary || '',
        salary_min_inr: parseSalaryMin(j.salary || ''),
        url: j.url || '', posted_at: j.publication_date || new Date().toISOString(),
        score: 0, match_reasons: [], warnings: []
      };
    });
  } catch { return []; }
}

async function scrapeWeWorkRemotely(kv) {
  const { status, body } = await fetchUrl('https://weworkremotely.com/remote-jobs.rss',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  if (status !== 200) return [];
  try {
    const items = parseRssXml(body);
    return items.map(function(item) {
      return {
        id: 'wwr-' + Buffer.from(item.link).toString('base64').slice(0, 12),
        source: 'WeWorkRemotely', title: item.title || '',
        company: item.company || item['wwr:company_name'] || '',
        location: 'Remote', remote: true,
        description: truncateDesc(item.description || '', 300),
        tags: '', salary: '', salary_min_inr: 0,
        url: item.link || '', posted_at: item.pubDate || new Date().toISOString(),
        score: 0, match_reasons: [], warnings: []
      };
    });
  } catch { return []; }
}

async function scrapeLinkedInRSS(keyword, kv) {
  const url = 'https://www.linkedin.com/jobs/search/?keywords=' + encodeURIComponent(keyword) + '&f_JT=F&sortBy=DD&format=rss';
  const { status, body } = await fetchUrl(url);
  if (status !== 200) return [];
  try {
    const items = parseRssXml(body);
    return items.slice(0, 30).map(function(item) {
      return {
        id: 'linkedin-rss-' + Buffer.from(item.link).toString('base64').slice(0, 12),
        source: 'LinkedIn', title: item.title || '', company: item.source || '',
        location: 'Remote', remote: true,
        description: truncateDesc(item.description || '', 300),
        tags: '', salary: '', salary_min_inr: 0,
        url: item.link || '', posted_at: item.pubDate || new Date().toISOString(),
        score: 0, match_reasons: [], warnings: []
      };
    });
  } catch { return []; }
}

// ── Free-to-apply sources (Greenhouse API - direct company careers) ────────────

async function scrapeGreenhouse(board, kv) {
  // Use content=false for speed — no description needed in Worker
  // Limit jobs per board to prevent exponential growth
  const url = 'https://boards-api.greenhouse.io/v1/boards/' + board + '/jobs?content=false&limit=15';
  const { status, body } = await fetchUrl(url);
  if (status !== 200) return [];
  try {
    const parsed = JSON.parse(body);
    const jobs = parsed.jobs || [];
    return jobs
      .filter(function(j) { return j.title && j.title.length > 3; })
      .map(function(j) {
        const location = j.location?.name || 'Remote';
        const isRemote = location.toLowerCase().includes('remote');
        return {
          id: 'greenhouse-' + board + '-' + j.id,
          source: 'Greenhouse:' + board,
          title: j.title || '',
          company: board,
          location: location,
          remote: isRemote,
          description: '',
          tags: (j.departments || []).join(', '),
          salary: '',
          salary_min_inr: 0,
          url: j.absolute_url || '',
          posted_at: j.updated_at || new Date().toISOString(),
          score: 0, match_reasons: [], warnings: []
        };
      });
  } catch { return []; }
}

async function scrapeGreenhouseFiltered(keyword, kv) {
  // Worker uses a subset of boards to avoid CPU timeout (20 of 45 total)
  const workerBoards = [
    'Cloudflare', 'Stripe', 'Datadog', 'Databricks', 'MongoDB', 'Elastic', 'Okta', 'Block',
    'Roku', 'Roblox', 'Pinterest', 'Coinbase', 'Robinhood', 'Brex', 'Dropbox', 'Asana',
    'Intercom', 'Figma', 'Vercel', 'Coupang'
  ];
  const boards = workerBoards;
  const batches = [];
  for (let i = 0; i < boards.length; i += 8) {
    batches.push(boards.slice(i, i + 8));
  }
  const allResults = [];
  for (const batch of batches) {
    const batchResults = await Promise.allSettled(
      batch.map(function(board) { return scrapeGreenhouse(board, kv); })
    );
    allResults.push(...batchResults);
  }
  return allResults
    .filter(function(r) { return r.status === 'fulfilled'; })
    .flatMap(function(r) { return r.value.filter(Boolean); });
}

async function scrapeLever(board, kv) {
  const url = 'https://lever.co/' + board + '/feed.xml';
  const { status, body } = await fetchUrl(url);
  if (status !== 200 && status !== 308) return [];
  try {
    const items = parseRssXml(body);
    return items.map(function(item) {
      return {
        id: 'lever-' + board + '-' + Buffer.from(item.link).toString('base64').slice(0, 12),
        source: 'Lever:' + board,
        title: item.title || '',
        company: board,
        location: item.location || 'Remote',
        remote: (item.location || '').toLowerCase().includes('remote'),
        description: truncateDesc(item.description || '', 300),
        tags: '', salary: '', salary_min_inr: 0,
        url: item.link || '', posted_at: item.pubDate || new Date().toISOString(),
        score: 0, match_reasons: [], warnings: []
      };
    });
  } catch { return []; }
}

async function scrapeLeverFiltered(keyword, kv) {
  const boards = ['airbnb', 'uber', 'spotify', 'shopify', 'coinbase', 'discord', 'slack', 'netflix'];
  const allResults = await Promise.allSettled(
    boards.map(function(board) { return scrapeLever(board, kv); })
  );
  return allResults
    .filter(function(r) { return r.status === 'fulfilled'; })
    .flatMap(function(r) { return r.value.filter(Boolean); });
}

async function scrapeAllSources(profile, kv) {
  const keywords = profile.required_keywords || ['GCP', 'Cloud'];
  const keyword = keywords[0];

  const results = await Promise.allSettled([
    scrapeLinkedInRSS(keyword, kv),
    // Free-to-apply sources (direct company APIs - no paywall)
    scrapeGreenhouseFiltered(keyword, kv),
  ]);

  const all = results
    .filter(function(r) { return r.status === 'fulfilled'; })
    .flatMap(function(r) { return r.value.filter(Boolean); });

  // Deduplicate by URL
  const seen = new Set();
  return all.filter(function(job) {
    const key = job.url || job.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Matcher ──────────────────────────────────────────────────────────────────

function normalize(str) {
  if (Array.isArray(str)) str = str.join(' ');
  return String(str || '').toLowerCase().replace(/[^\w\s]/g, ' ');
}

function containsAny(text, keywords, loose) {
  if (loose === undefined) loose = false;
  const t = normalize(text);
  return keywords.filter(function(kw) {
    const n = normalize(kw);
    if (loose) return t.includes(n);
    const regex = new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    return regex.test(t);
  });
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: b.length + 1 }, function(_, i) { return [i]; });
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(matrix[j][i - 1] + 1, matrix[j - 1][i] + 1, matrix[j - 1][i - 1] + cost);
    }
  }
  return matrix[b.length][a.length];
}

function titleSimilarity(title, targets) {
  const t = normalize(title);
  let maxScore = 0;
  for (const target of targets) {
    const targetNorm = normalize(target);
    const tWords = new Set(t.split(/\s+/));
    const targetWords = new Set(targetNorm.split(/\s+/));
    const intersection = [...tWords].filter(function(w) { return targetWords.has(w); }).length;
    const union = new Set([...tWords, ...targetWords]).size;
    const jaccard = union > 0 ? intersection / union : 0;
    const tFirst = t.split(/\s+/)[0] || '';
    const tgtFirst = targetNorm.split(/\s+/)[0] || '';
    const maxLen = Math.max(tFirst.length, tgtFirst.length);
    const levRatio = maxLen > 0 ? 1 - levenshtein(tFirst, tgtFirst) / maxLen : 0;
    maxScore = Math.max(maxScore, jaccard * 0.6 + levRatio * 0.4);
  }
  return maxScore;
}

function isRecent(dateStr) {
  if (!dateStr) return false;
  const diffDays = (Date.now() - new Date(dateStr).getTime()) / 86400000;
  return diffDays <= 7;
}

function isTechnicalTitle(title) {
  return containsAny(title, ['engineer', 'architect', 'developer', 'technical', 'consultant', 'lead', 'manager'], true).length > 0;
}

function scoreJob(job, profile) {
  const fullText = [job.title, job.description, job.tags, job.company, job.location].join(' ');
  let score = 0;
  const reasons = [];
  const warnings = [];

  const target_titles = profile.target_titles || [];
  const required_keywords = profile.required_keywords || [];
  const deal_breakers = profile.deal_breakers || [];
  const min_salary = (profile.target_salary && profile.target_salary.min_lakhs) ? profile.target_salary.min_lakhs * 100000 : 3500000;

  // ── Deal-breakers ──────────────────────────────────────────────────────────
  // Check title, company, AND the first 500 chars of description — many
  // irrelevant roles mention their product is "cloud-based" in the blurb.
  const textForDealBreakers = [job.title, job.company, (job.description || '').slice(0, 500)].join(' ');
  const breakers = containsAny(textForDealBreakers, deal_breakers, true);
  const softBreakers = ['sales', 'marketing', 'business development', 'customer service', 'customer success'];
  const hardBlockers = breakers.filter(function(b) { return softBreakers.indexOf(b) === -1; });
  if (hardBlockers.length > 0) return Object.assign({}, job, { score: -999, match_reasons: [], warnings: ['Deal-breaker: ' + hardBlockers.join(', ')] });
  if (breakers.length > 0 && !isTechnicalTitle(job.title)) {
    return Object.assign({}, job, { score: -999, match_reasons: [], warnings: ['Deal-breaker: ' + breakers.join(', ')] });
  }
  // Hard blockers for sales engineer roles
  const salesEngineerBlocks = containsAny(normalize(job.title), ['sales engineer', 'pre-sales', 'presales', 'technical sales'], true);
  if (salesEngineerBlocks.length > 0) {
    return Object.assign({}, job, { score: -999, match_reasons: [], warnings: ['Deal-breaker: ' + salesEngineerBlocks.join(', ')] });
  }

  // ── Title match ────────────────────────────────────────────────────────────
  const titleMatch = containsAny(job.title, target_titles, false);
  let hasTitleSignal = false;

  if (titleMatch.length > 0) {
    score += 40;
    reasons.push('Title match: "' + titleMatch[0] + '"');
    hasTitleSignal = true;
  } else {
    const simScore = titleSimilarity(job.title, target_titles);
    if (simScore > 0.3) {
      score += Math.round(25 * simScore);
      reasons.push('Title similarity: ' + Math.round(simScore * 100) + '%');
      hasTitleSignal = true;
    }
  }

  // ── Required skills ────────────────────────────────────────────────────────
  const reqMatches = containsAny(fullText, required_keywords, false);
  // Cap at 3 keywords — beyond that, marginal mentions shouldn't dominate the score
  const reqScore = Math.min(reqMatches.length, 3) * 8;
  score += reqScore;
  if (reqMatches.length > 0) reasons.push('Required skills: ' + reqMatches.slice(0, 4).join(', '));

  // ── Bonus skills ───────────────────────────────────────────────────────────
  const bonusMatches = containsAny(fullText, profile.bonus_keywords || [], false);
  const bonusScore = Math.min(bonusMatches.length, 5) * 5;
  score += bonusScore;
  if (bonusMatches.length > 0) reasons.push('Bonus skills: ' + bonusMatches.slice(0, 3).join(', '));

  // ── Relevance gate ─────────────────────────────────────────────────────────
  // A job must have at least a partial title match OR mention 2+ required
  // keywords. Otherwise it's almost certainly irrelevant.
  if (!hasTitleSignal && reqMatches.length < 2) {
    return Object.assign({}, job, { score: -999, match_reasons: [], warnings: ['No title or keyword signal — likely irrelevant'] });
  }

  // ── Remote/hybrid/location ─────────────────────────────────────────────────
  const isRemote = job.remote || normalize(job.location).includes('remote');
  const isHybrid = normalize(job.location).includes('hybrid');
  const isMumbai = containsAny(job.location + ' ' + fullText, ['mumbai'], true).length > 0;

  if (isRemote) { score += 10; reasons.push('Remote'); }
  else if (isHybrid && isMumbai) { score += 8; reasons.push('Hybrid in Mumbai'); }
  else if (isMumbai) { score += 5; reasons.push('Location: Mumbai'); }

  // ── Salary ─────────────────────────────────────────────────────────────────
  if (job.salary_min_inr >= min_salary) { score += 10; reasons.push('Salary: ' + job.salary); }
  else if (job.salary_min_inr > 0) {
    return Object.assign({}, job, { score: -999, match_reasons: [], warnings: ['Salary below threshold: ' + job.salary] });
  }

  // ── Recency ────────────────────────────────────────────────────────────────
  if (isRecent(job.posted_at)) { score += 10; reasons.push('Recency'); }

  return Object.assign({}, job, { score: score, match_reasons: reasons, warnings: warnings, status: job.status || 'new' });
}

// ── Scrape runner ───────────────────────────────────────────────────────────

async function runScrape(env) {
  const profile = await loadData(env.JOBS_KV, 'profile');
  if (!profile.name) return { error: 'No profile found. Set up your profile first via the dashboard.' };

  const savedJobs = await loadData(env.JOBS_KV, 'jobs');
  const jobList = savedJobs.jobs || [];

  const newJobs = await scrapeAllSources(profile, env.JOBS_KV);
  console.log('Scraped ' + newJobs.length + ' new jobs');

  // Build set of existing IDs to avoid duplicating already-tracked jobs
  const existingIds = new Set(jobList.map(function(j) { return j.id; }));
  const freshJobs = newJobs.filter(function(j) { return !existingIds.has(j.id); });
  console.log('Fresh jobs (not in KV): ' + freshJobs.length + ' / duplicates skipped: ' + (newJobs.length - freshJobs.length));

  const allJobs = jobList.concat(freshJobs);
  // Deduplicate by title+company (normalized) to reduce noise from same job on multiple sources
  const seenKeys = new Set();
  const uniqueJobs = allJobs.filter(function(j) {
    const key = ((j.title || '').toLowerCase().trim() + '|' + (j.company || '').toLowerCase().trim());
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  console.log('Dedup: ' + allJobs.length + ' -> ' + uniqueJobs.length + ' (removed ' + (allJobs.length - uniqueJobs.length) + ')');

  const ranked = uniqueJobs.map(function(j) {
    const scored = scoreJob(j, profile);
    // Preserve user-applied status across re-scrapes; only genuinely new
    // jobs get marked 'new'. Otherwise every scrape would wipe out
    // saved/applied/skipped/ignored state.
    const existing = jobList.find(function(e) { return e.id === j.id; });
    if (existing && existing.status && existing.status !== 'new') {
      scored.status = existing.status;
    }
    return scored;
  }).sort(function(a, b) { return b.score - a.score; });

  await saveData(env.JOBS_KV, 'jobs', { jobs: ranked });

  const runStats = await loadData(env.JOBS_KV, 'scrape_runs');
  const matched = ranked.filter(function(j) { return j.score >= 35; }).length;
  runStats.lastRun = {
    fetched: newJobs.length,
    total: ranked.length,
    matched: matched,
    at: new Date().toISOString()
  };
  await saveData(env.JOBS_KV, 'scrape_runs', runStats);

  return { success: true, fetched: newJobs.length, total: ranked.length, matched: matched };
}

// ── Request handler ─────────────────────────────────────────────────────────

async function handleRequest(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        'Cache-Control': 'no-store'
      }
    });
  }

  if (path === '/api/stats' && req.method === 'GET') {
    const jobs = await loadData(env.JOBS_KV, 'jobs');
    const runs = await loadData(env.JOBS_KV, 'scrape_runs');
    const profile = await loadData(env.JOBS_KV, 'profile');
    const total = (jobs.jobs || []).length;
    const newJobs = (jobs.jobs || []).filter(function(j) { return j.status === 'new'; }).length;
    const applied = (jobs.jobs || []).filter(function(j) { return j.status === 'applied'; }).length;
    const skipped = (jobs.jobs || []).filter(function(j) { return j.status === 'skipped'; }).length;
    const saved = (jobs.jobs || []).filter(function(j) { return j.status === 'saved'; }).length;
    return new Response(JSON.stringify({
      total_jobs: total, new_jobs: newJobs, applied_jobs: applied,
      skipped_jobs: skipped, saved_jobs: saved,
      last_run: runs.lastRun || null, profile_name: profile.name || 'Not set'
    }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  if (path === '/api/jobs' && req.method === 'GET') {
    const jobs = await loadData(env.JOBS_KV, 'jobs');
    const allJobs = jobs.jobs || [];
    const status = url.searchParams.get('status') || 'new';
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const company = url.searchParams.get('company');
    const region = url.searchParams.get('region');
    const jobType = url.searchParams.get('jobType');
    let filtered;
    if (status === 'all') {
      filtered = allJobs;
    } else {
      filtered = allJobs.filter(function(j) { return j.status === status; });
    }
    if (company) {
      const c = company.toLowerCase();
      filtered = filtered.filter(function(j) {
        return (j.company || '').toLowerCase() === c;
      });
    }
    if (region) {
      const REGION_KEYWORDS = {
        india: ['india', 'mumbai', 'delhi', 'bangalore', 'hyderabad', 'chennai', 'pune', 'kolkata', 'ahmedabad', 'kochi', 'bengaluru', 'blr', 'inr', '₹'],
        usa: ['usa', 'us ', 'united states', 'new york', 'san francisco', 'austin', 'seattle', 'boston', 'chicago', 'denver', 'atlanta', 'dallas', 'miami', 'los angeles', 'usd'],
        europe: ['europe', 'uk ', 'london', 'berlin', 'paris', 'amsterdam', 'dublin', 'stockholm', 'oslo', 'helsinki', 'zurich', 'geneva', 'milan', 'madrid', 'barcelona', 'lisbon', 'eur', 'eu'],
        'asia-pacific': ['china', 'shanghai', 'beijing', 'shenzhen', 'hong kong', 'taiwan', 'singapore', 'sydney', 'melbourne', 'tokyo', 'osaka', 'seoul', 'manila', 'jakarta', 'kuala lumpur', 'thailand', 'vietnam', 'philippines', 'cny', 'sgd', 'aud', 'jpy']
      };
      const keywords = REGION_KEYWORDS[region] || [];
      filtered = filtered.filter(function(j) {
        const loc = (j.location || '').toLowerCase();
        const full = (j.location || ' ' + j.description || '').toLowerCase();
        return keywords.some(function(kw) { return full.includes(kw); });
      });
    }
    if (jobType && jobType === 'remote') {
      filtered = filtered.filter(function(j) { return j.remote || j.source === 'RemoteOK' || j.source === 'Remotive' || j.source === 'WeWorkRemotely'; });
    }
    const sortBy = url.searchParams.get('sort') || 'score';
    if (sortBy === 'score') {
      filtered.sort(function(a, b) { return (b.score || 0) - (a.score || 0); });
    } else if (sortBy === 'posted') {
      filtered.sort(function(a, b) { return new Date(b.posted_at || 0) - new Date(a.posted_at || 0); });
    }
    filtered = filtered.slice(0, limit);
    return new Response(JSON.stringify(filtered), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  if (path === '/api/profile' && req.method === 'GET') {
    const profile = await loadData(env.JOBS_KV, 'profile');
    return new Response(JSON.stringify(profile), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  if (path === '/api/profile' && req.method === 'PUT') {
    const profile = await req.json();
    await saveData(env.JOBS_KV, 'profile', profile);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  if (path === '/api/apply' && req.method === 'POST') {
    const body = await req.json();
    const jobId = body.jobId;
    const jobs = await loadData(env.JOBS_KV, 'jobs');
    const jobList = jobs.jobs || [];
    const idx = jobList.findIndex(function(j) { return j.id === jobId; });
    if (idx >= 0) { jobList[idx].status = 'applied'; await saveData(env.JOBS_KV, 'jobs', { jobs: jobList }); }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  if (path === '/api/skip' && req.method === 'POST') {
    const body = await req.json();
    const jobId = body.jobId;
    const jobs = await loadData(env.JOBS_KV, 'jobs');
    const jobList = jobs.jobs || [];
    const idx = jobList.findIndex(function(j) { return j.id === jobId; });
    if (idx >= 0) {
      jobList[idx].status = 'skipped';
      if (body.title) {
        var words = body.title.toLowerCase().split(/\s+/).filter(function(w){ return w.length >= 4; });
        var stop = ['the','and','for','with','this','that','from','your','what','when','where','which','their','there','about','these','those','after','before','other','between','through','during','below','above','under','over','just','will','each','such','than','into','has','had','have','does','done','may','can','shall','not','been','being'];
        var unique = words.filter(function(w){ return stop.indexOf(w) < 0; });
        var profile = await loadData(env.JOBS_KV, 'profile') || {};
        var existing = profile.skip_keywords || [];
        unique.forEach(function(kw){ if(existing.indexOf(kw) < 0) existing.push(kw); });
        profile.skip_keywords = existing.slice(-50);
        await saveData(env.JOBS_KV, 'profile', profile);
      }
      await saveData(env.JOBS_KV, 'jobs', { jobs: jobList });
    }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  if (path === '/api/save' && req.method === 'POST') {
    const body = await req.json();
    const jobId = body.jobId;
    const jobs = await loadData(env.JOBS_KV, 'jobs');
    const jobList = jobs.jobs || [];
    const idx = jobList.findIndex(function(j) { return j.id === jobId; });
    if (idx >= 0) { jobList[idx].status = 'saved'; await saveData(env.JOBS_KV, 'jobs', { jobs: jobList }); }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  if (path === '/api/ignore' && req.method === 'POST') {
    const body = await req.json();
    const jobId = body.jobId;
    const jobs = await loadData(env.JOBS_KV, 'jobs');
    const jobList = jobs.jobs || [];
    const idx = jobList.findIndex(function(j) { return j.id === jobId; });
    if (idx >= 0) { jobList[idx].status = 'ignored'; await saveData(env.JOBS_KV, 'jobs', { jobs: jobList }); }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  if (path === '/api/new' && req.method === 'POST') {
    const body = await req.json();
    const jobId = body.jobId;
    const jobs = await loadData(env.JOBS_KV, 'jobs');
    const jobList = jobs.jobs || [];
    const idx = jobList.findIndex(function(j) { return j.id === jobId; });
    if (idx >= 0) { jobList[idx].status = 'new'; await saveData(env.JOBS_KV, 'jobs', { jobs: jobList }); }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  if (path === '/api/scrape' && req.method === 'POST') {
    const result = await runScrape(env);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  // Update boards configuration
  if (path === '/api/config' && req.method === 'POST') {
    const body = await req.json();
    const cfg = {
      greenhouse: body.greenhouse || DEFAULT_BOARDS,
      lever: body.lever || [],
      worker_limit: body.worker_limit || Math.min(20, (body.greenhouse || DEFAULT_BOARDS).length)
    };
    await saveData(env.JOBS_KV, 'boards_config', cfg);
    return new Response(JSON.stringify({ success: true, message: 'Boards config updated' }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  // Read boards configuration
  if (path === '/api/config' && req.method === 'GET') {
    const cfg = await loadData(env.JOBS_KV, 'boards_config');
    return new Response(JSON.stringify(cfg), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  // Serve static assets
  if (path === '/styles.css') {
    return new Response(getStylesCss(), { headers: { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' } });
  }
  if (path === '/app.js') {
    return new Response(getAppJs(), { headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' } });
  }

  // API endpoint not found - return 404 JSON
  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Not found', path: path }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
  
  // Serve dashboard HTML for SPA fallback
  return new Response(getDashboardHtml(Date.now(), "fba5ba22"), {
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }
  });
}

function getStylesCss() {
  const b = atob(STYLES_CSS_B64);
  const bytes = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function getAppJs() {
  const b = atob(APP_JS_B64);
  const bytes = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Dashboard HTML (base64 encoded to avoid require issues)
const STYLES_CSS_B64 = 'LyogSm9iIEFnZW50IERhc2hib2FyZCBTdHlsZXMgKi8NCjpyb290IHsNCiAgLS1iZzogIzBmMTcyYTsgLS1zdXJmYWNlOiAjMWUyOTNiOyAtLXN1cmZhY2UyOiAjMzM0MTU1Ow0KICAtLWJvcmRlcjogIzMzNDE1NTsgLS10ZXh0OiAjZjFmNWY5OyAtLW11dGVkOiAjOTRhM2I4OyAtLWFjY2VudDogIzYwYTVmYTsNCiAgLS1ncmVlbjogIzRhZGU4MDsgLS1hbWJlcjogI2ZiYmYyNDsgLS1yZWQ6ICNmODcxNzE7DQp9DQoqIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9DQpib2R5IHsgZm9udC1mYW1pbHk6IC1hcHBsZS1zeXN0ZW0sIEJsaW5rTWFjU3lzdGVtRm9udCwgJ1NlZ29lIFVJJywgc2Fucy1zZXJpZjsgYmFja2dyb3VuZDogdmFyKC0tYmcpOyBjb2xvcjogdmFyKC0tdGV4dCk7IG1pbi1oZWlnaHQ6IDEwMHZoOyB9DQoNCi8qIFRvcGJhciAqLw0KLnRvcGJhciB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgcGFkZGluZzogMXJlbSAxLjVyZW07IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgfQ0KLmJyYW5kIGgxIHsgZm9udC1zaXplOiAxLjJyZW07IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9DQouYnJhbmQgLnN1YiB7IGZvbnQtc2l6ZTogLjhyZW07IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0NCi5hY3Rpb25zIHsgZGlzcGxheTogZmxleDsgZ2FwOiAuNXJlbTsgfQ0KDQovKiBCdXR0b25zICovDQouYnRuLXByaW1hcnkgeyBiYWNrZ3JvdW5kOiAjMjU2M2ViOyBjb2xvcjogd2hpdGU7IGJvcmRlcjogbm9uZTsgcGFkZGluZzogLjVyZW0gMXJlbTsgYm9yZGVyLXJhZGl1czogOHB4OyBjdXJzb3I6IHBvaW50ZXI7IGZvbnQtc2l6ZTogLjg3NXJlbTsgZm9udC13ZWlnaHQ6IDUwMDsgfQ0KLmJ0bi1wcmltYXJ5OmhvdmVyIHsgYmFja2dyb3VuZDogIzFkNGVkODsgfQ0KLmJ0bi1naG9zdCB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UyKTsgY29sb3I6IHZhcigtLXRleHQpOyBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyBwYWRkaW5nOiAuNXJlbSAxcmVtOyBib3JkZXItcmFkaXVzOiA4cHg7IGN1cnNvcjogcG9pbnRlcjsgZm9udC1zaXplOiAuODc1cmVtOyB9DQouYnRuLWdob3N0OmhvdmVyIHsgYmFja2dyb3VuZDogIzQ3NTU2OTsgfQ0KLmJ0bi1zdWNjZXNzIHsgYmFja2dyb3VuZDogIzE2YTM0YTsgY29sb3I6IHdoaXRlOyBib3JkZXI6IG5vbmU7IHBhZGRpbmc6IC41cmVtIDFyZW07IGJvcmRlci1yYWRpdXM6IDhweDsgY3Vyc29yOiBwb2ludGVyOyBmb250LXNpemU6IC44NzVyZW07IH0NCi5idG4tZGFuZ2VyIHsgYmFja2dyb3VuZDogI2RjMjYyNjsgY29sb3I6IHdoaXRlOyBib3JkZXI6IG5vbmU7IHBhZGRpbmc6IC41cmVtIDFyZW07IGJvcmRlci1yYWRpdXM6IDhweDsgY3Vyc29yOiBwb2ludGVyOyBmb250LXNpemU6IC44NzVyZW07IH0NCi5idG4tc2Vjb25kYXJ5IHsgYmFja2dyb3VuZDogIzQ3NTU2OTsgY29sb3I6IHdoaXRlOyBib3JkZXI6IG5vbmU7IHBhZGRpbmc6IC41cmVtIDFyZW07IGJvcmRlci1yYWRpdXM6IDhweDsgY3Vyc29yOiBwb2ludGVyOyBmb250LXNpemU6IC44NzVyZW07IH0NCi5idG4tc2Vjb25kYXJ5OmhvdmVyIHsgYmFja2dyb3VuZDogIzMzNDE1NTsgfQ0KDQovKiBTdGF0cyBiYXIgKi8NCi5zdGF0cyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogMXJlbTsgcGFkZGluZzogMXJlbSAxLjVyZW07IGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyBmbGV4LXdyYXA6IHdyYXA7IH0NCi5zdGF0IHsgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IGJvcmRlci1yYWRpdXM6IDhweDsgcGFkZGluZzogLjVyZW0gMXJlbTsgZm9udC1zaXplOiAuODVyZW07IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGFsaWduLWl0ZW1zOiBjZW50ZXI7IG1pbi13aWR0aDogOTBweDsgfQ0KLnN0YXQgYiB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyBmb250LXNpemU6IDEuMnJlbTsgfQ0KLnN0YXQgc3BhbiB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IGZvbnQtc2l6ZTogLjc1cmVtOyB9DQoNCi8qIFRvb2xiYXIgKi8NCi50b29sYmFyIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOyBwYWRkaW5nOiAuNzVyZW0gMS41cmVtOyBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgZmxleC13cmFwOiB3cmFwOyBnYXA6IC41cmVtOyB9DQouZmlsdGVycyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogLjVyZW07IGZsZXgtd3JhcDogd3JhcDsgfQ0KLmZpbHRlcnMgc2VsZWN0LCAuZmlsdGVycyBpbnB1dCB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBjb2xvcjogdmFyKC0tdGV4dCk7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IHBhZGRpbmc6IC40cmVtIC43NXJlbTsgYm9yZGVyLXJhZGl1czogNnB4OyBmb250LXNpemU6IC44NXJlbTsgfQ0KLmZpbHRlcnMgaW5wdXQgeyBtaW4td2lkdGg6IDIwMHB4OyB9DQouYnVsay1hY3Rpb25zIHsgZGlzcGxheTogZmxleDsgZ2FwOiAuNXJlbTsgfQ0KDQovKiBKb2IgUXVldWUgKi8NCi5xdWV1ZSB7IHBhZGRpbmc6IDFyZW0gMS41cmVtOyBtYXgtd2lkdGg6IDEyMDBweDsgfQ0KLmpvYi1jYXJkIHsgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IGJvcmRlci1yYWRpdXM6IDEycHg7IG1hcmdpbi1ib3R0b206IDFyZW07IG92ZXJmbG93OiBoaWRkZW47IH0NCi5qb2ItaGVhZGVyIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGZsZXgtc3RhcnQ7IGdhcDogMXJlbTsgcGFkZGluZzogMXJlbTsgYmFja2dyb3VuZDogIzE2MjAzMjsgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IH0NCi5qb2ItcmFuayB7IGZvbnQtc2l6ZTogMS4ycmVtOyBmb250LXdlaWdodDogNzAwOyBjb2xvcjogdmFyKC0tYWNjZW50KTsgbWluLXdpZHRoOiAycmVtOyB9DQouam9iLXRpdGxlLWJsb2NrIHsgZmxleDogMTsgfQ0KLmpvYi10aXRsZS1ibG9jayBoMiB7IGZvbnQtc2l6ZTogMXJlbTsgY29sb3I6IHZhcigtLXRleHQpOyB9DQouam9iLW1ldGEgeyBmb250LXNpemU6IC44NXJlbTsgY29sb3I6IHZhcigtLW11dGVkKTsgbWFyZ2luLXRvcDogLjI1cmVtOyB9DQouYmFkZ2VzIHsgZGlzcGxheTogZmxleDsgZ2FwOiAuNHJlbTsgZmxleC13cmFwOiB3cmFwOyBtYXJnaW4tdG9wOiAuNXJlbTsgfQ0KLmJhZGdlIHsgZm9udC1zaXplOiAuN3JlbTsgcGFkZGluZzogMnB4IDhweDsgYm9yZGVyLXJhZGl1czogMTJweDsgZm9udC13ZWlnaHQ6IDUwMDsgfQ0KLmJhZGdlLnNvdXJjZSB7IGJhY2tncm91bmQ6ICMxZTNhNWY7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9DQouYmFkZ2UucmVtb3RlIHsgYmFja2dyb3VuZDogIzE0NTMyZDsgY29sb3I6IHZhcigtLWdyZWVuKTsgfQ0KLmJhZGdlLnNhbGFyeSB7IGJhY2tncm91bmQ6ICM0MjIwMDY7IGNvbG9yOiB2YXIoLS1hbWJlcik7IH0NCi5zY29yZS1iYXItd3JhcCB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGFsaWduLWl0ZW1zOiBmbGV4LWVuZDsgZ2FwOiA0cHg7IG1pbi13aWR0aDogMTAwcHg7IH0NCi5zY29yZS1iYXItd3JhcCBzcGFuIHsgZm9udC1zaXplOiAuNzVyZW07IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0NCi5zY29yZS1iYXIgeyBoZWlnaHQ6IDZweDsgYm9yZGVyLXJhZGl1czogM3B4OyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlMik7IHdpZHRoOiAxMDAlOyB9DQouc2NvcmUtZmlsbCB7IGhlaWdodDogMTAwJTsgYm9yZGVyLXJhZGl1czogM3B4OyBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOyB9DQoNCi5qb2ItYm9keSB7IHBhZGRpbmc6IDFyZW07IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogLjc1cmVtOyB9DQoucmVhc29ucyBoNCwgLmRlc2MgaDQgeyBmb250LXNpemU6IC43NXJlbTsgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsgY29sb3I6IHZhcigtLW11dGVkKTsgbGV0dGVyLXNwYWNpbmc6IC4wNWVtOyBtYXJnaW4tYm90dG9tOiAuNXJlbTsgfQ0KLnJlYXNvbnMgdWwgeyBsaXN0LXN0eWxlOiBub25lOyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IDRweDsgfQ0KLnJlYXNvbnMgbGkgeyBmb250LXNpemU6IC44NXJlbTsgY29sb3I6IHZhcigtLXRleHQpOyB9DQoucmVhc29ucyBsaS53YXJuIHsgY29sb3I6IHZhcigtLWFtYmVyKTsgfQ0KLmRlc2MgcCB7IGZvbnQtc2l6ZTogLjg1cmVtOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBsaW5lLWhlaWdodDogMS42OyB9DQouY2wtYm94IHsgYmFja2dyb3VuZDogdmFyKC0tYmcpOyBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyBib3JkZXItcmFkaXVzOiA4cHg7IHBhZGRpbmc6IC43NXJlbTsgZm9udC1zaXplOiAuODVyZW07IGNvbG9yOiB2YXIoLS10ZXh0KTsgd2hpdGUtc3BhY2U6IHByZS13cmFwOyBsaW5lLWhlaWdodDogMS42OyB9DQouY2wtYm94IGJ1dHRvbiB7IG1hcmdpbi10b3A6IC41cmVtOyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlMik7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyBwYWRkaW5nOiAuM3JlbSAuNzVyZW07IGJvcmRlci1yYWRpdXM6IDZweDsgY3Vyc29yOiBwb2ludGVyOyBmb250LXNpemU6IC44cmVtOyB9DQouYWN0aW9ucyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogLjc1cmVtOyBmbGV4LXdyYXA6IHdyYXA7IHBhZGRpbmctdG9wOiAuNXJlbTsgYm9yZGVyLXRvcDogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IH0NCi5hY3Rpb25zIGEgeyBiYWNrZ3JvdW5kOiAjMjU2M2ViOyBjb2xvcjogd2hpdGU7IHBhZGRpbmc6IC41cmVtIDFyZW07IGJvcmRlci1yYWRpdXM6IDhweDsgZm9udC1zaXplOiAuODc1cmVtOyBmb250LXdlaWdodDogNTAwOyB0ZXh0LWRlY29yYXRpb246IG5vbmU7IGRpc3BsYXk6IGlubGluZS1mbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyB9DQouYWN0aW9ucyBidXR0b24geyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlMik7IGNvbG9yOiB2YXIoLS10ZXh0KTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgcGFkZGluZzogLjVyZW0gMXJlbTsgYm9yZGVyLXJhZGl1czogOHB4OyBjdXJzb3I6IHBvaW50ZXI7IGZvbnQtc2l6ZTogLjhyZW07IH0NCi5hY3Rpb25zIGJ1dHRvbjpob3ZlciB7IGJhY2tncm91bmQ6ICM0NzU1Njk7IH0NCi5zdGF0dXMtYmFkZ2UgeyBkaXNwbGF5OiBpbmxpbmUtYmxvY2s7IGZvbnQtc2l6ZTogLjdyZW07IHBhZGRpbmc6IDJweCA4cHg7IGJvcmRlci1yYWRpdXM6IDEycHg7IG1hcmdpbi1sZWZ0OiAuNXJlbTsgfQ0KLnN0YXR1cy1uZXcgeyBiYWNrZ3JvdW5kOiAjMWUzYTVmOyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQ0KLnN0YXR1cy1zYXZlZCB7IGJhY2tncm91bmQ6ICM0MjIwMDY7IGNvbG9yOiB2YXIoLS1hbWJlcik7IH0NCi5zdGF0dXMtYXBwbGllZCB7IGJhY2tncm91bmQ6ICMxNDUzMmQ7IGNvbG9yOiB2YXIoLS1ncmVlbik7IH0NCi5zdGF0dXMtc2tpcHBlZCB7IGJhY2tncm91bmQ6ICM0NTBhMGE7IGNvbG9yOiB2YXIoLS1yZWQpOyB9DQouc3RhdHVzLWlnbm9yZWQgeyBiYWNrZ3JvdW5kOiAjMWMxOTE3OyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB9DQoNCi8qIEVtcHR5IHN0YXRlICovDQouZW1wdHktc3RhdGUgeyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB0ZXh0LWFsaWduOiBjZW50ZXI7IHBhZGRpbmc6IDNyZW07IGZvbnQtc2l6ZTogLjlyZW07IH0NCg0KLyogTW9kYWwgKi8NCi5tb2RhbCB7IHBvc2l0aW9uOiBmaXhlZDsgaW5zZXQ6IDA7IGJhY2tncm91bmQ6IHJnYmEoMCwwLDAsLjYpOyB6LWluZGV4OiAxMDA7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogY2VudGVyOyB9DQoubW9kYWwtY29udGVudCB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyBib3JkZXItcmFkaXVzOiAxMnB4OyB3aWR0aDogOTAlOyBtYXgtd2lkdGg6IDYwMHB4OyBtYXgtaGVpZ2h0OiA5MHZoOyBvdmVyZmxvdy15OiBhdXRvOyB9DQoubW9kYWwtaGVhZGVyIHsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOyBwYWRkaW5nOiAxcmVtIDEuNXJlbTsgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IH0NCi5tb2RhbC1oZWFkZXIgaDIgeyBmb250LXNpemU6IDEuMXJlbTsgfQ0KLm1vZGFsLWhlYWRlciAuY2xvc2UgeyBiYWNrZ3JvdW5kOiBub25lOyBib3JkZXI6IG5vbmU7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IGZvbnQtc2l6ZTogMS4ycmVtOyBjdXJzb3I6IHBvaW50ZXI7IH0NCi5tb2RhbC1jb250ZW50IGZvcm0geyBwYWRkaW5nOiAxLjVyZW07IH0NCi5mb3JtLWdyaWQgeyBkaXNwbGF5OiBncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmciAxZnI7IGdhcDogMXJlbTsgfQ0KLmZvcm0tZ3JpZCBsYWJlbCB7IGRpc3BsYXk6IGZsZXg7IGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47IGdhcDogLjI1cmVtOyBmb250LXNpemU6IC44NXJlbTsgY29sb3I6IHZhcigtLW11dGVkKTsgfQ0KLmZvcm0tZ3JpZCBsYWJlbCBpbnB1dCwgLmZvcm0tZ3JpZCBsYWJlbCBzZWxlY3QsIC5mb3JtLWdyaWQgbGFiZWwgdGV4dGFyZWEgeyBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7IGNvbG9yOiB2YXIoLS10ZXh0KTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgcGFkZGluZzogLjVyZW07IGJvcmRlci1yYWRpdXM6IDZweDsgZm9udC1zaXplOiAuOXJlbTsgfQ0KLmZvcm0tZ3JpZCBsYWJlbCB0ZXh0YXJlYSB7IHJlc2l6ZTogdmVydGljYWw7IG1pbi1oZWlnaHQ6IDYwcHg7IH0NCi5tb2RhbC1hY3Rpb25zIHsgZGlzcGxheTogZmxleDsgZ2FwOiAuNXJlbTsganVzdGlmeS1jb250ZW50OiBmbGV4LWVuZDsgcGFkZGluZzogMXJlbSAxLjVyZW07IGJvcmRlci10b3A6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyB9DQouYXBwbHktY2hlY2tsaXN0IHsgbGlzdC1zdHlsZTogbm9uZTsgcGFkZGluZzogMDsgfQ0KLmFwcGx5LWNoZWNrbGlzdCBsaSB7IHBhZGRpbmc6IC41cmVtIDA7IGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBnYXA6IC41cmVtOyBmb250LXNpemU6IC45cmVtOyB9DQouYXBwbHktY2hlY2tsaXN0IC52YWwgeyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQ0KDQovKiBUb2FzdCAqLw0KLnRvYXN0IHsgcG9zaXRpb246IGZpeGVkOyBib3R0b206IDEuNXJlbTsgcmlnaHQ6IDEuNXJlbTsgYmFja2dyb3VuZDogdmFyKC0tZ3JlZW4pOyBjb2xvcjogIzAwMDsgcGFkZGluZzogLjc1cmVtIDEuMjVyZW07IGJvcmRlci1yYWRpdXM6IDhweDsgZm9udC1zaXplOiAuODc1cmVtOyBkaXNwbGF5OiBub25lOyB6LWluZGV4OiAyMDA7IGZvbnQtd2VpZ2h0OiA1MDA7IH0=';
const APP_JS_B64 = 'LyoqDQogKiBhcHAuanMg4oCUIERhc2hib2FyZCBjbGllbnQtc2lkZSBsb2dpYw0KICovDQpjb25zdCBBUEkgPSAnL2FwaSc7DQpsZXQgYWxsSm9icyA9IFtdOw0KbGV0IGN1cnJlbnRKb2JJZCA9IG51bGw7DQoNCi8vIOKUgOKUgCBJbml0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignRE9NQ29udGVudExvYWRlZCcsIGFzeW5jICgpID0+IHsNCiAgYXdhaXQgbG9hZFByb2ZpbGUoKTsNCiAgYXdhaXQgbG9hZFN0YXRzKCk7DQogIGF3YWl0IGxvYWRTb3VyY2VzKCk7DQogIGF3YWl0IGxvYWRKb2JzKCk7DQogIGJpbmRFdmVudHMoKTsNCn0pOw0KDQovLyDilIDilIAgUHJvZmlsZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCmFzeW5jIGZ1bmN0aW9uIGxvYWRQcm9maWxlKCkgew0KICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCk7DQogIGNvbnN0IHAgPSBhd2FpdCByLmpzb24oKTsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVOYW1lJykudGV4dENvbnRlbnQgPSBwLm5hbWUgfHwgJ0pvYiBBZ2VudCc7DQogIHdpbmRvdy5fcHJvZmlsZSA9IHA7DQp9DQoNCmFzeW5jIGZ1bmN0aW9uIGxvYWRTb3VyY2VzKCkgew0KICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9qb2JzP2xpbWl0PTUwMDBgKTsNCiAgY29uc3Qgam9icyA9IGF3YWl0IHIuanNvbigpOw0KICBjb25zdCBzb3VyY2VzID0gWy4uLm5ldyBTZXQoam9icy5tYXAoaiA9PiBqLnNvdXJjZSkpXS5zb3J0KCk7DQogIGNvbnN0IHNlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3VyY2VGaWx0ZXInKTsNCiAgc291cmNlcy5mb3JFYWNoKHMgPT4gew0KICAgIGNvbnN0IG9wdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpOw0KICAgIG9wdC52YWx1ZSA9IHM7IG9wdC50ZXh0Q29udGVudCA9IHM7DQogICAgc2VsLmFwcGVuZENoaWxkKG9wdCk7DQogIH0pOw0KDQogIC8vIFBvcHVsYXRlIGNvbXBhbnkgZmlsdGVyDQogIGNvbnN0IGNvbXBhbmllcyA9IFsuLi5uZXcgU2V0KGpvYnMubWFwKGogPT4gai5jb21wYW55KSldLnNvcnQoKTsNCiAgY29uc3QgY29tcGFueVNlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJyk7DQogIGNvbXBhbmllcy5mb3JFYWNoKGMgPT4gew0KICAgIGNvbnN0IG9wdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpOw0KICAgIG9wdC52YWx1ZSA9IGM7IG9wdC50ZXh0Q29udGVudCA9IGM7DQogICAgY29tcGFueVNlbC5hcHBlbmRDaGlsZChvcHQpOw0KICB9KTsNCn0NCg0KLy8g4pSA4pSAIFN0YXRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KYXN5bmMgZnVuY3Rpb24gbG9hZFN0YXRzKCkgew0KICBjb25zdCBzID0gYXdhaXQgKGF3YWl0IGZldGNoKGAke0FQSX0vc3RhdHNgKSkuanNvbigpOw0KICBjb25zdCBlbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc3RhdCBiJyk7DQogIGVsc1swXS50ZXh0Q29udGVudCA9IHMudG90YWxfam9iczsNCiAgZWxzWzFdLnRleHRDb250ZW50ID0gcy5uZXdfam9iczsNCiAgZWxzWzJdLnRleHRDb250ZW50ID0gcy5zYXZlZF9qb2JzOw0KICBlbHNbM10udGV4dENvbnRlbnQgPSBzLmFwcGxpZWRfam9iczsNCiAgZWxzWzRdLnRleHRDb250ZW50ID0gcy5za2lwcGVkX2pvYnM7DQp9DQoNCi8vIOKUgOKUgCBKb2JzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KYXN5bmMgZnVuY3Rpb24gbG9hZEpvYnMoKSB7DQogIGNvbnN0IHN0YXR1cyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0dXNGaWx0ZXInKS52YWx1ZTsNCiAgY29uc3QgY29tcGFueSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJykudmFsdWU7DQogIGNvbnN0IHJlZ2lvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZTsNCiAgY29uc3Qgam9iVHlwZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykudmFsdWU7DQogIGNvbnN0IHNvdXJjZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3VyY2VGaWx0ZXInKS52YWx1ZTsNCiAgY29uc3Qgc29ydCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3J0RmlsdGVyJykudmFsdWU7DQogIGNvbnN0IHNlYXJjaCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZWFyY2hJbnB1dCcpLnZhbHVlLnRvTG93ZXJDYXNlKCk7DQoNCiAgbGV0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoeyBzdGF0dXMsIHNvcnQsIGxpbWl0OiA1MDAgfSk7DQogIGlmIChjb21wYW55KSBwYXJhbXMuc2V0KCdjb21wYW55JywgY29tcGFueSk7DQogIGlmIChyZWdpb24pIHBhcmFtcy5zZXQoJ3JlZ2lvbicsIHJlZ2lvbik7DQogIGlmIChqb2JUeXBlKSBwYXJhbXMuc2V0KCdqb2JUeXBlJywgam9iVHlwZSk7DQogIGlmIChzb3VyY2UpIHBhcmFtcy5zZXQoJ3NvdXJjZScsIHNvdXJjZSk7DQogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgJHtBUEl9L2pvYnM/JHtwYXJhbXN9YCk7DQogIGFsbEpvYnMgPSBhd2FpdCByLmpzb24oKTsNCg0KICAvLyBDbGllbnQtc2lkZSBzZWFyY2ggZmlsdGVyDQogIGlmIChzZWFyY2gpIHsNCiAgICBhbGxKb2JzID0gYWxsSm9icy5maWx0ZXIoaiA9Pg0KICAgICAgKGoudGl0bGUgfHwgJycpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKSB8fA0KICAgICAgKGouY29tcGFueSB8fCAnJykudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhzZWFyY2gpIHx8DQogICAgICAoai5kZXNjcmlwdGlvbiB8fCAnJykudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhzZWFyY2gpDQogICAgKTsNCiAgfQ0KDQogIHJlbmRlckpvYnMoYWxsSm9icyk7DQogIGF3YWl0IGxvYWRTdGF0cygpOw0KICB1cGRhdGVDbGVhckJ1dHRvbigpOw0KfQ0KDQpmdW5jdGlvbiB1cGRhdGVDbGVhckJ1dHRvbigpIHsNCiAgY29uc3QgaGFzRmlsdGVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKS52YWx1ZSB8fA0KICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVnaW9uRmlsdGVyJykudmFsdWUgfHwNCiAgICAgICAgICAgICAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlR5cGVGaWx0ZXInKS52YWx1ZSB8fA0KICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2VhcmNoSW5wdXQnKS52YWx1ZTsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NsZWFyRmlsdGVycycpLnN0eWxlLmRpc3BsYXkgPSBoYXNGaWx0ZXIgPyAnJyA6ICdub25lJzsNCn0NCg0KZnVuY3Rpb24gcmVuZGVySm9icyhqb2JzKSB7DQogIGNvbnN0IHEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnam9iUXVldWUnKTsNCiAgaWYgKGpvYnMubGVuZ3RoID09PSAwKSB7DQogICAgcS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0iZW1wdHktc3RhdGUiPk5vIGpvYnMgZm91bmQuIENsaWNrICJTY3JhcGUgTm93IiB0byBmZXRjaCBmcmVzaCBsaXN0aW5ncy48L2Rpdj4nOw0KICAgIHJldHVybjsNCiAgfQ0KICBxLmlubmVySFRNTCA9IGpvYnMubWFwKChqLCBpKSA9PiBqb2JDYXJkKGosIGkpKS5qb2luKCcnKTsNCn0NCg0KZnVuY3Rpb24gam9iQ2FyZChqb2IsIGluZGV4KSB7DQogIGNvbnN0IHJlYXNvbnMgPSAoam9iLm1hdGNoX3JlYXNvbnMgfHwgW10pLm1hcChyID0+IGA8bGk+4pyFICR7cn08L2xpPmApLmpvaW4oJycpOw0KICBjb25zdCB3YXJuaW5ncyA9IChqb2Iud2FybmluZ3MgfHwgW10pLmZpbHRlcih3ID0+IHcpLm1hcCh3ID0+IGA8bGkgY2xhc3M9Indhcm4iPuKaoO+4jyAke3d9PC9saT5gKS5qb2luKCcnKTsNCiAgY29uc3Qgc2FsYXJ5QmFkZ2UgPSBqb2Iuc2FsYXJ5ID8gYDxzcGFuIGNsYXNzPSJiYWRnZSBzYWxhcnkiPiR7am9iLnNhbGFyeX08L3NwYW4+YCA6ICcnOw0KICBjb25zdCByZW1vdGVCYWRnZSA9IGpvYi5yZW1vdGUgfHwgam9iLnNvdXJjZSA9PT0gJ1JlbW90ZU9LJyB8fCBqb2Iuc291cmNlID09PSAnUmVtb3RpdmUnIHx8IGpvYi5zb3VyY2UgPT09ICdXZVdvcmtSZW1vdGVseScgPyBgPHNwYW4gY2xhc3M9ImJhZGdlIHJlbW90ZSI+UmVtb3RlPC9zcGFuPmAgOiAnJzsNCiAgY29uc3QgY2xIdG1sID0gam9iLmNvdmVyX2xldHRlcg0KICAgID8gYDxkaXYgY2xhc3M9ImNsLWJveCI+JHtlc2NhcGVIdG1sKGpvYi5jb3Zlcl9sZXR0ZXIuc2xpY2UoMCwgNDAwKSl9JHtqb2IuY292ZXJfbGV0dGVyLmxlbmd0aCA+IDQwMCA/ICcuLi4nIDogJyd9PGJ1dHRvbiBvbmNsaWNrPSJjb3B5VGV4dCgnY2wtJHtpbmRleH0nKSI+Q29weTwvYnV0dG9uPjwvZGl2PmANCiAgICA6ICcnOw0KICBjb25zdCBzdGF0dXNDbGFzcyA9IGBzdGF0dXMtJHtqb2Iuc3RhdHVzIHx8ICduZXcnfWA7DQogIGNvbnN0IHBjdCA9IE1hdGgubWluKDEwMCwgTWF0aC5yb3VuZCgoam9iLnNjb3JlIHx8IDApIC8gMTIwICogMTAwKSk7DQogIGNvbnN0IHNjb3JlQ29sb3IgPSBwY3QgPj0gNzAgPyAnIzRhZGU4MCcgOiBwY3QgPj0gNDAgPyAnI2ZiYmYyNCcgOiAnI2Y4NzE3MSc7DQoNCiAgLy8gU3RhdHVzLXNwZWNpZmljIGFjdGlvbiBidXR0b25zDQogIGxldCBhY3Rpb25zSHRtbCA9ICcnOw0KICBjb25zdCBzdGF0dXMgPSBqb2Iuc3RhdHVzIHx8ICduZXcnOw0KDQogIGlmIChzdGF0dXMgPT09ICduZXcnKSB7DQogICAgYWN0aW9uc0h0bWwgPSBgDQogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYnRuLWFwcGx5Ij5WaWV3IEpvYjwvYT4NCiAgICAgICAgPGJ1dHRvbiBvbmNsaWNrPSJvcGVuQXBwbHkoJyR7am9iLmlkfScpIiBjbGFzcz0iYnRuLXNlY29uZGFyeSI+QXBwbHk8L2J1dHRvbj4NCiAgICAgICAgPGJ1dHRvbiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdzYXZlZCcpIiBjbGFzcz0iYnRuLWdob3N0Ij5TYXZlPC9idXR0b24+DQogICAgICAgIDxidXR0b24gb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9Jywnc2tpcHBlZCcpIiBjbGFzcz0iYnRuLWdob3N0Ij5Ta2lwPC9idXR0b24+DQogICAgICAgIDxidXR0b24gb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9JywnaWdub3JlZCcpIiBjbGFzcz0iYnRuLWdob3N0Ij5JZ25vcmU8L2J1dHRvbj4NCiAgICAgIGA7DQogIH0gZWxzZSBpZiAoc3RhdHVzID09PSAnYXBwbGllZCcpIHsNCiAgICBhY3Rpb25zSHRtbCA9IGANCiAgICAgICAgPGEgaHJlZj0iJHtlc2NhcGVIdG1sKGpvYi51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJidG4tYXBwbHkiPlZpZXcgSm9iPC9hPg0KICAgICAgICA8c3BhbiBjbGFzcz0ic3RhdHVzLWJhZGdlIHN0YXR1cy1hcHBsaWVkIj5BcHBsaWVkPC9zcGFuPg0KICAgICAgICA8YnV0dG9uIG9uY2xpY2s9Im1hcmtBY3Rpb24oJyR7am9iLmlkfScsJ3NraXBwZWQnKSIgY2xhc3M9ImJ0bi1naG9zdCI+UmV2b2tlICYgU2tpcDwvYnV0dG9uPg0KICAgICAgYDsNCiAgfSBlbHNlIGlmIChzdGF0dXMgPT09ICdzYXZlZCcpIHsNCiAgICBhY3Rpb25zSHRtbCA9IGANCiAgICAgICAgPGEgaHJlZj0iJHtlc2NhcGVIdG1sKGpvYi51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJidG4tYXBwbHkiPlZpZXcgSm9iPC9hPg0KICAgICAgICA8YnV0dG9uIG9uY2xpY2s9Im9wZW5BcHBseSgnJHtqb2IuaWR9JykiIGNsYXNzPSJidG4tc2Vjb25kYXJ5Ij5BcHBseTwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIG9uY2xpY2s9Im1hcmtBY3Rpb24oJyR7am9iLmlkfScsJ3NraXBwZWQnKSIgY2xhc3M9ImJ0bi1naG9zdCI+U2tpcDwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIG9uY2xpY2s9Im1hcmtBY3Rpb24oJyR7am9iLmlkfScsJ2lnbm9yZWQnKSIgY2xhc3M9ImJ0bi1naG9zdCI+SWdub3JlPC9idXR0b24+DQogICAgICBgOw0KICB9IGVsc2UgaWYgKHN0YXR1cyA9PT0gJ3NraXBwZWQnKSB7DQogICAgYWN0aW9uc0h0bWwgPSBgDQogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYnRuLWFwcGx5Ij5WaWV3IEpvYjwvYT4NCiAgICAgICAgPHNwYW4gY2xhc3M9InN0YXR1cy1iYWRnZSBzdGF0dXMtc2tpcHBlZCI+U2tpcHBlZDwvc3Bhbj4NCiAgICAgICAgPGJ1dHRvbiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCduZXcnKSIgY2xhc3M9ImJ0bi1naG9zdCI+UmVvcGVuPC9idXR0b24+DQogICAgICBgOw0KICB9IGVsc2UgaWYgKHN0YXR1cyA9PT0gJ2lnbm9yZWQnKSB7DQogICAgYWN0aW9uc0h0bWwgPSBgDQogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYnRuLWFwcGx5Ij5WaWV3IEpvYjwvYT4NCiAgICAgICAgPHNwYW4gY2xhc3M9InN0YXR1cy1iYWRnZSBzdGF0dXMtaWdub3JlZCI+SWdub3JlZDwvc3Bhbj4NCiAgICAgICAgPGJ1dHRvbiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCduZXcnKSIgY2xhc3M9ImJ0bi1naG9zdCI+UmVvcGVuPC9idXR0b24+DQogICAgICBgOw0KICB9DQoNCiAgcmV0dXJuIGANCiAgPGRpdiBjbGFzcz0iam9iLWNhcmQiIGlkPSJqb2ItJHtqb2IuaWR9Ij4NCiAgICA8ZGl2IGNsYXNzPSJqb2ItaGVhZGVyIj4NCiAgICAgIDxkaXYgY2xhc3M9ImpvYi1yYW5rIj4jJHtpbmRleCArIDF9IDxzcGFuIGNsYXNzPSJzdGF0dXMtYmFkZ2UgJHtzdGF0dXNDbGFzc30iPiR7c3RhdHVzLnRvVXBwZXJDYXNlKCl9PC9zcGFuPjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iam9iLXRpdGxlLWJsb2NrIj4NCiAgICAgICAgPGgyPiR7ZXNjYXBlSHRtbChqb2IudGl0bGUpfTwvaDI+DQogICAgICAgIDxkaXYgY2xhc3M9ImpvYi1tZXRhIj4ke2VzY2FwZUh0bWwoam9iLmNvbXBhbnkpfSDCtyAke2VzY2FwZUh0bWwoam9iLnNvdXJjZSl9PC9kaXY+DQogICAgICAgIDxkaXYgY2xhc3M9ImJhZGdlcyI+DQogICAgICAgICAgPHNwYW4gY2xhc3M9ImJhZGdlIHNvdXJjZSI+JHtlc2NhcGVIdG1sKGpvYi5zb3VyY2UpfTwvc3Bhbj4NCiAgICAgICAgICAke3JlbW90ZUJhZGdlfQ0KICAgICAgICAgICR7c2FsYXJ5QmFkZ2V9DQogICAgICAgIDwvZGl2Pg0KICAgICAgPC9kaXY+DQogICAgICA8ZGl2IGNsYXNzPSJzY29yZS1iYXItd3JhcCI+DQogICAgICAgIDxkaXYgY2xhc3M9InNjb3JlLWJhciI+PGRpdiBjbGFzcz0ic2NvcmUtZmlsbCIgc3R5bGU9IndpZHRoOiR7cGN0fSU7YmFja2dyb3VuZDoke3Njb3JlQ29sb3J9Ij48L2Rpdj48L2Rpdj4NCiAgICAgICAgPHNwYW4+JHtqb2Iuc2NvcmV9IHB0czwvc3Bhbj4NCiAgICAgIDwvZGl2Pg0KICAgIDwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9ImpvYi1ib2R5Ij4NCiAgICAgIDxkaXYgY2xhc3M9InJlYXNvbnMiPg0KICAgICAgICA8aDQ+V2h5IHRoaXMgbWF0Y2hlZDwvaDQ+DQogICAgICAgIDx1bD4ke3JlYXNvbnN9JHt3YXJuaW5nc308L3VsPg0KICAgICAgPC9kaXY+DQogICAgICA8ZGl2IGNsYXNzPSJkZXNjIj4NCiAgICAgICAgPGg0PkRlc2NyaXB0aW9uPC9oND4NCiAgICAgICAgPHA+JHtlc2NhcGVIdG1sKChqb2IuZGVzY3JpcHRpb24gfHwgJycpLnNsaWNlKDAsIDMwMCkpfSR7KGpvYi5kZXNjcmlwdGlvbiB8fCAnJykubGVuZ3RoID4gMzAwID8gJy4uLiAobGluayBmb3IgZnVsbCB0ZXh0KScgOiAnJ308L3A+DQogICAgICA8L2Rpdj4NCiAgICAgICR7Y2xIdG1sfQ0KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+DQogICAgICAgICR7YWN0aW9uc0h0bWx9DQogICAgICA8L2Rpdj4NCiAgICA8L2Rpdj4NCiAgPC9kaXY+YDsNCn0NCg0KLy8g4pSA4pSAIEFjdGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQphc3luYyBmdW5jdGlvbiBtYXJrQWN0aW9uKGpvYklkLCBhY3Rpb24pIHsNCiAgLy8gTWFwIGFjdGlvbiBuYW1lcyB0byBBUEkgZW5kcG9pbnRzDQogIGNvbnN0IGVuZHBvaW50TWFwID0geyBhcHBsaWVkOiAnYXBwbHknLCBza2lwcGVkOiAnc2tpcCcsIHNhdmVkOiAnc2F2ZScsIGlnbm9yZWQ6ICdpZ25vcmUnLCBuZXc6ICduZXcnIH07DQogIGNvbnN0IGVuZHBvaW50ID0gZW5kcG9pbnRNYXBbYWN0aW9uXSB8fCBhY3Rpb247DQogIC8vIFdoZW4gc2tpcHBpbmcsIGFsc28gcGFzcyB0aGUgam9iIHRpdGxlIHNvIHRoZSB3b3JrZXIgY2FuIGV4dHJhY3Qgc2tpcCBrZXl3b3Jkcw0KICBsZXQgcGF5bG9hZCA9IHsgam9iSWQgfTsNCiAgaWYgKGFjdGlvbiA9PT0gJ3NraXBwZWQnKSB7DQogICAgY29uc3Qgam9iID0gYWxsSm9icy5maW5kKGogPT4gai5pZCA9PT0gam9iSWQpOw0KICAgIGlmIChqb2IgJiYgam9iLnRpdGxlKSBwYXlsb2FkLnRpdGxlID0gam9iLnRpdGxlOw0KICB9DQogIHRyeSB7DQogICAgY29uc3QgcmVzcCA9IGF3YWl0IGZldGNoKGAke0FQSX0vJHtlbmRwb2ludH1gLCB7DQogICAgICBtZXRob2Q6ICdQT1NUJywNCiAgICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9LA0KICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkNCiAgICB9KTsNCiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzcC50ZXh0KCk7DQogICAgaWYgKCFyZXNwLm9rKSB7DQogICAgICB0aHJvdyBuZXcgRXJyb3IoJ0hUVFAgJyArIHJlc3Auc3RhdHVzICsgJzogJyArIHRleHQpOw0KICAgIH0NCiAgICBKU09OLnBhcnNlKHRleHQpOw0KICAgIHRvYXN0KGAke2FjdGlvbi5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIGFjdGlvbi5zbGljZSgxKX1kIGpvYmApOw0KICAgIGF3YWl0IGxvYWRKb2JzKCk7DQogIH0gY2F0Y2ggKGVycikgew0KICAgIHRvYXN0KCdFcnJvcjogJyArIGVyci5tZXNzYWdlKTsNCiAgfQ0KfQ0KDQphc3luYyBmdW5jdGlvbiBidWxrU2F2ZSgpIHsNCiAgY29uc3QgdmlzaWJsZSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5qb2ItY2FyZCcpOw0KICB2aXNpYmxlLmZvckVhY2goZWwgPT4gew0KICAgIGNvbnN0IGpvYklkID0gZWwuaWQucmVwbGFjZSgnam9iLScsICcnKTsNCiAgICBtYXJrQWN0aW9uKGpvYklkLCAnc2F2ZWQnKTsNCiAgfSk7DQp9DQoNCmFzeW5jIGZ1bmN0aW9uIGJ1bGtTa2lwTG93KCkgew0KICBhbGxKb2JzLmZpbHRlcihqID0+IGouc2NvcmUgPCAzMCAmJiAoai5zdGF0dXMgPT09ICduZXcnKSkuZm9yRWFjaChqID0+IG1hcmtBY3Rpb24oai5pZCwgJ3NraXBwZWQnKSk7DQp9DQoNCi8vIOKUgOKUgCBBcHBseSBNb2RhbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCmZ1bmN0aW9uIG9wZW5BcHBseShqb2JJZCkgew0KICBjdXJyZW50Sm9iSWQgPSBqb2JJZDsNCiAgY29uc3Qgam9iID0gYWxsSm9icy5maW5kKGogPT4gai5pZCA9PT0gam9iSWQpOw0KICBpZiAoIWpvYikgcmV0dXJuOw0KICBjb25zdCBwID0gd2luZG93Ll9wcm9maWxlIHx8IHt9Ow0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlDb250ZW50JykuaW5uZXJIVE1MID0gYA0KICAgIDxoMz4ke2VzY2FwZUh0bWwoam9iLnRpdGxlKX0gQCAke2VzY2FwZUh0bWwoam9iLmNvbXBhbnkpfTwvaDM+DQogICAgPHAgc3R5bGU9ImNvbG9yOnZhcigtLW11dGVkKTttYXJnaW46LjVyZW0gMCI+JHtlc2NhcGVIdG1sKGpvYi5kZXNjcmlwdGlvbj8uc2xpY2UoMCwgMjAwKSkgfHwgJ05vIGRlc2NyaXB0aW9uIGF2YWlsYWJsZS4nfTwvcD4NCiAgICA8cCBzdHlsZT0ibWFyZ2luOi41cmVtIDAiPjxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBzdHlsZT0iY29sb3I6dmFyKC0tYWNjZW50KSI+VmlldyBmdWxsIGpvYiBsaXN0aW5nIOKGkjwvYT48L3A+DQogICAgPGg0PkFwcGxpY2F0aW9uIENoZWNrbGlzdDo8L2g0Pg0KICAgIDx1bCBjbGFzcz0iYXBwbHktY2hlY2tsaXN0Ij4NCiAgICAgIDxsaT48aW5wdXQgdHlwZT0iY2hlY2tib3giIGNoZWNrZWQgZGlzYWJsZWQ+IE5hbWU6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLm5hbWUgfHwgJ+KAlCcpfTwvc3Bhbj48L2xpPg0KICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gRW1haWw6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLmVtYWlsIHx8ICfigJQnKX08L3NwYW4+PC9saT4NCiAgICAgIDxsaT48aW5wdXQgdHlwZT0iY2hlY2tib3giIGNoZWNrZWQgZGlzYWJsZWQ+IFBob25lOiA8c3BhbiBjbGFzcz0idmFsIj4ke2VzY2FwZUh0bWwocC5waG9uZSB8fCAn4oCUJyl9PC9zcGFuPjwvbGk+DQogICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBSZXN1bWU6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLnJlc3VtZV9wYXRoIHx8ICdub3Qgc2V0Jyl9PC9zcGFuPjwvbGk+DQogICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBDb3ZlciBsZXR0ZXI6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7am9iLmNvdmVyX2xldHRlciA/ICfinJMgR2VuZXJhdGVkJyA6ICdSdW4gd2l0aCBBTlRIUk9QSUNfQVBJX0tFWSd9PC9zcGFuPjwvbGk+DQogICAgPC91bD4NCiAgYDsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5VXJsQnRuJykuaHJlZiA9IGpvYi51cmw7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtYXJrQXBwbGllZEJ0bicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7DQogICAgYXdhaXQgbWFya0FjdGlvbihqb2JJZCwgJ2FwcGxpZWQnKTsNCiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7DQogICAgdG9hc3QoJ01hcmtlZCBhcyBhcHBsaWVkIScpOw0KICB9Ow0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnZmxleCc7DQp9DQoNCi8vIOKUgOKUgCBQcm9maWxlIE1vZGFsIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVCdG4nKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gew0KICBjb25zdCBwID0gYXdhaXQgKGF3YWl0IGZldGNoKGAke0FQSX0vcHJvZmlsZWApKS5qc29uKCk7DQogIHdpbmRvdy5fcHJvZmlsZSA9IHA7DQogIE9iamVjdC5rZXlzKHApLmZvckVhY2goayA9PiB7DQogICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncF8nICsgayk7DQogICAgaWYgKGVsKSBlbC52YWx1ZSA9IEFycmF5LmlzQXJyYXkocFtrXSkgPyBwW2tdLmpvaW4oJywgJykgOiAocFtrXSB8fCAnJyk7DQogIH0pOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJvZmlsZU1vZGFsJykuc3R5bGUuZGlzcGxheSA9ICdmbGV4JzsNCn07DQoNCmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlRm9ybScpLm9uc3VibWl0ID0gYXN5bmMgKGUpID0+IHsNCiAgZS5wcmV2ZW50RGVmYXVsdCgpOw0KICBjb25zdCBmZCA9IG5ldyBGb3JtRGF0YShlLnRhcmdldCk7DQogIGNvbnN0IHAgPSB7fTsNCiAgZmQuZm9yRWFjaCgodiwgaykgPT4geyBwW2tdID0gdjsgfSk7DQogIC8vIFBhcnNlIGNvbW1hLXNlcGFyYXRlZCBmaWVsZHMNCiAgZm9yIChjb25zdCBrZXkgb2YgWydza2lsbHMnLCAndGFyZ2V0X3RpdGxlcycsICdyZXF1aXJlZF9rZXl3b3JkcycsICdib251c19rZXl3b3JkcycsICdkZWFsX2JyZWFrZXJzJywgJ3ByZWZlcnJlZF93b3JrX3R5cGUnLCAncHJlZmVycmVkX2xvY2F0aW9ucycsICdwcmVmZXJyZWRfZW1wbG95bWVudCddKSB7DQogICAgcFtrZXldID0gKHBba2V5XSB8fCAnJykuc3BsaXQoJywnKS5tYXAocyA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pOw0KICB9DQogIHAuZXhwZXJpZW5jZV95ZWFycyA9IHBhcnNlSW50KHAuZXhwZXJpZW5jZV95ZWFycykgfHwgMDsNCiAgcC5zYWxhcnlfbWluX2xha2hzID0gcGFyc2VGbG9hdChwLnNhbGFyeV9taW5fbGFraHMpIHx8IDM1Ow0KICBwLnRhcmdldF9zYWxhcnkgPSB7IGN1cnJlbmN5OiBwLnNhbGFyeV9jdXJyZW5jeSB8fCAnSU5SJywgbWluX2xha2hzOiBwLnNhbGFyeV9taW5fbGFraHMgfTsNCiAgYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCwgeyBtZXRob2Q6ICdQVVQnLCBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwgYm9keTogSlNPTi5zdHJpbmdpZnkocCkgfSk7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOw0KICB0b2FzdCgnUHJvZmlsZSBzYXZlZCEnKTsNCiAgbG9hZFByb2ZpbGUoKTsNCn07DQoNCi8vIOKUgOKUgCBFdmVudHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQpmdW5jdGlvbiBiaW5kRXZlbnRzKCkgew0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NyYXBlQnRuJykub25jbGljayA9IGFzeW5jICgpID0+IHsNCiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NyYXBlQnRuJykuZGlzYWJsZWQgPSB0cnVlOw0KICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS50ZXh0Q29udGVudCA9ICdTY3JhcGluZy4uLic7DQogICAgYXdhaXQgZmV0Y2goYCR7QVBJfS9zY3JhcGVgLCB7IG1ldGhvZDogJ1BPU1QnIH0pOw0KICAgIHNldFRpbWVvdXQoKCkgPT4geyBsb2FkSm9icygpOyBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NyYXBlQnRuJykuZGlzYWJsZWQgPSBmYWxzZTsgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjcmFwZUJ0bicpLnRleHRDb250ZW50ID0gJ1NjcmFwZSBOb3cnOyB9LCAyMDAwKTsNCiAgfTsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NsZWFyRmlsdGVycycpLm9uY2xpY2sgPSAoKSA9PiB7DQogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKS52YWx1ZSA9ICcnOw0KICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZSA9ICcnOw0KICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykudmFsdWUgPSAnJzsNCiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2VhcmNoSW5wdXQnKS52YWx1ZSA9ICcnOw0KICAgIGxvYWRKb2JzKCk7DQogIH07DQoNCiAgZnVuY3Rpb24gb25GaWx0ZXJDaGFuZ2UoKSB7IGxvYWRKb2JzKCk7IHVwZGF0ZUNsZWFyQnV0dG9uKCk7IH0NCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1c0ZpbHRlcicpLm9uY2hhbmdlID0gbG9hZEpvYnM7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJykub25jaGFuZ2UgPSBvbkZpbHRlckNoYW5nZTsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlZ2lvbkZpbHRlcicpLm9uY2hhbmdlID0gb25GaWx0ZXJDaGFuZ2U7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykub25jaGFuZ2UgPSBvbkZpbHRlckNoYW5nZTsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NvdXJjZUZpbHRlcicpLm9uY2hhbmdlID0gbG9hZEpvYnM7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3J0RmlsdGVyJykub25jaGFuZ2UgPSBsb2FkSm9iczsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NlYXJjaElucHV0Jykub25pbnB1dCA9ICgpID0+IHsgY2xlYXJUaW1lb3V0KHdpbmRvdy5fc2VhcmNoVGltZXIpOyB3aW5kb3cuX3NlYXJjaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IGxvYWRKb2JzKCk7IHVwZGF0ZUNsZWFyQnV0dG9uKCk7IH0sIDMwMCk7IH07DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdidWxrU2F2ZScpLm9uY2xpY2sgPSBidWxrU2F2ZTsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2J1bGtTa2lwJykub25jbGljayA9IGJ1bGtTa2lwTG93Ow0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xvc2VQcm9maWxlQnRuJykub25jbGljayA9ICgpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2FuY2VsUHJvZmlsZUJ0bicpLm9uY2xpY2sgPSAoKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJvZmlsZU1vZGFsJykuc3R5bGUuZGlzcGxheSA9ICdub25lJzsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Nsb3NlQXBwbHlCdG4nKS5vbmNsaWNrID0gKCkgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5TW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOw0KfQ0KDQovLyDilIDilIAgVXRpbHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQpmdW5jdGlvbiB0b2FzdChtc2cpIHsNCiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndG9hc3QnKTsNCiAgZWwudGV4dENvbnRlbnQgPSBtc2c7IGVsLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snOw0KICBzZXRUaW1lb3V0KCgpID0+IGVsLnN0eWxlLmRpc3BsYXkgPSAnbm9uZScsIDI1MDApOw0KfQ0KDQpmdW5jdGlvbiBlc2NhcGVIdG1sKHMpIHsNCiAgaWYgKCFzKSByZXR1cm4gJyc7DQogIHJldHVybiBTdHJpbmcocykucmVwbGFjZSgvJi9nLCcmYW1wOycpLnJlcGxhY2UoLzwvZywnJmx0OycpLnJlcGxhY2UoLz4vZywnJmd0OycpLnJlcGxhY2UoLyIvZywnJnF1b3Q7Jyk7DQp9DQoNCndpbmRvdy5jb3B5VGV4dCA9IGZ1bmN0aW9uKGlkKSB7DQogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOw0KICBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dChlbC50ZXh0Q29udGVudCkudGhlbigoKSA9PiB0b2FzdCgnQ292ZXIgbGV0dGVyIGNvcGllZCEnKSk7DQp9Ow0Kd2luZG93Lm1hcmtBY3Rpb24gPSBtYXJrQWN0aW9uOw0Kd2luZG93Lm9wZW5BcHBseSA9IG9wZW5BcHBseTsNCndpbmRvdy5idWxrU2F2ZSA9IGJ1bGtTYXZlOw0Kd2luZG93LmJ1bGtTa2lwTG93ID0gYnVsa1NraXBMb3c7DQo=';

const DASHBOARD_HTML_B64 = 'PCFET0NUWVBFIGh0bWw+DQo8aHRtbCBsYW5nPSJlbiI+DQo8aGVhZD4NCiAgPG1ldGEgY2hhcnNldD0iVVRGLTgiLz4NCiAgPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiLz4NCiAgPHRpdGxlPkpvYiBBZ2VudCB2Mi4xPC90aXRsZT4NCiAgPGxpbmsgcmVsPSJzdHlsZXNoZWV0IiBocmVmPSIvc3R5bGVzLmNzcz92PV9fU1RZTEVTX1ZFUlNJT05fXyIvPg0KPC9oZWFkPg0KPGJvZHk+DQogIDxoZWFkZXIgY2xhc3M9InRvcGJhciI+DQogICAgPGRpdiBjbGFzcz0iYnJhbmQiPg0KICAgICAgPGgxPvCflI4gSm9iIEFnZW50PC9oMT4NCiAgICAgIDxzcGFuIGNsYXNzPSJzdWIiIGlkPSJwcm9maWxlTmFtZSI+TG9hZGluZy4uLjwvc3Bhbj4NCiAgICA8L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIj4NCiAgICAgIDxidXR0b24gaWQ9InNjcmFwZUJ0biIgY2xhc3M9ImJ0bi1wcmltYXJ5Ij7wn5SEIFNjcmFwZSBOb3c8L2J1dHRvbj4NCiAgICAgIDxidXR0b24gaWQ9InByb2ZpbGVCdG4iIGNsYXNzPSJidG4tZ2hvc3QiPvCfkaQgUHJvZmlsZTwvYnV0dG9uPg0KICAgIDwvZGl2Pg0KICA8L2hlYWRlcj4NCg0KICA8bWFpbj4NCiAgICA8c2VjdGlvbiBjbGFzcz0ic3RhdHMiIGlkPSJzdGF0c0JhciI+DQogICAgICA8ZGl2IGNsYXNzPSJzdGF0Ij48Yj7igJQ8L2I+PHNwYW4+VG90YWwgSm9iczwvc3Bhbj48L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxiPuKAlDwvYj48c3Bhbj5OZXc8L3NwYW4+PC9kaXY+DQogICAgICA8ZGl2IGNsYXNzPSJzdGF0Ij48Yj7igJQ8L2I+PHNwYW4+U2F2ZWQ8L3NwYW4+PC9kaXY+DQogICAgICA8ZGl2IGNsYXNzPSJzdGF0Ij48Yj7igJQ8L2I+PHNwYW4+QXBwbGllZDwvc3Bhbj48L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxiPuKAlDwvYj48c3Bhbj5Ta2lwcGVkPC9zcGFuPjwvZGl2Pg0KICAgIDwvc2VjdGlvbj4NCg0KICAgIDxzZWN0aW9uIGNsYXNzPSJ0b29sYmFyIj4NCiAgICAgIDxkaXYgY2xhc3M9ImZpbHRlcnMiPg0KICAgICAgICA8c2VsZWN0IGlkPSJzdGF0dXNGaWx0ZXIiIHRpdGxlPSJGaWx0ZXIgYnkgc3RhdHVzIj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJuZXciPk5ldyBKb2JzPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2F2ZWQiPlNhdmVkPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYXBwbGllZCI+QXBwbGllZDwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InNraXBwZWQiPlNraXBwZWQ8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJpZ25vcmVkIj5JZ25vcmVkPC9vcHRpb24+DQogICAgICAgIDwvc2VsZWN0Pg0KICAgICAgICA8c2VsZWN0IGlkPSJjb21wYW55RmlsdGVyIiB0aXRsZT0iRmlsdGVyIGJ5IGNvbXBhbnkiPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9IiI+QWxsIENvbXBhbmllczwvb3B0aW9uPg0KICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgPHNlbGVjdCBpZD0icmVnaW9uRmlsdGVyIiB0aXRsZT0iRmlsdGVyIGJ5IHJlZ2lvbiI+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgUmVnaW9uczwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImluZGlhIj7wn4eu8J+HsyBJbmRpYTwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InJlbW90ZSI+8J+MkCBSZW1vdGU8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJ1c2EiPvCfh7rwn4e4IFVTQTwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImV1cm9wZSI+8J+HqvCfh7ogRXVyb3BlPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYXNpYS1wYWNpZmljIj7wn4yPIEFzaWEtUGFjaWZpYzwvb3B0aW9uPg0KICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgPHNlbGVjdCBpZD0iam9iVHlwZUZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBqb2IgdHlwZSI+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgVHlwZXM8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJyZW1vdGUiPlJlbW90ZSBPbmx5PC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ib25zaXRlIj5Pbi1zaXRlIE9ubHk8L29wdGlvbj4NCiAgICAgICAgPC9zZWxlY3Q+DQogICAgICAgIDxzZWxlY3QgaWQ9InNvdXJjZUZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBzb3VyY2UiPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9IiI+QWxsIFNvdXJjZXM8L29wdGlvbj4NCiAgICAgICAgPC9zZWxlY3Q+DQogICAgICAgIDxzZWxlY3QgaWQ9InNvcnRGaWx0ZXIiIHRpdGxlPSJTb3J0IGJ5Ij4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJzY29yZSI+U29ydDogU2NvcmUgKGRlc2MpPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icG9zdGVkIj5Tb3J0OiBOZXdlc3Q8L29wdGlvbj4NCiAgICAgICAgPC9zZWxlY3Q+DQogICAgICAgIDxpbnB1dCBpZD0ic2VhcmNoSW5wdXQiIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSLwn5SNIFNlYXJjaCB0aXRsZSwga2V5d29yZHMuLi4iLz4NCiAgICAgICAgPGJ1dHRvbiBpZD0iY2xlYXJGaWx0ZXJzIiBjbGFzcz0iYnRuLWdob3N0IiBzdHlsZT0iZGlzcGxheTpub25lIj7inJUgQ2xlYXI8L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iYnVsay1hY3Rpb25zIj4NCiAgICAgICAgPGJ1dHRvbiBpZD0iYnVsa1NhdmUiIGNsYXNzPSJidG4tZ2hvc3QiPlNhdmUgQWxsIFZpc2libGU8L2J1dHRvbj4NCiAgICAgICAgPGJ1dHRvbiBpZD0iYnVsa1NraXAiIGNsYXNzPSJidG4tZ2hvc3QiPlNraXAgQWxsIEJlbG93IDMwPC9idXR0b24+DQogICAgICA8L2Rpdj4NCiAgICA8L3NlY3Rpb24+DQoNCiAgICA8c2VjdGlvbiBjbGFzcz0icXVldWUiIGlkPSJqb2JRdWV1ZSI+DQogICAgICA8ZGl2IGNsYXNzPSJlbXB0eS1zdGF0ZSI+TG9hZGluZyBqb2JzLi4uPC9kaXY+DQogICAgPC9zZWN0aW9uPg0KICA8L21haW4+DQoNCiAgPCEtLSBQcm9maWxlIE1vZGFsIC0tPg0KICA8ZGl2IGlkPSJwcm9maWxlTW9kYWwiIGNsYXNzPSJtb2RhbCIgc3R5bGU9ImRpc3BsYXk6bm9uZSI+DQogICAgPGRpdiBjbGFzcz0ibW9kYWwtY29udGVudCI+DQogICAgICA8ZGl2IGNsYXNzPSJtb2RhbC1oZWFkZXIiPg0KICAgICAgICA8aDI+8J+RpCBFZGl0IFByb2ZpbGU8L2gyPg0KICAgICAgICA8YnV0dG9uIGlkPSJjbG9zZVByb2ZpbGVCdG4iIGNsYXNzPSJjbG9zZSI+4pyVPC9idXR0b24+DQogICAgICA8L2Rpdj4NCiAgICAgIDxmb3JtIGlkPSJwcm9maWxlRm9ybSI+DQogICAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JpZCI+DQogICAgICAgICAgPGxhYmVsPk5hbWU8aW5wdXQgaWQ9InBfbmFtZSIgbmFtZT0ibmFtZSIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPkVtYWlsPGlucHV0IGlkPSJwX2VtYWlsIiBuYW1lPSJlbWFpbCIgdHlwZT0iZW1haWwiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5QaG9uZTxpbnB1dCBpZD0icF9waG9uZSIgbmFtZT0icGhvbmUiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5MaW5rZWRJbjxpbnB1dCBpZD0icF9saW5rZWRpbiIgbmFtZT0ibGlua2VkaW4iLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5Mb2NhdGlvbjxpbnB1dCBpZD0icF9sb2NhdGlvbiIgbmFtZT0ibG9jYXRpb24iLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5SZXN1bWUgUGF0aDxpbnB1dCBpZD0icF9yZXN1bWVfcGF0aCIgbmFtZT0icmVzdW1lX3BhdGgiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5FeHBlcmllbmNlICh5ZWFycyk8aW5wdXQgaWQ9InBfZXhwIiBuYW1lPSJleHBlcmllbmNlX3llYXJzIiB0eXBlPSJudW1iZXIiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5DdXJyZW50IFJvbGU8aW5wdXQgaWQ9InBfcm9sZSIgbmFtZT0iY3VycmVudF9yb2xlIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+Q3VycmVudCBDb21wYW55PGlucHV0IGlkPSJwX2NvbXBhbnkiIG5hbWU9ImN1cnJlbnRfY29tcGFueSIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPlNraWxscyAoY29tbWEtc2VwYXJhdGVkKTxpbnB1dCBpZD0icF9za2lsbHMiIG5hbWU9InNraWxscyIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPlRhcmdldCBUaXRsZXMgKGNvbW1hLXNlcGFyYXRlZCk8aW5wdXQgaWQ9InBfdGl0bGVzIiBuYW1lPSJ0YXJnZXRfdGl0bGVzIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+UmVxdWlyZWQgS2V5d29yZHM8aW5wdXQgaWQ9InBfcmVxX2t3IiBuYW1lPSJyZXF1aXJlZF9rZXl3b3JkcyIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPkJvbnVzIEtleXdvcmRzPGlucHV0IGlkPSJwX2JvbnVzX2t3IiBuYW1lPSJib251c19rZXl3b3JkcyIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPk1pbiBTYWxhcnkgKExha2hzIElOUik8aW5wdXQgaWQ9InBfbWluX3NhbGFyeSIgbmFtZT0ic2FsYXJ5X21pbl9sYWtocyIgdHlwZT0ibnVtYmVyIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+U2FsYXJ5IEN1cnJlbmN5DQogICAgICAgICAgICA8c2VsZWN0IGlkPSJwX2N1cnJlbmN5IiBuYW1lPSJzYWxhcnlfY3VycmVuY3kiPg0KICAgICAgICAgICAgICA8b3B0aW9uPklOUjwvb3B0aW9uPjxvcHRpb24+VVNEPC9vcHRpb24+PG9wdGlvbj5FVVI8L29wdGlvbj48b3B0aW9uPkdCUDwvb3B0aW9uPg0KICAgICAgICAgICAgPC9zZWxlY3Q+DQogICAgICAgICAgPC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+V29yayBUeXBlDQogICAgICAgICAgICA8c2VsZWN0IGlkPSJwX3dvcmtfdHlwZSIgbmFtZT0id29ya190eXBlIiBtdWx0aXBsZSBzaXplPSIzIj4NCiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icmVtb3RlIj5SZW1vdGU8L29wdGlvbj4NCiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iaHlicmlkIj5IeWJyaWQ8L29wdGlvbj4NCiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ib24tc2l0ZSI+T24tc2l0ZTwvb3B0aW9uPg0KICAgICAgICAgICAgPC9zZWxlY3Q+DQogICAgICAgICAgPC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+UHJlZmVycmVkIExvY2F0aW9uczxpbnB1dCBpZD0icF9sb2NhdGlvbnMiIG5hbWU9ImxvY2F0aW9ucyIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPlN1bW1hcnk8dGV4dGFyZWEgaWQ9InBfc3VtbWFyeSIgbmFtZT0ic3VtbWFyeSIgcm93cz0iMyI+PC90ZXh0YXJlYT48L2xhYmVsPg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtYWN0aW9ucyI+DQogICAgICAgICAgPGJ1dHRvbiB0eXBlPSJzdWJtaXQiIGNsYXNzPSJidG4tcHJpbWFyeSI+U2F2ZSBQcm9maWxlPC9idXR0b24+DQogICAgICAgICAgPGJ1dHRvbiB0eXBlPSJidXR0b24iIGlkPSJjYW5jZWxQcm9maWxlQnRuIiBjbGFzcz0iYnRuLWdob3N0Ij5DYW5jZWw8L2J1dHRvbj4NCiAgICAgICAgPC9kaXY+DQogICAgICA8L2Zvcm0+DQogICAgPC9kaXY+DQogIDwvZGl2Pg0KDQogIDwhLS0gQXBwbHkgTW9kYWwgLS0+DQogIDxkaXYgaWQ9ImFwcGx5TW9kYWwiIGNsYXNzPSJtb2RhbCIgc3R5bGU9ImRpc3BsYXk6bm9uZSI+DQogICAgPGRpdiBjbGFzcz0ibW9kYWwtY29udGVudCI+DQogICAgICA8ZGl2IGNsYXNzPSJtb2RhbC1oZWFkZXIiPg0KICAgICAgICA8aDI+8J+agCBQcmVwYXJlIEFwcGxpY2F0aW9uPC9oMj4NCiAgICAgICAgPGJ1dHRvbiBpZD0iY2xvc2VBcHBseUJ0biIgY2xhc3M9ImNsb3NlIj7inJU8L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KICAgICAgPGRpdiBpZD0iYXBwbHlDb250ZW50Ij48L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9Im1vZGFsLWFjdGlvbnMiPg0KICAgICAgICA8YSBpZD0iYXBwbHlVcmxCdG4iIGhyZWY9IiMiIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYnRuLXByaW1hcnkiPk9wZW4gSm9iIFBhZ2U8L2E+DQogICAgICAgIDxidXR0b24gaWQ9Im1hcmtBcHBsaWVkQnRuIiBjbGFzcz0iYnRuLXN1Y2Nlc3MiPuKchSBNYXJrIGFzIEFwcGxpZWQ8L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KICAgIDwvZGl2Pg0KICA8L2Rpdj4NCg0KICA8ZGl2IGlkPSJ0b2FzdCIgY2xhc3M9InRvYXN0Ij48L2Rpdj4NCiAgPHNjcmlwdCBpZD0iYXBwLWpzLXNyYyIgc3JjPSIvYXBwLmpzP3Q9ZmJhNWJhMjIiPjwvc2NyaXB0Pg0KPC9ib2R5Pg0KPC9odG1sPg==';

// Dashboard HTML (base64 encoded to avoid require issues)
function getDashboardHtml(timestamp, jsHash) {
  let html = getDashboardHtmlRaw();
  // Replace timestamp with dynamic value to bust JS cache on every page load
  html = html.replace('__TIMESTAMP__', String(timestamp));
  html = html.replace('__STYLES_VERSION__', String(timestamp));
  return html;
}

function getDashboardHtmlRaw() {
  const binaryString = atob(DASHBOARD_HTML_B64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// ── Entry points ─────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {
    // Add CORS headers to allow browser access
    const origin = req.headers.get('Origin');
    const response = await handleRequest(req, env);
    response.headers.set('Access-Control-Allow-Origin', origin || '*');
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
    return response;
  },


  async schedule(event) {
    console.log('Running daily job scrape...');
    const result = await runScrape(event.env);
    console.log('Daily scrape completed:', JSON.stringify(result));
  }
};
