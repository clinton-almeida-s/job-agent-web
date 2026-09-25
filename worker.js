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
  // Lower threshold for GCP/cloud roles — they should still match with just 1 keyword
  if (!hasTitleSignal && reqMatches.length < 2) {
    // GCP/cloud/infra roles get a pass if they mention cloud/infra in title or body
    const hasCloudSignal = /\bgcp\b|google\s*cloud|aws|azure|platform|devops|sre|kubernetes|terraform|cloud|infrastructure/i.test(normalize(job.title + ' ' + (job.description || '')));
    if (!hasCloudSignal) {
      return Object.assign({}, job, { score: -999, match_reasons: [], warnings: ['No title or keyword signal — likely irrelevant'] });
    }
    // Add a small bonus for cloud signal in description
    if (/\bgcp\b|google\s*cloud|infrastructure/i.test(normalize(job.title))) {
      score += 5;
      reasons.push('Cloud/Infra title signal');
    }
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
    const source = url.searchParams.get('source');
    const minScore = parseInt(url.searchParams.get('minScore'), 10);
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
    if (source) {
      filtered = filtered.filter(function(j) { return j.source === source; });
    }
    if (!isNaN(minScore)) {
      filtered = filtered.filter(function(j) { return (j.score || 0) >= minScore; });
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
const STYLES_CSS_B64 = 'LyogTWlzc2lvbiBDb250cm9sIERhc2hib2FyZCDigJQgUmVkZXNpZ25lZCAqLwpAaW1wb3J0IHVybCgnaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbS9jc3MyP2ZhbWlseT1HZWlzdDp3Z2h0QDQwMDs1MDA7NjAwOzcwMCZmYW1pbHk9SmV0QnJhaW5zK01vbm86d2dodEA0MDA7NTAwOzYwMCZkaXNwbGF5PXN3YXAnKTsKCjpyb290IHsKICAtLWJnOiAjMDgwOTBEOwogIC0tc3VyZmFjZTogIzExMTMxODsKICAtLXN1cmZhY2UyOiAjMUExRDI3OwogIC0tYm9yZGVyOiAjMUYyOTM3OwogIC0tYm9yZGVyLXN1YnRsZTogIzI1MkMzQjsKICAtLXRleHQ6ICNFNUU3RUI7CiAgLS1tdXRlZDogIzcyNzk4NjsKICAtLW11dGVkLWRpbTogIzVCNjM3MDsKICAtLWFjY2VudDogIzAwRDRGRjsKICAtLWFjY2VudC1kaW06IHJnYmEoMCwgMjEyLCAyNTUsIDAuMTIpOwogIC0tYWNjZW50LWdsb3c6IHJnYmEoMCwgMjEyLCAyNTUsIDAuMjUpOwogIC0tZ3JlZW46ICMxMEI5ODE7CiAgLS1ncmVlbi1kaW06IHJnYmEoMTYsIDE4NSwgMTI5LCAwLjEyKTsKICAtLWFtYmVyOiAjRjU5RTBCOwogIC0tYW1iZXItZGltOiByZ2JhKDI0NSwgMTU4LCAxMSwgMC4xMik7CiAgLS1yZWQ6ICNFRjQ0NDQ7CiAgLS1yZWQtZGltOiByZ2JhKDIzOSwgNjgsIDY4LCAwLjEyKTsKfQoKKiB7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7IG1hcmdpbjogMDsgcGFkZGluZzogMDsgfQoKLyogR2xvYmFsIGZvY3VzLXZpc2libGUgZm9yIGtleWJvYXJkIG5hdmlnYXRpb24gKi8KKjpmb2N1cy12aXNpYmxlIHsKICBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tYWNjZW50KTsKICBvdXRsaW5lLW9mZnNldDogMnB4OwogIGJvcmRlci1yYWRpdXM6IDJweDsKfQpidXR0b246Zm9jdXMtdmlzaWJsZSwgYTpmb2N1cy12aXNpYmxlIHsKICBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tYWNjZW50KTsKICBvdXRsaW5lLW9mZnNldDogMnB4Owp9Cgpib2R5IHsKICBmb250LWZhbWlseTogJ0dlaXN0JywgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBzYW5zLXNlcmlmOwogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgbWluLWhlaWdodDogMTAwZHZoOwogIGZvbnQtc2l6ZTogMTRweDsKICBsaW5lLWhlaWdodDogMS41OwogIHBvc2l0aW9uOiByZWxhdGl2ZTsKfQoKLyog4pSA4pSAIE5vaXNlIHRleHR1cmUgb3ZlcmxheSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KYm9keTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogZml4ZWQ7CiAgaW5zZXQ6IDA7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7CiAgei1pbmRleDogOTk5OTsKICBvcGFjaXR5OiAwLjAyNTsKICBiYWNrZ3JvdW5kLWltYWdlOiB1cmwoImRhdGE6aW1hZ2Uvc3ZnK3htbCwlM0Nzdmcgdmlld0JveD0nMCAwIDI1NiAyNTYnIHhtbG5zPSdodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyclM0UlM0NmaWx0ZXIgaWQ9J25vaXNlJyUzRSUzQ2ZlVHVyYnVsZW5jZSB0eXBlPSdmcmFjdGFsTm9pc2UnIGJhc2VGcmVxdWVuY3k9JzAuOScgbnVtT2N0YXZlcz0nNCcgc3RpdGNoVGlsZXM9J3N0aXRjaCcvJTNFJTNDL2ZpbHRlciUzRSUzQ3JlY3Qgd2lkdGg9JzEwMCUyNScgaGVpZ2h0PScxMDAlMjUnIGZpbHRlcj0ndXJsKCUyM25vaXNlKScvJTNFJTNDL3N2ZyUzRSIpOwogIGJhY2tncm91bmQtcmVwZWF0OiByZXBlYXQ7CiAgYmFja2dyb3VuZC1zaXplOiAyNTZweCAyNTZweDsKfQoKLyog4pSA4pSAIEFtYmllbnQgZ2xvdyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KLmFtYmllbnQtZ2xvdyB7CiAgcG9zaXRpb246IGZpeGVkOwogIHRvcDogLTIwMHB4OwogIHJpZ2h0OiAtMTAwcHg7CiAgd2lkdGg6IDYwMHB4OwogIGhlaWdodDogNjAwcHg7CiAgYmFja2dyb3VuZDogcmFkaWFsLWdyYWRpZW50KGNpcmNsZSwgcmdiYSgwLDIxMiwyNTUsMC4wNikgMCUsIHRyYW5zcGFyZW50IDcwJSk7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7CiAgei1pbmRleDogMDsKfQoKLyog4pSA4pSAIExheW91dCBjb250YWluZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5wYWdlLXdyYXAgewogIG1heC13aWR0aDogMTI4MHB4OwogIG1hcmdpbjogMCBhdXRvOwogIHBhZGRpbmc6IDAgMnJlbTsKICBwb3NpdGlvbjogcmVsYXRpdmU7CiAgei1pbmRleDogMTsKfQoKLyog4pSA4pSAIFRvcCBCYXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi50b3BiYXIgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgcGFkZGluZzogMCAycmVtOwogIGhlaWdodDogNTJweDsKICBiYWNrZ3JvdW5kOiByZ2JhKDE3LCAxOSwgMjQsIDAuOCk7CiAgYmFja2Ryb3AtZmlsdGVyOiBibHVyKDEycHgpOwogIC13ZWJraXQtYmFja2Ryb3AtZmlsdGVyOiBibHVyKDEycHgpOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHBvc2l0aW9uOiBzdGlja3k7CiAgdG9wOiAwOwogIHotaW5kZXg6IDEwMDsKfQoudG9wYmFyLWlubmVyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIHdpZHRoOiAxMDAlOwogIG1heC13aWR0aDogMTI4MHB4OwogIG1hcmdpbjogMCBhdXRvOwogIGdhcDogMXJlbTsKfQoKLnRvcGJhci1icmFuZCB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogYmFzZWxpbmU7CiAgZ2FwOiAuNzVyZW07Cn0KCi50b3BiYXItYnJhbmQgaDEgewogIGZvbnQtc2l6ZTogMTNweDsKICBmb250LXdlaWdodDogNzAwOwogIGxldHRlci1zcGFjaW5nOiAuMTJlbTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKfQoudG9wYmFyLWJyYW5kIGgxIHNwYW4gewogIGNvbG9yOiB2YXIoLS1hY2NlbnQpOwp9CgoudG9wYmFyLXRhZ2xpbmUgewogIGZvbnQtc2l6ZTogMTFweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQtZGltKTsKICBsZXR0ZXItc3BhY2luZzogLjA0ZW07CiAgZm9udC1zdHlsZTogaXRhbGljOwp9CgoudG9wYmFyLW1ldGEgewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiAxMXB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IDFyZW07CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKfQoudG9wYmFyLW1ldGEgLmRvdCB7CiAgd2lkdGg6IDNweDsgaGVpZ2h0OiAzcHg7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGJhY2tncm91bmQ6IHZhcigtLW11dGVkLWRpbSk7Cn0KLnRvcGJhci1tZXRhIC5saXZlLWRvdCB7CiAgd2lkdGg6IDZweDsgaGVpZ2h0OiA2cHg7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGJhY2tncm91bmQ6IHZhcigtLWdyZWVuKTsKICBib3gtc2hhZG93OiAwIDAgOHB4IHZhcigtLWdyZWVuKTsKICBhbmltYXRpb246IHB1bHNlIDJzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgcHVsc2UgewogIDAlLCAxMDAlIHsgb3BhY2l0eTogMTsgdHJhbnNmb3JtOiBzY2FsZSgxKTsgfQogIDUwJSB7IG9wYWNpdHk6IDAuNjsgdHJhbnNmb3JtOiBzY2FsZSgxLjIpOyB9Cn0KCi50b3BiYXItYWN0aW9ucyB7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IC41cmVtOwp9CgovKiDilIDilIAgQnV0dG9ucyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KLmJ0biB7CiAgZm9udC1mYW1pbHk6ICdHZWlzdCcsIHNhbnMtc2VyaWY7CiAgZm9udC1zaXplOiAxMnB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgcGFkZGluZzogLjRyZW0gLjg3NXJlbTsKICBib3JkZXItcmFkaXVzOiA2cHg7CiAgY3Vyc29yOiBwb2ludGVyOwogIGJvcmRlcjogbm9uZTsKICB0cmFuc2l0aW9uOiBhbGwgLjJzIGN1YmljLWJlemllcigwLjMyLCAwLjcyLCAwLCAxKTsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogLjRyZW07CiAgbGV0dGVyLXNwYWNpbmc6IC4wMWVtOwp9Ci5idG46YWN0aXZlIHsgdHJhbnNmb3JtOiBzY2FsZSgwLjk3KTsgfQouYnRuOmRpc2FibGVkIHsgb3BhY2l0eTogMC41OyBjdXJzb3I6IG5vdC1hbGxvd2VkOyB9CgouYnRuLXByaW1hcnkgewogIGJhY2tncm91bmQ6IHZhcigtLWFjY2VudCk7CiAgY29sb3I6IHZhcigtLWJnKTsKICBib3gtc2hhZG93OiAwIDAgMjBweCB2YXIoLS1hY2NlbnQtZGltKSwgaW5zZXQgMCAxcHggMCByZ2JhKDI1NSwyNTUsMjU1LDAuMTUpOwp9Ci5idG4tcHJpbWFyeTpob3Zlcjpub3QoOmRpc2FibGVkKSB7CiAgYmFja2dyb3VuZDogIzMzREZGRjsKICBib3gtc2hhZG93OiAwIDAgMjhweCB2YXIoLS1hY2NlbnQtZ2xvdyksIGluc2V0IDAgMXB4IDAgcmdiYSgyNTUsMjU1LDI1NSwwLjIpOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWSgtMXB4KTsKfQoKLmJ0bi1naG9zdCB7CiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5idG4tZ2hvc3Q6aG92ZXIgewogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UyKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1ib3JkZXItc3VidGxlKTsKfQoKLyog4pSA4pSAIEhlcm8gU3RhdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5oZXJvLXN0YXRzIHsKICBkaXNwbGF5OiBncmlkOwogIGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDYsIDFmcik7CiAgZ2FwOiAxcHg7CiAgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6IDEycHg7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBtYXJnaW4tdG9wOiAxLjVyZW07CiAgbWFyZ2luLWJvdHRvbTogMXJlbTsKfQoKLnN0YXQtY2VsbCB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgcGFkZGluZzogMS4yNXJlbSAxLjVyZW07CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGdhcDogNHB4OwogIHRyYW5zaXRpb246IGJhY2tncm91bmQgLjJzOwp9Ci5zdGF0LWNlbGw6aG92ZXIgewogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UyKTsKfQoKLnN0YXQtY2VsbCAubnVtIHsKICBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOwogIGZvbnQtc2l6ZTogMzJweDsKICBmb250LXdlaWdodDogNjAwOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBsaW5lLWhlaWdodDogMTsKICBsZXR0ZXItc3BhY2luZzogLTAuMDJlbTsKfQouc3RhdC1jZWxsIC5udW0uYWNjZW50IHsgY29sb3I6IHZhcigtLWFjY2VudCk7IHRleHQtc2hhZG93OiAwIDAgMjBweCB2YXIoLS1hY2NlbnQtZGltKTsgfQouc3RhdC1jZWxsIC5udW0uZ3JlZW4geyBjb2xvcjogdmFyKC0tZ3JlZW4pOyB0ZXh0LXNoYWRvdzogMCAwIDIwcHggdmFyKC0tZ3JlZW4tZGltKTsgfQouc3RhdC1jZWxsIC5udW0uYW1iZXIgeyBjb2xvcjogdmFyKC0tYW1iZXIpOyB0ZXh0LXNoYWRvdzogMCAwIDIwcHggdmFyKC0tYW1iZXItZGltKTsgfQouc3RhdC1jZWxsIC5udW0ucmVkIHsgY29sb3I6IHZhcigtLXJlZCk7IH0KLnN0YXQtY2VsbCAubnVtLmRpbSB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0KCi5zdGF0LWNlbGwgLmxhYmVsIHsKICBmb250LXNpemU6IDEwcHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBsZXR0ZXItc3BhY2luZzogLjA4ZW07CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKICBjb2xvcjogdmFyKC0tbXV0ZWQtZGltKTsKfQoKLyog4pSA4pSAIEZpbHRlciBCYXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5maWx0ZXItYmFyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAuNXJlbTsKICBwYWRkaW5nOiAuNzVyZW0gMDsKICBmbGV4LXdyYXA6IHdyYXA7Cn0KCi5maWx0ZXItYmFyIHNlbGVjdCwKLmZpbHRlci1iYXIgaW5wdXQgewogIGZvbnQtZmFtaWx5OiAnR2Vpc3QnLCBzYW5zLXNlcmlmOwogIGZvbnQtc2l6ZTogMTJweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBwYWRkaW5nOiAuMzc1cmVtIC43NXJlbTsKICBib3JkZXItcmFkaXVzOiA2cHg7CiAgb3V0bGluZTogbm9uZTsKICB0cmFuc2l0aW9uOiBib3JkZXItY29sb3IgLjJzLCBib3gtc2hhZG93IC4yczsKICBjdXJzb3I6IHBvaW50ZXI7Cn0KLmZpbHRlci1iYXIgc2VsZWN0OmZvY3VzLAouZmlsdGVyLWJhciBpbnB1dDpmb2N1cyB7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOwogIGJveC1zaGFkb3c6IDAgMCAwIDNweCB2YXIoLS1hY2NlbnQtZGltKTsKfQoKLmZpbHRlci1iYXIgc2VsZWN0IHsgbWluLXdpZHRoOiAxMzBweDsgfQouZmlsdGVyLWJhciBpbnB1dFt0eXBlPSJ0ZXh0Il0geyBtaW4td2lkdGg6IDIyMHB4OyB9CgouZmlsdGVyLWJhciAuc3BhY2VyIHsgZmxleDogMTsgfQoKLyogQWN0aXZlIGZpbHRlciBwaWxscyAqLwouZmlsdGVyLXBpbGxzIHsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogLjM3NXJlbTsKICBmbGV4LXdyYXA6IHdyYXA7CiAgbWFyZ2luLWJvdHRvbTogLjVyZW07Cn0KLmZpbHRlci1waWxsIHsKICBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOwogIGZvbnQtc2l6ZTogMTBweDsKICBwYWRkaW5nOiAuMnJlbSAuNXJlbTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LWRpbSk7CiAgY29sb3I6IHZhcigtLWFjY2VudCk7CiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgwLDIxMiwyNTUsMC4yKTsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAuMzVyZW07CiAgbGV0dGVyLXNwYWNpbmc6IC4wNGVtOwp9Ci5maWx0ZXItcGlsbCAucmVtb3ZlIHsKICBjdXJzb3I6IHBvaW50ZXI7CiAgb3BhY2l0eTogMC42OwogIHRyYW5zaXRpb246IG9wYWNpdHkgLjE1czsKfQouZmlsdGVyLXBpbGwgLnJlbW92ZTpob3ZlciB7IG9wYWNpdHk6IDE7IH0KCi8qIOKUgOKUgCBKb2IgQ2FyZHMgKHJlcGxhY2luZyB0YWJsZSByb3dzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KLmpvYi1saXN0IHsKICBwYWRkaW5nOiAwOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBnYXA6IC41cmVtOwogIHBhZGRpbmctYm90dG9tOiAzcmVtOwp9Cgouam9iLWNhcmQgewogIGRpc3BsYXk6IGdyaWQ7CiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgYXV0byAxODBweCAyMjBweDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1sZWZ0OiAzcHggc29saWQgdmFyKC0tYWNjZW50KTsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgcGFkZGluZzogMXJlbSAxLjI1cmVtOwogIHRyYW5zaXRpb246IGFsbCAuMnMgY3ViaWMtYmV6aWVyKDAuMzIsIDAuNzIsIDAsIDEpOwogIGN1cnNvcjogZGVmYXVsdDsKICBwb3NpdGlvbjogcmVsYXRpdmU7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKfQouam9iLWNhcmQ6OmJlZm9yZSB7CiAgY29udGVudDogJyc7CiAgcG9zaXRpb246IGFic29sdXRlOwogIGluc2V0OiAwOwogIGJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCgxMzVkZWcsIHJnYmEoMCwyMTIsMjU1LDAuMDMpIDAlLCB0cmFuc3BhcmVudCA2MCUpOwogIG9wYWNpdHk6IDA7CiAgdHJhbnNpdGlvbjogb3BhY2l0eSAuMnM7Cn0KLmpvYi1jYXJkOmhvdmVyIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlMik7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1ib3JkZXItc3VidGxlKTsKICBib3JkZXItbGVmdC1jb2xvcjogdmFyKC0tYWNjZW50KTsKICB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoMnB4KTsKfQouam9iLWNhcmQ6aG92ZXI6OmJlZm9yZSB7IG9wYWNpdHk6IDE7IH0KCi8qIFN0YXR1cyB2YXJpYW50cyAqLwouam9iLWNhcmQuYXBwbGllZCB7IGJvcmRlci1sZWZ0LWNvbG9yOiB2YXIoLS1ncmVlbik7IH0KLmpvYi1jYXJkLmFwcGxpZWQ6OmJlZm9yZSB7IGJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCgxMzVkZWcsIHJnYmEoMTYsMTg1LDEyOSwwLjA0KSAwJSwgdHJhbnNwYXJlbnQgNjAlKTsgfQouam9iLWNhcmQuc2F2ZWQgeyBib3JkZXItbGVmdC1jb2xvcjogdmFyKC0tYW1iZXIpOyB9Ci5qb2ItY2FyZC5zYXZlZDo6YmVmb3JlIHsgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDEzNWRlZywgcmdiYSgyNDUsMTU4LDExLDAuMDQpIDAlLCB0cmFuc3BhcmVudCA2MCUpOyB9Ci5qb2ItY2FyZC5za2lwcGVkIHsKICBiYWNrZ3JvdW5kOiByZ2JhKDIzOSwgNjgsIDY4LCAwLjAzKTsKICBib3JkZXItbGVmdC1jb2xvcjogcmdiYSgyMzksIDY4LCA2OCwgMC40KTsKfQouam9iLWNhcmQuc2tpcHBlZCAuam9iLXRpdGxlLAouam9iLWNhcmQuc2tpcHBlZCAuam9iLWNvbXBhbnkgeyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB9Ci5qb2ItY2FyZC5pZ25vcmVkIHsKICBiYWNrZ3JvdW5kOiByZ2JhKDkxLCA5OSwgMTEyLCAwLjA0KTsKICBib3JkZXItbGVmdC1jb2xvcjogcmdiYSg5MSwgOTksIDExMiwgMC40KTsKfQouam9iLWNhcmQuaWdub3JlZCAuam9iLXRpdGxlLAouam9iLWNhcmQuaWdub3JlZCAuam9iLWNvbXBhbnkgeyBjb2xvcjogdmFyKC0tbXV0ZWQtZGltKTsgfQoKLyog4pSA4pSAIENhcmQ6IEpvYiBJbmZvIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwouY2FyZC1pbmZvIHsgcGFkZGluZy1yaWdodDogMXJlbTsgcG9zaXRpb246IHJlbGF0aXZlOyB6LWluZGV4OiAxOyB9Cgouam9iLXRpdGxlIHsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDYwMDsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgbWFyZ2luLWJvdHRvbTogNHB4OwogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IC41cmVtOwogIHRleHQtd3JhcDogYmFsYW5jZTsKfQouam9iLWNhcmQuc2tpcHBlZCAuam9iLXRpdGxlLAouam9iLWNhcmQuaWdub3JlZCAuam9iLXRpdGxlIHsgY29sb3I6IHZhcigtLW11dGVkKTsgfQouam9iLWNhcmQuaWdub3JlZCAuam9iLXRpdGxlIHsgY29sb3I6IHZhcigtLW11dGVkLWRpbSk7IH0KCi5qb2ItY29tcGFueSB7CiAgZm9udC1zaXplOiAxMnB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7CiAgbWFyZ2luLWJvdHRvbTogNnB4OwogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IC40cmVtOwp9Cgouam9iLXRhZ3MgewogIGRpc3BsYXk6IGZsZXg7CiAgZ2FwOiAuM3JlbTsKICBmbGV4LXdyYXA6IHdyYXA7Cn0KLmpvYi10YWcgewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiAxMHB4OwogIHBhZGRpbmc6IDJweCA3cHg7CiAgYm9yZGVyLXJhZGl1czogM3B4OwogIGJhY2tncm91bmQ6IHZhcigtLWJvcmRlcik7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKICBsZXR0ZXItc3BhY2luZzogLjAzZW07Cn0KLmpvYi10YWcucmVtb3RlIHsgYmFja2dyb3VuZDogdmFyKC0tZ3JlZW4tZGltKTsgY29sb3I6IHZhcigtLWdyZWVuKTsgfQouam9iLXRhZy5zYWxhcnkgeyBiYWNrZ3JvdW5kOiB2YXIoLS1hbWJlci1kaW0pOyBjb2xvcjogdmFyKC0tYW1iZXIpOyB9Cgouc3RhdHVzLXRhZyB7CiAgZm9udC1mYW1pbHk6ICdKZXRCcmFpbnMgTW9ubycsIG1vbm9zcGFjZTsKICBmb250LXNpemU6IDlweDsKICBmb250LXdlaWdodDogNTAwOwogIHBhZGRpbmc6IDJweCA3cHg7CiAgYm9yZGVyLXJhZGl1czogM3B4OwogIGxldHRlci1zcGFjaW5nOiAuMDZlbTsKICB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOwogIGZsZXgtc2hyaW5rOiAwOwp9Ci5zdGF0dXMtdGFnLm5ldyB7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1kaW0pOyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQouc3RhdHVzLXRhZy5hcHBsaWVkIHsgYmFja2dyb3VuZDogdmFyKC0tZ3JlZW4tZGltKTsgY29sb3I6IHZhcigtLWdyZWVuKTsgfQouc3RhdHVzLXRhZy5zYXZlZCB7IGJhY2tncm91bmQ6IHZhcigtLWFtYmVyLWRpbSk7IGNvbG9yOiB2YXIoLS1hbWJlcik7IH0KLnN0YXR1cy10YWcuc2tpcHBlZCB7IGJhY2tncm91bmQ6IHZhcigtLXJlZC1kaW0pOyBjb2xvcjogdmFyKC0tcmVkKTsgfQouc3RhdHVzLXRhZy5pZ25vcmVkIHsgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsgY29sb3I6IHZhcigtLW11dGVkKTsgfQoKLyog4pSA4pSAIENhcmQ6IERldGFpbHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5jYXJkLWRldGFpbHMgewogIHBhZGRpbmc6IDAgMS4yNXJlbTsKICBib3JkZXItcmlnaHQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXItc3VidGxlKTsKICBib3JkZXItbGVmdDogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdWJ0bGUpOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBnYXA6IDJweDsKfQouY2FyZC1kZXRhaWxzIC5sb2NhdGlvbiB7CiAgZm9udC1zaXplOiAxM3B4OwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKfQouY2FyZC1kZXRhaWxzIC5zb3VyY2UgewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiAxMHB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7CiAgbGV0dGVyLXNwYWNpbmc6IC4wNGVtOwp9CgovKiDilIDilIAgQ2FyZDogU2NvcmUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5jYXJkLXNjb3JlIHsKICBwYWRkaW5nOiAwIDEuMjVyZW07CiAgYm9yZGVyLXJpZ2h0OiAxcHggc29saWQgdmFyKC0tYm9yZGVyLXN1YnRsZSk7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGFsaWduLWl0ZW1zOiBmbGV4LWVuZDsKICBnYXA6IDZweDsKICBtaW4td2lkdGg6IDEyMHB4Owp9Ci5zY29yZS10cmFjayB7CiAgd2lkdGg6IDEwMCU7CiAgaGVpZ2h0OiA0cHg7CiAgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAycHg7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKICBwb3NpdGlvbjogcmVsYXRpdmU7Cn0KLnNjb3JlLWZpbGwgewogIGhlaWdodDogMTAwJTsKICBib3JkZXItcmFkaXVzOiAycHg7CiAgdHJhbnNpdGlvbjogd2lkdGggLjZzIGN1YmljLWJlemllcigwLjMyLCAwLjcyLCAwLCAxKTsKICBwb3NpdGlvbjogcmVsYXRpdmU7Cn0KLnNjb3JlLWZpbGw6OmFmdGVyIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogYWJzb2x1dGU7CiAgcmlnaHQ6IDA7IHRvcDogMDsgYm90dG9tOiAwOyB3aWR0aDogMjBweDsKICBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoOTBkZWcsIHRyYW5zcGFyZW50LCByZ2JhKDI1NSwyNTUsMjU1LDAuMykpOwogIGJvcmRlci1yYWRpdXM6IDJweDsKfQouc2NvcmUtZmlsbC5oaWdoIHsgYmFja2dyb3VuZDogdmFyKC0tZ3JlZW4pOyBib3gtc2hhZG93OiAwIDAgOHB4IHZhcigtLWdyZWVuLWRpbSk7IH0KLnNjb3JlLWZpbGwubWlkIHsgYmFja2dyb3VuZDogdmFyKC0tYW1iZXIpOyBib3gtc2hhZG93OiAwIDAgOHB4IHZhcigtLWFtYmVyLWRpbSk7IH0KLnNjb3JlLWZpbGwubG93IHsgYmFja2dyb3VuZDogdmFyKC0tcmVkKTsgfQouc2NvcmUtdmFsIHsKICBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOwogIGZvbnQtc2l6ZTogMTFweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwogIGxldHRlci1zcGFjaW5nOiAuMDRlbTsKfQouc2NvcmUtdmFsIHN0cm9uZyB7IGNvbG9yOiB2YXIoLS10ZXh0KTsgZm9udC13ZWlnaHQ6IDYwMDsgfQoKLyog4pSA4pSAIENhcmQ6IEFjdGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5jYXJkLWFjdGlvbnMgewogIHBhZGRpbmc6IDAgLjI1cmVtOwogIGRpc3BsYXk6IGZsZXg7CiAgZ2FwOiAuM3JlbTsKICBhbGlnbi1pdGVtczogY2VudGVyOwp9Ci5hY3Rpb24tYnRuIHsKICBmb250LWZhbWlseTogJ0dlaXN0Jywgc2Fucy1zZXJpZjsKICBmb250LXNpemU6IDExcHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBwYWRkaW5nOiAuM3JlbSAuNnJlbTsKICBib3JkZXItcmFkaXVzOiA1cHg7CiAgY3Vyc29yOiBwb2ludGVyOwogIGJvcmRlcjogbm9uZTsKICB0ZXh0LWRlY29yYXRpb246IG5vbmU7CiAgdHJhbnNpdGlvbjogYWxsIC4xNXMgY3ViaWMtYmV6aWVyKDAuMzIsIDAuNzIsIDAsIDEpOwogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAuM3JlbTsKfQouYWN0aW9uLWJ0bjphY3RpdmUgeyB0cmFuc2Zvcm06IHNjYWxlKDAuOTUpOyB9Ci5hY3Rpb24tYnRuLnZpZXcgewogIGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1kaW0pOwogIGNvbG9yOiB2YXIoLS1hY2NlbnQpOwp9Ci5hY3Rpb24tYnRuLnZpZXc6aG92ZXIgeyBiYWNrZ3JvdW5kOiByZ2JhKDAsMjEyLDI1NSwwLjIpOyB9Ci5hY3Rpb24tYnRuLmFwcGx5IHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbi1kaW0pOwogIGNvbG9yOiB2YXIoLS1ncmVlbik7Cn0KLmFjdGlvbi1idG4uYXBwbHk6aG92ZXIgeyBiYWNrZ3JvdW5kOiByZ2JhKDE2LDE4NSwxMjksMC4yKTsgfQouYWN0aW9uLWJ0bi5zYXZlIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlMik7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5hY3Rpb24tYnRuLnNhdmU6aG92ZXIgeyBjb2xvcjogdmFyKC0tdGV4dCk7IGJvcmRlci1jb2xvcjogdmFyKC0tYm9yZGVyLXN1YnRsZSk7IH0KLmFjdGlvbi1idG4uc2tpcCB7CiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5hY3Rpb24tYnRuLnNraXA6aG92ZXIgeyBjb2xvcjogdmFyKC0tcmVkKTsgYm9yZGVyLWNvbG9yOiB2YXIoLS1yZWQtZGltKTsgfQoKLyog4pSA4pSAIFNrZWxldG9uIExvYWRlciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KLnNrZWxldG9uLWNhcmQgewogIGRpc3BsYXk6IGdyaWQ7CiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgYXV0byAxODBweCAyMjBweDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1sZWZ0OiAzcHggc29saWQgdmFyKC0tYm9yZGVyLXN1YnRsZSk7CiAgYm9yZGVyLXJhZGl1czogOHB4OwogIHBhZGRpbmc6IDFyZW0gMS4yNXJlbTsKICBtYXJnaW4tYm90dG9tOiAuNXJlbTsKfQouc2tlbGV0b24tbGluZSB7CiAgaGVpZ2h0OiAxMnB4OwogIGJhY2tncm91bmQ6IHZhcigtLWJvcmRlcik7CiAgYm9yZGVyLXJhZGl1czogM3B4OwogIGFuaW1hdGlvbjogc2hpbW1lciAxLjVzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9Ci5za2VsZXRvbi1saW5lLnRpdGxlIHsgaGVpZ2h0OiAxNHB4OyB3aWR0aDogNzAlOyBtYXJnaW4tYm90dG9tOiA2cHg7IH0KLnNrZWxldG9uLWxpbmUubWV0YSB7IGhlaWdodDogMTBweDsgd2lkdGg6IDQwJTsgbWFyZ2luLWJvdHRvbTogOHB4OyB9Ci5za2VsZXRvbi1saW5lLnRhZ3MgeyBoZWlnaHQ6IDEwcHg7IHdpZHRoOiAzMCU7IH0KLnNrZWxldG9uLWJhciB7CiAgaGVpZ2h0OiA0cHg7CiAgd2lkdGg6IDEwMCU7CiAgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAycHg7CiAgYW5pbWF0aW9uOiBzaGltbWVyIDEuNXMgZWFzZS1pbi1vdXQgaW5maW5pdGU7Cn0KLnNrZWxldG9uLWJsb2NrIHsKICB3aWR0aDogODBweDsKICBoZWlnaHQ6IDEycHg7CiAgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAzcHg7CiAgYW5pbWF0aW9uOiBzaGltbWVyIDEuNXMgZWFzZS1pbi1vdXQgaW5maW5pdGU7Cn0KQGtleWZyYW1lcyBzaGltbWVyIHsKICAwJSwgMTAwJSB7IG9wYWNpdHk6IDAuNDsgfQogIDUwJSB7IG9wYWNpdHk6IDE7IH0KfQoKLyog4pSA4pSAIEVtcHR5IFN0YXRlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwouZW1wdHktc3RhdGUgewogIHRleHQtYWxpZ246IGNlbnRlcjsKICBwYWRkaW5nOiA1cmVtIDJyZW07Cn0KLmVtcHR5LXN0YXRlIC5pY29uIHsKICBmb250LXNpemU6IDIuNXJlbTsKICBtYXJnaW4tYm90dG9tOiAxcmVtOwogIG9wYWNpdHk6IDAuMzsKfQouZW1wdHktc3RhdGUgaDMgewogIGZvbnQtc2l6ZTogMTZweDsKICBmb250LXdlaWdodDogNjAwOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBtYXJnaW4tYm90dG9tOiAuNXJlbTsKfQouZW1wdHktc3RhdGUgcCB7CiAgZm9udC1zaXplOiAxM3B4OwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7CiAgbWF4LXdpZHRoOiAzNjBweDsKICBtYXJnaW46IDAgYXV0byAxLjVyZW07CiAgbGluZS1oZWlnaHQ6IDEuNjsKfQouZW1wdHktc3RhdGUgLmJ0biB7IG1hcmdpbjogMCBhdXRvOyB9CgovKiDilIDilIAgTW9kYWwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5tb2RhbCB7CiAgcG9zaXRpb246IGZpeGVkOyBpbnNldDogMDsKICBiYWNrZ3JvdW5kOiByZ2JhKDAsMCwwLC42KTsKICB6LWluZGV4OiAxMDA7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogY2VudGVyOwp9Ci5tb2RhbC1jb250ZW50IHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6IDhweDsKICB3aWR0aDogOTAlOwogIG1heC13aWR0aDogNjAwcHg7CiAgbWF4LWhlaWdodDogOTB2aDsKICBvdmVyZmxvdy15OiBhdXRvOwp9Ci5tb2RhbC1oZWFkZXIgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgcGFkZGluZzogMXJlbSAxLjVyZW07CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLm1vZGFsLWhlYWRlciBoMiB7CiAgZm9udC1zaXplOiAxM3B4OwogIGZvbnQtd2VpZ2h0OiA2MDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wMmVtOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKfQoubW9kYWwtaGVhZGVyIC5jbG9zZSB7CiAgYmFja2dyb3VuZDogbm9uZTsKICBib3JkZXI6IG5vbmU7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKICBmb250LXNpemU6IDE4cHg7CiAgY3Vyc29yOiBwb2ludGVyOwp9Ci5tb2RhbC1oZWFkZXIgLmNsb3NlOmhvdmVyIHsgY29sb3I6IHZhcigtLXRleHQpOyB9Ci5tb2RhbC1jb250ZW50IGZvcm0geyBwYWRkaW5nOiAxLjVyZW07IH0KLmZvcm0tZ3JpZCB7CiAgZGlzcGxheTogZ3JpZDsKICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmciAxZnI7CiAgZ2FwOiAxcmVtOwp9Ci5mb3JtLWdyaWQgbGFiZWwgewogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBnYXA6IC4yNXJlbTsKICBmb250LXNpemU6IDExcHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBsZXR0ZXItc3BhY2luZzogLjAyZW07CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQouZm9ybS1ncmlkIGxhYmVsIGlucHV0LAouZm9ybS1ncmlkIGxhYmVsIHNlbGVjdCwKLmZvcm0tZ3JpZCBsYWJlbCB0ZXh0YXJlYSB7CiAgYmFja2dyb3VuZDogdmFyKC0tYmcpOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHBhZGRpbmc6IC41cmVtOwogIGJvcmRlci1yYWRpdXM6IDNweDsKICBmb250LXNpemU6IDEzcHg7CiAgZm9udC1mYW1pbHk6ICdHZWlzdCcsIHNhbnMtc2VyaWY7CiAgb3V0bGluZTogbm9uZTsKfQouZm9ybS1ncmlkIGxhYmVsIGlucHV0OmZvY3VzLAouZm9ybS1ncmlkIGxhYmVsIHNlbGVjdDpmb2N1cywKLmZvcm0tZ3JpZCBsYWJlbCB0ZXh0YXJlYTpmb2N1cyB7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOwogIGJveC1zaGFkb3c6IDAgMCAwIDJweCB2YXIoLS1hY2NlbnQtZGltKTsKfQouZm9ybS1ncmlkIGxhYmVsIHRleHRhcmVhIHsgcmVzaXplOiB2ZXJ0aWNhbDsgbWluLWhlaWdodDogNjBweDsgfQoubW9kYWwtYWN0aW9ucyB7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IC41cmVtOwogIGp1c3RpZnktY29udGVudDogZmxleC1lbmQ7CiAgcGFkZGluZzogMXJlbSAxLjVyZW07CiAgYm9yZGVyLXRvcDogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmFwcGx5LWNoZWNrbGlzdCB7IGxpc3Qtc3R5bGU6IG5vbmU7IHBhZGRpbmc6IDA7IH0KLmFwcGx5LWNoZWNrbGlzdCBsaSB7CiAgcGFkZGluZzogLjVyZW0gMDsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAuNXJlbTsKICBmb250LXNpemU6IDEzcHg7Cn0KLmFwcGx5LWNoZWNrbGlzdCAudmFsIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7IGZvbnQtc2l6ZTogMTJweDsgfQoKLyog4pSA4pSAIFRvYXN0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwoudG9hc3QgewogIHBvc2l0aW9uOiBmaXhlZDsKICBib3R0b206IDEuNXJlbTsKICByaWdodDogMS41cmVtOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWdyZWVuKTsKICBjb2xvcjogdmFyKC0tZ3JlZW4pOwogIHBhZGRpbmc6IC42MjVyZW0gMXJlbTsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgZm9udC1zaXplOiAxMnB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgZGlzcGxheTogbm9uZTsKICB6LWluZGV4OiAyMDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wMmVtOwogIGJveC1zaGFkb3c6IDAgNHB4IDI0cHggcmdiYSgwLDAsMCwwLjQpLCAwIDAgMCAxcHggcmdiYSgxNiwxODUsMTI5LDAuMSk7CiAgYW5pbWF0aW9uOiBzbGlkZVVwIC4zcyBjdWJpYy1iZXppZXIoMC4zMiwgMC43MiwgMCwgMSk7Cn0KLnRvYXN0LmVycm9yIHsKICBib3JkZXItY29sb3I6IHZhcigtLXJlZCk7CiAgY29sb3I6IHZhcigtLXJlZCk7CiAgYm94LXNoYWRvdzogMCA0cHggMjRweCByZ2JhKDAsMCwwLDAuNCksIDAgMCAwIDFweCByZ2JhKDIzOSw2OCw2OCwwLjEpOwp9CkBrZXlmcmFtZXMgc2xpZGVVcCB7CiAgZnJvbSB7IHRyYW5zZm9ybTogdHJhbnNsYXRlWSg4cHgpOyBvcGFjaXR5OiAwOyB9CiAgdG8geyB0cmFuc2Zvcm06IHRyYW5zbGF0ZVkoMCk7IG9wYWNpdHk6IDE7IH0KfQoKLyog4pSA4pSAIFNlY3Rpb24gTGFiZWwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5zZWN0aW9uLWxhYmVsIHsKICBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOwogIGZvbnQtc2l6ZTogMTBweDsKICBmb250LXdlaWdodDogNTAwOwogIGxldHRlci1zcGFjaW5nOiAuMWVtOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgY29sb3I6IHZhcigtLW11dGVkLWRpbSk7CiAgcGFkZGluZzogMS4yNXJlbSAwIC41cmVtOwogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IC43NXJlbTsKfQouc2VjdGlvbi1sYWJlbDo6YWZ0ZXIgewogIGNvbnRlbnQ6ICcnOwogIGZsZXg6IDE7CiAgaGVpZ2h0OiAxcHg7CiAgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsKfQoKLyog4pSA4pSAIFJlc3BvbnNpdmUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCkBtZWRpYSAobWF4LXdpZHRoOiAxMDI0cHgpIHsKICAuaGVyby1zdGF0cyB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDMsIDFmcik7IH0KICAuam9iLWNhcmQgeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmciBhdXRvOyB9CiAgLmNhcmQtZGV0YWlscyB7IGRpc3BsYXk6IG5vbmU7IH0KICAuY2FyZC1zY29yZSB7IGJvcmRlci1yaWdodDogbm9uZTsgfQp9CkBtZWRpYSAobWF4LXdpZHRoOiA2NDBweCkgewogIC5wYWdlLXdyYXAgeyBwYWRkaW5nOiAwIDFyZW07IH0KICAuaGVyby1zdGF0cyB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDIsIDFmcik7IH0KICAudG9wYmFyLW1ldGEgeyBkaXNwbGF5OiBub25lOyB9CiAgLmNhcmQtYWN0aW9ucyB7IGRpc3BsYXk6IG5vbmU7IH0KfQoKLyog4pSA4pSAIFNjcm9sbGJhciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KOjotd2Via2l0LXNjcm9sbGJhciB7IHdpZHRoOiA2cHg7IH0KOjotd2Via2l0LXNjcm9sbGJhci10cmFjayB7IGJhY2tncm91bmQ6IHZhcigtLWJnKTsgfQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1iIHsgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsgYm9yZGVyLXJhZGl1czogM3B4OyB9Cjo6LXdlYmtpdC1zY3JvbGxiYXItdGh1bWI6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1tdXRlZC1kaW0pOyB9Cg==';
const APP_JS_B64 = 'LyoqDQogKiBhcHAuanMg4oCUIERhc2hib2FyZCBjbGllbnQtc2lkZSBsb2dpYw0KICovDQpjb25zdCBBUEkgPSAnL2FwaSc7DQpsZXQgYWxsSm9icyA9IFtdOw0KbGV0IGN1cnJlbnRKb2JJZCA9IG51bGw7DQoNCi8vIOKUgOKUgCBJbml0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignRE9NQ29udGVudExvYWRlZCcsIGFzeW5jICgpID0+IHsNCiAgYXdhaXQgbG9hZFByb2ZpbGUoKTsNCiAgYXdhaXQgbG9hZFN0YXRzKCk7DQogIGF3YWl0IGxvYWRTb3VyY2VzKCk7DQogIGF3YWl0IGxvYWRKb2JzKCk7DQogIGJpbmRFdmVudHMoKTsNCiAgc3RhcnRJc3RDbG9jaygpOw0KfSk7DQoNCi8vIOKUgOKUgCBJU1QgQ2xvY2sg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQpmdW5jdGlvbiBzdGFydElzdENsb2NrKCkgew0KICBmdW5jdGlvbiB0aWNrKCkgew0KICAgIC8vIElTVCA9IFVUQys1OjMwDQogICAgY29uc3QgaXN0TXMgPSBEYXRlLm5vdygpICsgKDUuNSAqIDYwICogNjAgKiAxMDAwKTsNCiAgICBjb25zdCBkID0gbmV3IERhdGUoaXN0TXMpOw0KICAgIGNvbnN0IGggPSBTdHJpbmcoZC5nZXRVVENIb3VycygpKS5wYWRTdGFydCgyLCAnMCcpOw0KICAgIGNvbnN0IG0gPSBTdHJpbmcoZC5nZXRVVENNaW51dGVzKCkpLnBhZFN0YXJ0KDIsICcwJyk7DQogICAgY29uc3QgcyA9IFN0cmluZyhkLmdldFVUQ1NlY29uZHMoKSkucGFkU3RhcnQoMiwgJzAnKTsNCiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd1dGNUaW1lJyk7DQogICAgaWYgKGVsKSBlbC50ZXh0Q29udGVudCA9IGggKyAnOicgKyBtICsgJzonICsgcyArICcgSVNUJzsNCiAgfQ0KICB0aWNrKCk7DQogIHNldEludGVydmFsKHRpY2ssIDEwMDApOw0KfQ0KDQovLyDilIDilIAgUHJvZmlsZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCmFzeW5jIGZ1bmN0aW9uIGxvYWRQcm9maWxlKCkgew0KICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCk7DQogIGNvbnN0IHAgPSBhd2FpdCByLmpzb24oKTsNCiAgd2luZG93Ll9wcm9maWxlID0gcDsNCn0NCg0KYXN5bmMgZnVuY3Rpb24gbG9hZFNvdXJjZXMoKSB7DQogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgJHtBUEl9L2pvYnM/bGltaXQ9NTAwMGApOw0KICBjb25zdCBqb2JzID0gYXdhaXQgci5qc29uKCk7DQogIGNvbnN0IHNvdXJjZXMgPSBbLi4ubmV3IFNldChqb2JzLm1hcChqID0+IGouc291cmNlKSldLnNvcnQoKTsNCiAgY29uc3Qgc2VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NvdXJjZUZpbHRlcicpOw0KICBzb3VyY2VzLmZvckVhY2gocyA9PiB7DQogICAgY29uc3Qgb3B0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7DQogICAgb3B0LnZhbHVlID0gczsgb3B0LnRleHRDb250ZW50ID0gczsNCiAgICBzZWwuYXBwZW5kQ2hpbGQob3B0KTsNCiAgfSk7DQoNCiAgY29uc3QgY29tcGFuaWVzID0gWy4uLm5ldyBTZXQoam9icy5tYXAoaiA9PiBqLmNvbXBhbnkpKV0uc29ydCgpOw0KICBjb25zdCBjb21wYW55U2VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKTsNCiAgY29tcGFuaWVzLmZvckVhY2goYyA9PiB7DQogICAgY29uc3Qgb3B0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7DQogICAgb3B0LnZhbHVlID0gYzsgb3B0LnRleHRDb250ZW50ID0gYzsNCiAgICBjb21wYW55U2VsLmFwcGVuZENoaWxkKG9wdCk7DQogIH0pOw0KfQ0KDQovLyDilIDilIAgU3RhdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQphc3luYyBmdW5jdGlvbiBsb2FkU3RhdHMoKSB7DQogIGNvbnN0IHMgPSBhd2FpdCAoYXdhaXQgZmV0Y2goYCR7QVBJfS9zdGF0c2ApKS5qc29uKCk7DQogIGNvbnN0IGNlbGxzID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmhlcm8tc3RhdHMgLnN0YXQtY2VsbCcpOw0KICBpZiAoY2VsbHNbMF0pIGNlbGxzWzBdLnF1ZXJ5U2VsZWN0b3IoJy5udW0nKS50ZXh0Q29udGVudCA9IHMudG90YWxfam9iczsNCiAgaWYgKGNlbGxzWzFdKSBjZWxsc1sxXS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLm5ld19qb2JzOw0KICBpZiAoY2VsbHNbMl0pIGNlbGxzWzJdLnF1ZXJ5U2VsZWN0b3IoJy5udW0nKS50ZXh0Q29udGVudCA9IHMuc2F2ZWRfam9iczsNCiAgaWYgKGNlbGxzWzNdKSBjZWxsc1szXS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLmFwcGxpZWRfam9iczsNCiAgaWYgKGNlbGxzWzRdKSBjZWxsc1s0XS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLnNraXBwZWRfam9iczsNCiAgaWYgKGNlbGxzWzVdKSBjZWxsc1s1XS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLmlnbm9yZWRfam9icyB8fCAwOw0KICBjb25zdCB0bSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0b3BiYXJNYXRjaGVkJyk7DQogIGNvbnN0IHR0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RvcGJhclRvdGFsJyk7DQogIGlmICh0bSkgdG0udGV4dENvbnRlbnQgPSAocy5tYXRjaGVkX2pvYnMgfHwgcy5uZXdfam9icykgKyAnIG1hdGNoZWQnOw0KICBpZiAodHQpIHR0LnRleHRDb250ZW50ID0gcy50b3RhbF9qb2JzICsgJyB0b3RhbCc7DQp9DQoNCi8vIOKUgOKUgCBKb2JzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KYXN5bmMgZnVuY3Rpb24gbG9hZEpvYnMoKSB7DQogIGNvbnN0IHN0YXR1cyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0dXNGaWx0ZXInKS52YWx1ZTsNCiAgY29uc3QgY29tcGFueSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJykudmFsdWU7DQogIGNvbnN0IHJlZ2lvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZTsNCiAgY29uc3Qgam9iVHlwZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykudmFsdWU7DQogIGNvbnN0IHNvdXJjZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3VyY2VGaWx0ZXInKS52YWx1ZTsNCiAgY29uc3Qgc29ydCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3J0RmlsdGVyJykudmFsdWU7DQogIGNvbnN0IHNlYXJjaCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZWFyY2hJbnB1dCcpLnZhbHVlLnRvTG93ZXJDYXNlKCk7DQoNCiAgbGV0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoeyBzdGF0dXMsIHNvcnQsIGxpbWl0OiA1MDAgfSk7DQogIGlmIChjb21wYW55KSBwYXJhbXMuc2V0KCdjb21wYW55JywgY29tcGFueSk7DQogIGlmIChyZWdpb24pIHBhcmFtcy5zZXQoJ3JlZ2lvbicsIHJlZ2lvbik7DQogIGlmIChqb2JUeXBlKSBwYXJhbXMuc2V0KCdqb2JUeXBlJywgam9iVHlwZSk7DQogIGlmIChzb3VyY2UpIHBhcmFtcy5zZXQoJ3NvdXJjZScsIHNvdXJjZSk7DQogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgJHtBUEl9L2pvYnM/JHtwYXJhbXN9YCk7DQogIGFsbEpvYnMgPSBhd2FpdCByLmpzb24oKTsNCg0KICBpZiAoc2VhcmNoKSB7DQogICAgYWxsSm9icyA9IGFsbEpvYnMuZmlsdGVyKGogPT4NCiAgICAgIChqLnRpdGxlIHx8ICcnKS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHNlYXJjaCkgfHwNCiAgICAgIChqLmNvbXBhbnkgfHwgJycpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKSB8fA0KICAgICAgKGouZGVzY3JpcHRpb24gfHwgJycpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKQ0KICAgICk7DQogIH0NCg0KICByZW5kZXJKb2JzKGFsbEpvYnMpOw0KICBhd2FpdCBsb2FkU3RhdHMoKTsNCiAgdXBkYXRlQ2xlYXJCdXR0b24oKTsNCn0NCg0KZnVuY3Rpb24gdXBkYXRlQ2xlYXJCdXR0b24oKSB7DQogIGNvbnN0IGhhc0ZpbHRlciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJykudmFsdWUgfHwNCiAgICAgICAgICAgICAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlZ2lvbkZpbHRlcicpLnZhbHVlIHx8DQogICAgICAgICAgICAgICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykudmFsdWUgfHwNCiAgICAgICAgICAgICAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NlYXJjaElucHV0JykudmFsdWU7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbGVhckZpbHRlcnMnKS5zdHlsZS5kaXNwbGF5ID0gaGFzRmlsdGVyID8gJycgOiAnbm9uZSc7DQp9DQoNCmZ1bmN0aW9uIHJlbmRlckpvYnMoam9icykgew0KICBjb25zdCBxID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlF1ZXVlJyk7DQogIGlmIChqb2JzLmxlbmd0aCA9PT0gMCkgew0KICAgIGNvbnN0IHJlc3VsdENvdW50ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jlc3VsdENvdW50Jyk7DQogIGlmIChyZXN1bHRDb3VudCkgcmVzdWx0Q291bnQudGV4dENvbnRlbnQgPSBqb2JzLmxlbmd0aDsNCiAgcS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0iZW1wdHktc3RhdGUiPjxkaXYgY2xhc3M9Imljb24iPuKOkzwvZGl2PjxoMz5ObyBqb2JzIGZvdW5kPC9oMz48cD5DbGljayAiU2NyYXBlIE5vdyIgdG8gZmV0Y2ggZnJlc2ggbGlzdGluZ3MgZnJvbSByZW1vdGUtZmlyc3QgYm9hcmRzLjwvcD48L2Rpdj4nOw0KICAgIHJldHVybjsNCiAgfQ0KICBxLmlubmVySFRNTCA9IGpvYnMubWFwKChqLCBpKSA9PiBqb2JSb3coaiwgaSkpLmpvaW4oJycpOw0KICBjb25zdCByYyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZXN1bHRDb3VudCcpOw0KICBpZiAocmMpIHJjLnRleHRDb250ZW50ID0gam9icy5sZW5ndGg7DQp9DQoNCmZ1bmN0aW9uIGpvYlJvdyhqb2IsIGluZGV4KSB7DQogIGNvbnN0IHNhbGFyeUJhZGdlID0gam9iLnNhbGFyeSA/IGA8c3BhbiBjbGFzcz0iam9iLXRhZyBzYWxhcnkiPiR7ZXNjYXBlSHRtbChqb2Iuc2FsYXJ5KX08L3NwYW4+YCA6ICcnOw0KICBjb25zdCByZW1vdGVCYWRnZSA9IGpvYi5yZW1vdGUgfHwgam9iLnNvdXJjZSA9PT0gJ1JlbW90ZU9LJyB8fCBqb2Iuc291cmNlID09PSAnUmVtb3RpdmUnIHx8IGpvYi5zb3VyY2UgPT09ICdXZVdvcmtSZW1vdGVseScNCiAgICA/IGA8c3BhbiBjbGFzcz0iam9iLXRhZyByZW1vdGUiPlJlbW90ZTwvc3Bhbj5gIDogJyc7DQogIGNvbnN0IHN0YXR1cyA9IGpvYi5zdGF0dXMgfHwgJ25ldyc7DQogIGNvbnN0IHN0YXR1c0NsYXNzID0gYHN0YXR1cy0ke3N0YXR1c31gOyAvLyBzdGF0dXNDbGFzcyBmb3Igc3RhdHVzLWJhZGdlIGNsYXNzDQogIGNvbnN0IHJvd0NsYXNzID0gc3RhdHVzID09PSAnYXBwbGllZCcgPyAnYXBwbGllZCcgOiBzdGF0dXMgPT09ICdzYXZlZCcgPyAnc2F2ZWQnDQogICAgOiBzdGF0dXMgPT09ICdza2lwcGVkJyA/ICdza2lwcGVkJyA6IHN0YXR1cyA9PT0gJ2lnbm9yZWQnID8gJ2lnbm9yZWQnIDogJyc7DQogIGNvbnN0IHBjdCA9IE1hdGgubWluKDEwMCwgTWF0aC5yb3VuZCgoam9iLnNjb3JlIHx8IDApIC8gMTIwICogMTAwKSk7DQogIGNvbnN0IHNjb3JlQ2xhc3MgPSBwY3QgPj0gNzAgPyAnaGlnaCcgOiBwY3QgPj0gNDAgPyAnbWlkJyA6ICdsb3cnOw0KICBjb25zdCBsb2NhdGlvbiA9IGpvYi5sb2NhdGlvbiB8fCBqb2IucmVnaW9uIHx8ICfigJQnOw0KICBjb25zdCBzb3VyY2VMYWJlbCA9IGpvYi5zb3VyY2UgfHwgJyc7DQoNCiAgbGV0IGFjdGlvbnNIdG1sID0gJyc7DQogIGlmIChzdGF0dXMgPT09ICduZXcnKSB7DQogICAgYWN0aW9uc0h0bWwgPSBgDQogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYWN0aW9uLWJ0biB2aWV3IiBhcmlhLWxhYmVsPSJWaWV3IGpvYiBkZXRhaWxzIj5WaWV3PC9hPg0KICAgICAgICA8YSBocmVmPSJqYXZhc2NyaXB0OnZvaWQoMCkiIG9uY2xpY2s9Im9wZW5BcHBseSgnJHtqb2IuaWR9JykiIGNsYXNzPSJhY3Rpb24tYnRuIGFwcGx5IiBhcmlhLWxhYmVsPSJBcHBseSB0byB0aGlzIGpvYiI+QXBwbHk8L2E+DQogICAgICAgIDxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9Jywnc2F2ZWQnKSIgY2xhc3M9ImFjdGlvbi1idG4gc2F2ZSIgYXJpYS1sYWJlbD0iU2F2ZSB0aGlzIGpvYiI+U2F2ZTwvYT4NCiAgICAgIGA7DQogIH0gZWxzZSBpZiAoc3RhdHVzID09PSAnYXBwbGllZCcpIHsNCiAgICBhY3Rpb25zSHRtbCA9IGANCiAgICAgICAgPGEgaHJlZj0iJHtlc2NhcGVIdG1sKGpvYi51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJhY3Rpb24tYnRuIHZpZXciIGFyaWEtbGFiZWw9IlZpZXcgam9iIGRldGFpbHMiPlZpZXc8L2E+DQogICAgICAgIDxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0ib3BlbkFwcGx5KCcke2pvYi5pZH0nKSIgY2xhc3M9ImFjdGlvbi1idG4gYXBwbHkiIGFyaWEtbGFiZWw9IlJlLWFwcGx5IHRvIHRoaXMgam9iIj5BcHBseTwvYT4NCiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdza2lwcGVkJykiIGNsYXNzPSJhY3Rpb24tYnRuIHNraXAiIGFyaWEtbGFiZWw9IlJldm9rZSBhcHBsaWNhdGlvbiBhbmQgc2tpcCI+UmV2b2tlPC9hPg0KICAgICAgYDsNCiAgfSBlbHNlIGlmIChzdGF0dXMgPT09ICdzYXZlZCcpIHsNCiAgICBhY3Rpb25zSHRtbCA9IGANCiAgICAgICAgPGEgaHJlZj0iJHtlc2NhcGVIdG1sKGpvYi51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJhY3Rpb24tYnRuIHZpZXciIGFyaWEtbGFiZWw9IlZpZXcgam9iIGRldGFpbHMiPlZpZXc8L2E+DQogICAgICAgIDxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0ib3BlbkFwcGx5KCcke2pvYi5pZH0nKSIgY2xhc3M9ImFjdGlvbi1idG4gYXBwbHkiIGFyaWEtbGFiZWw9IkFwcGx5IHRvIHRoaXMgam9iIj5BcHBseTwvYT4NCiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdza2lwcGVkJykiIGNsYXNzPSJhY3Rpb24tYnRuIHNraXAiIGFyaWEtbGFiZWw9Ik1vdmUgdG8gc2tpcHBlZCI+U2tpcDwvYT4NCiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdpZ25vcmVkJykiIGNsYXNzPSJhY3Rpb24tYnRuIHNraXAiIGFyaWEtbGFiZWw9Ik1vdmUgdG8gaWdub3JlZCI+SWdub3JlPC9hPg0KICAgICAgYDsNCiAgfSBlbHNlIGlmIChzdGF0dXMgPT09ICdza2lwcGVkJykgew0KICAgIGFjdGlvbnNIdG1sID0gYA0KICAgICAgICA8YSBocmVmPSIke2VzY2FwZUh0bWwoam9iLnVybCl9IiB0YXJnZXQ9Il9ibGFuayIgY2xhc3M9ImFjdGlvbi1idG4gdmlldyIgYXJpYS1sYWJlbD0iVmlldyBqb2IgZGV0YWlscyI+VmlldzwvYT4NCiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCduZXcnKSIgY2xhc3M9ImFjdGlvbi1idG4gc2F2ZSIgYXJpYS1sYWJlbD0iUmVvcGVuIHRoaXMgam9iIj5SZW9wZW48L2E+DQogICAgICBgOw0KICB9IGVsc2UgaWYgKHN0YXR1cyA9PT0gJ2lnbm9yZWQnKSB7DQogICAgYWN0aW9uc0h0bWwgPSBgDQogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYWN0aW9uLWJ0biB2aWV3IiBhcmlhLWxhYmVsPSJWaWV3IGpvYiBkZXRhaWxzIj5WaWV3PC9hPg0KICAgICAgICA8YSBocmVmPSJqYXZhc2NyaXB0OnZvaWQoMCkiIG9uY2xpY2s9Im1hcmtBY3Rpb24oJyR7am9iLmlkfScsJ25ldycpIiBjbGFzcz0iYWN0aW9uLWJ0biBzYXZlIiBhcmlhLWxhYmVsPSJSZW9wZW4gdGhpcyBqb2IiPlJlb3BlbjwvYT4NCiAgICAgIGA7DQogIH0NCg0KICByZXR1cm4gYA0KICA8ZGl2IGNsYXNzPSJqb2ItY2FyZCAke3Jvd0NsYXNzfSIgaWQ9ImpvYi0ke2pvYi5pZH0iPg0KICAgIDxkaXYgY2xhc3M9ImNhcmQtaW5mbyI+DQogICAgICA8ZGl2IGNsYXNzPSJqb2ItdGl0bGUiPg0KICAgICAgICAke2VzY2FwZUh0bWwoam9iLnRpdGxlKX0NCiAgICAgICAgPHNwYW4gY2xhc3M9InN0YXR1cy10YWcgJHtzdGF0dXNDbGFzc30iPiR7c3RhdHVzfTwvc3Bhbj4NCiAgICAgIDwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iam9iLWNvbXBhbnkiPiR7ZXNjYXBlSHRtbChqb2IuY29tcGFueSB8fCAnJyl9ICZtaWRkb3Q7ICR7ZXNjYXBlSHRtbChzb3VyY2VMYWJlbCl9PC9kaXY+DQogICAgICA8ZGl2IGNsYXNzPSJqb2ItdGFncyI+JHtyZW1vdGVCYWRnZX0ke3NhbGFyeUJhZGdlfTwvZGl2Pg0KICAgIDwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9ImNhcmQtZGV0YWlscyI+DQogICAgICA8ZGl2IGNsYXNzPSJsb2NhdGlvbiI+JHtlc2NhcGVIdG1sKGxvY2F0aW9uKX08L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9InNvdXJjZSI+JHtlc2NhcGVIdG1sKHNvdXJjZUxhYmVsKX08L2Rpdj4NCiAgICA8L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJjYXJkLXNjb3JlIj4NCiAgICAgIDxkaXYgY2xhc3M9InNjb3JlLXRyYWNrIj48ZGl2IGNsYXNzPSJzY29yZS1maWxsICR7c2NvcmVDbGFzc30iIHN0eWxlPSJ3aWR0aDoke3BjdH0lIj48L2Rpdj48L2Rpdj4NCiAgICAgIDxzcGFuIGNsYXNzPSJzY29yZS12YWwiPjxzdHJvbmc+JHtqb2Iuc2NvcmV9PC9zdHJvbmc+IHB0czwvc3Bhbj4NCiAgICA8L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJjYXJkLWFjdGlvbnMiPiR7YWN0aW9uc0h0bWx9PC9kaXY+DQogIDwvZGl2PmA7DQp9DQoNCi8vIOKUgOKUgCBBY3Rpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KYXN5bmMgZnVuY3Rpb24gbWFya0FjdGlvbihqb2JJZCwgYWN0aW9uKSB7DQogIGNvbnN0IGVuZHBvaW50TWFwID0geyBhcHBsaWVkOiAnYXBwbHknLCBza2lwcGVkOiAnc2tpcCcsIHNhdmVkOiAnc2F2ZScsIGlnbm9yZWQ6ICdpZ25vcmUnLCBuZXc6ICduZXcnIH07DQogIGNvbnN0IGVuZHBvaW50ID0gZW5kcG9pbnRNYXBbYWN0aW9uXSB8fCBhY3Rpb247DQogIGxldCBwYXlsb2FkID0geyBqb2JJZCB9Ow0KICBpZiAoYWN0aW9uID09PSAnc2tpcHBlZCcgfHwgYWN0aW9uID09PSAnaWdub3JlZCcpIHsNCiAgICBjb25zdCBqb2IgPSBhbGxKb2JzLmZpbmQoaiA9PiBqLmlkID09PSBqb2JJZCk7DQogICAgaWYgKGpvYiAmJiBqb2IudGl0bGUpIHBheWxvYWQudGl0bGUgPSBqb2IudGl0bGU7DQogIH0NCiAgdHJ5IHsNCiAgICBjb25zdCByZXNwID0gYXdhaXQgZmV0Y2goYCR7QVBJfS8ke2VuZHBvaW50fWAsIHsNCiAgICAgIG1ldGhvZDogJ1BPU1QnLA0KICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sDQogICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShwYXlsb2FkKQ0KICAgIH0pOw0KICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXNwLnRleHQoKTsNCiAgICBpZiAoIXJlc3Aub2spIHRocm93IG5ldyBFcnJvcignSFRUUCAnICsgcmVzcC5zdGF0dXMgKyAnOiAnICsgdGV4dCk7DQogICAgSlNPTi5wYXJzZSh0ZXh0KTsNCiAgICB0b2FzdChgJHthY3Rpb24uY2hhckF0KDApLnRvVXBwZXJDYXNlKCkgKyBhY3Rpb24uc2xpY2UoMSl9ZCBqb2JgKTsNCiAgICBhd2FpdCBsb2FkSm9icygpOw0KICB9IGNhdGNoIChlcnIpIHsNCiAgICB0b2FzdCgnRXJyb3I6ICcgKyBlcnIubWVzc2FnZSk7DQogIH0NCn0NCg0KLy8g4pSA4pSAIEFwcGx5IE1vZGFsIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KZnVuY3Rpb24gb3BlbkFwcGx5KGpvYklkKSB7DQogIGN1cnJlbnRKb2JJZCA9IGpvYklkOw0KICBjb25zdCBqb2IgPSBhbGxKb2JzLmZpbmQoaiA9PiBqLmlkID09PSBqb2JJZCk7DQogIGlmICgham9iKSByZXR1cm47DQogIGNvbnN0IHAgPSB3aW5kb3cuX3Byb2ZpbGUgfHwge307DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHBseUNvbnRlbnQnKS5pbm5lckhUTUwgPSBgDQogICAgPGRpdiBzdHlsZT0icGFkZGluZzoxLjVyZW0iPg0KICAgICAgPGgzIHN0eWxlPSJmb250LXNpemU6MTRweDtmb250LXdlaWdodDo2MDA7bWFyZ2luLWJvdHRvbTouMjVyZW0iPiR7ZXNjYXBlSHRtbChqb2IudGl0bGUpfSBAICR7ZXNjYXBlSHRtbChqb2IuY29tcGFueSl9PC9oMz4NCiAgICAgIDxwIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luOi41cmVtIDA7Zm9udC1zaXplOjEzcHgiPiR7ZXNjYXBlSHRtbChqb2IuZGVzY3JpcHRpb24/LnNsaWNlKDAsIDIwMCkpIHx8ICdObyBkZXNjcmlwdGlvbiBhdmFpbGFibGUuJ308L3A+DQogICAgICA8cCBzdHlsZT0ibWFyZ2luOi41cmVtIDA7Zm9udC1zaXplOjEzcHgiPjxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBzdHlsZT0iY29sb3I6dmFyKC0tYWNjZW50KSI+VmlldyBmdWxsIGpvYiBsaXN0aW5nIOKGkjwvYT48L3A+DQogICAgICA8aDQgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0OjUwMDtsZXR0ZXItc3BhY2luZzouMDZlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Y29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbjoxcmVtIDAgLjVyZW0iPkFwcGxpY2F0aW9uIENoZWNrbGlzdDo8L2g0Pg0KICAgICAgPHVsIGNsYXNzPSJhcHBseS1jaGVja2xpc3QiPg0KICAgICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBOYW1lOiA8c3BhbiBjbGFzcz0idmFsIj4ke2VzY2FwZUh0bWwocC5uYW1lIHx8ICfigJQnKX08L3NwYW4+PC9saT4NCiAgICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gRW1haWw6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLmVtYWlsIHx8ICfigJQnKX08L3NwYW4+PC9saT4NCiAgICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gUGhvbmU6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLnBob25lIHx8ICfigJQnKX08L3NwYW4+PC9saT4NCiAgICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gUmVzdW1lOiA8c3BhbiBjbGFzcz0idmFsIj4ke2VzY2FwZUh0bWwocC5yZXN1bWVfcGF0aCB8fCAnbm90IHNldCcpfTwvc3Bhbj48L2xpPg0KICAgICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBDb3ZlciBsZXR0ZXI6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7am9iLmNvdmVyX2xldHRlciA/ICfinJMgR2VuZXJhdGVkJyA6ICdSdW4gd2l0aCBBTlRIUk9QSUNfQVBJX0tFWSd9PC9zcGFuPjwvbGk+DQogICAgICA8L3VsPg0KICAgIDwvZGl2Pg0KICBgOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlVcmxCdG4nKS5ocmVmID0gam9iLnVybDsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21hcmtBcHBsaWVkQnRuJykub25jbGljayA9IGFzeW5jICgpID0+IHsNCiAgICBhd2FpdCBtYXJrQWN0aW9uKGpvYklkLCAnYXBwbGllZCcpOw0KICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHBseU1vZGFsJykuc3R5bGUuZGlzcGxheSA9ICdub25lJzsNCiAgICB0b2FzdCgnTWFya2VkIGFzIGFwcGxpZWQhJyk7DQogIH07DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHBseU1vZGFsJykuc3R5bGUuZGlzcGxheSA9ICdmbGV4JzsNCn0NCg0KLy8g4pSA4pSAIFByb2ZpbGUgTW9kYWwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJvZmlsZUJ0bicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7DQogIGNvbnN0IHAgPSBhd2FpdCAoYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCkpLmpzb24oKTsNCiAgd2luZG93Ll9wcm9maWxlID0gcDsNCiAgT2JqZWN0LmtleXMocCkuZm9yRWFjaChrID0+IHsNCiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwXycgKyBrKTsNCiAgICBpZiAoZWwpIGVsLnZhbHVlID0gQXJyYXkuaXNBcnJheShwW2tdKSA/IHBba10uam9pbignLCAnKSA6IChwW2tdIHx8ICcnKTsNCiAgfSk7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnOw0KfTsNCg0KZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVGb3JtJykub25zdWJtaXQgPSBhc3luYyAoZSkgPT4gew0KICBlLnByZXZlbnREZWZhdWx0KCk7DQogIGNvbnN0IGZkID0gbmV3IEZvcm1EYXRhKGUudGFyZ2V0KTsNCiAgY29uc3QgcCA9IHt9Ow0KICBmZC5mb3JFYWNoKCh2LCBrKSA9PiB7IHBba10gPSB2OyB9KTsNCiAgZm9yIChjb25zdCBrZXkgb2YgWydza2lsbHMnLCAndGFyZ2V0X3RpdGxlcycsICdyZXF1aXJlZF9rZXl3b3JkcycsICdib251c19rZXl3b3JkcycsICdkZWFsX2JyZWFrZXJzJywgJ3ByZWZlcnJlZF93b3JrX3R5cGUnLCAncHJlZmVycmVkX2xvY2F0aW9ucycsICdwcmVmZXJyZWRfZW1wbG95bWVudCddKSB7DQogICAgcFtrZXldID0gKHBba2V5XSB8fCAnJykuc3BsaXQoJywnKS5tYXAocyA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pOw0KICB9DQogIHAuZXhwZXJpZW5jZV95ZWFycyA9IHBhcnNlSW50KHAuZXhwZXJpZW5jZV95ZWFycykgfHwgMDsNCiAgcC5zYWxhcnlfbWluX2xha2hzID0gcGFyc2VGbG9hdChwLnNhbGFyeV9taW5fbGFraHMpIHx8IDM1Ow0KICBwLnRhcmdldF9zYWxhcnkgPSB7IGN1cnJlbmN5OiBwLnNhbGFyeV9jdXJyZW5jeSB8fCAnSU5SJywgbWluX2xha2hzOiBwLnNhbGFyeV9taW5fbGFraHMgfTsNCiAgYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCwgeyBtZXRob2Q6ICdQVVQnLCBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwgYm9keTogSlNPTi5zdHJpbmdpZnkocCkgfSk7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOw0KICB0b2FzdCgnUHJvZmlsZSBzYXZlZCEnKTsNCiAgbG9hZFByb2ZpbGUoKTsNCn07DQoNCi8vIOKUgOKUgCBFdmVudHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQpmdW5jdGlvbiBiaW5kRXZlbnRzKCkgew0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NyYXBlQnRuJykub25jbGljayA9IGFzeW5jICgpID0+IHsNCiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NyYXBlQnRuJykuZGlzYWJsZWQgPSB0cnVlOw0KICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS50ZXh0Q29udGVudCA9ICdTY3JhcGluZy4uLic7DQogICAgYXdhaXQgZmV0Y2goYCR7QVBJfS9zY3JhcGVgLCB7IG1ldGhvZDogJ1BPU1QnIH0pOw0KICAgIHNldFRpbWVvdXQoKCkgPT4gew0KICAgICAgbG9hZEpvYnMoKTsNCiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS5kaXNhYmxlZCA9IGZhbHNlOw0KICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjcmFwZUJ0bicpLnRleHRDb250ZW50ID0gJ1NjcmFwZSBOb3cnOw0KICAgIH0sIDIwMDApOw0KICB9Ow0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xlYXJGaWx0ZXJzJykub25jbGljayA9ICgpID0+IHsNCiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY29tcGFueUZpbHRlcicpLnZhbHVlID0gJyc7DQogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlZ2lvbkZpbHRlcicpLnZhbHVlID0gJyc7DQogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlR5cGVGaWx0ZXInKS52YWx1ZSA9ICcnOw0KICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZWFyY2hJbnB1dCcpLnZhbHVlID0gJyc7DQogICAgbG9hZEpvYnMoKTsNCiAgfTsNCg0KICBmdW5jdGlvbiBvbkZpbHRlckNoYW5nZSgpIHsgbG9hZEpvYnMoKTsgdXBkYXRlQ2xlYXJCdXR0b24oKTsgfQ0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzRmlsdGVyJykub25jaGFuZ2UgPSBsb2FkSm9iczsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKS5vbmNoYW5nZSA9IG9uRmlsdGVyQ2hhbmdlOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVnaW9uRmlsdGVyJykub25jaGFuZ2UgPSBvbkZpbHRlckNoYW5nZTsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlR5cGVGaWx0ZXInKS5vbmNoYW5nZSA9IG9uRmlsdGVyQ2hhbmdlOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc291cmNlRmlsdGVyJykub25jaGFuZ2UgPSBsb2FkSm9iczsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NvcnRGaWx0ZXInKS5vbmNoYW5nZSA9IGxvYWRKb2JzOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2VhcmNoSW5wdXQnKS5vbmlucHV0ID0gKCkgPT4gew0KICAgIGNsZWFyVGltZW91dCh3aW5kb3cuX3NlYXJjaFRpbWVyKTsNCiAgICB3aW5kb3cuX3NlYXJjaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IGxvYWRKb2JzKCk7IHVwZGF0ZUNsZWFyQnV0dG9uKCk7IH0sIDMwMCk7DQogIH07DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbG9zZVByb2ZpbGVCdG4nKS5vbmNsaWNrID0gKCkgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjYW5jZWxQcm9maWxlQnRuJykub25jbGljayA9ICgpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xvc2VBcHBseUJ0bicpLm9uY2xpY2sgPSAoKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7DQp9DQoNCi8vIOKUgOKUgCBVdGlscyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCmZ1bmN0aW9uIHRvYXN0KG1zZykgew0KICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0b2FzdCcpOw0KICBlbC50ZXh0Q29udGVudCA9IG1zZzsgZWwuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7DQogIHNldFRpbWVvdXQoKCkgPT4gZWwuc3R5bGUuZGlzcGxheSA9ICdub25lJywgMjUwMCk7DQp9DQoNCmZ1bmN0aW9uIGVzY2FwZUh0bWwocykgew0KICBpZiAoIXMpIHJldHVybiAnJzsNCiAgcmV0dXJuIFN0cmluZyhzKS5yZXBsYWNlKC8mL2csJyZhbXA7JykucmVwbGFjZSgvPC9nLCcmbHQ7JykucmVwbGFjZSgvPi9nLCcmZ3Q7JykucmVwbGFjZSgvIi9nLCcmcXVvdDsnKTsNCn0NCg0Kd2luZG93Lm1hcmtBY3Rpb24gPSBtYXJrQWN0aW9uOw0Kd2luZG93Lm9wZW5BcHBseSA9IG9wZW5BcHBseTsNCg==';

const DASHBOARD_HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0iVVRGLTgiLz4KICA8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEuMCIvPgogIDx0aXRsZT5Kb2IgQWdlbnQg4oCUIHlvdXIgY2FyZWVyLiBhdXRvbWF0ZWQuPC90aXRsZT4KICA8bGluayByZWw9InN0eWxlc2hlZXQiIGhyZWY9Ii9zdHlsZXMuY3NzP3Q9X19TVFlMRVNfVkVSU0lPTl9fIi8+CjwvaGVhZD4KPGJvZHk+CiAgPGRpdiBjbGFzcz0iYW1iaWVudC1nbG93Ij48L2Rpdj4KCiAgPCEtLSBUb3AgQmFyIC0tPgogIDxoZWFkZXIgY2xhc3M9InRvcGJhciI+CiAgICA8ZGl2IGNsYXNzPSJ0b3BiYXItaW5uZXIiPgogICAgICA8ZGl2IGNsYXNzPSJ0b3BiYXItYnJhbmQiPgogICAgICAgIDxoMT5Kb2I8c3Bhbj5BZ2VudDwvc3Bhbj48L2gxPgogICAgICAgIDxzcGFuIGNsYXNzPSJ0b3BiYXItdGFnbGluZSI+eW91ciBjYXJlZXIuIGF1dG9tYXRlZC48L3NwYW4+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0b3BiYXItbWV0YSI+CiAgICAgICAgPHNwYW4+PHNwYW4gY2xhc3M9ImxpdmUtZG90IiBzdHlsZT0iZGlzcGxheTppbmxpbmUtYmxvY2s7dmVydGljYWwtYWxpZ246bWlkZGxlO21hcmdpbi1yaWdodDo0cHg7Ij48L3NwYW4+PHNwYW4gaWQ9InRvcGJhck1hdGNoZWQiPuKAlCBtYXRjaGVkPC9zcGFuPjwvc3Bhbj4KICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgPHNwYW4gaWQ9InRvcGJhclRvdGFsIj7igJQgdG90YWw8L3NwYW4+CiAgICAgICAgPHNwYW4gY2xhc3M9ImRvdCI+PC9zcGFuPgogICAgICAgIDxzcGFuIGlkPSJ1dGNUaW1lIj4tLTotLSBJU1Q8L3NwYW4+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0b3BiYXItYWN0aW9ucyI+CiAgICAgICAgPGJ1dHRvbiBpZD0icHJvZmlsZUJ0biIgY2xhc3M9ImJ0biBidG4tZ2hvc3QiPlByb2ZpbGU8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGlkPSJzY3JhcGVCdG4iIGNsYXNzPSJidG4gYnRuLXByaW1hcnkiPuKaoSBTY3JhcGUgTm93PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgPC9oZWFkZXI+CgogIDxkaXYgY2xhc3M9InBhZ2Utd3JhcCI+CiAgICA8IS0tIEhlcm8gU3RhdHMgLS0+CiAgICA8ZGl2IGNsYXNzPSJoZXJvLXN0YXRzIj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdC1jZWxsIj48c3BhbiBjbGFzcz0ibnVtIj7igJQ8L3NwYW4+PHNwYW4gY2xhc3M9ImxhYmVsIj5Ub3RhbCBKb2JzPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0LWNlbGwiPjxzcGFuIGNsYXNzPSJudW0gYWNjZW50Ij7igJQ8L3NwYW4+PHNwYW4gY2xhc3M9ImxhYmVsIj5OZXc8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQtY2VsbCI+PHNwYW4gY2xhc3M9Im51bSBhbWJlciI+4oCUPC9zcGFuPjxzcGFuIGNsYXNzPSJsYWJlbCI+U2F2ZWQ8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQtY2VsbCI+PHNwYW4gY2xhc3M9Im51bSBncmVlbiI+4oCUPC9zcGFuPjxzcGFuIGNsYXNzPSJsYWJlbCI+QXBwbGllZDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdC1jZWxsIj48c3BhbiBjbGFzcz0ibnVtIHJlZCI+4oCUPC9zcGFuPjxzcGFuIGNsYXNzPSJsYWJlbCI+U2tpcHBlZDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdC1jZWxsIj48c3BhbiBjbGFzcz0ibnVtIGRpbSI+4oCUPC9zcGFuPjxzcGFuIGNsYXNzPSJsYWJlbCI+SWdub3JlZDwvc3Bhbj48L2Rpdj4KICAgIDwvZGl2PgoKICAgIDwhLS0gRmlsdGVycyAtLT4KICAgIDxkaXYgY2xhc3M9ImZpbHRlci1waWxscyIgaWQ9ImZpbHRlclBpbGxzIj48L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJmaWx0ZXItYmFyIj4KICAgICAgPHNlbGVjdCBpZD0ic3RhdHVzRmlsdGVyIiB0aXRsZT0iRmlsdGVyIGJ5IHN0YXR1cyIgYXJpYS1sYWJlbD0iRmlsdGVyIGJ5IHN0YXR1cyI+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0ibmV3Ij5OZXcgSm9iczwvb3B0aW9uPgogICAgICAgIDxvcHRpb24gdmFsdWU9InNhdmVkIj5TYXZlZDwvb3B0aW9uPgogICAgICAgIDxvcHRpb24gdmFsdWU9ImFwcGxpZWQiPkFwcGxpZWQ8L29wdGlvbj4KICAgICAgICA8b3B0aW9uIHZhbHVlPSJza2lwcGVkIj5Ta2lwcGVkPC9vcHRpb24+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iaWdub3JlZCI+SWdub3JlZDwvb3B0aW9uPgogICAgICA8L3NlbGVjdD4KICAgICAgPHNlbGVjdCBpZD0iY29tcGFueUZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBjb21wYW55IiBhcmlhLWxhYmVsPSJGaWx0ZXIgYnkgY29tcGFueSI+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgQ29tcGFuaWVzPC9vcHRpb24+CiAgICAgIDwvc2VsZWN0PgogICAgICA8c2VsZWN0IGlkPSJyZWdpb25GaWx0ZXIiIHRpdGxlPSJGaWx0ZXIgYnkgcmVnaW9uIiBhcmlhLWxhYmVsPSJGaWx0ZXIgYnkgcmVnaW9uIj4KICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBSZWdpb25zPC9vcHRpb24+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iaW5kaWEiPkluZGlhPC9vcHRpb24+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0icmVtb3RlIj5SZW1vdGU8L29wdGlvbj4KICAgICAgICA8b3B0aW9uIHZhbHVlPSJ1c2EiPlVTQTwvb3B0aW9uPgogICAgICAgIDxvcHRpb24gdmFsdWU9ImV1cm9wZSI+RXVyb3BlPC9vcHRpb24+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYXNpYS1wYWNpZmljIj5Bc2lhLVBhY2lmaWM8L29wdGlvbj4KICAgICAgPC9zZWxlY3Q+CiAgICAgIDxzZWxlY3QgaWQ9ImpvYlR5cGVGaWx0ZXIiIHRpdGxlPSJGaWx0ZXIgYnkgam9iIHR5cGUiIGFyaWEtbGFiZWw9IkZpbHRlciBieSBqb2IgdHlwZSI+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgVHlwZXM8L29wdGlvbj4KICAgICAgICA8b3B0aW9uIHZhbHVlPSJyZW1vdGUiPlJlbW90ZSBPbmx5PC9vcHRpb24+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0ib25zaXRlIj5Pbi1zaXRlIE9ubHk8L29wdGlvbj4KICAgICAgPC9zZWxlY3Q+CiAgICAgIDxzZWxlY3QgaWQ9InNvdXJjZUZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBzb3VyY2UiIGFyaWEtbGFiZWw9IkZpbHRlciBieSBzb3VyY2UiPgogICAgICAgIDxvcHRpb24gdmFsdWU9IiI+QWxsIFNvdXJjZXM8L29wdGlvbj4KICAgICAgPC9zZWxlY3Q+CiAgICAgIDxzZWxlY3QgaWQ9InNvcnRGaWx0ZXIiIHRpdGxlPSJTb3J0IGJ5IiBhcmlhLWxhYmVsPSJTb3J0IGJ5Ij4KICAgICAgICA8b3B0aW9uIHZhbHVlPSJzY29yZSI+U2NvcmUgKGRlc2MpPC9vcHRpb24+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0icG9zdGVkIj5OZXdlc3Q8L29wdGlvbj4KICAgICAgPC9zZWxlY3Q+CiAgICAgIDxkaXYgY2xhc3M9InNwYWNlciI+PC9kaXY+CiAgICAgIDxpbnB1dCBpZD0ic2VhcmNoSW5wdXQiIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSJTZWFyY2ggdGl0bGUsIGNvbXBhbnkuLi4iLz4KICAgICAgPGJ1dHRvbiBpZD0iY2xlYXJGaWx0ZXJzIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCIgc3R5bGU9ImRpc3BsYXk6bm9uZSI+Q2xlYXI8L2J1dHRvbj4KICAgIDwvZGl2PgoKICAgIDwhLS0gU2VjdGlvbiBsYWJlbCAtLT4KICAgIDxkaXYgY2xhc3M9InNlY3Rpb24tbGFiZWwiIGlkPSJzZWN0aW9uTGFiZWwiPkpvYiBRdWV1ZSDigJQgPHNwYW4gaWQ9InJlc3VsdENvdW50Ij7igJQ8L3NwYW4+IHJlc3VsdHM8L2Rpdj4KCiAgICA8IS0tIEpvYiBMaXN0IC0tPgogICAgPGRpdiBjbGFzcz0iam9iLWxpc3QiIGlkPSJqb2JRdWV1ZSI+CiAgICAgIDxkaXYgY2xhc3M9ImVtcHR5LXN0YXRlIj48cD5Mb2FkaW5nIGpvYnMuLi48L3A+PC9kaXY+CiAgICA8L2Rpdj4KICA8L2Rpdj4KCiAgPCEtLSBQcm9maWxlIE1vZGFsIC0tPgogIDxkaXYgaWQ9InByb2ZpbGVNb2RhbCIgY2xhc3M9Im1vZGFsIiBzdHlsZT0iZGlzcGxheTpub25lIiByb2xlPSJkaWFsb2ciIGFyaWEtbW9kYWw9InRydWUiIGFyaWEtbGFiZWw9IkVkaXQgcHJvZmlsZSI+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1jb250ZW50Ij4KICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtaGVhZGVyIj4KICAgICAgICA8aDI+RWRpdCBwcm9maWxlPC9oMj4KICAgICAgICA8YnV0dG9uIGlkPSJjbG9zZVByb2ZpbGVCdG4iIGNsYXNzPSJjbG9zZSIgYXJpYS1sYWJlbD0iQ2xvc2UgZGlhbG9nIj4mdGltZXM7PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8Zm9ybSBpZD0icHJvZmlsZUZvcm0iPgogICAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JpZCI+CiAgICAgICAgICA8bGFiZWw+TmFtZTxpbnB1dCBpZD0icF9uYW1lIiBuYW1lPSJuYW1lIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5FbWFpbDxpbnB1dCBpZD0icF9lbWFpbCIgbmFtZT0iZW1haWwiIHR5cGU9ImVtYWlsIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5QaG9uZTxpbnB1dCBpZD0icF9waG9uZSIgbmFtZT0icGhvbmUiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkxpbmtlZEluPGlucHV0IGlkPSJwX2xpbmtlZGluIiBuYW1lPSJsaW5rZWRpbiIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+TG9jYXRpb248aW5wdXQgaWQ9InBfbG9jYXRpb24iIG5hbWU9ImxvY2F0aW9uIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5SZXN1bWUgUGF0aDxpbnB1dCBpZD0icF9yZXN1bWVfcGF0aCIgbmFtZT0icmVzdW1lX3BhdGgiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkV4cGVyaWVuY2UgKHllYXJzKTxpbnB1dCBpZD0icF9leHAiIG5hbWU9ImV4cGVyaWVuY2VfeWVhcnMiIHR5cGU9Im51bWJlciIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+Q3VycmVudCBSb2xlPGlucHV0IGlkPSJwX3JvbGUiIG5hbWU9ImN1cnJlbnRfcm9sZSIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+Q3VycmVudCBDb21wYW55PGlucHV0IGlkPSJwX2NvbXBhbnkiIG5hbWU9ImN1cnJlbnRfY29tcGFueSIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+U2tpbGxzIChjb21tYS1zZXBhcmF0ZWQpPGlucHV0IGlkPSJwX3NraWxscyIgbmFtZT0ic2tpbGxzIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5UYXJnZXQgVGl0bGVzIChjb21tYS1zZXBhcmF0ZWQpPGlucHV0IGlkPSJwX3RpdGxlcyIgbmFtZT0idGFyZ2V0X3RpdGxlcyIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+UmVxdWlyZWQgS2V5d29yZHM8aW5wdXQgaWQ9InBfcmVxX2t3IiBuYW1lPSJyZXF1aXJlZF9rZXl3b3JkcyIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+Qm9udXMgS2V5d29yZHM8aW5wdXQgaWQ9InBfYm9udXNfa3ciIG5hbWU9ImJvbnVzX2tleXdvcmRzIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5NaW4gU2FsYXJ5IChMYWtocyBJTlIpPGlucHV0IGlkPSJwX21pbl9zYWxhcnkiIG5hbWU9InNhbGFyeV9taW5fbGFraHMiIHR5cGU9Im51bWJlciIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+Q3VycmVuY3kKICAgICAgICAgICAgPHNlbGVjdCBpZD0icF9jdXJyZW5jeSIgbmFtZT0ic2FsYXJ5X2N1cnJlbmN5Ij4KICAgICAgICAgICAgICA8b3B0aW9uPklOUjwvb3B0aW9uPjxvcHRpb24+VVNEPC9vcHRpb24+PG9wdGlvbj5FVVI8L29wdGlvbj48b3B0aW9uPkdCUDwvb3B0aW9uPgogICAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICAgIDwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+V29yayBUeXBlCiAgICAgICAgICAgIDxzZWxlY3QgaWQ9InBfd29ya190eXBlIiBuYW1lPSJ3b3JrX3R5cGUiIG11bHRpcGxlIHNpemU9IjMiPgogICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9InJlbW90ZSI+UmVtb3RlPC9vcHRpb24+CiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iaHlicmlkIj5IeWJyaWQ8L29wdGlvbj4KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJvbi1zaXRlIj5Pbi1zaXRlPC9vcHRpb24+CiAgICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgICAgPC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5QcmVmZXJyZWQgTG9jYXRpb25zPGlucHV0IGlkPSJwX2xvY2F0aW9ucyIgbmFtZT0ibG9jYXRpb25zIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5TdW1tYXJ5PHRleHRhcmVhIGlkPSJwX3N1bW1hcnkiIG5hbWU9InN1bW1hcnkiIHJvd3M9IjMiPjwvdGV4dGFyZWE+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj4KICAgICAgICAgIDxidXR0b24gdHlwZT0ic3VibWl0IiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5Ij5TYXZlIFByb2ZpbGU8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gdHlwZT0iYnV0dG9uIiBpZD0iY2FuY2VsUHJvZmlsZUJ0biIgY2xhc3M9ImJ0biBidG4tZ2hvc3QiPkNhbmNlbDwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Zvcm0+CiAgICA8L2Rpdj4KICA8L2Rpdj4KCiAgPCEtLSBBcHBseSBNb2RhbCAtLT4KICA8ZGl2IGlkPSJhcHBseU1vZGFsIiBjbGFzcz0ibW9kYWwiIHN0eWxlPSJkaXNwbGF5Om5vbmUiIHJvbGU9ImRpYWxvZyIgYXJpYS1tb2RhbD0idHJ1ZSIgYXJpYS1sYWJlbD0iUHJlcGFyZSBhcHBsaWNhdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1jb250ZW50Ij4KICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtaGVhZGVyIj4KICAgICAgICA8aDI+UHJlcGFyZSBhcHBsaWNhdGlvbjwvaDI+CiAgICAgICAgPGJ1dHRvbiBpZD0iY2xvc2VBcHBseUJ0biIgY2xhc3M9ImNsb3NlIiBhcmlhLWxhYmVsPSJDbG9zZSBkaWFsb2ciPiZ0aW1lczs8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgaWQ9ImFwcGx5Q29udGVudCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1vZGFsLWFjdGlvbnMiPgogICAgICAgIDxhIGlkPSJhcHBseVVybEJ0biIgaHJlZj0iIyIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJidG4gYnRuLWdob3N0Ij5PcGVuIEpvYiBQYWdlPC9hPgogICAgICAgIDxidXR0b24gaWQ9Im1hcmtBcHBsaWVkQnRuIiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1ncmVlbikiPk1hcmsgYXMgQXBwbGllZDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvZGl2PgoKICA8ZGl2IGlkPSJ0b2FzdCIgY2xhc3M9InRvYXN0Ij48L2Rpdj4KICA8c2NyaXB0IHNyYz0iL2FwcC5qcz90PV9fVElNRVNUQU1QX18iPjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K';

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
