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

  // Deal-breakers
  const textForDealBreakers = [job.title, job.company].join(' ');
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

  // Title match
  const titleMatch = containsAny(job.title, target_titles, false);
  if (titleMatch.length > 0) { score += 40; reasons.push('Title match: "' + titleMatch[0] + '"'); }

  // Title similarity
  if (titleMatch.length === 0) {
    const simScore = titleSimilarity(job.title, target_titles);
    if (simScore > 0.3) {
      score += Math.round(25 * simScore);
      reasons.push('Title similarity: ' + Math.round(simScore * 100) + '%');
    }
  }

  // Required skills
  const reqMatches = containsAny(fullText, required_keywords, false);
  score += reqMatches.length * 8;
  if (reqMatches.length > 0) reasons.push('Required skills: ' + reqMatches.slice(0, 4).join(', '));

  // Bonus skills
  const bonusMatches = containsAny(fullText, profile.bonus_keywords || [], false);
  score += bonusMatches.length * 5;
  if (bonusMatches.length > 0) reasons.push('Bonus skills: ' + bonusMatches.slice(0, 3).join(', '));

  // Remote/hybrid/location
  const isRemote = job.remote || normalize(job.location).includes('remote');
  const isHybrid = normalize(job.location).includes('hybrid');
  const isMumbai = containsAny(job.location + ' ' + fullText, ['mumbai'], true).length > 0;

  if (isRemote) { score += 20; reasons.push('Remote'); }
  else if (isHybrid && isMumbai) { score += 10; reasons.push('Hybrid in Mumbai'); }
  else if (isMumbai) { score += 15; reasons.push('Location: Mumbai'); }

  // Salary
  if (job.salary_min_inr >= min_salary) { score += 10; reasons.push('Salary: ' + job.salary); }
  else if (job.salary_min_inr > 0) {
    return Object.assign({}, job, { score: -999, match_reasons: [], warnings: ['Salary below threshold: ' + job.salary] });
  }

  // Recency
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
  const ranked = allJobs.map(function(j) { return scoreJob(j, profile); }).sort(function(a, b) { return b.score - a.score; });

  await saveData(env.JOBS_KV, 'jobs', { jobs: ranked });

  const runStats = await loadData(env.JOBS_KV, 'scrape_runs');
  const matched = ranked.filter(function(j) { return j.score >= 20; }).length;
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
    if (idx >= 0) { jobList[idx].status = 'skipped'; await saveData(env.JOBS_KV, 'jobs', { jobs: jobList }); }
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

  // Serve dashboard HTML for SPA fallback
  return new Response(getDashboardHtml(Date.now()), {
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
const APP_JS_B64 = 'LyoqCiAqIGFwcC5qcyDigJQgRGFzaGJvYXJkIGNsaWVudC1zaWRlIGxvZ2ljCiAqLwpjb25zdCBBUEkgPSAnL2FwaSc7CmxldCBhbGxKb2JzID0gW107CmxldCBjdXJyZW50Sm9iSWQgPSBudWxsOwoKLy8g4pSA4pSAIEluaXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ0RPTUNvbnRlbnRMb2FkZWQnLCBhc3luYyAoKSA9PiB7CiAgYXdhaXQgbG9hZFByb2ZpbGUoKTsKICBhd2FpdCBsb2FkU3RhdHMoKTsKICBhd2FpdCBsb2FkU291cmNlcygpOwogIGF3YWl0IGxvYWRKb2JzKCk7CiAgYmluZEV2ZW50cygpOwp9KTsKCi8vIOKUgOKUgCBQcm9maWxlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAphc3luYyBmdW5jdGlvbiBsb2FkUHJvZmlsZSgpIHsKICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCk7CiAgY29uc3QgcCA9IGF3YWl0IHIuanNvbigpOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTmFtZScpLnRleHRDb250ZW50ID0gcC5uYW1lIHx8ICdKb2IgQWdlbnQnOwogIHdpbmRvdy5fcHJvZmlsZSA9IHA7Cn0KCmFzeW5jIGZ1bmN0aW9uIGxvYWRTb3VyY2VzKCkgewogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgJHtBUEl9L2pvYnM/bGltaXQ9NTAwMGApOwogIGNvbnN0IGpvYnMgPSBhd2FpdCByLmpzb24oKTsKICBjb25zdCBzb3VyY2VzID0gWy4uLm5ldyBTZXQoam9icy5tYXAoaiA9PiBqLnNvdXJjZSkpXS5zb3J0KCk7CiAgY29uc3Qgc2VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NvdXJjZUZpbHRlcicpOwogIHNvdXJjZXMuZm9yRWFjaChzID0+IHsKICAgIGNvbnN0IG9wdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpOwogICAgb3B0LnZhbHVlID0gczsgb3B0LnRleHRDb250ZW50ID0gczsKICAgIHNlbC5hcHBlbmRDaGlsZChvcHQpOwogIH0pOwoKICAvLyBQb3B1bGF0ZSBjb21wYW55IGZpbHRlcgogIGNvbnN0IGNvbXBhbmllcyA9IFsuLi5uZXcgU2V0KGpvYnMubWFwKGogPT4gai5jb21wYW55KSldLnNvcnQoKTsKICBjb25zdCBjb21wYW55U2VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKTsKICBjb21wYW5pZXMuZm9yRWFjaChjID0+IHsKICAgIGNvbnN0IG9wdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpOwogICAgb3B0LnZhbHVlID0gYzsgb3B0LnRleHRDb250ZW50ID0gYzsKICAgIGNvbXBhbnlTZWwuYXBwZW5kQ2hpbGQob3B0KTsKICB9KTsKfQoKLy8g4pSA4pSAIFN0YXRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAphc3luYyBmdW5jdGlvbiBsb2FkU3RhdHMoKSB7CiAgY29uc3QgcyA9IGF3YWl0IChhd2FpdCBmZXRjaChgJHtBUEl9L3N0YXRzYCkpLmpzb24oKTsKICBjb25zdCBlbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc3RhdCBiJyk7CiAgZWxzWzBdLnRleHRDb250ZW50ID0gcy50b3RhbF9qb2JzOwogIGVsc1sxXS50ZXh0Q29udGVudCA9IHMubmV3X2pvYnM7CiAgZWxzWzJdLnRleHRDb250ZW50ID0gcy5zYXZlZF9qb2JzOwogIGVsc1szXS50ZXh0Q29udGVudCA9IHMuYXBwbGllZF9qb2JzOwogIGVsc1s0XS50ZXh0Q29udGVudCA9IHMuc2tpcHBlZF9qb2JzOwp9CgovLyDilIDilIAgSm9icyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKYXN5bmMgZnVuY3Rpb24gbG9hZEpvYnMoKSB7CiAgY29uc3Qgc3RhdHVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1c0ZpbHRlcicpLnZhbHVlOwogIGNvbnN0IGNvbXBhbnkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY29tcGFueUZpbHRlcicpLnZhbHVlOwogIGNvbnN0IHJlZ2lvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZTsKICBjb25zdCBqb2JUeXBlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlR5cGVGaWx0ZXInKS52YWx1ZTsKICBjb25zdCBzb3VyY2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc291cmNlRmlsdGVyJykudmFsdWU7CiAgY29uc3Qgc29ydCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3J0RmlsdGVyJykudmFsdWU7CiAgY29uc3Qgc2VhcmNoID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NlYXJjaElucHV0JykudmFsdWUudG9Mb3dlckNhc2UoKTsKCiAgbGV0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoeyBzdGF0dXMsIHNvcnQsIGxpbWl0OiA1MDAgfSk7CiAgaWYgKGNvbXBhbnkpIHBhcmFtcy5zZXQoJ2NvbXBhbnknLCBjb21wYW55KTsKICBpZiAocmVnaW9uKSBwYXJhbXMuc2V0KCdyZWdpb24nLCByZWdpb24pOwogIGlmIChqb2JUeXBlKSBwYXJhbXMuc2V0KCdqb2JUeXBlJywgam9iVHlwZSk7CiAgaWYgKHNvdXJjZSkgcGFyYW1zLnNldCgnc291cmNlJywgc291cmNlKTsKICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9qb2JzPyR7cGFyYW1zfWApOwogIGFsbEpvYnMgPSBhd2FpdCByLmpzb24oKTsKCiAgLy8gQ2xpZW50LXNpZGUgc2VhcmNoIGZpbHRlcgogIGlmIChzZWFyY2gpIHsKICAgIGFsbEpvYnMgPSBhbGxKb2JzLmZpbHRlcihqID0+CiAgICAgIChqLnRpdGxlIHx8ICcnKS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHNlYXJjaCkgfHwKICAgICAgKGouY29tcGFueSB8fCAnJykudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhzZWFyY2gpIHx8CiAgICAgIChqLmRlc2NyaXB0aW9uIHx8ICcnKS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHNlYXJjaCkKICAgICk7CiAgfQoKICByZW5kZXJKb2JzKGFsbEpvYnMpOwogIGF3YWl0IGxvYWRTdGF0cygpOwogIHVwZGF0ZUNsZWFyQnV0dG9uKCk7Cn0KCmZ1bmN0aW9uIHVwZGF0ZUNsZWFyQnV0dG9uKCkgewogIGNvbnN0IGhhc0ZpbHRlciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJykudmFsdWUgfHwKICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVnaW9uRmlsdGVyJykudmFsdWUgfHwKICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnam9iVHlwZUZpbHRlcicpLnZhbHVlIHx8CiAgICAgICAgICAgICAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NlYXJjaElucHV0JykudmFsdWU7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NsZWFyRmlsdGVycycpLnN0eWxlLmRpc3BsYXkgPSBoYXNGaWx0ZXIgPyAnJyA6ICdub25lJzsKfQoKZnVuY3Rpb24gcmVuZGVySm9icyhqb2JzKSB7CiAgY29uc3QgcSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JRdWV1ZScpOwogIGlmIChqb2JzLmxlbmd0aCA9PT0gMCkgewogICAgcS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0iZW1wdHktc3RhdGUiPk5vIGpvYnMgZm91bmQuIENsaWNrICJTY3JhcGUgTm93IiB0byBmZXRjaCBmcmVzaCBsaXN0aW5ncy48L2Rpdj4nOwogICAgcmV0dXJuOwogIH0KICBxLmlubmVySFRNTCA9IGpvYnMubWFwKChqLCBpKSA9PiBqb2JDYXJkKGosIGkpKS5qb2luKCcnKTsKfQoKZnVuY3Rpb24gam9iQ2FyZChqb2IsIGluZGV4KSB7CiAgY29uc3QgcmVhc29ucyA9IChqb2IubWF0Y2hfcmVhc29ucyB8fCBbXSkubWFwKHIgPT4gYDxsaT7inIUgJHtyfTwvbGk+YCkuam9pbignJyk7CiAgY29uc3Qgd2FybmluZ3MgPSAoam9iLndhcm5pbmdzIHx8IFtdKS5maWx0ZXIodyA9PiB3KS5tYXAodyA9PiBgPGxpIGNsYXNzPSJ3YXJuIj7imqDvuI8gJHt3fTwvbGk+YCkuam9pbignJyk7CiAgY29uc3Qgc2FsYXJ5QmFkZ2UgPSBqb2Iuc2FsYXJ5ID8gYDxzcGFuIGNsYXNzPSJiYWRnZSBzYWxhcnkiPiR7am9iLnNhbGFyeX08L3NwYW4+YCA6ICcnOwogIGNvbnN0IHJlbW90ZUJhZGdlID0gam9iLnJlbW90ZSB8fCBqb2Iuc291cmNlID09PSAnUmVtb3RlT0snIHx8IGpvYi5zb3VyY2UgPT09ICdSZW1vdGl2ZScgfHwgam9iLnNvdXJjZSA9PT0gJ1dlV29ya1JlbW90ZWx5JyA/IGA8c3BhbiBjbGFzcz0iYmFkZ2UgcmVtb3RlIj5SZW1vdGU8L3NwYW4+YCA6ICcnOwogIGNvbnN0IGNsSHRtbCA9IGpvYi5jb3Zlcl9sZXR0ZXIKICAgID8gYDxkaXYgY2xhc3M9ImNsLWJveCI+JHtlc2NhcGVIdG1sKGpvYi5jb3Zlcl9sZXR0ZXIuc2xpY2UoMCwgNDAwKSl9JHtqb2IuY292ZXJfbGV0dGVyLmxlbmd0aCA+IDQwMCA/ICcuLi4nIDogJyd9PGJ1dHRvbiBvbmNsaWNrPSJjb3B5VGV4dCgnY2wtJHtpbmRleH0nKSI+Q29weTwvYnV0dG9uPjwvZGl2PmAKICAgIDogJyc7CiAgY29uc3Qgc3RhdHVzQ2xhc3MgPSBgc3RhdHVzLSR7am9iLnN0YXR1cyB8fCAnbmV3J31gOwogIGNvbnN0IHBjdCA9IE1hdGgubWluKDEwMCwgTWF0aC5yb3VuZCgoam9iLnNjb3JlIHx8IDApIC8gMTIwICogMTAwKSk7CiAgY29uc3Qgc2NvcmVDb2xvciA9IHBjdCA+PSA3MCA/ICcjNGFkZTgwJyA6IHBjdCA+PSA0MCA/ICcjZmJiZjI0JyA6ICcjZjg3MTcxJzsKCiAgLy8gU3RhdHVzLXNwZWNpZmljIGFjdGlvbiBidXR0b25zCiAgbGV0IGFjdGlvbnNIdG1sID0gJyc7CiAgY29uc3Qgc3RhdHVzID0gam9iLnN0YXR1cyB8fCAnbmV3JzsKCiAgaWYgKHN0YXR1cyA9PT0gJ25ldycpIHsKICAgIGFjdGlvbnNIdG1sID0gYAogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYnRuLWFwcGx5Ij5WaWV3IEpvYjwvYT4KICAgICAgICA8YnV0dG9uIG9uY2xpY2s9Im9wZW5BcHBseSgnJHtqb2IuaWR9JykiIGNsYXNzPSJidG4tc2Vjb25kYXJ5Ij5BcHBseTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9Jywnc2F2ZWQnKSIgY2xhc3M9ImJ0bi1naG9zdCI+U2F2ZTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9Jywnc2tpcHBlZCcpIiBjbGFzcz0iYnRuLWdob3N0Ij5Ta2lwPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdpZ25vcmVkJykiIGNsYXNzPSJidG4tZ2hvc3QiPklnbm9yZTwvYnV0dG9uPgogICAgICBgOwogIH0gZWxzZSBpZiAoc3RhdHVzID09PSAnYXBwbGllZCcpIHsKICAgIGFjdGlvbnNIdG1sID0gYAogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYnRuLWFwcGx5Ij5WaWV3IEpvYjwvYT4KICAgICAgICA8c3BhbiBjbGFzcz0ic3RhdHVzLWJhZGdlIHN0YXR1cy1hcHBsaWVkIj5BcHBsaWVkPC9zcGFuPgogICAgICAgIDxidXR0b24gb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9Jywnc2tpcHBlZCcpIiBjbGFzcz0iYnRuLWdob3N0Ij5SZXZva2UgJiBTa2lwPC9idXR0b24+CiAgICAgIGA7CiAgfSBlbHNlIGlmIChzdGF0dXMgPT09ICdzYXZlZCcpIHsKICAgIGFjdGlvbnNIdG1sID0gYAogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYnRuLWFwcGx5Ij5WaWV3IEpvYjwvYT4KICAgICAgICA8YnV0dG9uIG9uY2xpY2s9Im9wZW5BcHBseSgnJHtqb2IuaWR9JykiIGNsYXNzPSJidG4tc2Vjb25kYXJ5Ij5BcHBseTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9Jywnc2tpcHBlZCcpIiBjbGFzcz0iYnRuLWdob3N0Ij5Ta2lwPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdpZ25vcmVkJykiIGNsYXNzPSJidG4tZ2hvc3QiPklnbm9yZTwvYnV0dG9uPgogICAgICBgOwogIH0gZWxzZSBpZiAoc3RhdHVzID09PSAnc2tpcHBlZCcpIHsKICAgIGFjdGlvbnNIdG1sID0gYAogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYnRuLWFwcGx5Ij5WaWV3IEpvYjwvYT4KICAgICAgICA8c3BhbiBjbGFzcz0ic3RhdHVzLWJhZGdlIHN0YXR1cy1za2lwcGVkIj5Ta2lwcGVkPC9zcGFuPgogICAgICAgIDxidXR0b24gb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9JywnbmV3JykiIGNsYXNzPSJidG4tZ2hvc3QiPlJlb3BlbjwvYnV0dG9uPgogICAgICBgOwogIH0gZWxzZSBpZiAoc3RhdHVzID09PSAnaWdub3JlZCcpIHsKICAgIGFjdGlvbnNIdG1sID0gYAogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYnRuLWFwcGx5Ij5WaWV3IEpvYjwvYT4KICAgICAgICA8c3BhbiBjbGFzcz0ic3RhdHVzLWJhZGdlIHN0YXR1cy1pZ25vcmVkIj5JZ25vcmVkPC9zcGFuPgogICAgICAgIDxidXR0b24gb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9JywnbmV3JykiIGNsYXNzPSJidG4tZ2hvc3QiPlJlb3BlbjwvYnV0dG9uPgogICAgICBgOwogIH0KCiAgcmV0dXJuIGAKICA8ZGl2IGNsYXNzPSJqb2ItY2FyZCIgaWQ9ImpvYi0ke2pvYi5pZH0iPgogICAgPGRpdiBjbGFzcz0iam9iLWhlYWRlciI+CiAgICAgIDxkaXYgY2xhc3M9ImpvYi1yYW5rIj4jJHtpbmRleCArIDF9IDxzcGFuIGNsYXNzPSJzdGF0dXMtYmFkZ2UgJHtzdGF0dXNDbGFzc30iPiR7c3RhdHVzLnRvVXBwZXJDYXNlKCl9PC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJqb2ItdGl0bGUtYmxvY2siPgogICAgICAgIDxoMj4ke2VzY2FwZUh0bWwoam9iLnRpdGxlKX08L2gyPgogICAgICAgIDxkaXYgY2xhc3M9ImpvYi1tZXRhIj4ke2VzY2FwZUh0bWwoam9iLmNvbXBhbnkpfSDCtyAke2VzY2FwZUh0bWwoam9iLnNvdXJjZSl9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iYmFkZ2VzIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJiYWRnZSBzb3VyY2UiPiR7ZXNjYXBlSHRtbChqb2Iuc291cmNlKX08L3NwYW4+CiAgICAgICAgICAke3JlbW90ZUJhZGdlfQogICAgICAgICAgJHtzYWxhcnlCYWRnZX0KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InNjb3JlLWJhci13cmFwIj4KICAgICAgICA8ZGl2IGNsYXNzPSJzY29yZS1iYXIiPjxkaXYgY2xhc3M9InNjb3JlLWZpbGwiIHN0eWxlPSJ3aWR0aDoke3BjdH0lO2JhY2tncm91bmQ6JHtzY29yZUNvbG9yfSI+PC9kaXY+PC9kaXY+CiAgICAgICAgPHNwYW4+JHtqb2Iuc2NvcmV9IHB0czwvc3Bhbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImpvYi1ib2R5Ij4KICAgICAgPGRpdiBjbGFzcz0icmVhc29ucyI+CiAgICAgICAgPGg0PldoeSB0aGlzIG1hdGNoZWQ8L2g0PgogICAgICAgIDx1bD4ke3JlYXNvbnN9JHt3YXJuaW5nc308L3VsPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZGVzYyI+CiAgICAgICAgPGg0PkRlc2NyaXB0aW9uPC9oND4KICAgICAgICA8cD4ke2VzY2FwZUh0bWwoKGpvYi5kZXNjcmlwdGlvbiB8fCAnJykuc2xpY2UoMCwgMzAwKSl9JHsoam9iLmRlc2NyaXB0aW9uIHx8ICcnKS5sZW5ndGggPiAzMDAgPyAnLi4uIChsaW5rIGZvciBmdWxsIHRleHQpJyA6ICcnfTwvcD4KICAgICAgPC9kaXY+CiAgICAgICR7Y2xIdG1sfQogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIj4KICAgICAgICAke2FjdGlvbnNIdG1sfQogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvZGl2PmA7Cn0KCi8vIOKUgOKUgCBBY3Rpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAphc3luYyBmdW5jdGlvbiBtYXJrQWN0aW9uKGpvYklkLCBhY3Rpb24pIHsKICAvLyBNYXAgYWN0aW9uIG5hbWVzIHRvIEFQSSBlbmRwb2ludHMKICBjb25zdCBlbmRwb2ludCA9IGFjdGlvbiA9PT0gJ2FwcGxpZWQnID8gJ2FwcGx5JyA6IGFjdGlvbjsKICBjb25zb2xlLmxvZygnW0pvYiBBZ2VudF0gbWFya0FjdGlvbjonLCBqb2JJZCwgYWN0aW9uLCAnLT4gZW5kcG9pbnQ6JywgZW5kcG9pbnQpOwogIHRyeSB7CiAgICBjb25zdCByZXNwID0gYXdhaXQgZmV0Y2goYCR7QVBJfS8ke2VuZHBvaW50fWAsIHsgCiAgICAgIG1ldGhvZDogJ1BPU1QnLCAKICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sIAogICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGpvYklkIH0pIAogICAgfSk7CiAgICBjb25zb2xlLmxvZygnW0pvYiBBZ2VudF0gUmVzcG9uc2Ugc3RhdHVzOicsIHJlc3Auc3RhdHVzKTsKICAgIGlmICghcmVzcC5vaykgewogICAgICB0aHJvdyBuZXcgRXJyb3IoJ0hUVFAgJyArIHJlc3Auc3RhdHVzICsgJzogJyArIGF3YWl0IHJlc3AudGV4dCgpKTsKICAgIH0KICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc3AuanNvbigpOwogICAgY29uc29sZS5sb2coJ1tKb2IgQWdlbnRdIFJlc3BvbnNlOicsIHJlc3VsdCk7CiAgICB0b2FzdChgJHthY3Rpb24uY2hhckF0KDApLnRvVXBwZXJDYXNlKCkgKyBhY3Rpb24uc2xpY2UoMSl9ZCBqb2JgKTsKICAgIGF3YWl0IGxvYWRKb2JzKCk7CiAgfSBjYXRjaCAoZXJyKSB7CiAgICBjb25zb2xlLmVycm9yKCdbSm9iIEFnZW50XSBtYXJrQWN0aW9uIGZhaWxlZDonLCBlcnIpOwogICAgdG9hc3QoJ0Vycm9yOiAnICsgZXJyLm1lc3NhZ2UpOwogIH0KfQoKYXN5bmMgZnVuY3Rpb24gYnVsa1NhdmUoKSB7CiAgY29uc3QgdmlzaWJsZSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5qb2ItY2FyZCcpOwogIHZpc2libGUuZm9yRWFjaChlbCA9PiB7CiAgICBjb25zdCBqb2JJZCA9IGVsLmlkLnJlcGxhY2UoJ2pvYi0nLCAnJyk7CiAgICBtYXJrQWN0aW9uKGpvYklkLCAnc2F2ZWQnKTsKICB9KTsKfQoKYXN5bmMgZnVuY3Rpb24gYnVsa1NraXBMb3coKSB7CiAgYWxsSm9icy5maWx0ZXIoaiA9PiBqLnNjb3JlIDwgMzAgJiYgKGouc3RhdHVzID09PSAnbmV3JykpLmZvckVhY2goaiA9PiBtYXJrQWN0aW9uKGouaWQsICdza2lwcGVkJykpOwp9CgovLyDilIDilIAgQXBwbHkgTW9kYWwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmZ1bmN0aW9uIG9wZW5BcHBseShqb2JJZCkgewogIGN1cnJlbnRKb2JJZCA9IGpvYklkOwogIGNvbnN0IGpvYiA9IGFsbEpvYnMuZmluZChqID0+IGouaWQgPT09IGpvYklkKTsKICBpZiAoIWpvYikgcmV0dXJuOwogIGNvbnN0IHAgPSB3aW5kb3cuX3Byb2ZpbGUgfHwge307CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5Q29udGVudCcpLmlubmVySFRNTCA9IGAKICAgIDxoMz4ke2VzY2FwZUh0bWwoam9iLnRpdGxlKX0gQCAke2VzY2FwZUh0bWwoam9iLmNvbXBhbnkpfTwvaDM+CiAgICA8cCBzdHlsZT0iY29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbjouNXJlbSAwIj4ke2VzY2FwZUh0bWwoam9iLmRlc2NyaXB0aW9uPy5zbGljZSgwLCAyMDApKSB8fCAnTm8gZGVzY3JpcHRpb24gYXZhaWxhYmxlLid9PC9wPgogICAgPHAgc3R5bGU9Im1hcmdpbjouNXJlbSAwIj48YSBocmVmPSIke2VzY2FwZUh0bWwoam9iLnVybCl9IiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOnZhcigtLWFjY2VudCkiPlZpZXcgZnVsbCBqb2IgbGlzdGluZyDihpI8L2E+PC9wPgogICAgPGg0PkFwcGxpY2F0aW9uIENoZWNrbGlzdDo8L2g0PgogICAgPHVsIGNsYXNzPSJhcHBseS1jaGVja2xpc3QiPgogICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBOYW1lOiA8c3BhbiBjbGFzcz0idmFsIj4ke2VzY2FwZUh0bWwocC5uYW1lIHx8ICfigJQnKX08L3NwYW4+PC9saT4KICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gRW1haWw6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLmVtYWlsIHx8ICfigJQnKX08L3NwYW4+PC9saT4KICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gUGhvbmU6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLnBob25lIHx8ICfigJQnKX08L3NwYW4+PC9saT4KICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gUmVzdW1lOiA8c3BhbiBjbGFzcz0idmFsIj4ke2VzY2FwZUh0bWwocC5yZXN1bWVfcGF0aCB8fCAnbm90IHNldCcpfTwvc3Bhbj48L2xpPgogICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBDb3ZlciBsZXR0ZXI6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7am9iLmNvdmVyX2xldHRlciA/ICfinJMgR2VuZXJhdGVkJyA6ICdSdW4gd2l0aCBBTlRIUk9QSUNfQVBJX0tFWSd9PC9zcGFuPjwvbGk+CiAgICA8L3VsPgogIGA7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5VXJsQnRuJykuaHJlZiA9IGpvYi51cmw7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21hcmtBcHBsaWVkQnRuJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGF3YWl0IG1hcmtBY3Rpb24oam9iSWQsICdhcHBsaWVkJyk7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgICB0b2FzdCgnTWFya2VkIGFzIGFwcGxpZWQhJyk7CiAgfTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnZmxleCc7Cn0KCi8vIOKUgOKUgCBQcm9maWxlIE1vZGFsIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJvZmlsZUJ0bicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgY29uc3QgcCA9IGF3YWl0IChhd2FpdCBmZXRjaChgJHtBUEl9L3Byb2ZpbGVgKSkuanNvbigpOwogIHdpbmRvdy5fcHJvZmlsZSA9IHA7CiAgT2JqZWN0LmtleXMocCkuZm9yRWFjaChrID0+IHsKICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3BfJyArIGspOwogICAgaWYgKGVsKSBlbC52YWx1ZSA9IEFycmF5LmlzQXJyYXkocFtrXSkgPyBwW2tdLmpvaW4oJywgJykgOiAocFtrXSB8fCAnJyk7CiAgfSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnZmxleCc7Cn07Cgpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJvZmlsZUZvcm0nKS5vbnN1Ym1pdCA9IGFzeW5jIChlKSA9PiB7CiAgZS5wcmV2ZW50RGVmYXVsdCgpOwogIGNvbnN0IGZkID0gbmV3IEZvcm1EYXRhKGUudGFyZ2V0KTsKICBjb25zdCBwID0ge307CiAgZmQuZm9yRWFjaCgodiwgaykgPT4geyBwW2tdID0gdjsgfSk7CiAgLy8gUGFyc2UgY29tbWEtc2VwYXJhdGVkIGZpZWxkcwogIGZvciAoY29uc3Qga2V5IG9mIFsnc2tpbGxzJywgJ3RhcmdldF90aXRsZXMnLCAncmVxdWlyZWRfa2V5d29yZHMnLCAnYm9udXNfa2V5d29yZHMnLCAnZGVhbF9icmVha2VycycsICdwcmVmZXJyZWRfd29ya190eXBlJywgJ3ByZWZlcnJlZF9sb2NhdGlvbnMnLCAncHJlZmVycmVkX2VtcGxveW1lbnQnXSkgewogICAgcFtrZXldID0gKHBba2V5XSB8fCAnJykuc3BsaXQoJywnKS5tYXAocyA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pOwogIH0KICBwLmV4cGVyaWVuY2VfeWVhcnMgPSBwYXJzZUludChwLmV4cGVyaWVuY2VfeWVhcnMpIHx8IDA7CiAgcC5zYWxhcnlfbWluX2xha2hzID0gcGFyc2VGbG9hdChwLnNhbGFyeV9taW5fbGFraHMpIHx8IDM1OwogIHAudGFyZ2V0X3NhbGFyeSA9IHsgY3VycmVuY3k6IHAuc2FsYXJ5X2N1cnJlbmN5IHx8ICdJTlInLCBtaW5fbGFraHM6IHAuc2FsYXJ5X21pbl9sYWtocyB9OwogIGF3YWl0IGZldGNoKGAke0FQSX0vcHJvZmlsZWAsIHsgbWV0aG9kOiAnUFVUJywgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sIGJvZHk6IEpTT04uc3RyaW5naWZ5KHApIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogIHRvYXN0KCdQcm9maWxlIHNhdmVkIScpOwogIGxvYWRQcm9maWxlKCk7Cn07CgovLyDilIDilIAgRXZlbnRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApmdW5jdGlvbiBiaW5kRXZlbnRzKCkgewogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjcmFwZUJ0bicpLmRpc2FibGVkID0gdHJ1ZTsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS50ZXh0Q29udGVudCA9ICdTY3JhcGluZy4uLic7CiAgICBhd2FpdCBmZXRjaChgJHtBUEl9L3NjcmFwZWAsIHsgbWV0aG9kOiAnUE9TVCcgfSk7CiAgICBzZXRUaW1lb3V0KCgpID0+IHsgbG9hZEpvYnMoKTsgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjcmFwZUJ0bicpLmRpc2FibGVkID0gZmFsc2U7IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS50ZXh0Q29udGVudCA9ICdTY3JhcGUgTm93JzsgfSwgMjAwMCk7CiAgfTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xlYXJGaWx0ZXJzJykub25jbGljayA9ICgpID0+IHsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJykudmFsdWUgPSAnJzsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZSA9ICcnOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlR5cGVGaWx0ZXInKS52YWx1ZSA9ICcnOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NlYXJjaElucHV0JykudmFsdWUgPSAnJzsKICAgIGxvYWRKb2JzKCk7CiAgfTsKCiAgZnVuY3Rpb24gb25GaWx0ZXJDaGFuZ2UoKSB7IGxvYWRKb2JzKCk7IHVwZGF0ZUNsZWFyQnV0dG9uKCk7IH0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzRmlsdGVyJykub25jaGFuZ2UgPSBsb2FkSm9iczsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY29tcGFueUZpbHRlcicpLm9uY2hhbmdlID0gb25GaWx0ZXJDaGFuZ2U7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlZ2lvbkZpbHRlcicpLm9uY2hhbmdlID0gb25GaWx0ZXJDaGFuZ2U7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlR5cGVGaWx0ZXInKS5vbmNoYW5nZSA9IG9uRmlsdGVyQ2hhbmdlOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3VyY2VGaWx0ZXInKS5vbmNoYW5nZSA9IGxvYWRKb2JzOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3J0RmlsdGVyJykub25jaGFuZ2UgPSBsb2FkSm9iczsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2VhcmNoSW5wdXQnKS5vbmlucHV0ID0gKCkgPT4geyBjbGVhclRpbWVvdXQod2luZG93Ll9zZWFyY2hUaW1lcik7IHdpbmRvdy5fc2VhcmNoVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsgbG9hZEpvYnMoKTsgdXBkYXRlQ2xlYXJCdXR0b24oKTsgfSwgMzAwKTsgfTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYnVsa1NhdmUnKS5vbmNsaWNrID0gYnVsa1NhdmU7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2J1bGtTa2lwJykub25jbGljayA9IGJ1bGtTa2lwTG93OwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbG9zZVByb2ZpbGVCdG4nKS5vbmNsaWNrID0gKCkgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NhbmNlbFByb2ZpbGVCdG4nKS5vbmNsaWNrID0gKCkgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Nsb3NlQXBwbHlCdG4nKS5vbmNsaWNrID0gKCkgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5TW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwp9CgovLyDilIDilIAgVXRpbHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmZ1bmN0aW9uIHRvYXN0KG1zZykgewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RvYXN0Jyk7CiAgZWwudGV4dENvbnRlbnQgPSBtc2c7IGVsLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snOwogIHNldFRpbWVvdXQoKCkgPT4gZWwuc3R5bGUuZGlzcGxheSA9ICdub25lJywgMjUwMCk7Cn0KCmZ1bmN0aW9uIGVzY2FwZUh0bWwocykgewogIGlmICghcykgcmV0dXJuICcnOwogIHJldHVybiBTdHJpbmcocykucmVwbGFjZSgvJi9nLCcmYW1wOycpLnJlcGxhY2UoLzwvZywnJmx0OycpLnJlcGxhY2UoLz4vZywnJmd0OycpLnJlcGxhY2UoLyIvZywnJnF1b3Q7Jyk7Cn0KCndpbmRvdy5jb3B5VGV4dCA9IGZ1bmN0aW9uKGlkKSB7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CiAgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoZWwudGV4dENvbnRlbnQpLnRoZW4oKCkgPT4gdG9hc3QoJ0NvdmVyIGxldHRlciBjb3BpZWQhJykpOwp9Owp3aW5kb3cubWFya0FjdGlvbiA9IG1hcmtBY3Rpb247CndpbmRvdy5vcGVuQXBwbHkgPSBvcGVuQXBwbHk7CndpbmRvdy5idWxrU2F2ZSA9IGJ1bGtTYXZlOwp3aW5kb3cuYnVsa1NraXBMb3cgPSBidWxrU2tpcExvdzsK';

const DASHBOARD_HTML_B64 = 'PCFET0NUWVBFIGh0bWw+DQo8aHRtbCBsYW5nPSJlbiI+DQo8aGVhZD4NCiAgPG1ldGEgY2hhcnNldD0iVVRGLTgiLz4NCiAgPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiLz4NCiAgPHRpdGxlPkpvYiBBZ2VudCB2Mi4xPC90aXRsZT4NCiAgPGxpbmsgcmVsPSJzdHlsZXNoZWV0IiBocmVmPSIvc3R5bGVzLmNzcz92PTQ4YzNlZjM3Ii8+DQo8L2hlYWQ+DQo8Ym9keT4NCiAgPGhlYWRlciBjbGFzcz0idG9wYmFyIj4NCiAgICA8ZGl2IGNsYXNzPSJicmFuZCI+DQogICAgICA8aDE+8J+UjiBKb2IgQWdlbnQ8L2gxPg0KICAgICAgPHNwYW4gY2xhc3M9InN1YiIgaWQ9InByb2ZpbGVOYW1lIj5Mb2FkaW5nLi4uPC9zcGFuPg0KICAgIDwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPg0KICAgICAgPGJ1dHRvbiBpZD0ic2NyYXBlQnRuIiBjbGFzcz0iYnRuLXByaW1hcnkiPvCflIQgU2NyYXBlIE5vdzwvYnV0dG9uPg0KICAgICAgPGJ1dHRvbiBpZD0icHJvZmlsZUJ0biIgY2xhc3M9ImJ0bi1naG9zdCI+8J+RpCBQcm9maWxlPC9idXR0b24+DQogICAgPC9kaXY+DQogIDwvaGVhZGVyPg0KDQogIDxtYWluPg0KICAgIDxzZWN0aW9uIGNsYXNzPSJzdGF0cyIgaWQ9InN0YXRzQmFyIj4NCiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxiPuKAlDwvYj48c3Bhbj5Ub3RhbCBKb2JzPC9zcGFuPjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+PGI+4oCUPC9iPjxzcGFuPk5ldzwvc3Bhbj48L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxiPuKAlDwvYj48c3Bhbj5TYXZlZDwvc3Bhbj48L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxiPuKAlDwvYj48c3Bhbj5BcHBsaWVkPC9zcGFuPjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+PGI+4oCUPC9iPjxzcGFuPlNraXBwZWQ8L3NwYW4+PC9kaXY+DQogICAgPC9zZWN0aW9uPg0KDQogICAgPHNlY3Rpb24gY2xhc3M9InRvb2xiYXIiPg0KICAgICAgPGRpdiBjbGFzcz0iZmlsdGVycyI+DQogICAgICAgIDxzZWxlY3QgaWQ9InN0YXR1c0ZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBzdGF0dXMiPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Im5ldyI+TmV3IEpvYnM8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJzYXZlZCI+U2F2ZWQ8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhcHBsaWVkIj5BcHBsaWVkPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2tpcHBlZCI+U2tpcHBlZDwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Imlnbm9yZWQiPklnbm9yZWQ8L29wdGlvbj4NCiAgICAgICAgPC9zZWxlY3Q+DQogICAgICAgIDxzZWxlY3QgaWQ9ImNvbXBhbnlGaWx0ZXIiIHRpdGxlPSJGaWx0ZXIgYnkgY29tcGFueSI+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgQ29tcGFuaWVzPC9vcHRpb24+DQogICAgICAgIDwvc2VsZWN0Pg0KICAgICAgICA8c2VsZWN0IGlkPSJyZWdpb25GaWx0ZXIiIHRpdGxlPSJGaWx0ZXIgYnkgcmVnaW9uIj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBSZWdpb25zPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iaW5kaWEiPvCfh67wn4ezIEluZGlhPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icmVtb3RlIj7wn4yQIFJlbW90ZTwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InVzYSI+8J+HuvCfh7ggVVNBPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iZXVyb3BlIj7wn4eq8J+HuiBFdXJvcGU8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhc2lhLXBhY2lmaWMiPvCfjI8gQXNpYS1QYWNpZmljPC9vcHRpb24+DQogICAgICAgIDwvc2VsZWN0Pg0KICAgICAgICA8c2VsZWN0IGlkPSJqb2JUeXBlRmlsdGVyIiB0aXRsZT0iRmlsdGVyIGJ5IGpvYiB0eXBlIj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBUeXBlczwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InJlbW90ZSI+UmVtb3RlIE9ubHk8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJvbnNpdGUiPk9uLXNpdGUgT25seTwvb3B0aW9uPg0KICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgPHNlbGVjdCBpZD0ic291cmNlRmlsdGVyIiB0aXRsZT0iRmlsdGVyIGJ5IHNvdXJjZSI+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgU291cmNlczwvb3B0aW9uPg0KICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgPHNlbGVjdCBpZD0ic29ydEZpbHRlciIgdGl0bGU9IlNvcnQgYnkiPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InNjb3JlIj5Tb3J0OiBTY29yZSAoZGVzYyk8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJwb3N0ZWQiPlNvcnQ6IE5ld2VzdDwvb3B0aW9uPg0KICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgPGlucHV0IGlkPSJzZWFyY2hJbnB1dCIgdHlwZT0idGV4dCIgcGxhY2Vob2xkZXI9IvCflI0gU2VhcmNoIHRpdGxlLCBrZXl3b3Jkcy4uLiIvPg0KICAgICAgICA8YnV0dG9uIGlkPSJjbGVhckZpbHRlcnMiIGNsYXNzPSJidG4tZ2hvc3QiIHN0eWxlPSJkaXNwbGF5Om5vbmUiPuKclSBDbGVhcjwvYnV0dG9uPg0KICAgICAgPC9kaXY+DQogICAgICA8ZGl2IGNsYXNzPSJidWxrLWFjdGlvbnMiPg0KICAgICAgICA8YnV0dG9uIGlkPSJidWxrU2F2ZSIgY2xhc3M9ImJ0bi1naG9zdCI+U2F2ZSBBbGwgVmlzaWJsZTwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIGlkPSJidWxrU2tpcCIgY2xhc3M9ImJ0bi1naG9zdCI+U2tpcCBBbGwgQmVsb3cgMzA8L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KICAgIDwvc2VjdGlvbj4NCg0KICAgIDxzZWN0aW9uIGNsYXNzPSJxdWV1ZSIgaWQ9ImpvYlF1ZXVlIj4NCiAgICAgIDxkaXYgY2xhc3M9ImVtcHR5LXN0YXRlIj5Mb2FkaW5nIGpvYnMuLi48L2Rpdj4NCiAgICA8L3NlY3Rpb24+DQogIDwvbWFpbj4NCg0KICA8IS0tIFByb2ZpbGUgTW9kYWwgLS0+DQogIDxkaXYgaWQ9InByb2ZpbGVNb2RhbCIgY2xhc3M9Im1vZGFsIiBzdHlsZT0iZGlzcGxheTpub25lIj4NCiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1jb250ZW50Ij4NCiAgICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWRlciI+DQogICAgICAgIDxoMj7wn5GkIEVkaXQgUHJvZmlsZTwvaDI+DQogICAgICAgIDxidXR0b24gaWQ9ImNsb3NlUHJvZmlsZUJ0biIgY2xhc3M9ImNsb3NlIj7inJU8L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KICAgICAgPGZvcm0gaWQ9InByb2ZpbGVGb3JtIj4NCiAgICAgICAgPGRpdiBjbGFzcz0iZm9ybS1ncmlkIj4NCiAgICAgICAgICA8bGFiZWw+TmFtZTxpbnB1dCBpZD0icF9uYW1lIiBuYW1lPSJuYW1lIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+RW1haWw8aW5wdXQgaWQ9InBfZW1haWwiIG5hbWU9ImVtYWlsIiB0eXBlPSJlbWFpbCIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPlBob25lPGlucHV0IGlkPSJwX3Bob25lIiBuYW1lPSJwaG9uZSIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPkxpbmtlZEluPGlucHV0IGlkPSJwX2xpbmtlZGluIiBuYW1lPSJsaW5rZWRpbiIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPkxvY2F0aW9uPGlucHV0IGlkPSJwX2xvY2F0aW9uIiBuYW1lPSJsb2NhdGlvbiIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPlJlc3VtZSBQYXRoPGlucHV0IGlkPSJwX3Jlc3VtZV9wYXRoIiBuYW1lPSJyZXN1bWVfcGF0aCIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPkV4cGVyaWVuY2UgKHllYXJzKTxpbnB1dCBpZD0icF9leHAiIG5hbWU9ImV4cGVyaWVuY2VfeWVhcnMiIHR5cGU9Im51bWJlciIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPkN1cnJlbnQgUm9sZTxpbnB1dCBpZD0icF9yb2xlIiBuYW1lPSJjdXJyZW50X3JvbGUiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5DdXJyZW50IENvbXBhbnk8aW5wdXQgaWQ9InBfY29tcGFueSIgbmFtZT0iY3VycmVudF9jb21wYW55Ii8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+U2tpbGxzIChjb21tYS1zZXBhcmF0ZWQpPGlucHV0IGlkPSJwX3NraWxscyIgbmFtZT0ic2tpbGxzIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+VGFyZ2V0IFRpdGxlcyAoY29tbWEtc2VwYXJhdGVkKTxpbnB1dCBpZD0icF90aXRsZXMiIG5hbWU9InRhcmdldF90aXRsZXMiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5SZXF1aXJlZCBLZXl3b3JkczxpbnB1dCBpZD0icF9yZXFfa3ciIG5hbWU9InJlcXVpcmVkX2tleXdvcmRzIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+Qm9udXMgS2V5d29yZHM8aW5wdXQgaWQ9InBfYm9udXNfa3ciIG5hbWU9ImJvbnVzX2tleXdvcmRzIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+TWluIFNhbGFyeSAoTGFraHMgSU5SKTxpbnB1dCBpZD0icF9taW5fc2FsYXJ5IiBuYW1lPSJzYWxhcnlfbWluX2xha2hzIiB0eXBlPSJudW1iZXIiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5TYWxhcnkgQ3VycmVuY3kNCiAgICAgICAgICAgIDxzZWxlY3QgaWQ9InBfY3VycmVuY3kiIG5hbWU9InNhbGFyeV9jdXJyZW5jeSI+DQogICAgICAgICAgICAgIDxvcHRpb24+SU5SPC9vcHRpb24+PG9wdGlvbj5VU0Q8L29wdGlvbj48b3B0aW9uPkVVUjwvb3B0aW9uPjxvcHRpb24+R0JQPC9vcHRpb24+DQogICAgICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgICA8L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5Xb3JrIFR5cGUNCiAgICAgICAgICAgIDxzZWxlY3QgaWQ9InBfd29ya190eXBlIiBuYW1lPSJ3b3JrX3R5cGUiIG11bHRpcGxlIHNpemU9IjMiPg0KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJyZW1vdGUiPlJlbW90ZTwvb3B0aW9uPg0KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJoeWJyaWQiPkh5YnJpZDwvb3B0aW9uPg0KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJvbi1zaXRlIj5Pbi1zaXRlPC9vcHRpb24+DQogICAgICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgICA8L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5QcmVmZXJyZWQgTG9jYXRpb25zPGlucHV0IGlkPSJwX2xvY2F0aW9ucyIgbmFtZT0ibG9jYXRpb25zIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+U3VtbWFyeTx0ZXh0YXJlYSBpZD0icF9zdW1tYXJ5IiBuYW1lPSJzdW1tYXJ5IiByb3dzPSIzIj48L3RleHRhcmVhPjwvbGFiZWw+DQogICAgICAgIDwvZGl2Pg0KICAgICAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj4NCiAgICAgICAgICA8YnV0dG9uIHR5cGU9InN1Ym1pdCIgY2xhc3M9ImJ0bi1wcmltYXJ5Ij5TYXZlIFByb2ZpbGU8L2J1dHRvbj4NCiAgICAgICAgICA8YnV0dG9uIHR5cGU9ImJ1dHRvbiIgaWQ9ImNhbmNlbFByb2ZpbGVCdG4iIGNsYXNzPSJidG4tZ2hvc3QiPkNhbmNlbDwvYnV0dG9uPg0KICAgICAgICA8L2Rpdj4NCiAgICAgIDwvZm9ybT4NCiAgICA8L2Rpdj4NCiAgPC9kaXY+DQoNCiAgPCEtLSBBcHBseSBNb2RhbCAtLT4NCiAgPGRpdiBpZD0iYXBwbHlNb2RhbCIgY2xhc3M9Im1vZGFsIiBzdHlsZT0iZGlzcGxheTpub25lIj4NCiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1jb250ZW50Ij4NCiAgICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWRlciI+DQogICAgICAgIDxoMj7wn5qAIFByZXBhcmUgQXBwbGljYXRpb248L2gyPg0KICAgICAgICA8YnV0dG9uIGlkPSJjbG9zZUFwcGx5QnRuIiBjbGFzcz0iY2xvc2UiPuKclTwvYnV0dG9uPg0KICAgICAgPC9kaXY+DQogICAgICA8ZGl2IGlkPSJhcHBseUNvbnRlbnQiPjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtYWN0aW9ucyI+DQogICAgICAgIDxhIGlkPSJhcHBseVVybEJ0biIgaHJlZj0iIyIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJidG4tcHJpbWFyeSI+T3BlbiBKb2IgUGFnZTwvYT4NCiAgICAgICAgPGJ1dHRvbiBpZD0ibWFya0FwcGxpZWRCdG4iIGNsYXNzPSJidG4tc3VjY2VzcyI+4pyFIE1hcmsgYXMgQXBwbGllZDwvYnV0dG9uPg0KICAgICAgPC9kaXY+DQogICAgPC9kaXY+DQogIDwvZGl2Pg0KDQogIDxkaXYgaWQ9InRvYXN0IiBjbGFzcz0idG9hc3QiPjwvZGl2Pg0KICA8c2NyaXB0IGlkPSJhcHAtanMtc3JjIiBzcmM9Ii9hcHAuanM/dD0yNzlmY2MwYyI+PC9zY3JpcHQ+DQo8L2JvZHk+DQo8L2h0bWw+';

// Dashboard HTML (base64 encoded to avoid require issues)
function getDashboardHtml(timestamp) {
  let html = getDashboardHtmlRaw();
  // Inject dynamic timestamp to bust JS cache on every page load
  html = html.replace('__TIMESTAMP__', String(timestamp));
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
    return handleRequest(req, env);
  },

  async schedule(event) {
    console.log('Running daily job scrape...');
    const result = await runScrape(event.env);
    console.log('Daily scrape completed:', JSON.stringify(result));
  }
};
