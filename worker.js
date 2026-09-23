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

const REGION_KEYWORDS = {
  india: ['india', 'mumbai', 'delhi', 'bangalore', 'hyderabad', 'chennai', 'pune', 'kolkata', 'ahmedabad', 'kochi', 'bangalore', 'bengaluru', 'blr', 'in ', '₹', 'inr', 'groww', 'tcs', 'wipro', 'infosys', 'tech mahindra', 'zomato', 'swiggy', 'flipkart', 'phonepe', 'cred', 'zerodha', 'meesho', 'razorpay', 'paytm', 'byju', 'unacademy', 'postman', 'browserstack', 'freshworks', 'zoho', 'make my trip', 'payu'],
  usa: ['usa', 'us ', 'united states', 'new york', 'san francisco', 'austin', 'seattle', 'boston', 'chicago', 'denver', 'atlanta', 'dallas', 'miami', 'los angeles', 'usd', 'us$'],
  europe: ['europe', 'uk ', 'london', 'berlin', 'paris', 'amsterdam', 'dublin', 'stockholm', 'oslo', 'helsinki', 'zurich', 'zurich', 'geneva', 'milan', 'madrid', 'barcelona', 'lisbon', 'eur', '€', 'eu'],
  'asia-pacific': ['china', 'shanghai', 'beijing', 'shenzhen', 'hong kong', 'taiwan', 'singapore', 'sydney', 'melbourne', 'tokyo', 'osaka', 'seoul', 'manila', 'jakarta', 'kuala lumpur', 'thailand', 'vietnam', 'philippines', 'cny', '¥', 'sgd', 'aud', 'jpy']
};

function classifyRegion(job) {
  const text = (job.location + ' ' + job.title + ' ' + job.description + ' ' + job.company).toLowerCase();
  for (const [region, keywords] of Object.entries(REGION_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) return region;
    }
  }
  return '';
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

  // Assign region to all jobs (including existing ones for backfill)
  for (const job of allJobs) {
    if (!job.region) job.region = classifyRegion(job);
  }

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
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (path === '/api/jobs' && req.method === 'GET') {
    const jobs = await loadData(env.JOBS_KV, 'jobs');
    const allJobs = jobs.jobs || [];
    const status = url.searchParams.get('status') || 'new';
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const company = url.searchParams.get('company') || '';
    const region = url.searchParams.get('region') || '';
    const jobType = url.searchParams.get('jobType') || '';
    const source = url.searchParams.get('source') || '';

    let filtered;
    if (status === 'all') {
      filtered = allJobs;
    } else {
      filtered = allJobs.filter(function(j) { return j.status === status; });
    }
    if (company) filtered = filtered.filter(function(j) { return (j.company || '').toLowerCase() === company.toLowerCase(); });
    if (region) filtered = filtered.filter(function(j) { return (j.region || classifyRegion(j)) === region; });
    if (jobType) {
      filtered = filtered.filter(function(j) {
        if (jobType === 'remote') return j.remote || j.work_type === 'remote';
        if (jobType === 'onsite') return !j.remote && j.work_type !== 'remote';
        return true;
      });
    }
    if (source) filtered = filtered.filter(function(j) { return j.source === source; });
    filtered = filtered.slice(0, limit);
    return new Response(JSON.stringify(filtered), { headers: { 'Content-Type': 'application/json' } });
  }

  if (path === '/api/filters' && req.method === 'GET') {
    const jobs = await loadData(env.JOBS_KV, 'jobs');
    const allJobs = jobs.jobs || [];
    const companies = [...new Set(allJobs.map(function(j) { return j.company; }))].sort();
    const regions = [...new Set(allJobs.map(function(j) { return j.region; })).values()].filter(Boolean).sort();
    const sources = [...new Set(allJobs.map(function(j) { return j.source; }))].sort();
    return new Response(JSON.stringify({ companies: companies, regions: regions, sources: sources }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (path === '/api/profile' && req.method === 'GET') {
    const profile = await loadData(env.JOBS_KV, 'profile');
    return new Response(JSON.stringify(profile), { headers: { 'Content-Type': 'application/json' } });
  }

  if (path === '/api/profile' && req.method === 'PUT') {
    const profile = await req.json();
    await saveData(env.JOBS_KV, 'profile', profile);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (path === '/api/apply' && req.method === 'POST') {
    const body = await req.json();
    const jobId = body.jobId;
    const jobs = await loadData(env.JOBS_KV, 'jobs');
    const jobList = jobs.jobs || [];
    const idx = jobList.findIndex(function(j) { return j.id === jobId; });
    if (idx >= 0) { jobList[idx].status = 'applied'; await saveData(env.JOBS_KV, 'jobs', { jobs: jobList }); }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (path === '/api/skip' && req.method === 'POST') {
    const body = await req.json();
    const jobId = body.jobId;
    const jobs = await loadData(env.JOBS_KV, 'jobs');
    const jobList = jobs.jobs || [];
    const idx = jobList.findIndex(function(j) { return j.id === jobId; });
    if (idx >= 0) { jobList[idx].status = 'skipped'; await saveData(env.JOBS_KV, 'jobs', { jobs: jobList }); }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (path === '/api/save' && req.method === 'POST') {
    const body = await req.json();
    const jobId = body.jobId;
    const jobs = await loadData(env.JOBS_KV, 'jobs');
    const jobList = jobs.jobs || [];
    const idx = jobList.findIndex(function(j) { return j.id === jobId; });
    if (idx >= 0) { jobList[idx].status = 'saved'; await saveData(env.JOBS_KV, 'jobs', { jobs: jobList }); }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (path === '/api/ignore' && req.method === 'POST') {
    const body = await req.json();
    const jobId = body.jobId;
    const jobs = await loadData(env.JOBS_KV, 'jobs');
    const jobList = jobs.jobs || [];
    const idx = jobList.findIndex(function(j) { return j.id === jobId; });
    if (idx >= 0) { jobList[idx].status = 'ignored'; await saveData(env.JOBS_KV, 'jobs', { jobs: jobList }); }
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (path === '/api/scrape' && req.method === 'POST') {
    const result = await runScrape(env);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
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
      { headers: { 'Content-Type': 'application/json' } });
  }

  // Read boards configuration
  if (path === '/api/config' && req.method === 'GET') {
    const cfg = await loadData(env.JOBS_KV, 'boards_config');
    return new Response(JSON.stringify(cfg), { headers: { 'Content-Type': 'application/json' } });
  }

  // Serve static assets
  if (path === '/styles.css') {
    return new Response(getStylesCss(), { headers: { 'Content-Type': 'text/css' } });
  }
  if (path === '/app.js') {
    return new Response(getAppJs(), { headers: { 'Content-Type': 'application/javascript' } });
  }

  // Serve dashboard HTML for SPA fallback
  return new Response(getDashboardHtml(), {
    headers: { 'Content-Type': 'text/html' }
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
const STYLES_CSS_B64 = 'LyogSm9iIEFnZW50IERhc2hib2FyZCBTdHlsZXMgKi8NCjpyb290IHsNCiAgLS1iZzogIzBmMTcyYTsgLS1zdXJmYWNlOiAjMWUyOTNiOyAtLXN1cmZhY2UyOiAjMzM0MTU1Ow0KICAtLWJvcmRlcjogIzMzNDE1NTsgLS10ZXh0OiAjZjFmNWY5OyAtLW11dGVkOiAjOTRhM2I4OyAtLWFjY2VudDogIzYwYTVmYTsNCiAgLS1ncmVlbjogIzRhZGU4MDsgLS1hbWJlcjogI2ZiYmYyNDsgLS1yZWQ6ICNmODcxNzE7DQp9DQoqIHsgYm94LXNpemluZzogYm9yZGVyLWJveDsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9DQpib2R5IHsgZm9udC1mYW1pbHk6IC1hcHBsZS1zeXN0ZW0sIEJsaW5rTWFjU3lzdGVtRm9udCwgJ1NlZ29lIFVJJywgc2Fucy1zZXJpZjsgYmFja2dyb3VuZDogdmFyKC0tYmcpOyBjb2xvcjogdmFyKC0tdGV4dCk7IG1pbi1oZWlnaHQ6IDEwMHZoOyB9DQoNCi8qIFRvcGJhciAqLw0KLnRvcGJhciB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgcGFkZGluZzogMXJlbSAxLjVyZW07IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgfQ0KLmJyYW5kIGgxIHsgZm9udC1zaXplOiAxLjJyZW07IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9DQouYnJhbmQgLnN1YiB7IGZvbnQtc2l6ZTogLjhyZW07IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0NCi5hY3Rpb25zIHsgZGlzcGxheTogZmxleDsgZ2FwOiAuNXJlbTsgfQ0KDQovKiBCdXR0b25zICovDQouYnRuLXByaW1hcnkgeyBiYWNrZ3JvdW5kOiAjMjU2M2ViOyBjb2xvcjogd2hpdGU7IGJvcmRlcjogbm9uZTsgcGFkZGluZzogLjVyZW0gMXJlbTsgYm9yZGVyLXJhZGl1czogOHB4OyBjdXJzb3I6IHBvaW50ZXI7IGZvbnQtc2l6ZTogLjg3NXJlbTsgZm9udC13ZWlnaHQ6IDUwMDsgfQ0KLmJ0bi1wcmltYXJ5OmhvdmVyIHsgYmFja2dyb3VuZDogIzFkNGVkODsgfQ0KLmJ0bi1naG9zdCB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UyKTsgY29sb3I6IHZhcigtLXRleHQpOyBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyBwYWRkaW5nOiAuNXJlbSAxcmVtOyBib3JkZXItcmFkaXVzOiA4cHg7IGN1cnNvcjogcG9pbnRlcjsgZm9udC1zaXplOiAuODc1cmVtOyB9DQouYnRuLWdob3N0OmhvdmVyIHsgYmFja2dyb3VuZDogIzQ3NTU2OTsgfQ0KLmJ0bi1zdWNjZXNzIHsgYmFja2dyb3VuZDogIzE2YTM0YTsgY29sb3I6IHdoaXRlOyBib3JkZXI6IG5vbmU7IHBhZGRpbmc6IC41cmVtIDFyZW07IGJvcmRlci1yYWRpdXM6IDhweDsgY3Vyc29yOiBwb2ludGVyOyBmb250LXNpemU6IC44NzVyZW07IH0NCi5idG4tZGFuZ2VyIHsgYmFja2dyb3VuZDogI2RjMjYyNjsgY29sb3I6IHdoaXRlOyBib3JkZXI6IG5vbmU7IHBhZGRpbmc6IC41cmVtIDFyZW07IGJvcmRlci1yYWRpdXM6IDhweDsgY3Vyc29yOiBwb2ludGVyOyBmb250LXNpemU6IC44NzVyZW07IH0NCg0KLyogU3RhdHMgYmFyICovDQouc3RhdHMgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IDFyZW07IHBhZGRpbmc6IDFyZW0gMS41cmVtOyBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgZmxleC13cmFwOiB3cmFwOyB9DQouc3RhdCB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyBib3JkZXItcmFkaXVzOiA4cHg7IHBhZGRpbmc6IC41cmVtIDFyZW07IGZvbnQtc2l6ZTogLjg1cmVtOyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBhbGlnbi1pdGVtczogY2VudGVyOyBtaW4td2lkdGg6IDkwcHg7IH0NCi5zdGF0IGIgeyBjb2xvcjogdmFyKC0tYWNjZW50KTsgZm9udC1zaXplOiAxLjJyZW07IH0NCi5zdGF0IHNwYW4geyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBmb250LXNpemU6IC43NXJlbTsgfQ0KDQovKiBUb29sYmFyICovDQoudG9vbGJhciB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgcGFkZGluZzogLjc1cmVtIDEuNXJlbTsgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IGZsZXgtd3JhcDogd3JhcDsgZ2FwOiAuNXJlbTsgfQ0KLmZpbHRlcnMgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IC41cmVtOyBmbGV4LXdyYXA6IHdyYXA7IH0NCi5maWx0ZXJzIHNlbGVjdCwgLmZpbHRlcnMgaW5wdXQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsgY29sb3I6IHZhcigtLXRleHQpOyBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyBwYWRkaW5nOiAuNHJlbSAuNzVyZW07IGJvcmRlci1yYWRpdXM6IDZweDsgZm9udC1zaXplOiAuODVyZW07IH0NCi5maWx0ZXJzIGlucHV0IHsgbWluLXdpZHRoOiAyMDBweDsgfQ0KLmJ1bGstYWN0aW9ucyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogLjVyZW07IH0NCg0KLyogSm9iIFF1ZXVlICovDQoucXVldWUgeyBwYWRkaW5nOiAxcmVtIDEuNXJlbTsgbWF4LXdpZHRoOiAxMjAwcHg7IH0NCi5qb2ItY2FyZCB7IGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOyBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyBib3JkZXItcmFkaXVzOiAxMnB4OyBtYXJnaW4tYm90dG9tOiAxcmVtOyBvdmVyZmxvdzogaGlkZGVuOyB9DQouam9iLWhlYWRlciB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBmbGV4LXN0YXJ0OyBnYXA6IDFyZW07IHBhZGRpbmc6IDFyZW07IGJhY2tncm91bmQ6ICMxNjIwMzI7IGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyB9DQouam9iLXJhbmsgeyBmb250LXNpemU6IDEuMnJlbTsgZm9udC13ZWlnaHQ6IDcwMDsgY29sb3I6IHZhcigtLWFjY2VudCk7IG1pbi13aWR0aDogMnJlbTsgfQ0KLmpvYi10aXRsZS1ibG9jayB7IGZsZXg6IDE7IH0NCi5qb2ItdGl0bGUtYmxvY2sgaDIgeyBmb250LXNpemU6IDFyZW07IGNvbG9yOiB2YXIoLS10ZXh0KTsgfQ0KLmpvYi1tZXRhIHsgZm9udC1zaXplOiAuODVyZW07IGNvbG9yOiB2YXIoLS1tdXRlZCk7IG1hcmdpbi10b3A6IC4yNXJlbTsgfQ0KLmJhZGdlcyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogLjRyZW07IGZsZXgtd3JhcDogd3JhcDsgbWFyZ2luLXRvcDogLjVyZW07IH0NCi5iYWRnZSB7IGZvbnQtc2l6ZTogLjdyZW07IHBhZGRpbmc6IDJweCA4cHg7IGJvcmRlci1yYWRpdXM6IDEycHg7IGZvbnQtd2VpZ2h0OiA1MDA7IH0NCi5iYWRnZS5zb3VyY2UgeyBiYWNrZ3JvdW5kOiAjMWUzYTVmOyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQ0KLmJhZGdlLnJlbW90ZSB7IGJhY2tncm91bmQ6ICMxNDUzMmQ7IGNvbG9yOiB2YXIoLS1ncmVlbik7IH0NCi5iYWRnZS5zYWxhcnkgeyBiYWNrZ3JvdW5kOiAjNDIyMDA2OyBjb2xvcjogdmFyKC0tYW1iZXIpOyB9DQouc2NvcmUtYmFyLXdyYXAgeyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBhbGlnbi1pdGVtczogZmxleC1lbmQ7IGdhcDogNHB4OyBtaW4td2lkdGg6IDEwMHB4OyB9DQouc2NvcmUtYmFyLXdyYXAgc3BhbiB7IGZvbnQtc2l6ZTogLjc1cmVtOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB9DQouc2NvcmUtYmFyIHsgaGVpZ2h0OiA2cHg7IGJvcmRlci1yYWRpdXM6IDNweDsgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZTIpOyB3aWR0aDogMTAwJTsgfQ0KLnNjb3JlLWZpbGwgeyBoZWlnaHQ6IDEwMCU7IGJvcmRlci1yYWRpdXM6IDNweDsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsgfQ0KDQouam9iLWJvZHkgeyBwYWRkaW5nOiAxcmVtOyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IC43NXJlbTsgfQ0KLnJlYXNvbnMgaDQsIC5kZXNjIGg0IHsgZm9udC1zaXplOiAuNzVyZW07IHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IGxldHRlci1zcGFjaW5nOiAuMDVlbTsgbWFyZ2luLWJvdHRvbTogLjVyZW07IH0NCi5yZWFzb25zIHVsIHsgbGlzdC1zdHlsZTogbm9uZTsgZGlzcGxheTogZmxleDsgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsgZ2FwOiA0cHg7IH0NCi5yZWFzb25zIGxpIHsgZm9udC1zaXplOiAuODVyZW07IGNvbG9yOiB2YXIoLS10ZXh0KTsgfQ0KLnJlYXNvbnMgbGkud2FybiB7IGNvbG9yOiB2YXIoLS1hbWJlcik7IH0NCi5kZXNjIHAgeyBmb250LXNpemU6IC44NXJlbTsgY29sb3I6IHZhcigtLW11dGVkKTsgbGluZS1oZWlnaHQ6IDEuNjsgfQ0KLmNsLWJveCB7IGJhY2tncm91bmQ6IHZhcigtLWJnKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgYm9yZGVyLXJhZGl1czogOHB4OyBwYWRkaW5nOiAuNzVyZW07IGZvbnQtc2l6ZTogLjg1cmVtOyBjb2xvcjogdmFyKC0tdGV4dCk7IHdoaXRlLXNwYWNlOiBwcmUtd3JhcDsgbGluZS1oZWlnaHQ6IDEuNjsgfQ0KLmNsLWJveCBidXR0b24geyBtYXJnaW4tdG9wOiAuNXJlbTsgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZTIpOyBjb2xvcjogdmFyKC0tYWNjZW50KTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgcGFkZGluZzogLjNyZW0gLjc1cmVtOyBib3JkZXItcmFkaXVzOiA2cHg7IGN1cnNvcjogcG9pbnRlcjsgZm9udC1zaXplOiAuOHJlbTsgfQ0KLmFjdGlvbnMgeyBkaXNwbGF5OiBmbGV4OyBnYXA6IC43NXJlbTsgZmxleC13cmFwOiB3cmFwOyBwYWRkaW5nLXRvcDogLjVyZW07IGJvcmRlci10b3A6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyB9DQouYWN0aW9ucyBhIHsgYmFja2dyb3VuZDogIzI1NjNlYjsgY29sb3I6IHdoaXRlOyBwYWRkaW5nOiAuNXJlbSAxcmVtOyBib3JkZXItcmFkaXVzOiA4cHg7IGZvbnQtc2l6ZTogLjg3NXJlbTsgZm9udC13ZWlnaHQ6IDUwMDsgdGV4dC1kZWNvcmF0aW9uOiBub25lOyBkaXNwbGF5OiBpbmxpbmUtZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgfQ0KLmFjdGlvbnMgYnV0dG9uIHsgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZTIpOyBjb2xvcjogdmFyKC0tdGV4dCk7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IHBhZGRpbmc6IC41cmVtIDFyZW07IGJvcmRlci1yYWRpdXM6IDhweDsgY3Vyc29yOiBwb2ludGVyOyBmb250LXNpemU6IC44cmVtOyB9DQouYWN0aW9ucyBidXR0b246aG92ZXIgeyBiYWNrZ3JvdW5kOiAjNDc1NTY5OyB9DQouc3RhdHVzLWJhZGdlIHsgZGlzcGxheTogaW5saW5lLWJsb2NrOyBmb250LXNpemU6IC43cmVtOyBwYWRkaW5nOiAycHggOHB4OyBib3JkZXItcmFkaXVzOiAxMnB4OyBtYXJnaW4tbGVmdDogLjVyZW07IH0NCi5zdGF0dXMtbmV3IHsgYmFja2dyb3VuZDogIzFlM2E1ZjsgY29sb3I6IHZhcigtLWFjY2VudCk7IH0NCi5zdGF0dXMtc2F2ZWQgeyBiYWNrZ3JvdW5kOiAjNDIyMDA2OyBjb2xvcjogdmFyKC0tYW1iZXIpOyB9DQouc3RhdHVzLWFwcGxpZWQgeyBiYWNrZ3JvdW5kOiAjMTQ1MzJkOyBjb2xvcjogdmFyKC0tZ3JlZW4pOyB9DQouc3RhdHVzLXNraXBwZWQgeyBiYWNrZ3JvdW5kOiAjNDUwYTBhOyBjb2xvcjogdmFyKC0tcmVkKTsgfQ0KLnN0YXR1cy1pZ25vcmVkIHsgYmFja2dyb3VuZDogIzFjMTkxNzsgY29sb3I6IHZhcigtLW11dGVkKTsgfQ0KDQovKiBFbXB0eSBzdGF0ZSAqLw0KLmVtcHR5LXN0YXRlIHsgY29sb3I6IHZhcigtLW11dGVkKTsgdGV4dC1hbGlnbjogY2VudGVyOyBwYWRkaW5nOiAzcmVtOyBmb250LXNpemU6IC45cmVtOyB9DQoNCi8qIE1vZGFsICovDQoubW9kYWwgeyBwb3NpdGlvbjogZml4ZWQ7IGluc2V0OiAwOyBiYWNrZ3JvdW5kOiByZ2JhKDAsMCwwLC42KTsgei1pbmRleDogMTAwOyBkaXNwbGF5OiBmbGV4OyBhbGlnbi1pdGVtczogY2VudGVyOyBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsgfQ0KLm1vZGFsLWNvbnRlbnQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgYm9yZGVyLXJhZGl1czogMTJweDsgd2lkdGg6IDkwJTsgbWF4LXdpZHRoOiA2MDBweDsgbWF4LWhlaWdodDogOTB2aDsgb3ZlcmZsb3cteTogYXV0bzsgfQ0KLm1vZGFsLWhlYWRlciB7IGRpc3BsYXk6IGZsZXg7IGFsaWduLWl0ZW1zOiBjZW50ZXI7IGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsgcGFkZGluZzogMXJlbSAxLjVyZW07IGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOyB9DQoubW9kYWwtaGVhZGVyIGgyIHsgZm9udC1zaXplOiAxLjFyZW07IH0NCi5tb2RhbC1oZWFkZXIgLmNsb3NlIHsgYmFja2dyb3VuZDogbm9uZTsgYm9yZGVyOiBub25lOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyBmb250LXNpemU6IDEuMnJlbTsgY3Vyc29yOiBwb2ludGVyOyB9DQoubW9kYWwtY29udGVudCBmb3JtIHsgcGFkZGluZzogMS41cmVtOyB9DQouZm9ybS1ncmlkIHsgZGlzcGxheTogZ3JpZDsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgMWZyOyBnYXA6IDFyZW07IH0NCi5mb3JtLWdyaWQgbGFiZWwgeyBkaXNwbGF5OiBmbGV4OyBmbGV4LWRpcmVjdGlvbjogY29sdW1uOyBnYXA6IC4yNXJlbTsgZm9udC1zaXplOiAuODVyZW07IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0NCi5mb3JtLWdyaWQgbGFiZWwgaW5wdXQsIC5mb3JtLWdyaWQgbGFiZWwgc2VsZWN0LCAuZm9ybS1ncmlkIGxhYmVsIHRleHRhcmVhIHsgYmFja2dyb3VuZDogdmFyKC0tYmcpOyBjb2xvcjogdmFyKC0tdGV4dCk7IGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7IHBhZGRpbmc6IC41cmVtOyBib3JkZXItcmFkaXVzOiA2cHg7IGZvbnQtc2l6ZTogLjlyZW07IH0NCi5mb3JtLWdyaWQgbGFiZWwgdGV4dGFyZWEgeyByZXNpemU6IHZlcnRpY2FsOyBtaW4taGVpZ2h0OiA2MHB4OyB9DQoubW9kYWwtYWN0aW9ucyB7IGRpc3BsYXk6IGZsZXg7IGdhcDogLjVyZW07IGp1c3RpZnktY29udGVudDogZmxleC1lbmQ7IHBhZGRpbmc6IDFyZW0gMS41cmVtOyBib3JkZXItdG9wOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgfQ0KLmFwcGx5LWNoZWNrbGlzdCB7IGxpc3Qtc3R5bGU6IG5vbmU7IHBhZGRpbmc6IDA7IH0NCi5hcHBseS1jaGVja2xpc3QgbGkgeyBwYWRkaW5nOiAuNXJlbSAwOyBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsgZGlzcGxheTogZmxleDsgYWxpZ24taXRlbXM6IGNlbnRlcjsgZ2FwOiAuNXJlbTsgZm9udC1zaXplOiAuOXJlbTsgfQ0KLmFwcGx5LWNoZWNrbGlzdCAudmFsIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IH0NCg0KLyogVG9hc3QgKi8NCi50b2FzdCB7IHBvc2l0aW9uOiBmaXhlZDsgYm90dG9tOiAxLjVyZW07IHJpZ2h0OiAxLjVyZW07IGJhY2tncm91bmQ6IHZhcigtLWdyZWVuKTsgY29sb3I6ICMwMDA7IHBhZGRpbmc6IC43NXJlbSAxLjI1cmVtOyBib3JkZXItcmFkaXVzOiA4cHg7IGZvbnQtc2l6ZTogLjg3NXJlbTsgZGlzcGxheTogbm9uZTsgei1pbmRleDogMjAwOyBmb250LXdlaWdodDogNTAwOyB9';
const APP_JS_B64 = 'LyoqDQogKiBhcHAuanMg4oCUIERhc2hib2FyZCBjbGllbnQtc2lkZSBsb2dpYw0KICovDQpjb25zdCBBUEkgPSAnL2FwaSc7DQpsZXQgYWxsSm9icyA9IFtdOw0KbGV0IGN1cnJlbnRKb2JJZCA9IG51bGw7DQoNCi8vIOKUgOKUgCBJbml0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignRE9NQ29udGVudExvYWRlZCcsIGFzeW5jICgpID0+IHsNCiAgYXdhaXQgbG9hZFByb2ZpbGUoKTsNCiAgYXdhaXQgbG9hZFN0YXRzKCk7DQogIGF3YWl0IGxvYWRTb3VyY2VzKCk7DQogIGF3YWl0IGxvYWRKb2JzKCk7DQogIGJpbmRFdmVudHMoKTsNCn0pOw0KDQovLyDilIDilIAgUHJvZmlsZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCmFzeW5jIGZ1bmN0aW9uIGxvYWRQcm9maWxlKCkgew0KICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCk7DQogIGNvbnN0IHAgPSBhd2FpdCByLmpzb24oKTsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVOYW1lJykudGV4dENvbnRlbnQgPSBwLm5hbWUgfHwgJ0pvYiBBZ2VudCc7DQogIHdpbmRvdy5fcHJvZmlsZSA9IHA7DQp9DQoNCmFzeW5jIGZ1bmN0aW9uIGxvYWRTb3VyY2VzKCkgew0KICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9qb2JzP2xpbWl0PTUwMDBgKTsNCiAgY29uc3Qgam9icyA9IGF3YWl0IHIuanNvbigpOw0KICBjb25zdCBzb3VyY2VzID0gWy4uLm5ldyBTZXQoam9icy5tYXAoaiA9PiBqLnNvdXJjZSkpXS5zb3J0KCk7DQogIGNvbnN0IHNlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3VyY2VGaWx0ZXInKTsNCiAgc291cmNlcy5mb3JFYWNoKHMgPT4gew0KICAgIGNvbnN0IG9wdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpOw0KICAgIG9wdC52YWx1ZSA9IHM7IG9wdC50ZXh0Q29udGVudCA9IHM7DQogICAgc2VsLmFwcGVuZENoaWxkKG9wdCk7DQogIH0pOw0KDQogIC8vIFBvcHVsYXRlIGNvbXBhbnkgZmlsdGVyDQogIGNvbnN0IGNvbXBhbmllcyA9IFsuLi5uZXcgU2V0KGpvYnMubWFwKGogPT4gai5jb21wYW55KSldLnNvcnQoKTsNCiAgY29uc3QgY29tcGFueVNlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJyk7DQogIGNvbXBhbmllcy5mb3JFYWNoKGMgPT4gew0KICAgIGNvbnN0IG9wdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpOw0KICAgIG9wdC52YWx1ZSA9IGM7IG9wdC50ZXh0Q29udGVudCA9IGM7DQogICAgY29tcGFueVNlbC5hcHBlbmRDaGlsZChvcHQpOw0KICB9KTsNCn0NCg0KLy8g4pSA4pSAIFN0YXRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KYXN5bmMgZnVuY3Rpb24gbG9hZFN0YXRzKCkgew0KICBjb25zdCBzID0gYXdhaXQgKGF3YWl0IGZldGNoKGAke0FQSX0vc3RhdHNgKSkuanNvbigpOw0KICBjb25zdCBlbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc3RhdCBiJyk7DQogIGVsc1swXS50ZXh0Q29udGVudCA9IHMudG90YWxfam9iczsNCiAgZWxzWzFdLnRleHRDb250ZW50ID0gcy5uZXdfam9iczsNCiAgZWxzWzJdLnRleHRDb250ZW50ID0gcy5zYXZlZF9qb2JzOw0KICBlbHNbM10udGV4dENvbnRlbnQgPSBzLmFwcGxpZWRfam9iczsNCiAgZWxzWzRdLnRleHRDb250ZW50ID0gcy5za2lwcGVkX2pvYnM7DQp9DQoNCi8vIOKUgOKUgCBKb2JzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KYXN5bmMgZnVuY3Rpb24gbG9hZEpvYnMoKSB7DQogIGNvbnN0IHN0YXR1cyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0dXNGaWx0ZXInKS52YWx1ZTsNCiAgY29uc3QgY29tcGFueSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJykudmFsdWU7DQogIGNvbnN0IHJlZ2lvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZTsNCiAgY29uc3Qgam9iVHlwZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykudmFsdWU7DQogIGNvbnN0IHNvdXJjZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3VyY2VGaWx0ZXInKS52YWx1ZTsNCiAgY29uc3Qgc29ydCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3J0RmlsdGVyJykudmFsdWU7DQogIGNvbnN0IHNlYXJjaCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZWFyY2hJbnB1dCcpLnZhbHVlLnRvTG93ZXJDYXNlKCk7DQoNCiAgbGV0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoeyBzdGF0dXMsIHNvcnQsIGxpbWl0OiA1MDAgfSk7DQogIGlmIChjb21wYW55KSBwYXJhbXMuc2V0KCdjb21wYW55JywgY29tcGFueSk7DQogIGlmIChyZWdpb24pIHBhcmFtcy5zZXQoJ3JlZ2lvbicsIHJlZ2lvbik7DQogIGlmIChqb2JUeXBlKSBwYXJhbXMuc2V0KCdqb2JUeXBlJywgam9iVHlwZSk7DQogIGlmIChzb3VyY2UpIHBhcmFtcy5zZXQoJ3NvdXJjZScsIHNvdXJjZSk7DQogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgJHtBUEl9L2pvYnM/JHtwYXJhbXN9YCk7DQogIGFsbEpvYnMgPSBhd2FpdCByLmpzb24oKTsNCg0KICAvLyBDbGllbnQtc2lkZSBzZWFyY2ggZmlsdGVyDQogIGlmIChzZWFyY2gpIHsNCiAgICBhbGxKb2JzID0gYWxsSm9icy5maWx0ZXIoaiA9Pg0KICAgICAgKGoudGl0bGUgfHwgJycpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKSB8fA0KICAgICAgKGouY29tcGFueSB8fCAnJykudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhzZWFyY2gpIHx8DQogICAgICAoai5kZXNjcmlwdGlvbiB8fCAnJykudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhzZWFyY2gpDQogICAgKTsNCiAgfQ0KDQogIHJlbmRlckpvYnMoYWxsSm9icyk7DQogIGxvYWRTdGF0cygpOw0KICB1cGRhdGVDbGVhckJ1dHRvbigpOw0KfQ0KDQpmdW5jdGlvbiB1cGRhdGVDbGVhckJ1dHRvbigpIHsNCiAgY29uc3QgaGFzRmlsdGVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKS52YWx1ZSB8fA0KICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVnaW9uRmlsdGVyJykudmFsdWUgfHwNCiAgICAgICAgICAgICAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlR5cGVGaWx0ZXInKS52YWx1ZSB8fA0KICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2VhcmNoSW5wdXQnKS52YWx1ZTsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NsZWFyRmlsdGVycycpLnN0eWxlLmRpc3BsYXkgPSBoYXNGaWx0ZXIgPyAnJyA6ICdub25lJzsNCn0NCg0KZnVuY3Rpb24gcmVuZGVySm9icyhqb2JzKSB7DQogIGNvbnN0IHEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnam9iUXVldWUnKTsNCiAgaWYgKGpvYnMubGVuZ3RoID09PSAwKSB7DQogICAgcS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0iZW1wdHktc3RhdGUiPk5vIGpvYnMgZm91bmQuIENsaWNrICJTY3JhcGUgTm93IiB0byBmZXRjaCBmcmVzaCBsaXN0aW5ncy48L2Rpdj4nOw0KICAgIHJldHVybjsNCiAgfQ0KICBxLmlubmVySFRNTCA9IGpvYnMubWFwKChqLCBpKSA9PiBqb2JDYXJkKGosIGkpKS5qb2luKCcnKTsNCn0NCg0KZnVuY3Rpb24gam9iQ2FyZChqb2IsIGluZGV4KSB7DQogIGNvbnN0IHJlYXNvbnMgPSAoam9iLm1hdGNoX3JlYXNvbnMgfHwgW10pLm1hcChyID0+IGA8bGk+4pyFICR7cn08L2xpPmApLmpvaW4oJycpOw0KICBjb25zdCB3YXJuaW5ncyA9IChqb2Iud2FybmluZ3MgfHwgW10pLmZpbHRlcih3ID0+IHcpLm1hcCh3ID0+IGA8bGkgY2xhc3M9Indhcm4iPuKaoO+4jyAke3d9PC9saT5gKS5qb2luKCcnKTsNCiAgY29uc3Qgc2FsYXJ5QmFkZ2UgPSBqb2Iuc2FsYXJ5ID8gYDxzcGFuIGNsYXNzPSJiYWRnZSBzYWxhcnkiPvCfkrAgJHtqb2Iuc2FsYXJ5fTwvc3Bhbj5gIDogJyc7DQogIGNvbnN0IHJlbW90ZUJhZGdlID0gam9iLnJlbW90ZSB8fCBqb2Iuc291cmNlID09PSAnUmVtb3RlT0snIHx8IGpvYi5zb3VyY2UgPT09ICdSZW1vdGl2ZScgfHwgam9iLnNvdXJjZSA9PT0gJ1dlV29ya1JlbW90ZWx5JyA/IGA8c3BhbiBjbGFzcz0iYmFkZ2UgcmVtb3RlIj7wn4yQIFJlbW90ZTwvc3Bhbj5gIDogJyc7DQogIGNvbnN0IGNsSHRtbCA9IGpvYi5jb3Zlcl9sZXR0ZXINCiAgICA/IGA8ZGl2IGNsYXNzPSJjbC1ib3giPiR7ZXNjYXBlSHRtbChqb2IuY292ZXJfbGV0dGVyLnNsaWNlKDAsIDQwMCkpfSR7am9iLmNvdmVyX2xldHRlci5sZW5ndGggPiA0MDAgPyAnLi4uJyA6ICcnfTxidXR0b24gb25jbGljaz0iY29weVRleHQoJ2NsLSR7aW5kZXh9JykiPkNvcHk8L2J1dHRvbj48L2Rpdj5gDQogICAgOiAnJzsNCiAgY29uc3Qgc3RhdHVzQ2xhc3MgPSBgc3RhdHVzLSR7am9iLnN0YXR1cyB8fCAnbmV3J31gOw0KICBjb25zdCBwY3QgPSBNYXRoLm1pbigxMDAsIE1hdGgucm91bmQoKGpvYi5zY29yZSB8fCAwKSAvIDEyMCAqIDEwMCkpOw0KICBjb25zdCBzY29yZUNvbG9yID0gcGN0ID49IDcwID8gJyM0YWRlODAnIDogcGN0ID49IDQwID8gJyNmYmJmMjQnIDogJyNmODcxNzEnOw0KDQogIHJldHVybiBgDQogIDxkaXYgY2xhc3M9ImpvYi1jYXJkIiBpZD0iam9iLSR7am9iLmlkfSI+DQogICAgPGRpdiBjbGFzcz0iam9iLWhlYWRlciI+DQogICAgICA8ZGl2IGNsYXNzPSJqb2ItcmFuayI+IyR7aW5kZXggKyAxfSA8c3BhbiBjbGFzcz0ic3RhdHVzLWJhZGdlICR7c3RhdHVzQ2xhc3N9Ij4keyhqb2Iuc3RhdHVzIHx8ICduZXcnKS50b1VwcGVyQ2FzZSgpfTwvc3Bhbj48L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9ImpvYi10aXRsZS1ibG9jayI+DQogICAgICAgIDxoMj4ke2VzY2FwZUh0bWwoam9iLnRpdGxlKX08L2gyPg0KICAgICAgICA8ZGl2IGNsYXNzPSJqb2ItbWV0YSI+JHtlc2NhcGVIdG1sKGpvYi5jb21wYW55KX0gwrcgJHtlc2NhcGVIdG1sKGpvYi5zb3VyY2UpfTwvZGl2Pg0KICAgICAgICA8ZGl2IGNsYXNzPSJiYWRnZXMiPg0KICAgICAgICAgIDxzcGFuIGNsYXNzPSJiYWRnZSBzb3VyY2UiPiR7ZXNjYXBlSHRtbChqb2Iuc291cmNlKX08L3NwYW4+DQogICAgICAgICAgJHtyZW1vdGVCYWRnZX0NCiAgICAgICAgICAke3NhbGFyeUJhZGdlfQ0KICAgICAgICA8L2Rpdj4NCiAgICAgIDwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0ic2NvcmUtYmFyLXdyYXAiPg0KICAgICAgICA8ZGl2IGNsYXNzPSJzY29yZS1iYXIiPjxkaXYgY2xhc3M9InNjb3JlLWZpbGwiIHN0eWxlPSJ3aWR0aDoke3BjdH0lO2JhY2tncm91bmQ6JHtzY29yZUNvbG9yfSI+PC9kaXY+PC9kaXY+DQogICAgICAgIDxzcGFuPiR7am9iLnNjb3JlfSBwdHM8L3NwYW4+DQogICAgICA8L2Rpdj4NCiAgICA8L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJqb2ItYm9keSI+DQogICAgICA8ZGl2IGNsYXNzPSJyZWFzb25zIj4NCiAgICAgICAgPGg0PldoeSB0aGlzIG1hdGNoZWQ8L2g0Pg0KICAgICAgICA8dWw+JHtyZWFzb25zfSR7d2FybmluZ3N9PC91bD4NCiAgICAgIDwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iZGVzYyI+DQogICAgICAgIDxoND5EZXNjcmlwdGlvbjwvaDQ+DQogICAgICAgIDxwPiR7ZXNjYXBlSHRtbCgoam9iLmRlc2NyaXB0aW9uIHx8ICcnKS5zbGljZSgwLCAzMDApKX0keyhqb2IuZGVzY3JpcHRpb24gfHwgJycpLmxlbmd0aCA+IDMwMCA/ICcuLi4gKGxpbmsgZm9yIGZ1bGwgdGV4dCknIDogJyd9PC9wPg0KICAgICAgPC9kaXY+DQogICAgICAke2NsSHRtbH0NCiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPg0KICAgICAgICA8YSBocmVmPSIke2VzY2FwZUh0bWwoam9iLnVybCl9IiB0YXJnZXQ9Il9ibGFuayIgY2xhc3M9ImJ0bi1hcHBseSI+8J+UlyBWaWV3IEpvYjwvYT4NCiAgICAgICAgPGJ1dHRvbiBvbmNsaWNrPSJvcGVuQXBwbHkoJyR7am9iLmlkfScpIj7wn5qAIFByZXBhcmUgQXBwbGljYXRpb248L2J1dHRvbj4NCiAgICAgICAgPGJ1dHRvbiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdzYXZlZCcpIj7wn5K+IFNhdmU8L2J1dHRvbj4NCiAgICAgICAgPGJ1dHRvbiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdza2lwcGVkJykiPuKPrSBTa2lwPC9idXR0b24+DQogICAgICAgIDxidXR0b24gb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9JywnaWdub3JlZCcpIj7wn5eRIElnbm9yZTwvYnV0dG9uPg0KICAgICAgPC9kaXY+DQogICAgPC9kaXY+DQogIDwvZGl2PmA7DQp9DQoNCi8vIOKUgOKUgCBBY3Rpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KYXN5bmMgZnVuY3Rpb24gbWFya0FjdGlvbihqb2JJZCwgYWN0aW9uKSB7DQogIGF3YWl0IGZldGNoKGAke0FQSX0vJHthY3Rpb259YCwgeyBtZXRob2Q6ICdQT1NUJywgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgam9iSWQgfSkgfSk7DQogIHRvYXN0KGAke2FjdGlvbi5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIGFjdGlvbi5zbGljZSgxKX1kIGpvYmApOw0KICBsb2FkSm9icygpOw0KfQ0KDQphc3luYyBmdW5jdGlvbiBidWxrU2F2ZSgpIHsNCiAgY29uc3QgdmlzaWJsZSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5qb2ItY2FyZCcpOw0KICB2aXNpYmxlLmZvckVhY2goZWwgPT4gew0KICAgIGNvbnN0IGpvYklkID0gZWwuaWQucmVwbGFjZSgnam9iLScsICcnKTsNCiAgICBtYXJrQWN0aW9uKGpvYklkLCAnc2F2ZWQnKTsNCiAgfSk7DQp9DQoNCmFzeW5jIGZ1bmN0aW9uIGJ1bGtTa2lwTG93KCkgew0KICBhbGxKb2JzLmZpbHRlcihqID0+IGouc2NvcmUgPCAzMCAmJiAoai5zdGF0dXMgPT09ICduZXcnKSkuZm9yRWFjaChqID0+IG1hcmtBY3Rpb24oai5pZCwgJ3NraXBwZWQnKSk7DQp9DQoNCi8vIOKUgOKUgCBBcHBseSBNb2RhbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCmZ1bmN0aW9uIG9wZW5BcHBseShqb2JJZCkgew0KICBjdXJyZW50Sm9iSWQgPSBqb2JJZDsNCiAgY29uc3Qgam9iID0gYWxsSm9icy5maW5kKGogPT4gai5pZCA9PT0gam9iSWQpOw0KICBpZiAoIWpvYikgcmV0dXJuOw0KICBjb25zdCBwID0gd2luZG93Ll9wcm9maWxlIHx8IHt9Ow0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlDb250ZW50JykuaW5uZXJIVE1MID0gYA0KICAgIDxoMz4ke2VzY2FwZUh0bWwoam9iLnRpdGxlKX0gQCAke2VzY2FwZUh0bWwoam9iLmNvbXBhbnkpfTwvaDM+DQogICAgPHAgc3R5bGU9ImNvbG9yOnZhcigtLW11dGVkKTttYXJnaW46LjVyZW0gMCI+JHtlc2NhcGVIdG1sKGpvYi5kZXNjcmlwdGlvbj8uc2xpY2UoMCwgMjAwKSkgfHwgJ05vIGRlc2NyaXB0aW9uIGF2YWlsYWJsZS4nfTwvcD4NCiAgICA8cCBzdHlsZT0ibWFyZ2luOi41cmVtIDAiPjxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBzdHlsZT0iY29sb3I6dmFyKC0tYWNjZW50KSI+VmlldyBmdWxsIGpvYiBsaXN0aW5nIOKGkjwvYT48L3A+DQogICAgPGg0PkFwcGxpY2F0aW9uIENoZWNrbGlzdDo8L2g0Pg0KICAgIDx1bCBjbGFzcz0iYXBwbHktY2hlY2tsaXN0Ij4NCiAgICAgIDxsaT48aW5wdXQgdHlwZT0iY2hlY2tib3giIGNoZWNrZWQgZGlzYWJsZWQ+IE5hbWU6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLm5hbWUgfHwgJ+KAlCcpfTwvc3Bhbj48L2xpPg0KICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gRW1haWw6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLmVtYWlsIHx8ICfigJQnKX08L3NwYW4+PC9saT4NCiAgICAgIDxsaT48aW5wdXQgdHlwZT0iY2hlY2tib3giIGNoZWNrZWQgZGlzYWJsZWQ+IFBob25lOiA8c3BhbiBjbGFzcz0idmFsIj4ke2VzY2FwZUh0bWwocC5waG9uZSB8fCAn4oCUJyl9PC9zcGFuPjwvbGk+DQogICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBSZXN1bWU6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLnJlc3VtZV9wYXRoIHx8ICdub3Qgc2V0Jyl9PC9zcGFuPjwvbGk+DQogICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBDb3ZlciBsZXR0ZXI6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7am9iLmNvdmVyX2xldHRlciA/ICfinJMgR2VuZXJhdGVkJyA6ICdSdW4gd2l0aCBBTlRIUk9QSUNfQVBJX0tFWSd9PC9zcGFuPjwvbGk+DQogICAgPC91bD4NCiAgYDsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5VXJsQnRuJykuaHJlZiA9IGpvYi51cmw7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtYXJrQXBwbGllZEJ0bicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7DQogICAgYXdhaXQgbWFya0FjdGlvbihqb2JJZCwgJ2FwcGxpZWQnKTsNCiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7DQogICAgdG9hc3QoJ01hcmtlZCBhcyBhcHBsaWVkIScpOw0KICB9Ow0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnZmxleCc7DQp9DQoNCi8vIOKUgOKUgCBQcm9maWxlIE1vZGFsIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVCdG4nKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gew0KICBjb25zdCBwID0gYXdhaXQgKGF3YWl0IGZldGNoKGAke0FQSX0vcHJvZmlsZWApKS5qc29uKCk7DQogIHdpbmRvdy5fcHJvZmlsZSA9IHA7DQogIE9iamVjdC5rZXlzKHApLmZvckVhY2goayA9PiB7DQogICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncF8nICsgayk7DQogICAgaWYgKGVsKSBlbC52YWx1ZSA9IEFycmF5LmlzQXJyYXkocFtrXSkgPyBwW2tdLmpvaW4oJywgJykgOiAocFtrXSB8fCAnJyk7DQogIH0pOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJvZmlsZU1vZGFsJykuc3R5bGUuZGlzcGxheSA9ICdmbGV4JzsNCn07DQoNCmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlRm9ybScpLm9uc3VibWl0ID0gYXN5bmMgKGUpID0+IHsNCiAgZS5wcmV2ZW50RGVmYXVsdCgpOw0KICBjb25zdCBmZCA9IG5ldyBGb3JtRGF0YShlLnRhcmdldCk7DQogIGNvbnN0IHAgPSB7fTsNCiAgZmQuZm9yRWFjaCgodiwgaykgPT4geyBwW2tdID0gdjsgfSk7DQogIC8vIFBhcnNlIGNvbW1hLXNlcGFyYXRlZCBmaWVsZHMNCiAgZm9yIChjb25zdCBrZXkgb2YgWydza2lsbHMnLCAndGFyZ2V0X3RpdGxlcycsICdyZXF1aXJlZF9rZXl3b3JkcycsICdib251c19rZXl3b3JkcycsICdkZWFsX2JyZWFrZXJzJywgJ3ByZWZlcnJlZF93b3JrX3R5cGUnLCAncHJlZmVycmVkX2xvY2F0aW9ucycsICdwcmVmZXJyZWRfZW1wbG95bWVudCddKSB7DQogICAgcFtrZXldID0gKHBba2V5XSB8fCAnJykuc3BsaXQoJywnKS5tYXAocyA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pOw0KICB9DQogIHAuZXhwZXJpZW5jZV95ZWFycyA9IHBhcnNlSW50KHAuZXhwZXJpZW5jZV95ZWFycykgfHwgMDsNCiAgcC5zYWxhcnlfbWluX2xha2hzID0gcGFyc2VGbG9hdChwLnNhbGFyeV9taW5fbGFraHMpIHx8IDM1Ow0KICBwLnRhcmdldF9zYWxhcnkgPSB7IGN1cnJlbmN5OiBwLnNhbGFyeV9jdXJyZW5jeSB8fCAnSU5SJywgbWluX2xha2hzOiBwLnNhbGFyeV9taW5fbGFraHMgfTsNCiAgYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCwgeyBtZXRob2Q6ICdQVVQnLCBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwgYm9keTogSlNPTi5zdHJpbmdpZnkocCkgfSk7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOw0KICB0b2FzdCgnUHJvZmlsZSBzYXZlZCEnKTsNCiAgbG9hZFByb2ZpbGUoKTsNCn07DQoNCi8vIOKUgOKUgCBFdmVudHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQpmdW5jdGlvbiBiaW5kRXZlbnRzKCkgew0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NyYXBlQnRuJykub25jbGljayA9IGFzeW5jICgpID0+IHsNCiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NyYXBlQnRuJykuZGlzYWJsZWQgPSB0cnVlOw0KICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS50ZXh0Q29udGVudCA9ICfij7MgU2NyYXBpbmcuLi4nOw0KICAgIGF3YWl0IGZldGNoKGAke0FQSX0vc2NyYXBlYCwgeyBtZXRob2Q6ICdQT1NUJyB9KTsNCiAgICBzZXRUaW1lb3V0KCgpID0+IHsgbG9hZEpvYnMoKTsgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjcmFwZUJ0bicpLmRpc2FibGVkID0gZmFsc2U7IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS50ZXh0Q29udGVudCA9ICfwn5SEIFNjcmFwZSBOb3cnOyB9LCAyMDAwKTsNCiAgfTsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NsZWFyRmlsdGVycycpLm9uY2xpY2sgPSAoKSA9PiB7DQogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKS52YWx1ZSA9ICcnOw0KICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZSA9ICcnOw0KICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykudmFsdWUgPSAnJzsNCiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2VhcmNoSW5wdXQnKS52YWx1ZSA9ICcnOw0KICAgIGxvYWRKb2JzKCk7DQogIH07DQoNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1c0ZpbHRlcicpLm9uY2hhbmdlID0gbG9hZEpvYnM7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJykub25jaGFuZ2UgPSBsb2FkSm9iczsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlZ2lvbkZpbHRlcicpLm9uY2hhbmdlID0gbG9hZEpvYnM7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykub25jaGFuZ2UgPSBsb2FkSm9iczsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NvdXJjZUZpbHRlcicpLm9uY2hhbmdlID0gbG9hZEpvYnM7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3J0RmlsdGVyJykub25jaGFuZ2UgPSBsb2FkSm9iczsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NlYXJjaElucHV0Jykub25pbnB1dCA9ICgpID0+IHsgY2xlYXJUaW1lb3V0KHdpbmRvdy5fc2VhcmNoVGltZXIpOyB3aW5kb3cuX3NlYXJjaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IGxvYWRKb2JzKCk7IHVwZGF0ZUNsZWFyQnV0dG9uKCk7IH0sIDMwMCk7IH07DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJykub25jaGFuZ2UgPSB1cGRhdGVDbGVhckJ1dHRvbjsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlZ2lvbkZpbHRlcicpLm9uY2hhbmdlID0gdXBkYXRlQ2xlYXJCdXR0b247DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykub25jaGFuZ2UgPSB1cGRhdGVDbGVhckJ1dHRvbjsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2J1bGtTYXZlJykub25jbGljayA9IGJ1bGtTYXZlOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYnVsa1NraXAnKS5vbmNsaWNrID0gYnVsa1NraXBMb3c7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbG9zZVByb2ZpbGVCdG4nKS5vbmNsaWNrID0gKCkgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjYW5jZWxQcm9maWxlQnRuJykub25jbGljayA9ICgpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xvc2VBcHBseUJ0bicpLm9uY2xpY2sgPSAoKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7DQp9DQoNCi8vIOKUgOKUgCBVdGlscyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCmZ1bmN0aW9uIHRvYXN0KG1zZykgew0KICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0b2FzdCcpOw0KICBlbC50ZXh0Q29udGVudCA9IG1zZzsgZWwuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7DQogIHNldFRpbWVvdXQoKCkgPT4gZWwuc3R5bGUuZGlzcGxheSA9ICdub25lJywgMjUwMCk7DQp9DQoNCmZ1bmN0aW9uIGVzY2FwZUh0bWwocykgew0KICBpZiAoIXMpIHJldHVybiAnJzsNCiAgcmV0dXJuIFN0cmluZyhzKS5yZXBsYWNlKC8mL2csJyZhbXA7JykucmVwbGFjZSgvPC9nLCcmbHQ7JykucmVwbGFjZSgvPi9nLCcmZ3Q7JykucmVwbGFjZSgvIi9nLCcmcXVvdDsnKTsNCn0NCg0Kd2luZG93LmNvcHlUZXh0ID0gZnVuY3Rpb24oaWQpIHsNCiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7DQogIG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KGVsLnRleHRDb250ZW50KS50aGVuKCgpID0+IHRvYXN0KCdDb3ZlciBsZXR0ZXIgY29waWVkIScpKTsNCn07DQp3aW5kb3cubWFya0FjdGlvbiA9IG1hcmtBY3Rpb247DQp3aW5kb3cub3BlbkFwcGx5ID0gb3BlbkFwcGx5Ow0Kd2luZG93LmJ1bGtTYXZlID0gYnVsa1NhdmU7DQp3aW5kb3cuYnVsa1NraXBMb3cgPSBidWxrU2tpcExvdzs=';

const DASHBOARD_HTML_B64 = 'PCFET0NUWVBFIGh0bWw+DQo8aHRtbCBsYW5nPSJlbiI+DQo8aGVhZD4NCiAgPG1ldGEgY2hhcnNldD0iVVRGLTgiLz4NCiAgPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiLz4NCiAgPHRpdGxlPkpvYiBBZ2VudCBEYXNoYm9hcmQ8L3RpdGxlPg0KICA8bGluayByZWw9InN0eWxlc2hlZXQiIGhyZWY9Ii9zdHlsZXMuY3NzIi8+DQo8L2hlYWQ+DQo8Ym9keT4NCiAgPGhlYWRlciBjbGFzcz0idG9wYmFyIj4NCiAgICA8ZGl2IGNsYXNzPSJicmFuZCI+DQogICAgICA8aDE+8J+UjiBKb2IgQWdlbnQ8L2gxPg0KICAgICAgPHNwYW4gY2xhc3M9InN1YiIgaWQ9InByb2ZpbGVOYW1lIj5Mb2FkaW5nLi4uPC9zcGFuPg0KICAgIDwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPg0KICAgICAgPGJ1dHRvbiBpZD0ic2NyYXBlQnRuIiBjbGFzcz0iYnRuLXByaW1hcnkiPvCflIQgU2NyYXBlIE5vdzwvYnV0dG9uPg0KICAgICAgPGJ1dHRvbiBpZD0icHJvZmlsZUJ0biIgY2xhc3M9ImJ0bi1naG9zdCI+8J+RpCBQcm9maWxlPC9idXR0b24+DQogICAgPC9kaXY+DQogIDwvaGVhZGVyPg0KDQogIDxtYWluPg0KICAgIDxzZWN0aW9uIGNsYXNzPSJzdGF0cyIgaWQ9InN0YXRzQmFyIj4NCiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxiPuKAlDwvYj48c3Bhbj5Ub3RhbCBKb2JzPC9zcGFuPjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+PGI+4oCUPC9iPjxzcGFuPk5ldzwvc3Bhbj48L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxiPuKAlDwvYj48c3Bhbj5TYXZlZDwvc3Bhbj48L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxiPuKAlDwvYj48c3Bhbj5BcHBsaWVkPC9zcGFuPjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+PGI+4oCUPC9iPjxzcGFuPlNraXBwZWQ8L3NwYW4+PC9kaXY+DQogICAgPC9zZWN0aW9uPg0KDQogICAgPHNlY3Rpb24gY2xhc3M9InRvb2xiYXIiPg0KICAgICAgPGRpdiBjbGFzcz0iZmlsdGVycyI+DQogICAgICAgIDxzZWxlY3QgaWQ9InN0YXR1c0ZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBzdGF0dXMiPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Im5ldyI+TmV3IEpvYnM8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJzYXZlZCI+U2F2ZWQ8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhcHBsaWVkIj5BcHBsaWVkPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2tpcHBlZCI+U2tpcHBlZDwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Imlnbm9yZWQiPklnbm9yZWQ8L29wdGlvbj4NCiAgICAgICAgPC9zZWxlY3Q+DQogICAgICAgIDxzZWxlY3QgaWQ9ImNvbXBhbnlGaWx0ZXIiIHRpdGxlPSJGaWx0ZXIgYnkgY29tcGFueSI+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgQ29tcGFuaWVzPC9vcHRpb24+DQogICAgICAgIDwvc2VsZWN0Pg0KICAgICAgICA8c2VsZWN0IGlkPSJyZWdpb25GaWx0ZXIiIHRpdGxlPSJGaWx0ZXIgYnkgcmVnaW9uIj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBSZWdpb25zPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iaW5kaWEiPvCfh67wn4ezIEluZGlhPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icmVtb3RlIj7wn4yQIFJlbW90ZTwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InVzYSI+8J+HuvCfh7ggVVNBPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iZXVyb3BlIj7wn4eq8J+HuiBFdXJvcGU8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhc2lhLXBhY2lmaWMiPvCfjI8gQXNpYS1QYWNpZmljPC9vcHRpb24+DQogICAgICAgIDwvc2VsZWN0Pg0KICAgICAgICA8c2VsZWN0IGlkPSJqb2JUeXBlRmlsdGVyIiB0aXRsZT0iRmlsdGVyIGJ5IGpvYiB0eXBlIj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBUeXBlczwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InJlbW90ZSI+UmVtb3RlIE9ubHk8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJvbnNpdGUiPk9uLXNpdGUgT25seTwvb3B0aW9uPg0KICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgPHNlbGVjdCBpZD0ic291cmNlRmlsdGVyIiB0aXRsZT0iRmlsdGVyIGJ5IHNvdXJjZSI+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgU291cmNlczwvb3B0aW9uPg0KICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgPHNlbGVjdCBpZD0ic29ydEZpbHRlciIgdGl0bGU9IlNvcnQgYnkiPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InNjb3JlIj5Tb3J0OiBTY29yZSAoZGVzYyk8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJwb3N0ZWQiPlNvcnQ6IE5ld2VzdDwvb3B0aW9uPg0KICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgPGlucHV0IGlkPSJzZWFyY2hJbnB1dCIgdHlwZT0idGV4dCIgcGxhY2Vob2xkZXI9IvCflI0gU2VhcmNoIHRpdGxlLCBrZXl3b3Jkcy4uLiIvPg0KICAgICAgICA8YnV0dG9uIGlkPSJjbGVhckZpbHRlcnMiIGNsYXNzPSJidG4tZ2hvc3QiIHN0eWxlPSJkaXNwbGF5Om5vbmUiPuKclSBDbGVhcjwvYnV0dG9uPg0KICAgICAgPC9kaXY+DQogICAgICA8ZGl2IGNsYXNzPSJidWxrLWFjdGlvbnMiPg0KICAgICAgICA8YnV0dG9uIGlkPSJidWxrU2F2ZSIgY2xhc3M9ImJ0bi1naG9zdCI+U2F2ZSBBbGwgVmlzaWJsZTwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIGlkPSJidWxrU2tpcCIgY2xhc3M9ImJ0bi1naG9zdCI+U2tpcCBBbGwgQmVsb3cgMzA8L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KICAgIDwvc2VjdGlvbj4NCg0KICAgIDxzZWN0aW9uIGNsYXNzPSJxdWV1ZSIgaWQ9ImpvYlF1ZXVlIj4NCiAgICAgIDxkaXYgY2xhc3M9ImVtcHR5LXN0YXRlIj5Mb2FkaW5nIGpvYnMuLi48L2Rpdj4NCiAgICA8L3NlY3Rpb24+DQogIDwvbWFpbj4NCg0KICA8IS0tIFByb2ZpbGUgTW9kYWwgLS0+DQogIDxkaXYgaWQ9InByb2ZpbGVNb2RhbCIgY2xhc3M9Im1vZGFsIiBzdHlsZT0iZGlzcGxheTpub25lIj4NCiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1jb250ZW50Ij4NCiAgICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWRlciI+DQogICAgICAgIDxoMj7wn5GkIEVkaXQgUHJvZmlsZTwvaDI+DQogICAgICAgIDxidXR0b24gaWQ9ImNsb3NlUHJvZmlsZUJ0biIgY2xhc3M9ImNsb3NlIj7inJU8L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KICAgICAgPGZvcm0gaWQ9InByb2ZpbGVGb3JtIj4NCiAgICAgICAgPGRpdiBjbGFzcz0iZm9ybS1ncmlkIj4NCiAgICAgICAgICA8bGFiZWw+TmFtZTxpbnB1dCBpZD0icF9uYW1lIiBuYW1lPSJuYW1lIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+RW1haWw8aW5wdXQgaWQ9InBfZW1haWwiIG5hbWU9ImVtYWlsIiB0eXBlPSJlbWFpbCIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPlBob25lPGlucHV0IGlkPSJwX3Bob25lIiBuYW1lPSJwaG9uZSIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPkxpbmtlZEluPGlucHV0IGlkPSJwX2xpbmtlZGluIiBuYW1lPSJsaW5rZWRpbiIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPkxvY2F0aW9uPGlucHV0IGlkPSJwX2xvY2F0aW9uIiBuYW1lPSJsb2NhdGlvbiIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPlJlc3VtZSBQYXRoPGlucHV0IGlkPSJwX3Jlc3VtZV9wYXRoIiBuYW1lPSJyZXN1bWVfcGF0aCIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPkV4cGVyaWVuY2UgKHllYXJzKTxpbnB1dCBpZD0icF9leHAiIG5hbWU9ImV4cGVyaWVuY2VfeWVhcnMiIHR5cGU9Im51bWJlciIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPkN1cnJlbnQgUm9sZTxpbnB1dCBpZD0icF9yb2xlIiBuYW1lPSJjdXJyZW50X3JvbGUiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5DdXJyZW50IENvbXBhbnk8aW5wdXQgaWQ9InBfY29tcGFueSIgbmFtZT0iY3VycmVudF9jb21wYW55Ii8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+U2tpbGxzIChjb21tYS1zZXBhcmF0ZWQpPGlucHV0IGlkPSJwX3NraWxscyIgbmFtZT0ic2tpbGxzIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+VGFyZ2V0IFRpdGxlcyAoY29tbWEtc2VwYXJhdGVkKTxpbnB1dCBpZD0icF90aXRsZXMiIG5hbWU9InRhcmdldF90aXRsZXMiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5SZXF1aXJlZCBLZXl3b3JkczxpbnB1dCBpZD0icF9yZXFfa3ciIG5hbWU9InJlcXVpcmVkX2tleXdvcmRzIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+Qm9udXMgS2V5d29yZHM8aW5wdXQgaWQ9InBfYm9udXNfa3ciIG5hbWU9ImJvbnVzX2tleXdvcmRzIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+TWluIFNhbGFyeSAoTGFraHMgSU5SKTxpbnB1dCBpZD0icF9taW5fc2FsYXJ5IiBuYW1lPSJzYWxhcnlfbWluX2xha2hzIiB0eXBlPSJudW1iZXIiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5TYWxhcnkgQ3VycmVuY3kNCiAgICAgICAgICAgIDxzZWxlY3QgaWQ9InBfY3VycmVuY3kiIG5hbWU9InNhbGFyeV9jdXJyZW5jeSI+DQogICAgICAgICAgICAgIDxvcHRpb24+SU5SPC9vcHRpb24+PG9wdGlvbj5VU0Q8L29wdGlvbj48b3B0aW9uPkVVUjwvb3B0aW9uPjxvcHRpb24+R0JQPC9vcHRpb24+DQogICAgICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgICA8L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5Xb3JrIFR5cGUNCiAgICAgICAgICAgIDxzZWxlY3QgaWQ9InBfd29ya190eXBlIiBuYW1lPSJ3b3JrX3R5cGUiIG11bHRpcGxlIHNpemU9IjMiPg0KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJyZW1vdGUiPlJlbW90ZTwvb3B0aW9uPg0KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJoeWJyaWQiPkh5YnJpZDwvb3B0aW9uPg0KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJvbi1zaXRlIj5Pbi1zaXRlPC9vcHRpb24+DQogICAgICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgICA8L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5QcmVmZXJyZWQgTG9jYXRpb25zPGlucHV0IGlkPSJwX2xvY2F0aW9ucyIgbmFtZT0ibG9jYXRpb25zIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+U3VtbWFyeTx0ZXh0YXJlYSBpZD0icF9zdW1tYXJ5IiBuYW1lPSJzdW1tYXJ5IiByb3dzPSIzIj48L3RleHRhcmVhPjwvbGFiZWw+DQogICAgICAgIDwvZGl2Pg0KICAgICAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj4NCiAgICAgICAgICA8YnV0dG9uIHR5cGU9InN1Ym1pdCIgY2xhc3M9ImJ0bi1wcmltYXJ5Ij5TYXZlIFByb2ZpbGU8L2J1dHRvbj4NCiAgICAgICAgICA8YnV0dG9uIHR5cGU9ImJ1dHRvbiIgaWQ9ImNhbmNlbFByb2ZpbGVCdG4iIGNsYXNzPSJidG4tZ2hvc3QiPkNhbmNlbDwvYnV0dG9uPg0KICAgICAgICA8L2Rpdj4NCiAgICAgIDwvZm9ybT4NCiAgICA8L2Rpdj4NCiAgPC9kaXY+DQoNCiAgPCEtLSBBcHBseSBNb2RhbCAtLT4NCiAgPGRpdiBpZD0iYXBwbHlNb2RhbCIgY2xhc3M9Im1vZGFsIiBzdHlsZT0iZGlzcGxheTpub25lIj4NCiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1jb250ZW50Ij4NCiAgICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWRlciI+DQogICAgICAgIDxoMj7wn5qAIFByZXBhcmUgQXBwbGljYXRpb248L2gyPg0KICAgICAgICA8YnV0dG9uIGlkPSJjbG9zZUFwcGx5QnRuIiBjbGFzcz0iY2xvc2UiPuKclTwvYnV0dG9uPg0KICAgICAgPC9kaXY+DQogICAgICA8ZGl2IGlkPSJhcHBseUNvbnRlbnQiPjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtYWN0aW9ucyI+DQogICAgICAgIDxhIGlkPSJhcHBseVVybEJ0biIgaHJlZj0iIyIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJidG4tcHJpbWFyeSI+T3BlbiBKb2IgUGFnZTwvYT4NCiAgICAgICAgPGJ1dHRvbiBpZD0ibWFya0FwcGxpZWRCdG4iIGNsYXNzPSJidG4tc3VjY2VzcyI+4pyFIE1hcmsgYXMgQXBwbGllZDwvYnV0dG9uPg0KICAgICAgPC9kaXY+DQogICAgPC9kaXY+DQogIDwvZGl2Pg0KDQogIDxkaXYgaWQ9InRvYXN0IiBjbGFzcz0idG9hc3QiPjwvZGl2Pg0KICA8c2NyaXB0IHNyYz0iL2FwcC5qcyI+PC9zY3JpcHQ+DQo8L2JvZHk+DQo8L2h0bWw+';

// Dashboard HTML (base64 encoded to avoid require issues)
function getDashboardHtml() {
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
