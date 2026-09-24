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
  // Use high-priority keywords for scraping, prioritizing GCP and cloud terms
  const keywords = profile.required_keywords || ['GCP', 'Cloud'];
  const searchKeywords = ['GCP', 'Google Cloud', 'DevOps', 'Platform Engineer', 'SRE', 'Kubernetes', 'Terraform'];
  const selectedKeywords = searchKeywords.filter(function(kw) {
    return keywords.some(function(k) { return k.toLowerCase().includes(kw.toLowerCase()); });
  });
  const primaryKeywords = selectedKeywords.length > 0 ? selectedKeywords : ['GCP', 'DevOps'];

  const results = await Promise.allSettled([
    scrapeLinkedInRSS(primaryKeywords[0], kv),
    // Free-to-apply sources (direct company APIs - no paywall)
    scrapeGreenhouseFiltered(primaryKeywords[0], kv),
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
  // Filter out very short deal-breaker keywords to avoid false positives in descriptions
  const meaningfulDealBreakers = deal_breakers.filter(function(kw) { return kw.length >= 3; });
  const breakers = containsAny(textForDealBreakers, meaningfulDealBreakers, true);
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

  // ── GCP Priority Boost ──────────────────────────────────────────────────────
  // GCP is the user's strongest skill — boost matching significantly
  const isGCP = /\bgcp\b|google\s*cloud/i.test(normalize(job.title + ' ' + fullText));
  const hasGCPCert = /Google Professional Cloud Architect|GCP Associate Cloud Engineer/i.test(profile.certifications || []);

  // ── Title match ────────────────────────────────────────────────────────────
  const titleMatch = containsAny(job.title, target_titles, false);
  let hasTitleSignal = false;

  if (titleMatch.length > 0) {
    score += 40;
    reasons.push('Title match: "' + titleMatch[0] + '"');
    hasTitleSignal = true;
    // Extra boost for GCP roles
    if (isGCP) {
      score += 15;
      reasons.push('GCP platform match');
    }
  } else {
    const simScore = titleSimilarity(job.title, target_titles);
    if (simScore > 0.3) {
      // Reject fuzzy matches that lack any engineering/cloud signal in title
      const hasTechSignal = /engineer|architect|developer|infra|devops|sre|gcp|google\s*cloud|aws|azure|kubernetes|terraform|cloud/i.test(normalize(job.title));
      if (!hasTechSignal) {
        return Object.assign({}, job, { score: -999, match_reasons: [], warnings: ['No engineering signal in title'] });
      }
      score += Math.round(25 * simScore);
      reasons.push('Title similarity: ' + Math.round(simScore * 100) + '%');
      hasTitleSignal = true;
      // Extra boost for GCP roles
      if (isGCP) {
        score += 12;
        reasons.push('GCP platform match');
      }
    }
  }

  // ── Skip keywords ──────────────────────────────────────────────────────────
  // Jobs whose titles contain keywords from previously skipped jobs get blocked
  const skipKw = profile.skip_keywords || [];
  if (skipKw.length > 0) {
    const skipMatch = containsAny(job.title, skipKw, false);
    if (skipMatch.length > 0) {
      return Object.assign({}, job, { score: -999, match_reasons: [], warnings: ['Skipped keyword: ' + skipMatch[0]] });
    }
  }

  // ── Reject generic management roles without IC engineering context ─────────
  // E.g., "Business Development Manager" → blocked; "Engineering Manager" → blocked;
  // "Site Reliability Engineer" → passes
  const titleLower = normalize(job.title);
  if (/\bmanager\b/i.test(titleLower)) {
    const mangled = titleLower.replace(/,\s*.*$/, '').trim();
    const hasTechRole = /\b(?:engineer|architect|developer|analyst|scientist|programmer)\b/i.test(mangled);
    const hasCloudSignal = /gcp|google\s*cloud|aws|azure|kubernetes|terraform|infra|devops|sre|cloud/i.test(mangled);
    if (!hasTechRole && !hasCloudSignal) {
      return Object.assign({}, job, { score: -999, match_reasons: [], warnings: ['Management role without IC engineering title'] });
    }
  }

  // ── Required skills ────────────────────────────────────────────────────────
  const reqMatches = containsAny(fullText, required_keywords, false);
  // Cap at 3 keywords — beyond that, marginal mentions shouldn't dominate the score
  const reqScore = Math.min(reqMatches.length, 3) * 8;
  score += reqScore;
  if (reqMatches.length > 0) reasons.push('Required skills: ' + reqMatches.slice(0, 4).join(', '));

  // ── GCP Keyword Bonus ──────────────────────────────────────────────────────
  const gcpKeywords = ['GCP', 'Google Cloud', 'BigQuery', 'Cloud Composer', 'Pub/Sub', 'Cloud Run', 'Cloud Build'];
  const gcpMatches = gcpKeywords.filter(function(kw) { return fullText.toLowerCase().includes(kw.toLowerCase()); });
  if (gcpMatches.length > 0) {
    const gcpBonus = gcpMatches.length * 5;
    score += gcpBonus;
    reasons.push('GCP stack: ' + gcpMatches.join(', '));
  }

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
  // Re-score all jobs with updated profile
  if (path === '/api/rescore' && req.method === 'POST') {
    const profile = await loadData(env.JOBS_KV, 'profile');
    if (!profile.name) return new Response(JSON.stringify({ error: 'No profile found' }), { status: 400 });
    const savedJobs = await loadData(env.JOBS_KV, 'jobs');
    const jobList = savedJobs.jobs || [];
    
    // Fast pre-filter: only rescore jobs with strong potential to avoid CPU timeout
    const preFilterKeywords = profile.required_keywords || [];
    const preFilterTitles = profile.target_titles || [];
    const now = Date.now();

    // Only process jobs with exact title keyword matches OR very recent posts OR existing positive scores
    const promisingJobs = jobList.filter(function(j) {
      const title = (j.title || '').toLowerCase();
      // Check for strong title matches (exact keyword presence)
      const hasStrongTitleMatch = preFilterTitles.some(function(t) {
        return title.includes(t.toLowerCase());
      });
      // Check for keyword matches in title
      const hasKeywordInTitle = preFilterKeywords.some(function(kw) {
        return title.includes(kw.toLowerCase());
      });
      // Very recent jobs (within 7 days)
      const isVeryRecent = j.posted_at && (now - new Date(j.posted_at).getTime()) < 7 * 24 * 60 * 60 * 1000;
      // Already has positive score
      const hasExistingScore = (j.score || 0) > 0;
      return hasStrongTitleMatch || hasKeywordInTitle || isVeryRecent || hasExistingScore;
    });
    
    const rescored = promisingJobs.map(function(j) {
      const scored = scoreJob(j, profile);
      if (j.status && j.status !== 'new') scored.status = j.status;
      return scored;
    });
    
    // Merge back into full job list
    const rescoredIds = new Set(rescored.map(function(j) { return j.id; }));
    const unchangedJobs = jobList.filter(function(j) { return !rescoredIds.has(j.id); });
    const allJobs = unchangedJobs.concat(rescored);
    
    await saveData(env.JOBS_KV, 'jobs', { jobs: allJobs });
    const matched = allJobs.filter(function(j) { return j.score >= 35; }).length;
    const runStats = await loadData(env.JOBS_KV, 'scrape_runs');
    runStats.lastRun = { fetched: rescored.length, total: allJobs.length, matched: matched, at: new Date().toISOString() };
    await saveData(env.JOBS_KV, 'scrape_runs', runStats);
    return new Response(JSON.stringify({ success: true, rescored: rescored.length, total: allJobs.length, matched: matched }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
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
    const ignored = (jobs.jobs || []).filter(function(j) { return j.status === 'ignored'; }).length;
    return new Response(JSON.stringify({
      total_jobs: total, new_jobs: newJobs, applied_jobs: applied,
      skipped_jobs: skipped, saved_jobs: saved, ignored_jobs: ignored,
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
    if (idx >= 0) {
      jobList[idx].status = 'ignored';
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
  return new Response(getDashboardHtml(Date.now(), "d4e7f2a9"), {
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
const STYLES_CSS_B64 = 'LyogTWlzc2lvbiBDb250cm9sIERhc2hib2FyZCAqLwpAaW1wb3J0IHVybCgnaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbS9jc3MyP2ZhbWlseT1JbnRlcjp3Z2h0QDQwMDs1MDA7NjAwOzcwMCZmYW1pbHk9SmV0QnJhaW5zK01vbm86d2dodEA0MDA7NTAwOzYwMCZkaXNwbGF5PXN3YXAnKTsKCjpyb290IHsKICAtLWJnOiAjMDgwOTBEOwogIC0tc3VyZmFjZTogIzExMTMxODsKICAtLXN1cmZhY2UyOiAjMUExRDI3OwogIC0tYm9yZGVyOiAjMUYyOTM3OwogIC0tYm9yZGVyLXN1YnRsZTogIzI1MkMzQjsKICAtLXRleHQ6ICNFNUU3RUI7CiAgLS1tdXRlZDogIzZCNzI4MDsKICAtLW11dGVkLWRpbTogIzM3NDE1MTsKICAtLWFjY2VudDogIzAwRDRGRjsKICAtLWFjY2VudC1kaW06IHJnYmEoMCwgMjEyLCAyNTUsIDAuMTIpOwogIC0tZ3JlZW46ICMxMEI5ODE7CiAgLS1ncmVlbi1kaW06IHJnYmEoMTYsIDE4NSwgMTI5LCAwLjEyKTsKICAtLWFtYmVyOiAjRjU5RTBCOwogIC0tYW1iZXItZGltOiByZ2JhKDI0NSwgMTU4LCAxMSwgMC4xMik7CiAgLS1yZWQ6ICNFRjQ0NDQ7CiAgLS1yZWQtZGltOiByZ2JhKDIzOSwgNjgsIDY4LCAwLjEyKTsKfQoKKiB7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7IG1hcmdpbjogMDsgcGFkZGluZzogMDsgfQoKYm9keSB7CiAgZm9udC1mYW1pbHk6ICdJbnRlcicsIC1hcHBsZS1zeXN0ZW0sIEJsaW5rTWFjU3lzdGVtRm9udCwgc2Fucy1zZXJpZjsKICBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7CiAgY29sb3I6IHZhcigtLXRleHQpOwogIG1pbi1oZWlnaHQ6IDEwMHZoOwogIGZvbnQtc2l6ZTogMTRweDsKICBsaW5lLWhlaWdodDogMS41Owp9CgovKiDilIDilIAgVG9wIEJhciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KLnRvcGJhciB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsKICBwYWRkaW5nOiAwIDEuNXJlbTsKICBoZWlnaHQ6IDQ4cHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcG9zaXRpb246IHN0aWNreTsKICB0b3A6IDA7CiAgei1pbmRleDogMTA7Cn0KCi50b3BiYXItYnJhbmQgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGJhc2VsaW5lOwogIGdhcDogLjc1cmVtOwp9CgoudG9wYmFyLWJyYW5kIGgxIHsKICBmb250LXNpemU6IDEzcHg7CiAgZm9udC13ZWlnaHQ6IDcwMDsKICBsZXR0ZXItc3BhY2luZzogLjA4ZW07CiAgY29sb3I6IHZhcigtLWFjY2VudCk7CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKfQoKLnRvcGJhci1tZXRhIHsKICBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOwogIGZvbnQtc2l6ZTogMTFweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwogIGRpc3BsYXk6IGZsZXg7CiAgZ2FwOiAxcmVtOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7Cn0KCi50b3BiYXItbWV0YSAuZG90IHsKICB3aWR0aDogM3B4OwogIGhlaWdodDogM3B4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1tdXRlZC1kaW0pOwp9CgoudG9wYmFyLW1ldGEgLmxpdmUtZG90IHsKICB3aWR0aDogNnB4OwogIGhlaWdodDogNnB4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgYm94LXNoYWRvdzogMCAwIDZweCB2YXIoLS1ncmVlbik7Cn0KCi50b3BiYXItYWN0aW9ucyB7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IC41cmVtOwp9CgovKiDilIDilIAgQnV0dG9ucyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KLmJ0biB7CiAgZm9udC1mYW1pbHk6ICdJbnRlcicsIHNhbnMtc2VyaWY7CiAgZm9udC1zaXplOiAxMnB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgcGFkZGluZzogLjM3NXJlbSAuNzVyZW07CiAgYm9yZGVyLXJhZGl1czogNHB4OwogIGN1cnNvcjogcG9pbnRlcjsKICBib3JkZXI6IG5vbmU7CiAgdHJhbnNpdGlvbjogYmFja2dyb3VuZCAuMTVzLCBib3JkZXItY29sb3IgLjE1czsKfQoKLmJ0bi1wcmltYXJ5IHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQpOwogIGNvbG9yOiB2YXIoLS1iZyk7Cn0KLmJ0bi1wcmltYXJ5OmhvdmVyIHsgYmFja2dyb3VuZDogIzMzREZGRjsgfQoKLmJ0bi1naG9zdCB7CiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5idG4tZ2hvc3Q6aG92ZXIgewogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UyKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1ib3JkZXItc3VidGxlKTsKfQoKLyog4pSA4pSAIFN0YXQgU3RyaXAg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5zdGF0LXN0cmlwIHsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogMDsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKfQoKLnN0YXQtY2VsbCB7CiAgZmxleDogMTsKICBwYWRkaW5nOiAuNzVyZW0gMS4yNXJlbTsKICBib3JkZXItcmlnaHQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBnYXA6IDJweDsKfQouc3RhdC1jZWxsOmxhc3QtY2hpbGQgeyBib3JkZXItcmlnaHQ6IG5vbmU7IH0KCi5zdGF0LWNlbGwgLm51bSB7CiAgZm9udC1mYW1pbHk6ICdKZXRCcmFpbnMgTW9ubycsIG1vbm9zcGFjZTsKICBmb250LXNpemU6IDIwcHg7CiAgZm9udC13ZWlnaHQ6IDYwMDsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgbGluZS1oZWlnaHQ6IDE7Cn0KCi5zdGF0LWNlbGwgLm51bS5hY2NlbnQgeyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQouc3RhdC1jZWxsIC5udW0uZ3JlZW4geyBjb2xvcjogdmFyKC0tZ3JlZW4pOyB9Ci5zdGF0LWNlbGwgLm51bS5hbWJlciB7IGNvbG9yOiB2YXIoLS1hbWJlcik7IH0KLnN0YXQtY2VsbCAubnVtLnJlZCB7IGNvbG9yOiB2YXIoLS1yZWQpOyB9Cgouc3RhdC1jZWxsIC5sYWJlbCB7CiAgZm9udC1zaXplOiAxMHB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wNmVtOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQoKLyog4pSA4pSAIEZpbHRlciBCYXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5maWx0ZXItYmFyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAuNXJlbTsKICBwYWRkaW5nOiAuNjI1cmVtIDEuNXJlbTsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7CiAgZmxleC13cmFwOiB3cmFwOwp9CgouZmlsdGVyLWJhciBzZWxlY3QsCi5maWx0ZXItYmFyIGlucHV0IHsKICBmb250LWZhbWlseTogJ0ludGVyJywgc2Fucy1zZXJpZjsKICBmb250LXNpemU6IDEycHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgY29sb3I6IHZhcigtLXRleHQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogLjNyZW0gLjZyZW07CiAgYm9yZGVyLXJhZGl1czogM3B4OwogIG91dGxpbmU6IG5vbmU7Cn0KLmZpbHRlci1iYXIgc2VsZWN0OmZvY3VzLAouZmlsdGVyLWJhciBpbnB1dDpmb2N1cyB7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOwogIGJveC1zaGFkb3c6IDAgMCAwIDJweCB2YXIoLS1hY2NlbnQtZGltKTsKfQoKLmZpbHRlci1iYXIgc2VsZWN0IHsgbWluLXdpZHRoOiAxMjBweDsgY3Vyc29yOiBwb2ludGVyOyB9Ci5maWx0ZXItYmFyIGlucHV0W3R5cGU9InRleHQiXSB7IG1pbi13aWR0aDogMjAwcHg7IH0KCi5maWx0ZXItYmFyIC5zcGFjZXIgeyBmbGV4OiAxOyB9CgovKiDilIDilIAgSm9iIExpc3Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5qb2ItbGlzdCB7CiAgcGFkZGluZzogMDsKfQoKLmpvYi1yb3cgewogIGRpc3BsYXk6IGdyaWQ7CiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiA0OHB4IDFmciBhdXRvIDE2MHB4IDIwMHB4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAwOwogIHBhZGRpbmc6IDA7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdWJ0bGUpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIHRyYW5zaXRpb246IGJhY2tncm91bmQgLjFzOwogIGN1cnNvcjogZGVmYXVsdDsKfQoKLmpvYi1yb3c6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlMik7IH0KLmpvYi1yb3cuYXBwbGllZCB7IGJvcmRlci1sZWZ0OiAycHggc29saWQgdmFyKC0tZ3JlZW4pOyB9Ci5qb2Itcm93LnNhdmVkIHsgYm9yZGVyLWxlZnQ6IDJweCBzb2xpZCB2YXIoLS1hbWJlcik7IH0KLmpvYi1yb3cuc2tpcHBlZCB7IG9wYWNpdHk6IC40NTsgfQouam9iLXJvdy5pZ25vcmVkIHsgb3BhY2l0eTogLjM7IGJvcmRlci1sZWZ0OiAycHggc29saWQgdmFyKC0tbXV0ZWQtZGltKTsgfQoKLmpvYi1yYW5rIHsKICBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOwogIGZvbnQtc2l6ZTogMTFweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQtZGltKTsKICBwYWRkaW5nOiAuNzVyZW0gMXJlbTsKICB0ZXh0LWFsaWduOiBjZW50ZXI7CiAgYm9yZGVyLXJpZ2h0OiAxcHggc29saWQgdmFyKC0tYm9yZGVyLXN1YnRsZSk7Cn0KLmpvYi1yYW5rIC5yYW5rLW51bSB7CiAgZm9udC1zaXplOiAxNHB4OwogIGZvbnQtd2VpZ2h0OiA2MDA7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQoKLmpvYi1pbmZvIHsKICBwYWRkaW5nOiAuNzVyZW0gMXJlbTsKICBib3JkZXItcmlnaHQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXItc3VidGxlKTsKfQoKLmpvYi10aXRsZSB7CiAgZm9udC1zaXplOiAxM3B4OwogIGZvbnQtd2VpZ2h0OiA2MDA7CiAgY29sb3I6IHZhcigtLXRleHQpOwogIG1hcmdpbi1ib3R0b206IDNweDsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAuNXJlbTsKfQoKLmpvYi10aXRsZSAuc3RhdHVzLXRhZyB7CiAgZm9udC1mYW1pbHk6ICdKZXRCcmFpbnMgTW9ubycsIG1vbm9zcGFjZTsKICBmb250LXNpemU6IDlweDsKICBmb250LXdlaWdodDogNTAwOwogIHBhZGRpbmc6IDFweCA2cHg7CiAgYm9yZGVyLXJhZGl1czogMnB4OwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgbGV0dGVyLXNwYWNpbmc6IC4wNWVtOwogIGZsZXgtc2hyaW5rOiAwOwp9Ci5zdGF0dXMtdGFnLm5ldyB7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1kaW0pOyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQouc3RhdHVzLXRhZy5hcHBsaWVkIHsgYmFja2dyb3VuZDogdmFyKC0tZ3JlZW4tZGltKTsgY29sb3I6IHZhcigtLWdyZWVuKTsgfQouc3RhdHVzLXRhZy5zYXZlZCB7IGJhY2tncm91bmQ6IHZhcigtLWFtYmVyLWRpbSk7IGNvbG9yOiB2YXIoLS1hbWJlcik7IH0KLnN0YXR1cy10YWcuc2tpcHBlZCB7IGJhY2tncm91bmQ6IHZhcigtLXJlZC1kaW0pOyBjb2xvcjogdmFyKC0tcmVkKTsgfQouc3RhdHVzLXRhZy5pZ25vcmVkIHsgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsgY29sb3I6IHZhcigtLW11dGVkKTsgfQoKLmpvYi1jb21wYW55IHsKICBmb250LXNpemU6IDEycHg7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKICBtYXJnaW4tYm90dG9tOiA0cHg7Cn0KCi5qb2ItdGFncyB7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IC4zNXJlbTsKICBmbGV4LXdyYXA6IHdyYXA7Cn0KLmpvYi10YWcgewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiAxMHB4OwogIHBhZGRpbmc6IDFweCA2cHg7CiAgYm9yZGVyLXJhZGl1czogMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWJvcmRlcik7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQouam9iLXRhZy5yZW1vdGUgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbi1kaW0pOyBjb2xvcjogdmFyKC0tZ3JlZW4pOyB9Ci5qb2ItdGFnLnNhbGFyeSB7IGJhY2tncm91bmQ6IHZhcigtLWFtYmVyLWRpbSk7IGNvbG9yOiB2YXIoLS1hbWJlcik7IH0KCi5qb2ItZGV0YWlscyB7CiAgcGFkZGluZzogLjc1cmVtIDFyZW07CiAgYm9yZGVyLXJpZ2h0OiAxcHggc29saWQgdmFyKC0tYm9yZGVyLXN1YnRsZSk7Cn0KLmpvYi1kZXRhaWxzIC5sb2NhdGlvbiB7CiAgZm9udC1zaXplOiAxMnB4OwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBtYXJnaW4tYm90dG9tOiAycHg7Cn0KLmpvYi1kZXRhaWxzIC5zb3VyY2UgewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiAxMHB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7Cn0KCi5qb2Itc2NvcmUgewogIHBhZGRpbmc6IC43NXJlbSAxcmVtOwogIGJvcmRlci1yaWdodDogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdWJ0bGUpOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBhbGlnbi1pdGVtczogZmxleC1lbmQ7CiAgZ2FwOiA0cHg7Cn0KLnNjb3JlLWJhci10cmFjayB7CiAgd2lkdGg6IDEwMCU7CiAgaGVpZ2h0OiAzcHg7CiAgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAycHg7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKfQouc2NvcmUtYmFyLWZpbGwgewogIGhlaWdodDogMTAwJTsKICBib3JkZXItcmFkaXVzOiAycHg7CiAgdHJhbnNpdGlvbjogd2lkdGggLjNzIGVhc2U7Cn0KLnNjb3JlLWJhci1maWxsLmhpZ2ggeyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7IH0KLnNjb3JlLWJhci1maWxsLm1pZCB7IGJhY2tncm91bmQ6IHZhcigtLWFtYmVyKTsgfQouc2NvcmUtYmFyLWZpbGwubG93IHsgYmFja2dyb3VuZDogdmFyKC0tcmVkKTsgfQouc2NvcmUtdmFsIHsKICBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOwogIGZvbnQtc2l6ZTogMTFweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwp9Cgouam9iLWFjdGlvbnMgewogIHBhZGRpbmc6IC43NXJlbSAxcmVtOwogIGRpc3BsYXk6IGZsZXg7CiAgZ2FwOiAuMzVyZW07CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKfQouYWN0aW9uLWxpbmsgewogIGZvbnQtZmFtaWx5OiAnSW50ZXInLCBzYW5zLXNlcmlmOwogIGZvbnQtc2l6ZTogMTFweDsKICBmb250LXdlaWdodDogNTAwOwogIHBhZGRpbmc6IC4zcmVtIC42cmVtOwogIGJvcmRlci1yYWRpdXM6IDNweDsKICBjdXJzb3I6IHBvaW50ZXI7CiAgYm9yZGVyOiBub25lOwogIHRleHQtZGVjb3JhdGlvbjogbm9uZTsKICB0cmFuc2l0aW9uOiBhbGwgLjE1czsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogLjI1cmVtOwp9Ci5hY3Rpb24tbGluay52aWV3IHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtZGltKTsKICBjb2xvcjogdmFyKC0tYWNjZW50KTsKfQouYWN0aW9uLWxpbmsudmlldzpob3ZlciB7IGJhY2tncm91bmQ6IHJnYmEoMCwyMTIsMjU1LDAuMik7IH0KLmFjdGlvbi1saW5rLmFwcGx5IHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbi1kaW0pOwogIGNvbG9yOiB2YXIoLS1ncmVlbik7Cn0KLmFjdGlvbi1saW5rLmFwcGx5OmhvdmVyIHsgYmFja2dyb3VuZDogcmdiYSgxNiwxODUsMTI5LDAuMik7IH0KLmFjdGlvbi1saW5rLnNhdmUgewogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UyKTsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmFjdGlvbi1saW5rLnNhdmU6aG92ZXIgeyBjb2xvcjogdmFyKC0tdGV4dCk7IGJvcmRlci1jb2xvcjogdmFyKC0tYm9yZGVyLXN1YnRsZSk7IH0KLmFjdGlvbi1saW5rLnNraXAgewogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UyKTsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmFjdGlvbi1saW5rLnNraXA6aG92ZXIgeyBjb2xvcjogdmFyKC0tcmVkKTsgYm9yZGVyLWNvbG9yOiB2YXIoLS1yZWQtZGltKTsgfQoKLyog4pSA4pSAIFRhYmxlIEhlYWRlciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KLmxpc3QtaGVhZGVyIHsKICBkaXNwbGF5OiBncmlkOwogIGdyaWQtdGVtcGxhdGUtY29sdW1uczogNDhweCAxZnIgYXV0byAxNjBweCAyMDBweDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMDsKICBwYWRkaW5nOiAuNXJlbSAwOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIHBvc2l0aW9uOiBzdGlja3k7CiAgdG9wOiA0OHB4OwogIHotaW5kZXg6IDU7Cn0KLmxpc3QtaGVhZGVyIHNwYW4gewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiAxMHB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wNmVtOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgY29sb3I6IHZhcigtLW11dGVkLWRpbSk7CiAgcGFkZGluZzogMCAxcmVtOwp9Ci5saXN0LWhlYWRlciBzcGFuOm50aC1jaGlsZCgzKSB7IHBhZGRpbmc6IDAgMXJlbTsgfQoubGlzdC1oZWFkZXIgc3BhbjpudGgtY2hpbGQoNCkgeyB0ZXh0LWFsaWduOiByaWdodDsgcGFkZGluZy1yaWdodDogMXJlbTsgfQoubGlzdC1oZWFkZXIgc3BhbjpudGgtY2hpbGQoNSkgeyB0ZXh0LWFsaWduOiByaWdodDsgcGFkZGluZy1yaWdodDogMXJlbTsgfQoKLyog4pSA4pSAIEVtcHR5IFN0YXRlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwouZW1wdHktc3RhdGUgewogIHRleHQtYWxpZ246IGNlbnRlcjsKICBwYWRkaW5nOiA0cmVtIDJyZW07CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQouZW1wdHktc3RhdGUgLmljb24geyBmb250LXNpemU6IDJyZW07IG1hcmdpbi1ib3R0b206IC43NXJlbTsgfQouZW1wdHktc3RhdGUgcCB7IGZvbnQtc2l6ZTogMTNweDsgfQoKLyog4pSA4pSAIE1vZGFsIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwoubW9kYWwgewogIHBvc2l0aW9uOiBmaXhlZDsgaW5zZXQ6IDA7CiAgYmFja2dyb3VuZDogcmdiYSgwLDAsMCwuNik7CiAgei1pbmRleDogMTAwOwogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKfQoubW9kYWwtY29udGVudCB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgd2lkdGg6IDkwJTsKICBtYXgtd2lkdGg6IDYwMHB4OwogIG1heC1oZWlnaHQ6IDkwdmg7CiAgb3ZlcmZsb3cteTogYXV0bzsKfQoubW9kYWwtaGVhZGVyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIHBhZGRpbmc6IDFyZW0gMS41cmVtOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5tb2RhbC1oZWFkZXIgaDIgewogIGZvbnQtc2l6ZTogMTNweDsKICBmb250LXdlaWdodDogNjAwOwogIGxldHRlci1zcGFjaW5nOiAuMDZlbTsKICB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKfQoubW9kYWwtaGVhZGVyIC5jbG9zZSB7CiAgYmFja2dyb3VuZDogbm9uZTsKICBib3JkZXI6IG5vbmU7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKICBmb250LXNpemU6IDE4cHg7CiAgY3Vyc29yOiBwb2ludGVyOwp9Ci5tb2RhbC1oZWFkZXIgLmNsb3NlOmhvdmVyIHsgY29sb3I6IHZhcigtLXRleHQpOyB9Ci5tb2RhbC1jb250ZW50IGZvcm0geyBwYWRkaW5nOiAxLjVyZW07IH0KLmZvcm0tZ3JpZCB7CiAgZGlzcGxheTogZ3JpZDsKICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmciAxZnI7CiAgZ2FwOiAxcmVtOwp9Ci5mb3JtLWdyaWQgbGFiZWwgewogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBnYXA6IC4yNXJlbTsKICBmb250LXNpemU6IDExcHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBsZXR0ZXItc3BhY2luZzogLjA0ZW07CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwp9Ci5mb3JtLWdyaWQgbGFiZWwgaW5wdXQsCi5mb3JtLWdyaWQgbGFiZWwgc2VsZWN0LAouZm9ybS1ncmlkIGxhYmVsIHRleHRhcmVhIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7CiAgY29sb3I6IHZhcigtLXRleHQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogLjVyZW07CiAgYm9yZGVyLXJhZGl1czogM3B4OwogIGZvbnQtc2l6ZTogMTNweDsKICBmb250LWZhbWlseTogJ0ludGVyJywgc2Fucy1zZXJpZjsKICBvdXRsaW5lOiBub25lOwp9Ci5mb3JtLWdyaWQgbGFiZWwgaW5wdXQ6Zm9jdXMsCi5mb3JtLWdyaWQgbGFiZWwgc2VsZWN0OmZvY3VzLAouZm9ybS1ncmlkIGxhYmVsIHRleHRhcmVhOmZvY3VzIHsKICBib3JkZXItY29sb3I6IHZhcigtLWFjY2VudCk7CiAgYm94LXNoYWRvdzogMCAwIDAgMnB4IHZhcigtLWFjY2VudC1kaW0pOwp9Ci5mb3JtLWdyaWQgbGFiZWwgdGV4dGFyZWEgeyByZXNpemU6IHZlcnRpY2FsOyBtaW4taGVpZ2h0OiA2MHB4OyB9Ci5tb2RhbC1hY3Rpb25zIHsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogLjVyZW07CiAganVzdGlmeS1jb250ZW50OiBmbGV4LWVuZDsKICBwYWRkaW5nOiAxcmVtIDEuNXJlbTsKICBib3JkZXItdG9wOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouYXBwbHktY2hlY2tsaXN0IHsgbGlzdC1zdHlsZTogbm9uZTsgcGFkZGluZzogMDsgfQouYXBwbHktY2hlY2tsaXN0IGxpIHsKICBwYWRkaW5nOiAuNXJlbSAwOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IC41cmVtOwogIGZvbnQtc2l6ZTogMTNweDsKfQouYXBwbHktY2hlY2tsaXN0IC52YWwgeyBjb2xvcjogdmFyKC0tYWNjZW50KTsgZm9udC1mYW1pbHk6ICdKZXRCcmFpbnMgTW9ubycsIG1vbm9zcGFjZTsgZm9udC1zaXplOiAxMnB4OyB9CgovKiDilIDilIAgVG9hc3Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi50b2FzdCB7CiAgcG9zaXRpb246IGZpeGVkOwogIGJvdHRvbTogMS41cmVtOwogIHJpZ2h0OiAxLjVyZW07CiAgYmFja2dyb3VuZDogdmFyKC0tZ3JlZW4pOwogIGNvbG9yOiAjMDAwOwogIHBhZGRpbmc6IC42MjVyZW0gMS4xMjVyZW07CiAgYm9yZGVyLXJhZGl1czogNHB4OwogIGZvbnQtc2l6ZTogMTJweDsKICBmb250LXdlaWdodDogNjAwOwogIGRpc3BsYXk6IG5vbmU7CiAgei1pbmRleDogMjAwOwogIGxldHRlci1zcGFjaW5nOiAuMDJlbTsKfQoKLyog4pSA4pSAIFJlc3BvbnNpdmUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCkBtZWRpYSAobWF4LXdpZHRoOiA5MDBweCkgewogIC5qb2Itcm93IHsKICAgIGdyaWQtdGVtcGxhdGUtY29sdW1uczogNDBweCAxZnIgYXV0bzsKICB9CiAgLmpvYi1kZXRhaWxzIHsgZGlzcGxheTogbm9uZTsgfQogIC5saXN0LWhlYWRlciBzcGFuOm50aC1jaGlsZCg0KSB7IGRpc3BsYXk6IG5vbmU7IH0KfQpAbWVkaWEgKG1heC13aWR0aDogNjAwcHgpIHsKICAuam9iLWFjdGlvbnMgeyBkaXNwbGF5OiBub25lOyB9CiAgLmxpc3QtaGVhZGVyIHNwYW46bnRoLWNoaWxkKDUpIHsgZGlzcGxheTogbm9uZTsgfQogIC5zdGF0LWNlbGwgeyBwYWRkaW5nOiAuNXJlbSAuNzVyZW07IH0KICAuc3RhdC1jZWxsIC5udW0geyBmb250LXNpemU6IDE2cHg7IH0KfQoKLyog4pSA4pSAIFNjcm9sbGJhciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KOjotd2Via2l0LXNjcm9sbGJhciB7IHdpZHRoOiA2cHg7IH0KOjotd2Via2l0LXNjcm9sbGJhci10cmFjayB7IGJhY2tncm91bmQ6IHZhcigtLWJnKTsgfQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1iIHsgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsgYm9yZGVyLXJhZGl1czogM3B4OyB9Cjo6LXdlYmtpdC1zY3JvbGxiYXItdGh1bWI6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1tdXRlZC1kaW0pOyB9Cg==';
const APP_JS_B64 = 'LyoqCiAqIGFwcC5qcyDigJQgRGFzaGJvYXJkIGNsaWVudC1zaWRlIGxvZ2ljCiAqLwpjb25zdCBBUEkgPSAnL2FwaSc7CmxldCBhbGxKb2JzID0gW107CmxldCBjdXJyZW50Sm9iSWQgPSBudWxsOwoKLy8g4pSA4pSAIEluaXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ0RPTUNvbnRlbnRMb2FkZWQnLCBhc3luYyAoKSA9PiB7CiAgYXdhaXQgbG9hZFByb2ZpbGUoKTsKICBhd2FpdCBsb2FkU3RhdHMoKTsKICBhd2FpdCBsb2FkU291cmNlcygpOwogIGF3YWl0IGxvYWRKb2JzKCk7CiAgYmluZEV2ZW50cygpOwogIHN0YXJ0VXRjQ2xvY2soKTsKfSk7CgovLyDilIDilIAgVVRDIENsb2NrIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApmdW5jdGlvbiBzdGFydFV0Y0Nsb2NrKCkgewogIGZ1bmN0aW9uIHRpY2soKSB7CiAgICBjb25zdCBkID0gbmV3IERhdGUoKTsKICAgIGNvbnN0IGggPSBTdHJpbmcoZC5nZXRVVENIb3VycygpKS5wYWRTdGFydCgyLCAnMCcpOwogICAgY29uc3QgbSA9IFN0cmluZyhkLmdldFVUQ01pbnV0ZXMoKSkucGFkU3RhcnQoMiwgJzAnKTsKICAgIGNvbnN0IHMgPSBTdHJpbmcoZC5nZXRVVENTZWNvbmRzKCkpLnBhZFN0YXJ0KDIsICcwJyk7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd1dGNUaW1lJyk7CiAgICBpZiAoZWwpIGVsLnRleHRDb250ZW50ID0gaCArICc6JyArIG0gKyAnOicgKyBzICsgJyBVVEMnOwogIH0KICB0aWNrKCk7CiAgc2V0SW50ZXJ2YWwodGljaywgMTAwMCk7Cn0KCi8vIOKUgOKUgCBQcm9maWxlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAphc3luYyBmdW5jdGlvbiBsb2FkUHJvZmlsZSgpIHsKICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCk7CiAgY29uc3QgcCA9IGF3YWl0IHIuanNvbigpOwogIHdpbmRvdy5fcHJvZmlsZSA9IHA7Cn0KCmFzeW5jIGZ1bmN0aW9uIGxvYWRTb3VyY2VzKCkgewogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgJHtBUEl9L2pvYnM/bGltaXQ9NTAwMGApOwogIGNvbnN0IGpvYnMgPSBhd2FpdCByLmpzb24oKTsKICBjb25zdCBzb3VyY2VzID0gWy4uLm5ldyBTZXQoam9icy5tYXAoaiA9PiBqLnNvdXJjZSkpXS5zb3J0KCk7CiAgY29uc3Qgc2VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NvdXJjZUZpbHRlcicpOwogIHNvdXJjZXMuZm9yRWFjaChzID0+IHsKICAgIGNvbnN0IG9wdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpOwogICAgb3B0LnZhbHVlID0gczsgb3B0LnRleHRDb250ZW50ID0gczsKICAgIHNlbC5hcHBlbmRDaGlsZChvcHQpOwogIH0pOwoKICBjb25zdCBjb21wYW5pZXMgPSBbLi4ubmV3IFNldChqb2JzLm1hcChqID0+IGouY29tcGFueSkpXS5zb3J0KCk7CiAgY29uc3QgY29tcGFueVNlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJyk7CiAgY29tcGFuaWVzLmZvckVhY2goYyA9PiB7CiAgICBjb25zdCBvcHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTsKICAgIG9wdC52YWx1ZSA9IGM7IG9wdC50ZXh0Q29udGVudCA9IGM7CiAgICBjb21wYW55U2VsLmFwcGVuZENoaWxkKG9wdCk7CiAgfSk7Cn0KCi8vIOKUgOKUgCBTdGF0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKYXN5bmMgZnVuY3Rpb24gbG9hZFN0YXRzKCkgewogIGNvbnN0IHMgPSBhd2FpdCAoYXdhaXQgZmV0Y2goYCR7QVBJfS9zdGF0c2ApKS5qc29uKCk7CiAgY29uc3QgY2VsbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc3RhdC1zdHJpcCAuc3RhdC1jZWxsJyk7CiAgaWYgKGNlbGxzWzBdKSBjZWxsc1swXS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLnRvdGFsX2pvYnM7CiAgaWYgKGNlbGxzWzFdKSBjZWxsc1sxXS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLm5ld19qb2JzOwogIGlmIChjZWxsc1syXSkgY2VsbHNbMl0ucXVlcnlTZWxlY3RvcignLm51bScpLnRleHRDb250ZW50ID0gcy5zYXZlZF9qb2JzOwogIGlmIChjZWxsc1szXSkgY2VsbHNbM10ucXVlcnlTZWxlY3RvcignLm51bScpLnRleHRDb250ZW50ID0gcy5hcHBsaWVkX2pvYnM7CiAgaWYgKGNlbGxzWzRdKSBjZWxsc1s0XS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLnNraXBwZWRfam9iczsKICBpZiAoY2VsbHNbNV0pIGNlbGxzWzVdLnF1ZXJ5U2VsZWN0b3IoJy5udW0nKS50ZXh0Q29udGVudCA9IHMuaWdub3JlZF9qb2JzIHx8IDA7CiAgY29uc3QgdG0gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndG9wYmFyTWF0Y2hlZCcpOwogIGNvbnN0IHR0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RvcGJhclRvdGFsJyk7CiAgaWYgKHRtKSB0bS50ZXh0Q29udGVudCA9IChzLm1hdGNoZWRfam9icyB8fCBzLm5ld19qb2JzKSArICcgbWF0Y2hlZCc7CiAgaWYgKHR0KSB0dC50ZXh0Q29udGVudCA9IHMudG90YWxfam9icyArICcgdG90YWwnOwp9CgovLyDilIDilIAgSm9icyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKYXN5bmMgZnVuY3Rpb24gbG9hZEpvYnMoKSB7CiAgY29uc3Qgc3RhdHVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1c0ZpbHRlcicpLnZhbHVlOwogIGNvbnN0IGNvbXBhbnkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY29tcGFueUZpbHRlcicpLnZhbHVlOwogIGNvbnN0IHJlZ2lvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZTsKICBjb25zdCBqb2JUeXBlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlR5cGVGaWx0ZXInKS52YWx1ZTsKICBjb25zdCBzb3VyY2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc291cmNlRmlsdGVyJykudmFsdWU7CiAgY29uc3Qgc29ydCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3J0RmlsdGVyJykudmFsdWU7CiAgY29uc3Qgc2VhcmNoID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NlYXJjaElucHV0JykudmFsdWUudG9Mb3dlckNhc2UoKTsKCiAgbGV0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoeyBzdGF0dXMsIHNvcnQsIGxpbWl0OiA1MDAgfSk7CiAgaWYgKGNvbXBhbnkpIHBhcmFtcy5zZXQoJ2NvbXBhbnknLCBjb21wYW55KTsKICBpZiAocmVnaW9uKSBwYXJhbXMuc2V0KCdyZWdpb24nLCByZWdpb24pOwogIGlmIChqb2JUeXBlKSBwYXJhbXMuc2V0KCdqb2JUeXBlJywgam9iVHlwZSk7CiAgaWYgKHNvdXJjZSkgcGFyYW1zLnNldCgnc291cmNlJywgc291cmNlKTsKICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9qb2JzPyR7cGFyYW1zfWApOwogIGFsbEpvYnMgPSBhd2FpdCByLmpzb24oKTsKCiAgaWYgKHNlYXJjaCkgewogICAgYWxsSm9icyA9IGFsbEpvYnMuZmlsdGVyKGogPT4KICAgICAgKGoudGl0bGUgfHwgJycpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKSB8fAogICAgICAoai5jb21wYW55IHx8ICcnKS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHNlYXJjaCkgfHwKICAgICAgKGouZGVzY3JpcHRpb24gfHwgJycpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKQogICAgKTsKICB9CgogIHJlbmRlckpvYnMoYWxsSm9icyk7CiAgYXdhaXQgbG9hZFN0YXRzKCk7CiAgdXBkYXRlQ2xlYXJCdXR0b24oKTsKfQoKZnVuY3Rpb24gdXBkYXRlQ2xlYXJCdXR0b24oKSB7CiAgY29uc3QgaGFzRmlsdGVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKS52YWx1ZSB8fAogICAgICAgICAgICAgICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZSB8fAogICAgICAgICAgICAgICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykudmFsdWUgfHwKICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2VhcmNoSW5wdXQnKS52YWx1ZTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xlYXJGaWx0ZXJzJykuc3R5bGUuZGlzcGxheSA9IGhhc0ZpbHRlciA/ICcnIDogJ25vbmUnOwp9CgpmdW5jdGlvbiByZW5kZXJKb2JzKGpvYnMpIHsKICBjb25zdCBxID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlF1ZXVlJyk7CiAgaWYgKGpvYnMubGVuZ3RoID09PSAwKSB7CiAgICBxLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJlbXB0eS1zdGF0ZSI+PGRpdiBjbGFzcz0iaWNvbiI+4o6TPC9kaXY+PHA+Tm8gam9icyBmb3VuZC4gQ2xpY2sgIlNjcmFwZSBOb3ciIHRvIGZldGNoIGZyZXNoIGxpc3RpbmdzLjwvcD48L2Rpdj4nOwogICAgcmV0dXJuOwogIH0KICBxLmlubmVySFRNTCA9IGpvYnMubWFwKChqLCBpKSA9PiBqb2JSb3coaiwgaSkpLmpvaW4oJycpOwp9CgpmdW5jdGlvbiBqb2JSb3coam9iLCBpbmRleCkgewogIGNvbnN0IHNhbGFyeUJhZGdlID0gam9iLnNhbGFyeSA/IGA8c3BhbiBjbGFzcz0iam9iLXRhZyBzYWxhcnkiPiR7ZXNjYXBlSHRtbChqb2Iuc2FsYXJ5KX08L3NwYW4+YCA6ICcnOwogIGNvbnN0IHJlbW90ZUJhZGdlID0gam9iLnJlbW90ZSB8fCBqb2Iuc291cmNlID09PSAnUmVtb3RlT0snIHx8IGpvYi5zb3VyY2UgPT09ICdSZW1vdGl2ZScgfHwgam9iLnNvdXJjZSA9PT0gJ1dlV29ya1JlbW90ZWx5JwogICAgPyBgPHNwYW4gY2xhc3M9ImpvYi10YWcgcmVtb3RlIj5SZW1vdGU8L3NwYW4+YCA6ICcnOwogIGNvbnN0IHN0YXR1cyA9IGpvYi5zdGF0dXMgfHwgJ25ldyc7CiAgY29uc3Qgc3RhdHVzQ2xhc3MgPSBgc3RhdHVzLSR7c3RhdHVzfWA7IC8vIHN0YXR1c0NsYXNzIGZvciBzdGF0dXMtYmFkZ2UgY2xhc3MKICBjb25zdCByb3dDbGFzcyA9IHN0YXR1cyA9PT0gJ2FwcGxpZWQnID8gJ2FwcGxpZWQnIDogc3RhdHVzID09PSAnc2F2ZWQnID8gJ3NhdmVkJwogICAgOiBzdGF0dXMgPT09ICdza2lwcGVkJyA/ICdza2lwcGVkJyA6IHN0YXR1cyA9PT0gJ2lnbm9yZWQnID8gJ2lnbm9yZWQnIDogJyc7CiAgY29uc3QgcGN0ID0gTWF0aC5taW4oMTAwLCBNYXRoLnJvdW5kKChqb2Iuc2NvcmUgfHwgMCkgLyAxMjAgKiAxMDApKTsKICBjb25zdCBzY29yZUNsYXNzID0gcGN0ID49IDcwID8gJ2hpZ2gnIDogcGN0ID49IDQwID8gJ21pZCcgOiAnbG93JzsKICBjb25zdCBsb2NhdGlvbiA9IGpvYi5sb2NhdGlvbiB8fCBqb2IucmVnaW9uIHx8ICfigJQnOwogIGNvbnN0IHNvdXJjZUxhYmVsID0gam9iLnNvdXJjZSB8fCAnJzsKCiAgbGV0IGFjdGlvbnNIdG1sID0gJyc7CiAgaWYgKHN0YXR1cyA9PT0gJ25ldycpIHsKICAgIGFjdGlvbnNIdG1sID0gYAogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYWN0aW9uLWxpbmsgdmlldyI+VmlldyDilrg8L2E+CiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJvcGVuQXBwbHkoJyR7am9iLmlkfScpIiBjbGFzcz0iYWN0aW9uLWxpbmsgYXBwbHkiPkFwcGx5PC9hPgogICAgICAgIDxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9Jywnc2F2ZWQnKSIgY2xhc3M9ImFjdGlvbi1saW5rIHNhdmUiPlNhdmU8L2E+CiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdza2lwcGVkJykiIGNsYXNzPSJhY3Rpb24tbGluayBza2lwIj5Ta2lwPC9hPgogICAgICAgIDxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9JywnaWdub3JlZCcpIiBjbGFzcz0iYWN0aW9uLWxpbmsgc2tpcCI+SWdub3JlPC9hPgogICAgICBgOwogIH0gZWxzZSBpZiAoc3RhdHVzID09PSAnYXBwbGllZCcpIHsKICAgIGFjdGlvbnNIdG1sID0gYAogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYWN0aW9uLWxpbmsgdmlldyI+VmlldyDilrg8L2E+CiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJvcGVuQXBwbHkoJyR7am9iLmlkfScpIiBjbGFzcz0iYWN0aW9uLWxpbmsgYXBwbHkiPkFwcGx5PC9hPgogICAgICAgIDxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9Jywnc2tpcHBlZCcpIiBjbGFzcz0iYWN0aW9uLWxpbmsgc2tpcCI+UmV2b2tlICYgU2tpcDwvYT4KICAgICAgYDsKICB9IGVsc2UgaWYgKHN0YXR1cyA9PT0gJ3NhdmVkJykgewogICAgYWN0aW9uc0h0bWwgPSBgCiAgICAgICAgPGEgaHJlZj0iJHtlc2NhcGVIdG1sKGpvYi51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJhY3Rpb24tbGluayB2aWV3Ij5WaWV3IOKWuDwvYT4KICAgICAgICA8YSBocmVmPSJqYXZhc2NyaXB0OnZvaWQoMCkiIG9uY2xpY2s9Im9wZW5BcHBseSgnJHtqb2IuaWR9JykiIGNsYXNzPSJhY3Rpb24tbGluayBhcHBseSI+QXBwbHk8L2E+CiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdza2lwcGVkJykiIGNsYXNzPSJhY3Rpb24tbGluayBza2lwIj5Ta2lwPC9hPgogICAgICAgIDxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9JywnaWdub3JlZCcpIiBjbGFzcz0iYWN0aW9uLWxpbmsgc2tpcCI+SWdub3JlPC9hPgogICAgICBgOwogIH0gZWxzZSBpZiAoc3RhdHVzID09PSAnc2tpcHBlZCcpIHsKICAgIGFjdGlvbnNIdG1sID0gYAogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYWN0aW9uLWxpbmsgdmlldyI+VmlldyDilrg8L2E+CiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCduZXcnKSIgY2xhc3M9ImFjdGlvbi1saW5rIHNhdmUiPlJlb3BlbjwvYT4KICAgICAgYDsKICB9IGVsc2UgaWYgKHN0YXR1cyA9PT0gJ2lnbm9yZWQnKSB7CiAgICBhY3Rpb25zSHRtbCA9IGAKICAgICAgICA8YSBocmVmPSIke2VzY2FwZUh0bWwoam9iLnVybCl9IiB0YXJnZXQ9Il9ibGFuayIgY2xhc3M9ImFjdGlvbi1saW5rIHZpZXciPlZpZXcg4pa4PC9hPgogICAgICAgIDxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9JywnbmV3JykiIGNsYXNzPSJhY3Rpb24tbGluayBzYXZlIj5SZW9wZW48L2E+CiAgICAgIGA7CiAgfQoKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9ImpvYi1yb3cgJHtyb3dDbGFzc30iIGlkPSJqb2ItJHtqb2IuaWR9Ij4KICAgIDxkaXYgY2xhc3M9ImpvYi1yYW5rIj48c3BhbiBjbGFzcz0icmFuay1udW0iPiR7aW5kZXggKyAxfTwvc3Bhbj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImpvYi1pbmZvIj4KICAgICAgPGRpdiBjbGFzcz0iam9iLXRpdGxlIj4KICAgICAgICAke2VzY2FwZUh0bWwoam9iLnRpdGxlKX0KICAgICAgICA8c3BhbiBjbGFzcz0ic3RhdHVzLXRhZyAke3N0YXR1c0NsYXNzfSI+JHtzdGF0dXN9PC9zcGFuPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iam9iLWNvbXBhbnkiPiR7ZXNjYXBlSHRtbChqb2IuY29tcGFueSB8fCAnJyl9ICZtaWRkb3Q7ICR7ZXNjYXBlSHRtbChzb3VyY2VMYWJlbCl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImpvYi10YWdzIj4ke3JlbW90ZUJhZGdlfSR7c2FsYXJ5QmFkZ2V9PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImpvYi1kZXRhaWxzIj4KICAgICAgPGRpdiBjbGFzcz0ibG9jYXRpb24iPiR7ZXNjYXBlSHRtbChsb2NhdGlvbil9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InNvdXJjZSI+JHtlc2NhcGVIdG1sKHNvdXJjZUxhYmVsKX08L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iam9iLXNjb3JlIj4KICAgICAgPGRpdiBjbGFzcz0ic2NvcmUtYmFyLXRyYWNrIj48ZGl2IGNsYXNzPSJzY29yZS1iYXItZmlsbCAke3Njb3JlQ2xhc3N9IiBzdHlsZT0id2lkdGg6JHtwY3R9JSI+PC9kaXY+PC9kaXY+CiAgICAgIDxzcGFuIGNsYXNzPSJzY29yZS12YWwiPiR7am9iLnNjb3JlfSBwdHM8L3NwYW4+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImpvYi1hY3Rpb25zIj4ke2FjdGlvbnNIdG1sfTwvZGl2PgogIDwvZGl2PmA7Cn0KCi8vIOKUgOKUgCBBY3Rpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAphc3luYyBmdW5jdGlvbiBtYXJrQWN0aW9uKGpvYklkLCBhY3Rpb24pIHsKICBjb25zdCBlbmRwb2ludE1hcCA9IHsgYXBwbGllZDogJ2FwcGx5Jywgc2tpcHBlZDogJ3NraXAnLCBzYXZlZDogJ3NhdmUnLCBpZ25vcmVkOiAnaWdub3JlJywgbmV3OiAnbmV3JyB9OwogIGNvbnN0IGVuZHBvaW50ID0gZW5kcG9pbnRNYXBbYWN0aW9uXSB8fCBhY3Rpb247CiAgbGV0IHBheWxvYWQgPSB7IGpvYklkIH07CiAgaWYgKGFjdGlvbiA9PT0gJ3NraXBwZWQnIHx8IGFjdGlvbiA9PT0gJ2lnbm9yZWQnKSB7CiAgICBjb25zdCBqb2IgPSBhbGxKb2JzLmZpbmQoaiA9PiBqLmlkID09PSBqb2JJZCk7CiAgICBpZiAoam9iICYmIGpvYi50aXRsZSkgcGF5bG9hZC50aXRsZSA9IGpvYi50aXRsZTsKICB9CiAgdHJ5IHsKICAgIGNvbnN0IHJlc3AgPSBhd2FpdCBmZXRjaChgJHtBUEl9LyR7ZW5kcG9pbnR9YCwgewogICAgICBtZXRob2Q6ICdQT1NUJywKICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sCiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHBheWxvYWQpCiAgICB9KTsKICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXNwLnRleHQoKTsKICAgIGlmICghcmVzcC5vaykgdGhyb3cgbmV3IEVycm9yKCdIVFRQICcgKyByZXNwLnN0YXR1cyArICc6ICcgKyB0ZXh0KTsKICAgIEpTT04ucGFyc2UodGV4dCk7CiAgICB0b2FzdChgJHthY3Rpb24uY2hhckF0KDApLnRvVXBwZXJDYXNlKCkgKyBhY3Rpb24uc2xpY2UoMSl9ZCBqb2JgKTsKICAgIGF3YWl0IGxvYWRKb2JzKCk7CiAgfSBjYXRjaCAoZXJyKSB7CiAgICB0b2FzdCgnRXJyb3I6ICcgKyBlcnIubWVzc2FnZSk7CiAgfQp9CgovLyDilIDilIAgQXBwbHkgTW9kYWwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmZ1bmN0aW9uIG9wZW5BcHBseShqb2JJZCkgewogIGN1cnJlbnRKb2JJZCA9IGpvYklkOwogIGNvbnN0IGpvYiA9IGFsbEpvYnMuZmluZChqID0+IGouaWQgPT09IGpvYklkKTsKICBpZiAoIWpvYikgcmV0dXJuOwogIGNvbnN0IHAgPSB3aW5kb3cuX3Byb2ZpbGUgfHwge307CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5Q29udGVudCcpLmlubmVySFRNTCA9IGAKICAgIDxkaXYgc3R5bGU9InBhZGRpbmc6MS41cmVtIj4KICAgICAgPGgzIHN0eWxlPSJmb250LXNpemU6MTRweDtmb250LXdlaWdodDo2MDA7bWFyZ2luLWJvdHRvbTouMjVyZW0iPiR7ZXNjYXBlSHRtbChqb2IudGl0bGUpfSBAICR7ZXNjYXBlSHRtbChqb2IuY29tcGFueSl9PC9oMz4KICAgICAgPHAgc3R5bGU9ImNvbG9yOnZhcigtLW11dGVkKTttYXJnaW46LjVyZW0gMDtmb250LXNpemU6MTNweCI+JHtlc2NhcGVIdG1sKGpvYi5kZXNjcmlwdGlvbj8uc2xpY2UoMCwgMjAwKSkgfHwgJ05vIGRlc2NyaXB0aW9uIGF2YWlsYWJsZS4nfTwvcD4KICAgICAgPHAgc3R5bGU9Im1hcmdpbjouNXJlbSAwO2ZvbnQtc2l6ZToxM3B4Ij48YSBocmVmPSIke2VzY2FwZUh0bWwoam9iLnVybCl9IiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOnZhcigtLWFjY2VudCkiPlZpZXcgZnVsbCBqb2IgbGlzdGluZyDihpI8L2E+PC9wPgogICAgICA8aDQgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0OjUwMDtsZXR0ZXItc3BhY2luZzouMDZlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Y29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbjoxcmVtIDAgLjVyZW0iPkFwcGxpY2F0aW9uIENoZWNrbGlzdDo8L2g0PgogICAgICA8dWwgY2xhc3M9ImFwcGx5LWNoZWNrbGlzdCI+CiAgICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gTmFtZTogPHNwYW4gY2xhc3M9InZhbCI+JHtlc2NhcGVIdG1sKHAubmFtZSB8fCAn4oCUJyl9PC9zcGFuPjwvbGk+CiAgICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gRW1haWw6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLmVtYWlsIHx8ICfigJQnKX08L3NwYW4+PC9saT4KICAgICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBQaG9uZTogPHNwYW4gY2xhc3M9InZhbCI+JHtlc2NhcGVIdG1sKHAucGhvbmUgfHwgJ+KAlCcpfTwvc3Bhbj48L2xpPgogICAgICAgIDxsaT48aW5wdXQgdHlwZT0iY2hlY2tib3giIGNoZWNrZWQgZGlzYWJsZWQ+IFJlc3VtZTogPHNwYW4gY2xhc3M9InZhbCI+JHtlc2NhcGVIdG1sKHAucmVzdW1lX3BhdGggfHwgJ25vdCBzZXQnKX08L3NwYW4+PC9saT4KICAgICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBDb3ZlciBsZXR0ZXI6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7am9iLmNvdmVyX2xldHRlciA/ICfinJMgR2VuZXJhdGVkJyA6ICdSdW4gd2l0aCBBTlRIUk9QSUNfQVBJX0tFWSd9PC9zcGFuPjwvbGk+CiAgICAgIDwvdWw+CiAgICA8L2Rpdj4KICBgOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHBseVVybEJ0bicpLmhyZWYgPSBqb2IudXJsOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtYXJrQXBwbGllZEJ0bicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBhd2FpdCBtYXJrQWN0aW9uKGpvYklkLCAnYXBwbGllZCcpOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5TW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogICAgdG9hc3QoJ01hcmtlZCBhcyBhcHBsaWVkIScpOwogIH07CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5TW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnOwp9CgovLyDilIDilIAgUHJvZmlsZSBNb2RhbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVCdG4nKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogIGNvbnN0IHAgPSBhd2FpdCAoYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCkpLmpzb24oKTsKICB3aW5kb3cuX3Byb2ZpbGUgPSBwOwogIE9iamVjdC5rZXlzKHApLmZvckVhY2goayA9PiB7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwXycgKyBrKTsKICAgIGlmIChlbCkgZWwudmFsdWUgPSBBcnJheS5pc0FycmF5KHBba10pID8gcFtrXS5qb2luKCcsICcpIDogKHBba10gfHwgJycpOwogIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnOwp9OwoKZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVGb3JtJykub25zdWJtaXQgPSBhc3luYyAoZSkgPT4gewogIGUucHJldmVudERlZmF1bHQoKTsKICBjb25zdCBmZCA9IG5ldyBGb3JtRGF0YShlLnRhcmdldCk7CiAgY29uc3QgcCA9IHt9OwogIGZkLmZvckVhY2goKHYsIGspID0+IHsgcFtrXSA9IHY7IH0pOwogIGZvciAoY29uc3Qga2V5IG9mIFsnc2tpbGxzJywgJ3RhcmdldF90aXRsZXMnLCAncmVxdWlyZWRfa2V5d29yZHMnLCAnYm9udXNfa2V5d29yZHMnLCAnZGVhbF9icmVha2VycycsICdwcmVmZXJyZWRfd29ya190eXBlJywgJ3ByZWZlcnJlZF9sb2NhdGlvbnMnLCAncHJlZmVycmVkX2VtcGxveW1lbnQnXSkgewogICAgcFtrZXldID0gKHBba2V5XSB8fCAnJykuc3BsaXQoJywnKS5tYXAocyA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pOwogIH0KICBwLmV4cGVyaWVuY2VfeWVhcnMgPSBwYXJzZUludChwLmV4cGVyaWVuY2VfeWVhcnMpIHx8IDA7CiAgcC5zYWxhcnlfbWluX2xha2hzID0gcGFyc2VGbG9hdChwLnNhbGFyeV9taW5fbGFraHMpIHx8IDM1OwogIHAudGFyZ2V0X3NhbGFyeSA9IHsgY3VycmVuY3k6IHAuc2FsYXJ5X2N1cnJlbmN5IHx8ICdJTlInLCBtaW5fbGFraHM6IHAuc2FsYXJ5X21pbl9sYWtocyB9OwogIGF3YWl0IGZldGNoKGAke0FQSX0vcHJvZmlsZWAsIHsgbWV0aG9kOiAnUFVUJywgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sIGJvZHk6IEpTT04uc3RyaW5naWZ5KHApIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogIHRvYXN0KCdQcm9maWxlIHNhdmVkIScpOwogIGxvYWRQcm9maWxlKCk7Cn07CgovLyDilIDilIAgRXZlbnRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApmdW5jdGlvbiBiaW5kRXZlbnRzKCkgewogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjcmFwZUJ0bicpLmRpc2FibGVkID0gdHJ1ZTsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS50ZXh0Q29udGVudCA9ICdTY3JhcGluZy4uLic7CiAgICBhd2FpdCBmZXRjaChgJHtBUEl9L3NjcmFwZWAsIHsgbWV0aG9kOiAnUE9TVCcgfSk7CiAgICBzZXRUaW1lb3V0KCgpID0+IHsKICAgICAgbG9hZEpvYnMoKTsKICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjcmFwZUJ0bicpLmRpc2FibGVkID0gZmFsc2U7CiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS50ZXh0Q29udGVudCA9ICdTY3JhcGUgTm93JzsKICAgIH0sIDIwMDApOwogIH07CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NsZWFyRmlsdGVycycpLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY29tcGFueUZpbHRlcicpLnZhbHVlID0gJyc7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVnaW9uRmlsdGVyJykudmFsdWUgPSAnJzsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykudmFsdWUgPSAnJzsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZWFyY2hJbnB1dCcpLnZhbHVlID0gJyc7CiAgICBsb2FkSm9icygpOwogIH07CgogIGZ1bmN0aW9uIG9uRmlsdGVyQ2hhbmdlKCkgeyBsb2FkSm9icygpOyB1cGRhdGVDbGVhckJ1dHRvbigpOyB9CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1c0ZpbHRlcicpLm9uY2hhbmdlID0gbG9hZEpvYnM7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKS5vbmNoYW5nZSA9IG9uRmlsdGVyQ2hhbmdlOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS5vbmNoYW5nZSA9IG9uRmlsdGVyQ2hhbmdlOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykub25jaGFuZ2UgPSBvbkZpbHRlckNoYW5nZTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc291cmNlRmlsdGVyJykub25jaGFuZ2UgPSBsb2FkSm9iczsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc29ydEZpbHRlcicpLm9uY2hhbmdlID0gbG9hZEpvYnM7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NlYXJjaElucHV0Jykub25pbnB1dCA9ICgpID0+IHsKICAgIGNsZWFyVGltZW91dCh3aW5kb3cuX3NlYXJjaFRpbWVyKTsKICAgIHdpbmRvdy5fc2VhcmNoVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsgbG9hZEpvYnMoKTsgdXBkYXRlQ2xlYXJCdXR0b24oKTsgfSwgMzAwKTsKICB9OwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbG9zZVByb2ZpbGVCdG4nKS5vbmNsaWNrID0gKCkgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NhbmNlbFByb2ZpbGVCdG4nKS5vbmNsaWNrID0gKCkgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Nsb3NlQXBwbHlCdG4nKS5vbmNsaWNrID0gKCkgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5TW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwp9CgovLyDilIDilIAgVXRpbHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmZ1bmN0aW9uIHRvYXN0KG1zZykgewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RvYXN0Jyk7CiAgZWwudGV4dENvbnRlbnQgPSBtc2c7IGVsLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snOwogIHNldFRpbWVvdXQoKCkgPT4gZWwuc3R5bGUuZGlzcGxheSA9ICdub25lJywgMjUwMCk7Cn0KCmZ1bmN0aW9uIGVzY2FwZUh0bWwocykgewogIGlmICghcykgcmV0dXJuICcnOwogIHJldHVybiBTdHJpbmcocykucmVwbGFjZSgvJi9nLCcmYW1wOycpLnJlcGxhY2UoLzwvZywnJmx0OycpLnJlcGxhY2UoLz4vZywnJmd0OycpLnJlcGxhY2UoLyIvZywnJnF1b3Q7Jyk7Cn0KCndpbmRvdy5tYXJrQWN0aW9uID0gbWFya0FjdGlvbjsKd2luZG93Lm9wZW5BcHBseSA9IG9wZW5BcHBseTsK';

const DASHBOARD_HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0iVVRGLTgiLz4KICA8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEuMCIvPgogIDx0aXRsZT5Kb2IgQWdlbnQ8L3RpdGxlPgogIDxsaW5rIHJlbD0ic3R5bGVzaGVldCIgaHJlZj0iL3N0eWxlcy5jc3M/dD1fX1NUWUxFU19WRVJTSU9OX18iLz4KPC9oZWFkPgo8Ym9keT4KICA8IS0tIFRvcCBCYXIgLS0+CiAgPGhlYWRlciBjbGFzcz0idG9wYmFyIj4KICAgIDxkaXYgY2xhc3M9InRvcGJhci1icmFuZCI+CiAgICAgIDxoMT5Kb2IgQWdlbnQ8L2gxPgogICAgICA8ZGl2IGNsYXNzPSJ0b3BiYXItbWV0YSI+CiAgICAgICAgPHNwYW4gY2xhc3M9ImxpdmUtZG90Ij48L3NwYW4+CiAgICAgICAgPHNwYW4gaWQ9InRvcGJhck1hdGNoZWQiPuKAlCBtYXRjaGVkPC9zcGFuPgogICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICA8c3BhbiBpZD0idG9wYmFyVG90YWwiPuKAlCB0b3RhbDwvc3Bhbj4KICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgPHNwYW4gaWQ9InV0Y1RpbWUiPi0tOi0tIFVUQzwvc3Bhbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InRvcGJhci1hY3Rpb25zIj4KICAgICAgPGJ1dHRvbiBpZD0ic2NyYXBlQnRuIiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5Ij5TY3JhcGUgTm93PC9idXR0b24+CiAgICAgIDxidXR0b24gaWQ9InByb2ZpbGVCdG4iIGNsYXNzPSJidG4gYnRuLWdob3N0Ij5Qcm9maWxlPC9idXR0b24+CiAgICA8L2Rpdj4KICA8L2hlYWRlcj4KCiAgPCEtLSBTdGF0IFN0cmlwIC0tPgogIDxkaXYgY2xhc3M9InN0YXQtc3RyaXAiPgogICAgPGRpdiBjbGFzcz0ic3RhdC1jZWxsIj48c3BhbiBjbGFzcz0ibnVtIj7igJQ8L3NwYW4+PHNwYW4gY2xhc3M9ImxhYmVsIj5Ub3RhbDwvc3Bhbj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXQtY2VsbCI+PHNwYW4gY2xhc3M9Im51bSBhY2NlbnQiPuKAlDwvc3Bhbj48c3BhbiBjbGFzcz0ibGFiZWwiPk5ldzwvc3Bhbj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXQtY2VsbCI+PHNwYW4gY2xhc3M9Im51bSBhbWJlciI+4oCUPC9zcGFuPjxzcGFuIGNsYXNzPSJsYWJlbCI+U2F2ZWQ8L3NwYW4+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzdGF0LWNlbGwiPjxzcGFuIGNsYXNzPSJudW0gZ3JlZW4iPuKAlDwvc3Bhbj48c3BhbiBjbGFzcz0ibGFiZWwiPkFwcGxpZWQ8L3NwYW4+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzdGF0LWNlbGwiPjxzcGFuIGNsYXNzPSJudW0gcmVkIj7igJQ8L3NwYW4+PHNwYW4gY2xhc3M9ImxhYmVsIj5Ta2lwcGVkPC9zcGFuPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdC1jZWxsIj48c3BhbiBjbGFzcz0ibnVtIiBzdHlsZT0iY29sb3I6dmFyKC0tbXV0ZWQpIj7igJQ8L3NwYW4+PHNwYW4gY2xhc3M9ImxhYmVsIj5JZ25vcmVkPC9zcGFuPjwvZGl2PgogIDwvZGl2PgoKICA8IS0tIEZpbHRlciBCYXIgLS0+CiAgPGRpdiBjbGFzcz0iZmlsdGVyLWJhciI+CiAgICA8c2VsZWN0IGlkPSJzdGF0dXNGaWx0ZXIiIHRpdGxlPSJGaWx0ZXIgYnkgc3RhdHVzIj4KICAgICAgPG9wdGlvbiB2YWx1ZT0ibmV3Ij5OZXcgSm9iczwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJzYXZlZCI+U2F2ZWQ8L29wdGlvbj4KICAgICAgPG9wdGlvbiB2YWx1ZT0iYXBwbGllZCI+QXBwbGllZDwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJza2lwcGVkIj5Ta2lwcGVkPC9vcHRpb24+CiAgICAgIDxvcHRpb24gdmFsdWU9Imlnbm9yZWQiPklnbm9yZWQ8L29wdGlvbj4KICAgIDwvc2VsZWN0PgogICAgPHNlbGVjdCBpZD0iY29tcGFueUZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBjb21wYW55Ij4KICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgQ29tcGFuaWVzPC9vcHRpb24+CiAgICA8L3NlbGVjdD4KICAgIDxzZWxlY3QgaWQ9InJlZ2lvbkZpbHRlciIgdGl0bGU9IkZpbHRlciBieSByZWdpb24iPgogICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBSZWdpb25zPC9vcHRpb24+CiAgICAgIDxvcHRpb24gdmFsdWU9ImluZGlhIj5JbmRpYTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJyZW1vdGUiPlJlbW90ZTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJ1c2EiPlVTQTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJldXJvcGUiPkV1cm9wZTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJhc2lhLXBhY2lmaWMiPkFzaWEtUGFjaWZpYzwvb3B0aW9uPgogICAgPC9zZWxlY3Q+CiAgICA8c2VsZWN0IGlkPSJqb2JUeXBlRmlsdGVyIiB0aXRsZT0iRmlsdGVyIGJ5IGpvYiB0eXBlIj4KICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgVHlwZXM8L29wdGlvbj4KICAgICAgPG9wdGlvbiB2YWx1ZT0icmVtb3RlIj5SZW1vdGUgT25seTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJvbnNpdGUiPk9uLXNpdGUgT25seTwvb3B0aW9uPgogICAgPC9zZWxlY3Q+CiAgICA8c2VsZWN0IGlkPSJzb3VyY2VGaWx0ZXIiIHRpdGxlPSJGaWx0ZXIgYnkgc291cmNlIj4KICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgU291cmNlczwvb3B0aW9uPgogICAgPC9zZWxlY3Q+CiAgICA8c2VsZWN0IGlkPSJzb3J0RmlsdGVyIiB0aXRsZT0iU29ydCBieSI+CiAgICAgIDxvcHRpb24gdmFsdWU9InNjb3JlIj5TY29yZSAoZGVzYyk8L29wdGlvbj4KICAgICAgPG9wdGlvbiB2YWx1ZT0icG9zdGVkIj5OZXdlc3Q8L29wdGlvbj4KICAgIDwvc2VsZWN0PgogICAgPGRpdiBjbGFzcz0ic3BhY2VyIj48L2Rpdj4KICAgIDxpbnB1dCBpZD0ic2VhcmNoSW5wdXQiIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSJTZWFyY2ggdGl0bGUsIGNvbXBhbnkuLi4iLz4KICAgIDxidXR0b24gaWQ9ImNsZWFyRmlsdGVycyIgY2xhc3M9ImJ0biBidG4tZ2hvc3QiIHN0eWxlPSJkaXNwbGF5Om5vbmUiPkNsZWFyPC9idXR0b24+CiAgPC9kaXY+CgogIDwhLS0gSm9iIExpc3QgSGVhZGVyIC0tPgogIDxkaXYgY2xhc3M9Imxpc3QtaGVhZGVyIj4KICAgIDxzcGFuPiM8L3NwYW4+CiAgICA8c3Bhbj5Kb2I8L3NwYW4+CiAgICA8c3Bhbj5EZXRhaWxzPC9zcGFuPgogICAgPHNwYW4+U2NvcmU8L3NwYW4+CiAgICA8c3Bhbj5BY3Rpb25zPC9zcGFuPgogIDwvZGl2PgoKICA8IS0tIEpvYiBMaXN0IC0tPgogIDxkaXYgY2xhc3M9ImpvYi1saXN0IiBpZD0iam9iUXVldWUiPgogICAgPGRpdiBjbGFzcz0iZW1wdHktc3RhdGUiPjxwPkxvYWRpbmcgam9icy4uLjwvcD48L2Rpdj4KICA8L2Rpdj4KCiAgPCEtLSBQcm9maWxlIE1vZGFsIC0tPgogIDxkaXYgaWQ9InByb2ZpbGVNb2RhbCIgY2xhc3M9Im1vZGFsIiBzdHlsZT0iZGlzcGxheTpub25lIj4KICAgIDxkaXYgY2xhc3M9Im1vZGFsLWNvbnRlbnQiPgogICAgICA8ZGl2IGNsYXNzPSJtb2RhbC1oZWFkZXIiPgogICAgICAgIDxoMj5FZGl0IFByb2ZpbGU8L2gyPgogICAgICAgIDxidXR0b24gaWQ9ImNsb3NlUHJvZmlsZUJ0biIgY2xhc3M9ImNsb3NlIj4mdGltZXM7PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8Zm9ybSBpZD0icHJvZmlsZUZvcm0iPgogICAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JpZCI+CiAgICAgICAgICA8bGFiZWw+TmFtZTxpbnB1dCBpZD0icF9uYW1lIiBuYW1lPSJuYW1lIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5FbWFpbDxpbnB1dCBpZD0icF9lbWFpbCIgbmFtZT0iZW1haWwiIHR5cGU9ImVtYWlsIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5QaG9uZTxpbnB1dCBpZD0icF9waG9uZSIgbmFtZT0icGhvbmUiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkxpbmtlZEluPGlucHV0IGlkPSJwX2xpbmtlZGluIiBuYW1lPSJsaW5rZWRpbiIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+TG9jYXRpb248aW5wdXQgaWQ9InBfbG9jYXRpb24iIG5hbWU9ImxvY2F0aW9uIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5SZXN1bWUgUGF0aDxpbnB1dCBpZD0icF9yZXN1bWVfcGF0aCIgbmFtZT0icmVzdW1lX3BhdGgiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkV4cGVyaWVuY2UgKHllYXJzKTxpbnB1dCBpZD0icF9leHAiIG5hbWU9ImV4cGVyaWVuY2VfeWVhcnMiIHR5cGU9Im51bWJlciIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+Q3VycmVudCBSb2xlPGlucHV0IGlkPSJwX3JvbGUiIG5hbWU9ImN1cnJlbnRfcm9sZSIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+Q3VycmVudCBDb21wYW55PGlucHV0IGlkPSJwX2NvbXBhbnkiIG5hbWU9ImN1cnJlbnRfY29tcGFueSIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+U2tpbGxzIChjb21tYS1zZXBhcmF0ZWQpPGlucHV0IGlkPSJwX3NraWxscyIgbmFtZT0ic2tpbGxzIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5UYXJnZXQgVGl0bGVzIChjb21tYS1zZXBhcmF0ZWQpPGlucHV0IGlkPSJwX3RpdGxlcyIgbmFtZT0idGFyZ2V0X3RpdGxlcyIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+UmVxdWlyZWQgS2V5d29yZHM8aW5wdXQgaWQ9InBfcmVxX2t3IiBuYW1lPSJyZXF1aXJlZF9rZXl3b3JkcyIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+Qm9udXMgS2V5d29yZHM8aW5wdXQgaWQ9InBfYm9udXNfa3ciIG5hbWU9ImJvbnVzX2tleXdvcmRzIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5NaW4gU2FsYXJ5IChMYWtocyBJTlIpPGlucHV0IGlkPSJwX21pbl9zYWxhcnkiIG5hbWU9InNhbGFyeV9taW5fbGFraHMiIHR5cGU9Im51bWJlciIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+Q3VycmVuY3kKICAgICAgICAgICAgPHNlbGVjdCBpZD0icF9jdXJyZW5jeSIgbmFtZT0ic2FsYXJ5X2N1cnJlbmN5Ij4KICAgICAgICAgICAgICA8b3B0aW9uPklOUjwvb3B0aW9uPjxvcHRpb24+VVNEPC9vcHRpb24+PG9wdGlvbj5FVVI8L29wdGlvbj48b3B0aW9uPkdCUDwvb3B0aW9uPgogICAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICAgIDwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+V29yayBUeXBlCiAgICAgICAgICAgIDxzZWxlY3QgaWQ9InBfd29ya190eXBlIiBuYW1lPSJ3b3JrX3R5cGUiIG11bHRpcGxlIHNpemU9IjMiPgogICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9InJlbW90ZSI+UmVtb3RlPC9vcHRpb24+CiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iaHlicmlkIj5IeWJyaWQ8L29wdGlvbj4KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJvbi1zaXRlIj5Pbi1zaXRlPC9vcHRpb24+CiAgICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgICAgPC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5QcmVmZXJyZWQgTG9jYXRpb25zPGlucHV0IGlkPSJwX2xvY2F0aW9ucyIgbmFtZT0ibG9jYXRpb25zIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5TdW1tYXJ5PHRleHRhcmVhIGlkPSJwX3N1bW1hcnkiIG5hbWU9InN1bW1hcnkiIHJvd3M9IjMiPjwvdGV4dGFyZWE+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj4KICAgICAgICAgIDxidXR0b24gdHlwZT0ic3VibWl0IiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5Ij5TYXZlIFByb2ZpbGU8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gdHlwZT0iYnV0dG9uIiBpZD0iY2FuY2VsUHJvZmlsZUJ0biIgY2xhc3M9ImJ0biBidG4tZ2hvc3QiPkNhbmNlbDwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Zvcm0+CiAgICA8L2Rpdj4KICA8L2Rpdj4KCiAgPCEtLSBBcHBseSBNb2RhbCAtLT4KICA8ZGl2IGlkPSJhcHBseU1vZGFsIiBjbGFzcz0ibW9kYWwiIHN0eWxlPSJkaXNwbGF5Om5vbmUiPgogICAgPGRpdiBjbGFzcz0ibW9kYWwtY29udGVudCI+CiAgICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWRlciI+CiAgICAgICAgPGgyPlByZXBhcmUgQXBwbGljYXRpb248L2gyPgogICAgICAgIDxidXR0b24gaWQ9ImNsb3NlQXBwbHlCdG4iIGNsYXNzPSJjbG9zZSI+JnRpbWVzOzwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBpZD0iYXBwbHlDb250ZW50Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtYWN0aW9ucyI+CiAgICAgICAgPGEgaWQ9ImFwcGx5VXJsQnRuIiBocmVmPSIjIiB0YXJnZXQ9Il9ibGFuayIgY2xhc3M9ImJ0biBidG4tZ2hvc3QiPk9wZW4gSm9iIFBhZ2U8L2E+CiAgICAgICAgPGJ1dHRvbiBpZD0ibWFya0FwcGxpZWRCdG4iIGNsYXNzPSJidG4gYnRuLXByaW1hcnkiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLWdyZWVuKSI+TWFyayBhcyBBcHBsaWVkPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgPC9kaXY+CgogIDxkaXYgaWQ9InRvYXN0IiBjbGFzcz0idG9hc3QiPjwvZGl2PgogIDxzY3JpcHQgc3JjPSIvYXBwLmpzP3Q9X19USU1FU1RBTVBfXyI+PC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=';

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
