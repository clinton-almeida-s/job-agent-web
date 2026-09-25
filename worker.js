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
const STYLES_CSS_B64 = 'LyogTWlzc2lvbiBDb250cm9sIERhc2hib2FyZCAqLwpAaW1wb3J0IHVybCgnaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbS9jc3MyP2ZhbWlseT1JbnRlcjp3Z2h0QDQwMDs1MDA7NjAwOzcwMCZmYW1pbHk9SmV0QnJhaW5zK01vbm86d2dodEA0MDA7NTAwOzYwMCZkaXNwbGF5PXN3YXAnKTsKCjpyb290IHsKICAtLWJnOiAjMDgwOTBEOwogIC0tc3VyZmFjZTogIzExMTMxODsKICAtLXN1cmZhY2UyOiAjMUExRDI3OwogIC0tYm9yZGVyOiAjMUYyOTM3OwogIC0tYm9yZGVyLXN1YnRsZTogIzI1MkMzQjsKICAtLXRleHQ6ICNFNUU3RUI7CiAgLS1tdXRlZDogIzcyNzk4NjsKICAtLW11dGVkLWRpbTogIzVCNjM3MDsKICAtLWFjY2VudDogIzAwRDRGRjsKICAtLWFjY2VudC1kaW06IHJnYmEoMCwgMjEyLCAyNTUsIDAuMTIpOwogIC0tZ3JlZW46ICMxMEI5ODE7CiAgLS1ncmVlbi1kaW06IHJnYmEoMTYsIDE4NSwgMTI5LCAwLjEyKTsKICAtLWFtYmVyOiAjRjU5RTBCOwogIC0tYW1iZXItZGltOiByZ2JhKDI0NSwgMTU4LCAxMSwgMC4xMik7CiAgLS1yZWQ6ICNFRjQ0NDQ7CiAgLS1yZWQtZGltOiByZ2JhKDIzOSwgNjgsIDY4LCAwLjEyKTsKfQoKKiB7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7IG1hcmdpbjogMDsgcGFkZGluZzogMDsgfQoKLyogR2xvYmFsIGZvY3VzLXZpc2libGUgZm9yIGtleWJvYXJkIG5hdmlnYXRpb24gKi8KKjpmb2N1cy12aXNpYmxlIHsKICBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tYWNjZW50KTsKICBvdXRsaW5lLW9mZnNldDogMnB4OwogIGJvcmRlci1yYWRpdXM6IDJweDsKfQpidXR0b246Zm9jdXMtdmlzaWJsZSwgYTpmb2N1cy12aXNpYmxlIHsKICBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tYWNjZW50KTsKICBvdXRsaW5lLW9mZnNldDogMnB4Owp9Cgpib2R5IHsKICBmb250LWZhbWlseTogJ0ludGVyJywgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBzYW5zLXNlcmlmOwogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgbWluLWhlaWdodDogMTAwdmg7CiAgZm9udC1zaXplOiAxNHB4OwogIGxpbmUtaGVpZ2h0OiAxLjU7Cn0KCi8qIOKUgOKUgCBUb3AgQmFyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwoudG9wYmFyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIHBhZGRpbmc6IDAgMS41cmVtOwogIGhlaWdodDogNDhweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBwb3NpdGlvbjogc3RpY2t5OwogIHRvcDogMDsKICB6LWluZGV4OiAxMDsKfQoKLnRvcGJhci1icmFuZCB7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogYmFzZWxpbmU7CiAgZ2FwOiAuNzVyZW07Cn0KCi50b3BiYXItYnJhbmQgaDEgewogIGZvbnQtc2l6ZTogMTNweDsKICBmb250LXdlaWdodDogNzAwOwogIGxldHRlci1zcGFjaW5nOiAuMDhlbTsKICBjb2xvcjogdmFyKC0tYWNjZW50KTsKICB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOwp9CgoudG9wYmFyLW1ldGEgewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiAxMXB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IDFyZW07CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKfQoKLnRvcGJhci1tZXRhIC5kb3QgewogIHdpZHRoOiAzcHg7CiAgaGVpZ2h0OiAzcHg7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGJhY2tncm91bmQ6IHZhcigtLW11dGVkLWRpbSk7Cn0KCi50b3BiYXItbWV0YSAubGl2ZS1kb3QgewogIHdpZHRoOiA2cHg7CiAgaGVpZ2h0OiA2cHg7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGJhY2tncm91bmQ6IHZhcigtLWdyZWVuKTsKICBib3gtc2hhZG93OiAwIDAgNnB4IHZhcigtLWdyZWVuKTsKfQoKLnRvcGJhci1hY3Rpb25zIHsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogLjVyZW07Cn0KCi8qIOKUgOKUgCBCdXR0b25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwouYnRuIHsKICBmb250LWZhbWlseTogJ0ludGVyJywgc2Fucy1zZXJpZjsKICBmb250LXNpemU6IDEycHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBwYWRkaW5nOiAuMzc1cmVtIC43NXJlbTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgY3Vyc29yOiBwb2ludGVyOwogIGJvcmRlcjogbm9uZTsKICB0cmFuc2l0aW9uOiBiYWNrZ3JvdW5kIC4xNXMsIGJvcmRlci1jb2xvciAuMTVzOwp9CgouYnRuLXByaW1hcnkgewogIGJhY2tncm91bmQ6IHZhcigtLWFjY2VudCk7CiAgY29sb3I6IHZhcigtLWJnKTsKfQouYnRuLXByaW1hcnk6aG92ZXIgeyBiYWNrZ3JvdW5kOiAjMzNERkZGOyB9CgouYnRuLWdob3N0IHsKICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmJ0bi1naG9zdDpob3ZlciB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZTIpOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBib3JkZXItY29sb3I6IHZhcigtLWJvcmRlci1zdWJ0bGUpOwp9CgovKiDilIDilIAgU3RhdCBTdHJpcCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KLnN0YXQtc3RyaXAgewogIGRpc3BsYXk6IGZsZXg7CiAgZ2FwOiAwOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwp9Cgouc3RhdC1jZWxsIHsKICBmbGV4OiAxOwogIHBhZGRpbmc6IC43NXJlbSAxLjI1cmVtOwogIGJvcmRlci1yaWdodDogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGdhcDogMnB4Owp9Ci5zdGF0LWNlbGw6bGFzdC1jaGlsZCB7IGJvcmRlci1yaWdodDogbm9uZTsgfQoKLnN0YXQtY2VsbCAubnVtIHsKICBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOwogIGZvbnQtc2l6ZTogMjBweDsKICBmb250LXdlaWdodDogNjAwOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBsaW5lLWhlaWdodDogMTsKfQoKLnN0YXQtY2VsbCAubnVtLmFjY2VudCB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5zdGF0LWNlbGwgLm51bS5ncmVlbiB7IGNvbG9yOiB2YXIoLS1ncmVlbik7IH0KLnN0YXQtY2VsbCAubnVtLmFtYmVyIHsgY29sb3I6IHZhcigtLWFtYmVyKTsgfQouc3RhdC1jZWxsIC5udW0ucmVkIHsgY29sb3I6IHZhcigtLXJlZCk7IH0KCi5zdGF0LWNlbGwgLmxhYmVsIHsKICBmb250LXNpemU6IDEwcHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBsZXR0ZXItc3BhY2luZzogLjA0ZW07CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQoKLyog4pSA4pSAIEZpbHRlciBCYXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5maWx0ZXItYmFyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAuNXJlbTsKICBwYWRkaW5nOiAuNjI1cmVtIDEuNXJlbTsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7CiAgZmxleC13cmFwOiB3cmFwOwp9CgouZmlsdGVyLWJhciBzZWxlY3QsCi5maWx0ZXItYmFyIGlucHV0IHsKICBmb250LWZhbWlseTogJ0ludGVyJywgc2Fucy1zZXJpZjsKICBmb250LXNpemU6IDEycHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgY29sb3I6IHZhcigtLXRleHQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcGFkZGluZzogLjNyZW0gLjZyZW07CiAgYm9yZGVyLXJhZGl1czogM3B4OwogIG91dGxpbmU6IG5vbmU7Cn0KLmZpbHRlci1iYXIgc2VsZWN0OmZvY3VzLAouZmlsdGVyLWJhciBpbnB1dDpmb2N1cyB7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOwogIGJveC1zaGFkb3c6IDAgMCAwIDJweCB2YXIoLS1hY2NlbnQtZGltKTsKfQoKLmZpbHRlci1iYXIgc2VsZWN0IHsgbWluLXdpZHRoOiAxMjBweDsgY3Vyc29yOiBwb2ludGVyOyB9Ci5maWx0ZXItYmFyIGlucHV0W3R5cGU9InRleHQiXSB7IG1pbi13aWR0aDogMjAwcHg7IH0KCi5maWx0ZXItYmFyIC5zcGFjZXIgeyBmbGV4OiAxOyB9CgovKiDilIDilIAgSm9iIExpc3Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5qb2ItbGlzdCB7CiAgcGFkZGluZzogMDsKfQoKLmpvYi1yb3cgewogIGRpc3BsYXk6IGdyaWQ7CiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgYXV0byAxNjBweCAyMDBweDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMDsKICBwYWRkaW5nOiAwOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXItc3VidGxlKTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICB0cmFuc2l0aW9uOiBiYWNrZ3JvdW5kIC4xczsKICBjdXJzb3I6IGRlZmF1bHQ7Cn0KCi5qb2Itcm93OmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZTIpOyB9Ci5qb2Itcm93LmFwcGxpZWQgeyBib3JkZXItbGVmdDogMnB4IHNvbGlkIHZhcigtLWdyZWVuKTsgfQouam9iLXJvdy5zYXZlZCB7IGJvcmRlci1sZWZ0OiAycHggc29saWQgdmFyKC0tYW1iZXIpOyB9Ci5qb2Itcm93LnNraXBwZWQgeyBiYWNrZ3JvdW5kOiByZ2JhKDIzOSwgNjgsIDY4LCAwLjA0KTsgYm9yZGVyLWxlZnQ6IDJweCBzb2xpZCByZ2JhKDIzOSwgNjgsIDY4LCAwLjMpOyB9Ci5qb2Itcm93LnNraXBwZWQgLmpvYi10aXRsZSwKLmpvYi1yb3cuc2tpcHBlZCAuam9iLWNvbXBhbnksCi5qb2Itcm93LnNraXBwZWQgLmpvYi1kZXRhaWxzIC5sb2NhdGlvbiB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0KLmpvYi1yb3cuaWdub3JlZCB7IGJhY2tncm91bmQ6IHJnYmEoMTA3LCAxMTQsIDEyOCwgMC4wNik7IGJvcmRlci1sZWZ0OiAycHggc29saWQgcmdiYSgxMDcsIDExNCwgMTI4LCAwLjMpOyB9Ci5qb2Itcm93Lmlnbm9yZWQgLmpvYi10aXRsZSwKLmpvYi1yb3cuaWdub3JlZCAuam9iLWNvbXBhbnksCi5qb2Itcm93Lmlnbm9yZWQgLmpvYi1kZXRhaWxzIC5sb2NhdGlvbiB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0KCi5qb2ItcmFuayB7CiAgZm9udC1mYW1pbHk6ICdKZXRCcmFpbnMgTW9ubycsIG1vbm9zcGFjZTsKICBmb250LXNpemU6IDExcHg7CiAgY29sb3I6IHZhcigtLW11dGVkLWRpbSk7CiAgcGFkZGluZzogLjc1cmVtIDFyZW07CiAgdGV4dC1hbGlnbjogY2VudGVyOwogIGJvcmRlci1yaWdodDogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdWJ0bGUpOwp9Ci5qb2ItcmFuayAucmFuay1udW0gewogIGZvbnQtc2l6ZTogMTRweDsKICBmb250LXdlaWdodDogNjAwOwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7Cn0KCi5qb2ItaW5mbyB7CiAgcGFkZGluZzogLjc1cmVtIDFyZW07CiAgYm9yZGVyLXJpZ2h0OiAxcHggc29saWQgdmFyKC0tYm9yZGVyLXN1YnRsZSk7Cn0KCi5qb2ItdGl0bGUgewogIGZvbnQtc2l6ZTogMTNweDsKICBmb250LXdlaWdodDogNjAwOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBtYXJnaW4tYm90dG9tOiAzcHg7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogLjVyZW07Cn0KCi5qb2ItdGl0bGUgLnN0YXR1cy10YWcgewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiA5cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBwYWRkaW5nOiAxcHggNnB4OwogIGJvcmRlci1yYWRpdXM6IDJweDsKICBsZXR0ZXItc3BhY2luZzogLjA1ZW07CiAgZmxleC1zaHJpbms6IDA7Cn0KLnN0YXR1cy10YWcubmV3IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LWRpbSk7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5zdGF0dXMtdGFnLmFwcGxpZWQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbi1kaW0pOyBjb2xvcjogdmFyKC0tZ3JlZW4pOyB9Ci5zdGF0dXMtdGFnLnNhdmVkIHsgYmFja2dyb3VuZDogdmFyKC0tYW1iZXItZGltKTsgY29sb3I6IHZhcigtLWFtYmVyKTsgfQouc3RhdHVzLXRhZy5za2lwcGVkIHsgYmFja2dyb3VuZDogdmFyKC0tcmVkLWRpbSk7IGNvbG9yOiB2YXIoLS1yZWQpOyB9Ci5zdGF0dXMtdGFnLmlnbm9yZWQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ib3JkZXIpOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB9Cgouam9iLWNvbXBhbnkgewogIGZvbnQtc2l6ZTogMTJweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwogIG1hcmdpbi1ib3R0b206IDRweDsKfQoKLmpvYi10YWdzIHsKICBkaXNwbGF5OiBmbGV4OwogIGdhcDogLjM1cmVtOwogIGZsZXgtd3JhcDogd3JhcDsKfQouam9iLXRhZyB7CiAgZm9udC1mYW1pbHk6ICdKZXRCcmFpbnMgTW9ubycsIG1vbm9zcGFjZTsKICBmb250LXNpemU6IDEwcHg7CiAgcGFkZGluZzogMXB4IDZweDsKICBib3JkZXItcmFkaXVzOiAycHg7CiAgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwp9Ci5qb2ItdGFnLnJlbW90ZSB7IGJhY2tncm91bmQ6IHZhcigtLWdyZWVuLWRpbSk7IGNvbG9yOiB2YXIoLS1ncmVlbik7IH0KLmpvYi10YWcuc2FsYXJ5IHsgYmFja2dyb3VuZDogdmFyKC0tYW1iZXItZGltKTsgY29sb3I6IHZhcigtLWFtYmVyKTsgfQoKLmpvYi1kZXRhaWxzIHsKICBwYWRkaW5nOiAuNzVyZW0gMXJlbTsKICBib3JkZXItcmlnaHQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXItc3VidGxlKTsKfQouam9iLWRldGFpbHMgLmxvY2F0aW9uIHsKICBmb250LXNpemU6IDEycHg7CiAgY29sb3I6IHZhcigtLXRleHQpOwogIG1hcmdpbi1ib3R0b206IDJweDsKfQouam9iLWRldGFpbHMgLnNvdXJjZSB7CiAgZm9udC1mYW1pbHk6ICdKZXRCcmFpbnMgTW9ubycsIG1vbm9zcGFjZTsKICBmb250LXNpemU6IDEwcHg7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQoKLmpvYi1zY29yZSB7CiAgcGFkZGluZzogLjc1cmVtIDFyZW07CiAgYm9yZGVyLXJpZ2h0OiAxcHggc29saWQgdmFyKC0tYm9yZGVyLXN1YnRsZSk7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGFsaWduLWl0ZW1zOiBmbGV4LWVuZDsKICBnYXA6IDRweDsKfQouc2NvcmUtYmFyLXRyYWNrIHsKICB3aWR0aDogMTAwJTsKICBoZWlnaHQ6IDNweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6IDJweDsKICBvdmVyZmxvdzogaGlkZGVuOwp9Ci5zY29yZS1iYXItZmlsbCB7CiAgaGVpZ2h0OiAxMDAlOwogIGJvcmRlci1yYWRpdXM6IDJweDsKICB0cmFuc2l0aW9uOiB3aWR0aCAuM3MgZWFzZTsKfQouc2NvcmUtYmFyLWZpbGwuaGlnaCB7IGJhY2tncm91bmQ6IHZhcigtLWdyZWVuKTsgfQouc2NvcmUtYmFyLWZpbGwubWlkIHsgYmFja2dyb3VuZDogdmFyKC0tYW1iZXIpOyB9Ci5zY29yZS1iYXItZmlsbC5sb3cgeyBiYWNrZ3JvdW5kOiB2YXIoLS1yZWQpOyB9Ci5zY29yZS12YWwgewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiAxMXB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7Cn0KCi5qb2ItYWN0aW9ucyB7CiAgcGFkZGluZzogLjc1cmVtIDFyZW07CiAgZGlzcGxheTogZmxleDsKICBnYXA6IC4zNXJlbTsKICBhbGlnbi1pdGVtczogY2VudGVyOwp9Ci5hY3Rpb24tbGluayB7CiAgZm9udC1mYW1pbHk6ICdJbnRlcicsIHNhbnMtc2VyaWY7CiAgZm9udC1zaXplOiAxMXB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgcGFkZGluZzogLjNyZW0gLjZyZW07CiAgYm9yZGVyLXJhZGl1czogM3B4OwogIGN1cnNvcjogcG9pbnRlcjsKICBib3JkZXI6IG5vbmU7CiAgdGV4dC1kZWNvcmF0aW9uOiBub25lOwogIHRyYW5zaXRpb246IGFsbCAuMTVzOwogIGRpc3BsYXk6IGlubGluZS1mbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAuMjVyZW07Cn0KLmFjdGlvbi1saW5rLnZpZXcgewogIGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1kaW0pOwogIGNvbG9yOiB2YXIoLS1hY2NlbnQpOwp9Ci5hY3Rpb24tbGluay52aWV3OmhvdmVyIHsgYmFja2dyb3VuZDogcmdiYSgwLDIxMiwyNTUsMC4yKTsgfQouYWN0aW9uLWxpbmsuYXBwbHkgewogIGJhY2tncm91bmQ6IHZhcigtLWdyZWVuLWRpbSk7CiAgY29sb3I6IHZhcigtLWdyZWVuKTsKfQouYWN0aW9uLWxpbmsuYXBwbHk6aG92ZXIgeyBiYWNrZ3JvdW5kOiByZ2JhKDE2LDE4NSwxMjksMC4yKTsgfQouYWN0aW9uLWxpbmsuc2F2ZSB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZTIpOwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouYWN0aW9uLWxpbmsuc2F2ZTpob3ZlciB7IGNvbG9yOiB2YXIoLS10ZXh0KTsgYm9yZGVyLWNvbG9yOiB2YXIoLS1ib3JkZXItc3VidGxlKTsgfQouYWN0aW9uLWxpbmsuc2tpcCB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZTIpOwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKfQouYWN0aW9uLWxpbmsuc2tpcDpob3ZlciB7IGNvbG9yOiB2YXIoLS1yZWQpOyBib3JkZXItY29sb3I6IHZhcigtLXJlZC1kaW0pOyB9CgovKiDilIDilIAgVGFibGUgSGVhZGVyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwoubGlzdC1oZWFkZXIgewogIGRpc3BsYXk6IGdyaWQ7CiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgYXV0byAxNjBweCAyMDBweDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMDsKICBwYWRkaW5nOiAuNXJlbSAwOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwogIHBvc2l0aW9uOiBzdGlja3k7CiAgdG9wOiA0OHB4OwogIHotaW5kZXg6IDU7Cn0KLmxpc3QtaGVhZGVyIHNwYW4gewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiAxMHB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wNmVtOwogIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7CiAgY29sb3I6IHZhcigtLW11dGVkLWRpbSk7CiAgcGFkZGluZzogMCAxcmVtOwp9Ci5saXN0LWhlYWRlciBzcGFuOm50aC1jaGlsZCgyKSB7IHBhZGRpbmc6IDAgMXJlbTsgfQoubGlzdC1oZWFkZXIgc3BhbjpudGgtY2hpbGQoMykgeyB0ZXh0LWFsaWduOiByaWdodDsgcGFkZGluZy1yaWdodDogMXJlbTsgfQoubGlzdC1oZWFkZXIgc3BhbjpudGgtY2hpbGQoNCkgeyB0ZXh0LWFsaWduOiByaWdodDsgcGFkZGluZy1yaWdodDogMXJlbTsgfQoKLyog4pSA4pSAIEVtcHR5IFN0YXRlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwouZW1wdHktc3RhdGUgewogIHRleHQtYWxpZ246IGNlbnRlcjsKICBwYWRkaW5nOiA0cmVtIDJyZW07CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQouZW1wdHktc3RhdGUgLmljb24geyBmb250LXNpemU6IDJyZW07IG1hcmdpbi1ib3R0b206IC43NXJlbTsgfQouZW1wdHktc3RhdGUgcCB7IGZvbnQtc2l6ZTogMTNweDsgfQoKLyog4pSA4pSAIE1vZGFsIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwoubW9kYWwgewogIHBvc2l0aW9uOiBmaXhlZDsgaW5zZXQ6IDA7CiAgYmFja2dyb3VuZDogcmdiYSgwLDAsMCwuNik7CiAgei1pbmRleDogMTAwOwogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IGNlbnRlcjsKfQoubW9kYWwtY29udGVudCB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiA4cHg7CiAgd2lkdGg6IDkwJTsKICBtYXgtd2lkdGg6IDYwMHB4OwogIG1heC1oZWlnaHQ6IDkwdmg7CiAgb3ZlcmZsb3cteTogYXV0bzsKfQoubW9kYWwtaGVhZGVyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIHBhZGRpbmc6IDFyZW0gMS41cmVtOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5tb2RhbC1oZWFkZXIgaDIgewogIGZvbnQtc2l6ZTogMTNweDsKICBmb250LXdlaWdodDogNjAwOwogIGxldHRlci1zcGFjaW5nOiAuMDJlbTsKICBjb2xvcjogdmFyKC0tdGV4dCk7Cn0KLm1vZGFsLWhlYWRlciAuY2xvc2UgewogIGJhY2tncm91bmQ6IG5vbmU7CiAgYm9yZGVyOiBub25lOwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7CiAgZm9udC1zaXplOiAxOHB4OwogIGN1cnNvcjogcG9pbnRlcjsKfQoubW9kYWwtaGVhZGVyIC5jbG9zZTpob3ZlciB7IGNvbG9yOiB2YXIoLS10ZXh0KTsgfQoubW9kYWwtY29udGVudCBmb3JtIHsgcGFkZGluZzogMS41cmVtOyB9Ci5mb3JtLWdyaWQgewogIGRpc3BsYXk6IGdyaWQ7CiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgMWZyOwogIGdhcDogMXJlbTsKfQouZm9ybS1ncmlkIGxhYmVsIHsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47CiAgZ2FwOiAuMjVyZW07CiAgZm9udC1zaXplOiAxMXB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wMmVtOwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7Cn0KLmZvcm0tZ3JpZCBsYWJlbCBpbnB1dCwKLmZvcm0tZ3JpZCBsYWJlbCBzZWxlY3QsCi5mb3JtLWdyaWQgbGFiZWwgdGV4dGFyZWEgewogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBwYWRkaW5nOiAuNXJlbTsKICBib3JkZXItcmFkaXVzOiAzcHg7CiAgZm9udC1zaXplOiAxM3B4OwogIGZvbnQtZmFtaWx5OiAnSW50ZXInLCBzYW5zLXNlcmlmOwogIG91dGxpbmU6IG5vbmU7Cn0KLmZvcm0tZ3JpZCBsYWJlbCBpbnB1dDpmb2N1cywKLmZvcm0tZ3JpZCBsYWJlbCBzZWxlY3Q6Zm9jdXMsCi5mb3JtLWdyaWQgbGFiZWwgdGV4dGFyZWE6Zm9jdXMgewogIGJvcmRlci1jb2xvcjogdmFyKC0tYWNjZW50KTsKICBib3gtc2hhZG93OiAwIDAgMCAycHggdmFyKC0tYWNjZW50LWRpbSk7Cn0KLmZvcm0tZ3JpZCBsYWJlbCB0ZXh0YXJlYSB7IHJlc2l6ZTogdmVydGljYWw7IG1pbi1oZWlnaHQ6IDYwcHg7IH0KLm1vZGFsLWFjdGlvbnMgewogIGRpc3BsYXk6IGZsZXg7CiAgZ2FwOiAuNXJlbTsKICBqdXN0aWZ5LWNvbnRlbnQ6IGZsZXgtZW5kOwogIHBhZGRpbmc6IDFyZW0gMS41cmVtOwogIGJvcmRlci10b3A6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5hcHBseS1jaGVja2xpc3QgeyBsaXN0LXN0eWxlOiBub25lOyBwYWRkaW5nOiAwOyB9Ci5hcHBseS1jaGVja2xpc3QgbGkgewogIHBhZGRpbmc6IC41cmVtIDA7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogLjVyZW07CiAgZm9udC1zaXplOiAxM3B4Owp9Ci5hcHBseS1jaGVja2xpc3QgLnZhbCB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOyBmb250LXNpemU6IDEycHg7IH0KCi8qIOKUgOKUgCBUb2FzdCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KLnRvYXN0IHsKICBwb3NpdGlvbjogZml4ZWQ7CiAgYm90dG9tOiAxLjVyZW07CiAgcmlnaHQ6IDEuNXJlbTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgY29sb3I6ICMwMDA7CiAgcGFkZGluZzogLjYyNXJlbSAxLjEyNXJlbTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgZm9udC1zaXplOiAxMnB4OwogIGZvbnQtd2VpZ2h0OiA2MDA7CiAgZGlzcGxheTogbm9uZTsKICB6LWluZGV4OiAyMDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wMmVtOwp9CgovKiDilIDilIAgUmVzcG9uc2l2ZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KQG1lZGlhIChtYXgtd2lkdGg6IDkwMHB4KSB7CiAgLmpvYi1yb3cgewogICAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgYXV0bzsKICB9CiAgLmpvYi1kZXRhaWxzIHsgZGlzcGxheTogbm9uZTsgfQogIC5saXN0LWhlYWRlciBzcGFuOm50aC1jaGlsZCgzKSB7IGRpc3BsYXk6IG5vbmU7IH0KfQpAbWVkaWEgKG1heC13aWR0aDogNjAwcHgpIHsKICAuam9iLWFjdGlvbnMgeyBkaXNwbGF5OiBub25lOyB9CiAgLmxpc3QtaGVhZGVyIHNwYW46bnRoLWNoaWxkKDQpIHsgZGlzcGxheTogbm9uZTsgfQogIC5zdGF0LWNlbGwgeyBwYWRkaW5nOiAuNXJlbSAuNzVyZW07IH0KICAuc3RhdC1jZWxsIC5udW0geyBmb250LXNpemU6IDE2cHg7IH0KfQoKLyog4pSA4pSAIFNjcm9sbGJhciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KOjotd2Via2l0LXNjcm9sbGJhciB7IHdpZHRoOiA2cHg7IH0KOjotd2Via2l0LXNjcm9sbGJhci10cmFjayB7IGJhY2tncm91bmQ6IHZhcigtLWJnKTsgfQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1iIHsgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsgYm9yZGVyLXJhZGl1czogM3B4OyB9Cjo6LXdlYmtpdC1zY3JvbGxiYXItdGh1bWI6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1tdXRlZC1kaW0pOyB9Cg==';
const APP_JS_B64 = 'LyoqCiAqIGFwcC5qcyDigJQgRGFzaGJvYXJkIGNsaWVudC1zaWRlIGxvZ2ljCiAqLwpjb25zdCBBUEkgPSAnL2FwaSc7CmxldCBhbGxKb2JzID0gW107CmxldCBjdXJyZW50Sm9iSWQgPSBudWxsOwoKLy8g4pSA4pSAIEluaXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ0RPTUNvbnRlbnRMb2FkZWQnLCBhc3luYyAoKSA9PiB7CiAgYXdhaXQgbG9hZFByb2ZpbGUoKTsKICBhd2FpdCBsb2FkU3RhdHMoKTsKICBhd2FpdCBsb2FkU291cmNlcygpOwogIGF3YWl0IGxvYWRKb2JzKCk7CiAgYmluZEV2ZW50cygpOwogIHN0YXJ0VXRjQ2xvY2soKTsKfSk7CgovLyDilIDilIAgVVRDIENsb2NrIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApmdW5jdGlvbiBzdGFydFV0Y0Nsb2NrKCkgewogIGZ1bmN0aW9uIHRpY2soKSB7CiAgICBjb25zdCBkID0gbmV3IERhdGUoKTsKICAgIGNvbnN0IGggPSBTdHJpbmcoZC5nZXRVVENIb3VycygpKS5wYWRTdGFydCgyLCAnMCcpOwogICAgY29uc3QgbSA9IFN0cmluZyhkLmdldFVUQ01pbnV0ZXMoKSkucGFkU3RhcnQoMiwgJzAnKTsKICAgIGNvbnN0IHMgPSBTdHJpbmcoZC5nZXRVVENTZWNvbmRzKCkpLnBhZFN0YXJ0KDIsICcwJyk7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd1dGNUaW1lJyk7CiAgICBpZiAoZWwpIGVsLnRleHRDb250ZW50ID0gaCArICc6JyArIG0gKyAnOicgKyBzICsgJyBVVEMnOwogIH0KICB0aWNrKCk7CiAgc2V0SW50ZXJ2YWwodGljaywgMTAwMCk7Cn0KCi8vIOKUgOKUgCBQcm9maWxlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAphc3luYyBmdW5jdGlvbiBsb2FkUHJvZmlsZSgpIHsKICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCk7CiAgY29uc3QgcCA9IGF3YWl0IHIuanNvbigpOwogIHdpbmRvdy5fcHJvZmlsZSA9IHA7Cn0KCmFzeW5jIGZ1bmN0aW9uIGxvYWRTb3VyY2VzKCkgewogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgJHtBUEl9L2pvYnM/bGltaXQ9NTAwMGApOwogIGNvbnN0IGpvYnMgPSBhd2FpdCByLmpzb24oKTsKICBjb25zdCBzb3VyY2VzID0gWy4uLm5ldyBTZXQoam9icy5tYXAoaiA9PiBqLnNvdXJjZSkpXS5zb3J0KCk7CiAgY29uc3Qgc2VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NvdXJjZUZpbHRlcicpOwogIHNvdXJjZXMuZm9yRWFjaChzID0+IHsKICAgIGNvbnN0IG9wdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpOwogICAgb3B0LnZhbHVlID0gczsgb3B0LnRleHRDb250ZW50ID0gczsKICAgIHNlbC5hcHBlbmRDaGlsZChvcHQpOwogIH0pOwoKICBjb25zdCBjb21wYW5pZXMgPSBbLi4ubmV3IFNldChqb2JzLm1hcChqID0+IGouY29tcGFueSkpXS5zb3J0KCk7CiAgY29uc3QgY29tcGFueVNlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJyk7CiAgY29tcGFuaWVzLmZvckVhY2goYyA9PiB7CiAgICBjb25zdCBvcHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTsKICAgIG9wdC52YWx1ZSA9IGM7IG9wdC50ZXh0Q29udGVudCA9IGM7CiAgICBjb21wYW55U2VsLmFwcGVuZENoaWxkKG9wdCk7CiAgfSk7Cn0KCi8vIOKUgOKUgCBTdGF0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKYXN5bmMgZnVuY3Rpb24gbG9hZFN0YXRzKCkgewogIGNvbnN0IHMgPSBhd2FpdCAoYXdhaXQgZmV0Y2goYCR7QVBJfS9zdGF0c2ApKS5qc29uKCk7CiAgY29uc3QgY2VsbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc3RhdC1zdHJpcCAuc3RhdC1jZWxsJyk7CiAgaWYgKGNlbGxzWzBdKSBjZWxsc1swXS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLnRvdGFsX2pvYnM7CiAgaWYgKGNlbGxzWzFdKSBjZWxsc1sxXS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLm5ld19qb2JzOwogIGlmIChjZWxsc1syXSkgY2VsbHNbMl0ucXVlcnlTZWxlY3RvcignLm51bScpLnRleHRDb250ZW50ID0gcy5zYXZlZF9qb2JzOwogIGlmIChjZWxsc1szXSkgY2VsbHNbM10ucXVlcnlTZWxlY3RvcignLm51bScpLnRleHRDb250ZW50ID0gcy5hcHBsaWVkX2pvYnM7CiAgaWYgKGNlbGxzWzRdKSBjZWxsc1s0XS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLnNraXBwZWRfam9iczsKICBpZiAoY2VsbHNbNV0pIGNlbGxzWzVdLnF1ZXJ5U2VsZWN0b3IoJy5udW0nKS50ZXh0Q29udGVudCA9IHMuaWdub3JlZF9qb2JzIHx8IDA7CiAgY29uc3QgdG0gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndG9wYmFyTWF0Y2hlZCcpOwogIGNvbnN0IHR0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RvcGJhclRvdGFsJyk7CiAgaWYgKHRtKSB0bS50ZXh0Q29udGVudCA9IChzLm1hdGNoZWRfam9icyB8fCBzLm5ld19qb2JzKSArICcgbWF0Y2hlZCc7CiAgaWYgKHR0KSB0dC50ZXh0Q29udGVudCA9IHMudG90YWxfam9icyArICcgdG90YWwnOwp9CgovLyDilIDilIAgSm9icyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKYXN5bmMgZnVuY3Rpb24gbG9hZEpvYnMoKSB7CiAgY29uc3Qgc3RhdHVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1c0ZpbHRlcicpLnZhbHVlOwogIGNvbnN0IGNvbXBhbnkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY29tcGFueUZpbHRlcicpLnZhbHVlOwogIGNvbnN0IHJlZ2lvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZTsKICBjb25zdCBqb2JUeXBlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlR5cGVGaWx0ZXInKS52YWx1ZTsKICBjb25zdCBzb3VyY2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc291cmNlRmlsdGVyJykudmFsdWU7CiAgY29uc3Qgc29ydCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3J0RmlsdGVyJykudmFsdWU7CiAgY29uc3Qgc2VhcmNoID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NlYXJjaElucHV0JykudmFsdWUudG9Mb3dlckNhc2UoKTsKCiAgbGV0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoeyBzdGF0dXMsIHNvcnQsIGxpbWl0OiA1MDAgfSk7CiAgaWYgKGNvbXBhbnkpIHBhcmFtcy5zZXQoJ2NvbXBhbnknLCBjb21wYW55KTsKICBpZiAocmVnaW9uKSBwYXJhbXMuc2V0KCdyZWdpb24nLCByZWdpb24pOwogIGlmIChqb2JUeXBlKSBwYXJhbXMuc2V0KCdqb2JUeXBlJywgam9iVHlwZSk7CiAgaWYgKHNvdXJjZSkgcGFyYW1zLnNldCgnc291cmNlJywgc291cmNlKTsKICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9qb2JzPyR7cGFyYW1zfWApOwogIGFsbEpvYnMgPSBhd2FpdCByLmpzb24oKTsKCiAgaWYgKHNlYXJjaCkgewogICAgYWxsSm9icyA9IGFsbEpvYnMuZmlsdGVyKGogPT4KICAgICAgKGoudGl0bGUgfHwgJycpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKSB8fAogICAgICAoai5jb21wYW55IHx8ICcnKS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHNlYXJjaCkgfHwKICAgICAgKGouZGVzY3JpcHRpb24gfHwgJycpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKQogICAgKTsKICB9CgogIHJlbmRlckpvYnMoYWxsSm9icyk7CiAgYXdhaXQgbG9hZFN0YXRzKCk7CiAgdXBkYXRlQ2xlYXJCdXR0b24oKTsKfQoKZnVuY3Rpb24gdXBkYXRlQ2xlYXJCdXR0b24oKSB7CiAgY29uc3QgaGFzRmlsdGVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKS52YWx1ZSB8fAogICAgICAgICAgICAgICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZSB8fAogICAgICAgICAgICAgICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykudmFsdWUgfHwKICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2VhcmNoSW5wdXQnKS52YWx1ZTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xlYXJGaWx0ZXJzJykuc3R5bGUuZGlzcGxheSA9IGhhc0ZpbHRlciA/ICcnIDogJ25vbmUnOwp9CgpmdW5jdGlvbiByZW5kZXJKb2JzKGpvYnMpIHsKICBjb25zdCBxID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlF1ZXVlJyk7CiAgaWYgKGpvYnMubGVuZ3RoID09PSAwKSB7CiAgICBxLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJlbXB0eS1zdGF0ZSI+PGRpdiBjbGFzcz0iaWNvbiI+4o6TPC9kaXY+PHA+Tm8gam9icyBmb3VuZC4gQ2xpY2sgIlNjcmFwZSBOb3ciIHRvIGZldGNoIGZyZXNoIGxpc3RpbmdzLjwvcD48L2Rpdj4nOwogICAgcmV0dXJuOwogIH0KICBxLmlubmVySFRNTCA9IGpvYnMubWFwKChqLCBpKSA9PiBqb2JSb3coaiwgaSkpLmpvaW4oJycpOwp9CgpmdW5jdGlvbiBqb2JSb3coam9iLCBpbmRleCkgewogIGNvbnN0IHNhbGFyeUJhZGdlID0gam9iLnNhbGFyeSA/IGA8c3BhbiBjbGFzcz0iam9iLXRhZyBzYWxhcnkiPiR7ZXNjYXBlSHRtbChqb2Iuc2FsYXJ5KX08L3NwYW4+YCA6ICcnOwogIGNvbnN0IHJlbW90ZUJhZGdlID0gam9iLnJlbW90ZSB8fCBqb2Iuc291cmNlID09PSAnUmVtb3RlT0snIHx8IGpvYi5zb3VyY2UgPT09ICdSZW1vdGl2ZScgfHwgam9iLnNvdXJjZSA9PT0gJ1dlV29ya1JlbW90ZWx5JwogICAgPyBgPHNwYW4gY2xhc3M9ImpvYi10YWcgcmVtb3RlIj5SZW1vdGU8L3NwYW4+YCA6ICcnOwogIGNvbnN0IHN0YXR1cyA9IGpvYi5zdGF0dXMgfHwgJ25ldyc7CiAgY29uc3Qgc3RhdHVzQ2xhc3MgPSBgc3RhdHVzLSR7c3RhdHVzfWA7IC8vIHN0YXR1c0NsYXNzIGZvciBzdGF0dXMtYmFkZ2UgY2xhc3MKICBjb25zdCByb3dDbGFzcyA9IHN0YXR1cyA9PT0gJ2FwcGxpZWQnID8gJ2FwcGxpZWQnIDogc3RhdHVzID09PSAnc2F2ZWQnID8gJ3NhdmVkJwogICAgOiBzdGF0dXMgPT09ICdza2lwcGVkJyA/ICdza2lwcGVkJyA6IHN0YXR1cyA9PT0gJ2lnbm9yZWQnID8gJ2lnbm9yZWQnIDogJyc7CiAgY29uc3QgcGN0ID0gTWF0aC5taW4oMTAwLCBNYXRoLnJvdW5kKChqb2Iuc2NvcmUgfHwgMCkgLyAxMjAgKiAxMDApKTsKICBjb25zdCBzY29yZUNsYXNzID0gcGN0ID49IDcwID8gJ2hpZ2gnIDogcGN0ID49IDQwID8gJ21pZCcgOiAnbG93JzsKICBjb25zdCBsb2NhdGlvbiA9IGpvYi5sb2NhdGlvbiB8fCBqb2IucmVnaW9uIHx8ICfigJQnOwogIGNvbnN0IHNvdXJjZUxhYmVsID0gam9iLnNvdXJjZSB8fCAnJzsKCiAgbGV0IGFjdGlvbnNIdG1sID0gJyc7CiAgaWYgKHN0YXR1cyA9PT0gJ25ldycpIHsKICAgIGFjdGlvbnNIdG1sID0gYAogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYWN0aW9uLWxpbmsgdmlldyIgYXJpYS1sYWJlbD0iVmlldyBqb2IgZGV0YWlscyI+VmlldzwvYT4KICAgICAgICA8YSBocmVmPSJqYXZhc2NyaXB0OnZvaWQoMCkiIG9uY2xpY2s9Im9wZW5BcHBseSgnJHtqb2IuaWR9JykiIGNsYXNzPSJhY3Rpb24tbGluayBhcHBseSIgYXJpYS1sYWJlbD0iQXBwbHkgdG8gdGhpcyBqb2IiPkFwcGx5PC9hPgogICAgICAgIDxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9Jywnc2F2ZWQnKSIgY2xhc3M9ImFjdGlvbi1saW5rIHNhdmUiIGFyaWEtbGFiZWw9IlNhdmUgdGhpcyBqb2IiPlNhdmU8L2E+CiAgICAgIGA7CiAgfSBlbHNlIGlmIChzdGF0dXMgPT09ICdhcHBsaWVkJykgewogICAgYWN0aW9uc0h0bWwgPSBgCiAgICAgICAgPGEgaHJlZj0iJHtlc2NhcGVIdG1sKGpvYi51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJhY3Rpb24tbGluayB2aWV3IiBhcmlhLWxhYmVsPSJWaWV3IGpvYiBkZXRhaWxzIj5WaWV3PC9hPgogICAgICAgIDxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0ib3BlbkFwcGx5KCcke2pvYi5pZH0nKSIgY2xhc3M9ImFjdGlvbi1saW5rIGFwcGx5IiBhcmlhLWxhYmVsPSJSZS1hcHBseSB0byB0aGlzIGpvYiI+QXBwbHk8L2E+CiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdza2lwcGVkJykiIGNsYXNzPSJhY3Rpb24tbGluayBza2lwIiBhcmlhLWxhYmVsPSJSZXZva2UgYXBwbGljYXRpb24gYW5kIHNraXAiPlJldm9rZTwvYT4KICAgICAgYDsKICB9IGVsc2UgaWYgKHN0YXR1cyA9PT0gJ3NhdmVkJykgewogICAgYWN0aW9uc0h0bWwgPSBgCiAgICAgICAgPGEgaHJlZj0iJHtlc2NhcGVIdG1sKGpvYi51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJhY3Rpb24tbGluayB2aWV3IiBhcmlhLWxhYmVsPSJWaWV3IGpvYiBkZXRhaWxzIj5WaWV3PC9hPgogICAgICAgIDxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0ib3BlbkFwcGx5KCcke2pvYi5pZH0nKSIgY2xhc3M9ImFjdGlvbi1saW5rIGFwcGx5IiBhcmlhLWxhYmVsPSJBcHBseSB0byB0aGlzIGpvYiI+QXBwbHk8L2E+CiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdza2lwcGVkJykiIGNsYXNzPSJhY3Rpb24tbGluayBza2lwIiBhcmlhLWxhYmVsPSJNb3ZlIHRvIHNraXBwZWQiPlNraXA8L2E+CiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdpZ25vcmVkJykiIGNsYXNzPSJhY3Rpb24tbGluayBza2lwIiBhcmlhLWxhYmVsPSJNb3ZlIHRvIGlnbm9yZWQiPklnbm9yZTwvYT4KICAgICAgYDsKICB9IGVsc2UgaWYgKHN0YXR1cyA9PT0gJ3NraXBwZWQnKSB7CiAgICBhY3Rpb25zSHRtbCA9IGAKICAgICAgICA8YSBocmVmPSIke2VzY2FwZUh0bWwoam9iLnVybCl9IiB0YXJnZXQ9Il9ibGFuayIgY2xhc3M9ImFjdGlvbi1saW5rIHZpZXciIGFyaWEtbGFiZWw9IlZpZXcgam9iIGRldGFpbHMiPlZpZXc8L2E+CiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCduZXcnKSIgY2xhc3M9ImFjdGlvbi1saW5rIHNhdmUiIGFyaWEtbGFiZWw9IlJlb3BlbiB0aGlzIGpvYiI+UmVvcGVuPC9hPgogICAgICBgOwogIH0gZWxzZSBpZiAoc3RhdHVzID09PSAnaWdub3JlZCcpIHsKICAgIGFjdGlvbnNIdG1sID0gYAogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYWN0aW9uLWxpbmsgdmlldyIgYXJpYS1sYWJlbD0iVmlldyBqb2IgZGV0YWlscyI+VmlldzwvYT4KICAgICAgICA8YSBocmVmPSJqYXZhc2NyaXB0OnZvaWQoMCkiIG9uY2xpY2s9Im1hcmtBY3Rpb24oJyR7am9iLmlkfScsJ25ldycpIiBjbGFzcz0iYWN0aW9uLWxpbmsgc2F2ZSIgYXJpYS1sYWJlbD0iUmVvcGVuIHRoaXMgam9iIj5SZW9wZW48L2E+CiAgICAgIGA7CiAgfQoKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9ImpvYi1yb3cgJHtyb3dDbGFzc30iIGlkPSJqb2ItJHtqb2IuaWR9Ij4KICAgIDxkaXYgY2xhc3M9ImpvYi1pbmZvIj4KICAgICAgPGRpdiBjbGFzcz0iam9iLXRpdGxlIj4KICAgICAgICAke2VzY2FwZUh0bWwoam9iLnRpdGxlKX0KICAgICAgICA8c3BhbiBjbGFzcz0ic3RhdHVzLXRhZyAke3N0YXR1c0NsYXNzfSI+JHtzdGF0dXN9PC9zcGFuPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iam9iLWNvbXBhbnkiPiR7ZXNjYXBlSHRtbChqb2IuY29tcGFueSB8fCAnJyl9ICZtaWRkb3Q7ICR7ZXNjYXBlSHRtbChzb3VyY2VMYWJlbCl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImpvYi10YWdzIj4ke3JlbW90ZUJhZGdlfSR7c2FsYXJ5QmFkZ2V9PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImpvYi1kZXRhaWxzIj4KICAgICAgPGRpdiBjbGFzcz0ibG9jYXRpb24iPiR7ZXNjYXBlSHRtbChsb2NhdGlvbil9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InNvdXJjZSI+JHtlc2NhcGVIdG1sKHNvdXJjZUxhYmVsKX08L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iam9iLXNjb3JlIj4KICAgICAgPGRpdiBjbGFzcz0ic2NvcmUtYmFyLXRyYWNrIj48ZGl2IGNsYXNzPSJzY29yZS1iYXItZmlsbCAke3Njb3JlQ2xhc3N9IiBzdHlsZT0id2lkdGg6JHtwY3R9JSI+PC9kaXY+PC9kaXY+CiAgICAgIDxzcGFuIGNsYXNzPSJzY29yZS12YWwiPiR7am9iLnNjb3JlfSBwdHM8L3NwYW4+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImpvYi1hY3Rpb25zIj4ke2FjdGlvbnNIdG1sfTwvZGl2PgogIDwvZGl2PmA7Cn0KCi8vIOKUgOKUgCBBY3Rpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAphc3luYyBmdW5jdGlvbiBtYXJrQWN0aW9uKGpvYklkLCBhY3Rpb24pIHsKICBjb25zdCBlbmRwb2ludE1hcCA9IHsgYXBwbGllZDogJ2FwcGx5Jywgc2tpcHBlZDogJ3NraXAnLCBzYXZlZDogJ3NhdmUnLCBpZ25vcmVkOiAnaWdub3JlJywgbmV3OiAnbmV3JyB9OwogIGNvbnN0IGVuZHBvaW50ID0gZW5kcG9pbnRNYXBbYWN0aW9uXSB8fCBhY3Rpb247CiAgbGV0IHBheWxvYWQgPSB7IGpvYklkIH07CiAgaWYgKGFjdGlvbiA9PT0gJ3NraXBwZWQnIHx8IGFjdGlvbiA9PT0gJ2lnbm9yZWQnKSB7CiAgICBjb25zdCBqb2IgPSBhbGxKb2JzLmZpbmQoaiA9PiBqLmlkID09PSBqb2JJZCk7CiAgICBpZiAoam9iICYmIGpvYi50aXRsZSkgcGF5bG9hZC50aXRsZSA9IGpvYi50aXRsZTsKICB9CiAgdHJ5IHsKICAgIGNvbnN0IHJlc3AgPSBhd2FpdCBmZXRjaChgJHtBUEl9LyR7ZW5kcG9pbnR9YCwgewogICAgICBtZXRob2Q6ICdQT1NUJywKICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sCiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHBheWxvYWQpCiAgICB9KTsKICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXNwLnRleHQoKTsKICAgIGlmICghcmVzcC5vaykgdGhyb3cgbmV3IEVycm9yKCdIVFRQICcgKyByZXNwLnN0YXR1cyArICc6ICcgKyB0ZXh0KTsKICAgIEpTT04ucGFyc2UodGV4dCk7CiAgICB0b2FzdChgJHthY3Rpb24uY2hhckF0KDApLnRvVXBwZXJDYXNlKCkgKyBhY3Rpb24uc2xpY2UoMSl9ZCBqb2JgKTsKICAgIGF3YWl0IGxvYWRKb2JzKCk7CiAgfSBjYXRjaCAoZXJyKSB7CiAgICB0b2FzdCgnRXJyb3I6ICcgKyBlcnIubWVzc2FnZSk7CiAgfQp9CgovLyDilIDilIAgQXBwbHkgTW9kYWwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmZ1bmN0aW9uIG9wZW5BcHBseShqb2JJZCkgewogIGN1cnJlbnRKb2JJZCA9IGpvYklkOwogIGNvbnN0IGpvYiA9IGFsbEpvYnMuZmluZChqID0+IGouaWQgPT09IGpvYklkKTsKICBpZiAoIWpvYikgcmV0dXJuOwogIGNvbnN0IHAgPSB3aW5kb3cuX3Byb2ZpbGUgfHwge307CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5Q29udGVudCcpLmlubmVySFRNTCA9IGAKICAgIDxkaXYgc3R5bGU9InBhZGRpbmc6MS41cmVtIj4KICAgICAgPGgzIHN0eWxlPSJmb250LXNpemU6MTRweDtmb250LXdlaWdodDo2MDA7bWFyZ2luLWJvdHRvbTouMjVyZW0iPiR7ZXNjYXBlSHRtbChqb2IudGl0bGUpfSBAICR7ZXNjYXBlSHRtbChqb2IuY29tcGFueSl9PC9oMz4KICAgICAgPHAgc3R5bGU9ImNvbG9yOnZhcigtLW11dGVkKTttYXJnaW46LjVyZW0gMDtmb250LXNpemU6MTNweCI+JHtlc2NhcGVIdG1sKGpvYi5kZXNjcmlwdGlvbj8uc2xpY2UoMCwgMjAwKSkgfHwgJ05vIGRlc2NyaXB0aW9uIGF2YWlsYWJsZS4nfTwvcD4KICAgICAgPHAgc3R5bGU9Im1hcmdpbjouNXJlbSAwO2ZvbnQtc2l6ZToxM3B4Ij48YSBocmVmPSIke2VzY2FwZUh0bWwoam9iLnVybCl9IiB0YXJnZXQ9Il9ibGFuayIgc3R5bGU9ImNvbG9yOnZhcigtLWFjY2VudCkiPlZpZXcgZnVsbCBqb2IgbGlzdGluZyDihpI8L2E+PC9wPgogICAgICA8aDQgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0OjUwMDtsZXR0ZXItc3BhY2luZzouMDZlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Y29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbjoxcmVtIDAgLjVyZW0iPkFwcGxpY2F0aW9uIENoZWNrbGlzdDo8L2g0PgogICAgICA8dWwgY2xhc3M9ImFwcGx5LWNoZWNrbGlzdCI+CiAgICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gTmFtZTogPHNwYW4gY2xhc3M9InZhbCI+JHtlc2NhcGVIdG1sKHAubmFtZSB8fCAn4oCUJyl9PC9zcGFuPjwvbGk+CiAgICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gRW1haWw6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLmVtYWlsIHx8ICfigJQnKX08L3NwYW4+PC9saT4KICAgICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBQaG9uZTogPHNwYW4gY2xhc3M9InZhbCI+JHtlc2NhcGVIdG1sKHAucGhvbmUgfHwgJ+KAlCcpfTwvc3Bhbj48L2xpPgogICAgICAgIDxsaT48aW5wdXQgdHlwZT0iY2hlY2tib3giIGNoZWNrZWQgZGlzYWJsZWQ+IFJlc3VtZTogPHNwYW4gY2xhc3M9InZhbCI+JHtlc2NhcGVIdG1sKHAucmVzdW1lX3BhdGggfHwgJ25vdCBzZXQnKX08L3NwYW4+PC9saT4KICAgICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBDb3ZlciBsZXR0ZXI6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7am9iLmNvdmVyX2xldHRlciA/ICfinJMgR2VuZXJhdGVkJyA6ICdSdW4gd2l0aCBBTlRIUk9QSUNfQVBJX0tFWSd9PC9zcGFuPjwvbGk+CiAgICAgIDwvdWw+CiAgICA8L2Rpdj4KICBgOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHBseVVybEJ0bicpLmhyZWYgPSBqb2IudXJsOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdtYXJrQXBwbGllZEJ0bicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBhd2FpdCBtYXJrQWN0aW9uKGpvYklkLCAnYXBwbGllZCcpOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5TW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogICAgdG9hc3QoJ01hcmtlZCBhcyBhcHBsaWVkIScpOwogIH07CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5TW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnOwp9CgovLyDilIDilIAgUHJvZmlsZSBNb2RhbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVCdG4nKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogIGNvbnN0IHAgPSBhd2FpdCAoYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCkpLmpzb24oKTsKICB3aW5kb3cuX3Byb2ZpbGUgPSBwOwogIE9iamVjdC5rZXlzKHApLmZvckVhY2goayA9PiB7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwXycgKyBrKTsKICAgIGlmIChlbCkgZWwudmFsdWUgPSBBcnJheS5pc0FycmF5KHBba10pID8gcFtrXS5qb2luKCcsICcpIDogKHBba10gfHwgJycpOwogIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnOwp9OwoKZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVGb3JtJykub25zdWJtaXQgPSBhc3luYyAoZSkgPT4gewogIGUucHJldmVudERlZmF1bHQoKTsKICBjb25zdCBmZCA9IG5ldyBGb3JtRGF0YShlLnRhcmdldCk7CiAgY29uc3QgcCA9IHt9OwogIGZkLmZvckVhY2goKHYsIGspID0+IHsgcFtrXSA9IHY7IH0pOwogIGZvciAoY29uc3Qga2V5IG9mIFsnc2tpbGxzJywgJ3RhcmdldF90aXRsZXMnLCAncmVxdWlyZWRfa2V5d29yZHMnLCAnYm9udXNfa2V5d29yZHMnLCAnZGVhbF9icmVha2VycycsICdwcmVmZXJyZWRfd29ya190eXBlJywgJ3ByZWZlcnJlZF9sb2NhdGlvbnMnLCAncHJlZmVycmVkX2VtcGxveW1lbnQnXSkgewogICAgcFtrZXldID0gKHBba2V5XSB8fCAnJykuc3BsaXQoJywnKS5tYXAocyA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pOwogIH0KICBwLmV4cGVyaWVuY2VfeWVhcnMgPSBwYXJzZUludChwLmV4cGVyaWVuY2VfeWVhcnMpIHx8IDA7CiAgcC5zYWxhcnlfbWluX2xha2hzID0gcGFyc2VGbG9hdChwLnNhbGFyeV9taW5fbGFraHMpIHx8IDM1OwogIHAudGFyZ2V0X3NhbGFyeSA9IHsgY3VycmVuY3k6IHAuc2FsYXJ5X2N1cnJlbmN5IHx8ICdJTlInLCBtaW5fbGFraHM6IHAuc2FsYXJ5X21pbl9sYWtocyB9OwogIGF3YWl0IGZldGNoKGAke0FQSX0vcHJvZmlsZWAsIHsgbWV0aG9kOiAnUFVUJywgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sIGJvZHk6IEpTT04uc3RyaW5naWZ5KHApIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogIHRvYXN0KCdQcm9maWxlIHNhdmVkIScpOwogIGxvYWRQcm9maWxlKCk7Cn07CgovLyDilIDilIAgRXZlbnRzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApmdW5jdGlvbiBiaW5kRXZlbnRzKCkgewogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS5vbmNsaWNrID0gYXN5bmMgKCkgPT4gewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjcmFwZUJ0bicpLmRpc2FibGVkID0gdHJ1ZTsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS50ZXh0Q29udGVudCA9ICdTY3JhcGluZy4uLic7CiAgICBhd2FpdCBmZXRjaChgJHtBUEl9L3NjcmFwZWAsIHsgbWV0aG9kOiAnUE9TVCcgfSk7CiAgICBzZXRUaW1lb3V0KCgpID0+IHsKICAgICAgbG9hZEpvYnMoKTsKICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjcmFwZUJ0bicpLmRpc2FibGVkID0gZmFsc2U7CiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS50ZXh0Q29udGVudCA9ICdTY3JhcGUgTm93JzsKICAgIH0sIDIwMDApOwogIH07CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NsZWFyRmlsdGVycycpLm9uY2xpY2sgPSAoKSA9PiB7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY29tcGFueUZpbHRlcicpLnZhbHVlID0gJyc7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVnaW9uRmlsdGVyJykudmFsdWUgPSAnJzsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykudmFsdWUgPSAnJzsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZWFyY2hJbnB1dCcpLnZhbHVlID0gJyc7CiAgICBsb2FkSm9icygpOwogIH07CgogIGZ1bmN0aW9uIG9uRmlsdGVyQ2hhbmdlKCkgeyBsb2FkSm9icygpOyB1cGRhdGVDbGVhckJ1dHRvbigpOyB9CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1c0ZpbHRlcicpLm9uY2hhbmdlID0gbG9hZEpvYnM7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKS5vbmNoYW5nZSA9IG9uRmlsdGVyQ2hhbmdlOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS5vbmNoYW5nZSA9IG9uRmlsdGVyQ2hhbmdlOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykub25jaGFuZ2UgPSBvbkZpbHRlckNoYW5nZTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc291cmNlRmlsdGVyJykub25jaGFuZ2UgPSBsb2FkSm9iczsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc29ydEZpbHRlcicpLm9uY2hhbmdlID0gbG9hZEpvYnM7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NlYXJjaElucHV0Jykub25pbnB1dCA9ICgpID0+IHsKICAgIGNsZWFyVGltZW91dCh3aW5kb3cuX3NlYXJjaFRpbWVyKTsKICAgIHdpbmRvdy5fc2VhcmNoVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsgbG9hZEpvYnMoKTsgdXBkYXRlQ2xlYXJCdXR0b24oKTsgfSwgMzAwKTsKICB9OwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbG9zZVByb2ZpbGVCdG4nKS5vbmNsaWNrID0gKCkgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NhbmNlbFByb2ZpbGVCdG4nKS5vbmNsaWNrID0gKCkgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2Nsb3NlQXBwbHlCdG4nKS5vbmNsaWNrID0gKCkgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5TW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwp9CgovLyDilIDilIAgVXRpbHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmZ1bmN0aW9uIHRvYXN0KG1zZykgewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RvYXN0Jyk7CiAgZWwudGV4dENvbnRlbnQgPSBtc2c7IGVsLnN0eWxlLmRpc3BsYXkgPSAnYmxvY2snOwogIHNldFRpbWVvdXQoKCkgPT4gZWwuc3R5bGUuZGlzcGxheSA9ICdub25lJywgMjUwMCk7Cn0KCmZ1bmN0aW9uIGVzY2FwZUh0bWwocykgewogIGlmICghcykgcmV0dXJuICcnOwogIHJldHVybiBTdHJpbmcocykucmVwbGFjZSgvJi9nLCcmYW1wOycpLnJlcGxhY2UoLzwvZywnJmx0OycpLnJlcGxhY2UoLz4vZywnJmd0OycpLnJlcGxhY2UoLyIvZywnJnF1b3Q7Jyk7Cn0KCndpbmRvdy5tYXJrQWN0aW9uID0gbWFya0FjdGlvbjsKd2luZG93Lm9wZW5BcHBseSA9IG9wZW5BcHBseTsK';

const DASHBOARD_HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0iVVRGLTgiLz4KICA8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEuMCIvPgogIDx0aXRsZT5Kb2IgQWdlbnQ8L3RpdGxlPgogIDxsaW5rIHJlbD0ic3R5bGVzaGVldCIgaHJlZj0iL3N0eWxlcy5jc3M/dD1fX1NUWUxFU19WRVJTSU9OX18iLz4KPC9oZWFkPgo8Ym9keT4KICA8IS0tIFRvcCBCYXIgLS0+CiAgPGhlYWRlciBjbGFzcz0idG9wYmFyIj4KICAgIDxkaXYgY2xhc3M9InRvcGJhci1icmFuZCI+CiAgICAgIDxoMT5Kb2IgQWdlbnQ8L2gxPgogICAgICA8ZGl2IGNsYXNzPSJ0b3BiYXItbWV0YSI+CiAgICAgICAgPHNwYW4gY2xhc3M9ImxpdmUtZG90Ij48L3NwYW4+CiAgICAgICAgPHNwYW4gaWQ9InRvcGJhck1hdGNoZWQiPuKAlCBtYXRjaGVkPC9zcGFuPgogICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICA8c3BhbiBpZD0idG9wYmFyVG90YWwiPuKAlCB0b3RhbDwvc3Bhbj4KICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgPHNwYW4gaWQ9InV0Y1RpbWUiPi0tOi0tIFVUQzwvc3Bhbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InRvcGJhci1hY3Rpb25zIj4KICAgICAgPGJ1dHRvbiBpZD0ic2NyYXBlQnRuIiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5Ij5TY3JhcGUgTm93PC9idXR0b24+CiAgICAgIDxidXR0b24gaWQ9InByb2ZpbGVCdG4iIGNsYXNzPSJidG4gYnRuLWdob3N0Ij5Qcm9maWxlPC9idXR0b24+CiAgICA8L2Rpdj4KICA8L2hlYWRlcj4KCiAgPCEtLSBTdGF0IFN0cmlwIC0tPgogIDxkaXYgY2xhc3M9InN0YXQtc3RyaXAiPgogICAgPGRpdiBjbGFzcz0ic3RhdC1jZWxsIj48c3BhbiBjbGFzcz0ibnVtIj7igJQ8L3NwYW4+PHNwYW4gY2xhc3M9ImxhYmVsIj50b3RhbCBqb2JzPC9zcGFuPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdC1jZWxsIj48c3BhbiBjbGFzcz0ibnVtIGFjY2VudCI+4oCUPC9zcGFuPjxzcGFuIGNsYXNzPSJsYWJlbCI+bmV3PC9zcGFuPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdC1jZWxsIj48c3BhbiBjbGFzcz0ibnVtIGFtYmVyIj7igJQ8L3NwYW4+PHNwYW4gY2xhc3M9ImxhYmVsIj5zYXZlZDwvc3Bhbj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXQtY2VsbCI+PHNwYW4gY2xhc3M9Im51bSBncmVlbiI+4oCUPC9zcGFuPjxzcGFuIGNsYXNzPSJsYWJlbCI+YXBwbGllZDwvc3Bhbj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXQtY2VsbCI+PHNwYW4gY2xhc3M9Im51bSByZWQiPuKAlDwvc3Bhbj48c3BhbiBjbGFzcz0ibGFiZWwiPnNraXBwZWQ8L3NwYW4+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzdGF0LWNlbGwiPjxzcGFuIGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXRlZCkiPuKAlDwvc3Bhbj48c3BhbiBjbGFzcz0ibGFiZWwiPmlnbm9yZWQ8L3NwYW4+PC9kaXY+CiAgPC9kaXY+CgogIDwhLS0gRmlsdGVyIEJhciAtLT4KICA8ZGl2IGNsYXNzPSJmaWx0ZXItYmFyIj4KICAgIDxzZWxlY3QgaWQ9InN0YXR1c0ZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBzdGF0dXMiIGFyaWEtbGFiZWw9IkZpbHRlciBieSBzdGF0dXMiPgogICAgICA8b3B0aW9uIHZhbHVlPSJuZXciPk5ldyBKb2JzPC9vcHRpb24+CiAgICAgIDxvcHRpb24gdmFsdWU9InNhdmVkIj5TYXZlZDwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJhcHBsaWVkIj5BcHBsaWVkPC9vcHRpb24+CiAgICAgIDxvcHRpb24gdmFsdWU9InNraXBwZWQiPlNraXBwZWQ8L29wdGlvbj4KICAgICAgPG9wdGlvbiB2YWx1ZT0iaWdub3JlZCI+SWdub3JlZDwvb3B0aW9uPgogICAgPC9zZWxlY3Q+CiAgICA8c2VsZWN0IGlkPSJjb21wYW55RmlsdGVyIiB0aXRsZT0iRmlsdGVyIGJ5IGNvbXBhbnkiIGFyaWEtbGFiZWw9IkZpbHRlciBieSBjb21wYW55Ij4KICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgQ29tcGFuaWVzPC9vcHRpb24+CiAgICA8L3NlbGVjdD4KICAgIDxzZWxlY3QgaWQ9InJlZ2lvbkZpbHRlciIgdGl0bGU9IkZpbHRlciBieSByZWdpb24iIGFyaWEtbGFiZWw9IkZpbHRlciBieSByZWdpb24iPgogICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBSZWdpb25zPC9vcHRpb24+CiAgICAgIDxvcHRpb24gdmFsdWU9ImluZGlhIj5JbmRpYTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJyZW1vdGUiPlJlbW90ZTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJ1c2EiPlVTQTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJldXJvcGUiPkV1cm9wZTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJhc2lhLXBhY2lmaWMiPkFzaWEtUGFjaWZpYzwvb3B0aW9uPgogICAgPC9zZWxlY3Q+CiAgICA8c2VsZWN0IGlkPSJqb2JUeXBlRmlsdGVyIiB0aXRsZT0iRmlsdGVyIGJ5IGpvYiB0eXBlIiBhcmlhLWxhYmVsPSJGaWx0ZXIgYnkgam9iIHR5cGUiPgogICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBUeXBlczwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJyZW1vdGUiPlJlbW90ZSBPbmx5PC9vcHRpb24+CiAgICAgIDxvcHRpb24gdmFsdWU9Im9uc2l0ZSI+T24tc2l0ZSBPbmx5PC9vcHRpb24+CiAgICA8L3NlbGVjdD4KICAgIDxzZWxlY3QgaWQ9InNvdXJjZUZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBzb3VyY2UiIGFyaWEtbGFiZWw9IkZpbHRlciBieSBzb3VyY2UiPgogICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBTb3VyY2VzPC9vcHRpb24+CiAgICA8L3NlbGVjdD4KICAgIDxzZWxlY3QgaWQ9InNvcnRGaWx0ZXIiIHRpdGxlPSJTb3J0IGJ5IiBhcmlhLWxhYmVsPSJTb3J0IGJ5Ij4KICAgICAgPG9wdGlvbiB2YWx1ZT0ic2NvcmUiPlNjb3JlIChkZXNjKTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJwb3N0ZWQiPk5ld2VzdDwvb3B0aW9uPgogICAgPC9zZWxlY3Q+CiAgICA8ZGl2IGNsYXNzPSJzcGFjZXIiPjwvZGl2PgogICAgPGlucHV0IGlkPSJzZWFyY2hJbnB1dCIgdHlwZT0idGV4dCIgcGxhY2Vob2xkZXI9IlNlYXJjaCB0aXRsZSwgY29tcGFueS4uLiIvPgogICAgPGJ1dHRvbiBpZD0iY2xlYXJGaWx0ZXJzIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCIgc3R5bGU9ImRpc3BsYXk6bm9uZSI+Q2xlYXI8L2J1dHRvbj4KICA8L2Rpdj4KCiAgPCEtLSBKb2IgTGlzdCBIZWFkZXIgLS0+CiAgPGRpdiBjbGFzcz0ibGlzdC1oZWFkZXIiPgogICAgPHNwYW4+Sm9iPC9zcGFuPgogICAgPHNwYW4+RGV0YWlsczwvc3Bhbj4KICAgIDxzcGFuPlNjb3JlPC9zcGFuPgogICAgPHNwYW4+QWN0aW9uczwvc3Bhbj4KICA8L2Rpdj4KCiAgPCEtLSBKb2IgTGlzdCAtLT4KICA8ZGl2IGNsYXNzPSJqb2ItbGlzdCIgaWQ9ImpvYlF1ZXVlIj4KICAgIDxkaXYgY2xhc3M9ImVtcHR5LXN0YXRlIj48cD5Mb2FkaW5nIGpvYnMuLi48L3A+PC9kaXY+CiAgPC9kaXY+CgogIDwhLS0gUHJvZmlsZSBNb2RhbCAtLT4KICA8ZGl2IGlkPSJwcm9maWxlTW9kYWwiIGNsYXNzPSJtb2RhbCIgc3R5bGU9ImRpc3BsYXk6bm9uZSIgcm9sZT0iZGlhbG9nIiBhcmlhLW1vZGFsPSJ0cnVlIiBhcmlhLWxhYmVsPSJFZGl0IHByb2ZpbGUiPgogICAgPGRpdiBjbGFzcz0ibW9kYWwtY29udGVudCI+CiAgICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWRlciI+CiAgICAgICAgPGgyPkVkaXQgcHJvZmlsZTwvaDI+CiAgICAgICAgPGJ1dHRvbiBpZD0iY2xvc2VQcm9maWxlQnRuIiBjbGFzcz0iY2xvc2UiIGFyaWEtbGFiZWw9IkNsb3NlIGRpYWxvZyI+JnRpbWVzOzwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGZvcm0gaWQ9InByb2ZpbGVGb3JtIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmb3JtLWdyaWQiPgogICAgICAgICAgPGxhYmVsPk5hbWU8aW5wdXQgaWQ9InBfbmFtZSIgbmFtZT0ibmFtZSIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+RW1haWw8aW5wdXQgaWQ9InBfZW1haWwiIG5hbWU9ImVtYWlsIiB0eXBlPSJlbWFpbCIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+UGhvbmU8aW5wdXQgaWQ9InBfcGhvbmUiIG5hbWU9InBob25lIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5MaW5rZWRJbjxpbnB1dCBpZD0icF9saW5rZWRpbiIgbmFtZT0ibGlua2VkaW4iLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkxvY2F0aW9uPGlucHV0IGlkPSJwX2xvY2F0aW9uIiBuYW1lPSJsb2NhdGlvbiIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+UmVzdW1lIFBhdGg8aW5wdXQgaWQ9InBfcmVzdW1lX3BhdGgiIG5hbWU9InJlc3VtZV9wYXRoIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5FeHBlcmllbmNlICh5ZWFycyk8aW5wdXQgaWQ9InBfZXhwIiBuYW1lPSJleHBlcmllbmNlX3llYXJzIiB0eXBlPSJudW1iZXIiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkN1cnJlbnQgUm9sZTxpbnB1dCBpZD0icF9yb2xlIiBuYW1lPSJjdXJyZW50X3JvbGUiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkN1cnJlbnQgQ29tcGFueTxpbnB1dCBpZD0icF9jb21wYW55IiBuYW1lPSJjdXJyZW50X2NvbXBhbnkiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPlNraWxscyAoY29tbWEtc2VwYXJhdGVkKTxpbnB1dCBpZD0icF9za2lsbHMiIG5hbWU9InNraWxscyIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+VGFyZ2V0IFRpdGxlcyAoY29tbWEtc2VwYXJhdGVkKTxpbnB1dCBpZD0icF90aXRsZXMiIG5hbWU9InRhcmdldF90aXRsZXMiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPlJlcXVpcmVkIEtleXdvcmRzPGlucHV0IGlkPSJwX3JlcV9rdyIgbmFtZT0icmVxdWlyZWRfa2V5d29yZHMiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkJvbnVzIEtleXdvcmRzPGlucHV0IGlkPSJwX2JvbnVzX2t3IiBuYW1lPSJib251c19rZXl3b3JkcyIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+TWluIFNhbGFyeSAoTGFraHMgSU5SKTxpbnB1dCBpZD0icF9taW5fc2FsYXJ5IiBuYW1lPSJzYWxhcnlfbWluX2xha2hzIiB0eXBlPSJudW1iZXIiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkN1cnJlbmN5CiAgICAgICAgICAgIDxzZWxlY3QgaWQ9InBfY3VycmVuY3kiIG5hbWU9InNhbGFyeV9jdXJyZW5jeSI+CiAgICAgICAgICAgICAgPG9wdGlvbj5JTlI8L29wdGlvbj48b3B0aW9uPlVTRDwvb3B0aW9uPjxvcHRpb24+RVVSPC9vcHRpb24+PG9wdGlvbj5HQlA8L29wdGlvbj4KICAgICAgICAgICAgPC9zZWxlY3Q+CiAgICAgICAgICA8L2xhYmVsPgogICAgICAgICAgPGxhYmVsPldvcmsgVHlwZQogICAgICAgICAgICA8c2VsZWN0IGlkPSJwX3dvcmtfdHlwZSIgbmFtZT0id29ya190eXBlIiBtdWx0aXBsZSBzaXplPSIzIj4KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJyZW1vdGUiPlJlbW90ZTwvb3B0aW9uPgogICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9Imh5YnJpZCI+SHlicmlkPC9vcHRpb24+CiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ib24tc2l0ZSI+T24tc2l0ZTwvb3B0aW9uPgogICAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICAgIDwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+UHJlZmVycmVkIExvY2F0aW9uczxpbnB1dCBpZD0icF9sb2NhdGlvbnMiIG5hbWU9ImxvY2F0aW9ucyIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+U3VtbWFyeTx0ZXh0YXJlYSBpZD0icF9zdW1tYXJ5IiBuYW1lPSJzdW1tYXJ5IiByb3dzPSIzIj48L3RleHRhcmVhPjwvbGFiZWw+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtYWN0aW9ucyI+CiAgICAgICAgICA8YnV0dG9uIHR5cGU9InN1Ym1pdCIgY2xhc3M9ImJ0biBidG4tcHJpbWFyeSI+U2F2ZSBQcm9maWxlPC9idXR0b24+CiAgICAgICAgICA8YnV0dG9uIHR5cGU9ImJ1dHRvbiIgaWQ9ImNhbmNlbFByb2ZpbGVCdG4iIGNsYXNzPSJidG4gYnRuLWdob3N0Ij5DYW5jZWw8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9mb3JtPgogICAgPC9kaXY+CiAgPC9kaXY+CgogIDwhLS0gQXBwbHkgTW9kYWwgLS0+CiAgPGRpdiBpZD0iYXBwbHlNb2RhbCIgY2xhc3M9Im1vZGFsIiBzdHlsZT0iZGlzcGxheTpub25lIiByb2xlPSJkaWFsb2ciIGFyaWEtbW9kYWw9InRydWUiIGFyaWEtbGFiZWw9IlByZXBhcmUgYXBwbGljYXRpb24iPgogICAgPGRpdiBjbGFzcz0ibW9kYWwtY29udGVudCI+CiAgICAgIDxkaXYgY2xhc3M9Im1vZGFsLWhlYWRlciI+CiAgICAgICAgPGgyPlByZXBhcmUgYXBwbGljYXRpb248L2gyPgogICAgICAgIDxidXR0b24gaWQ9ImNsb3NlQXBwbHlCdG4iIGNsYXNzPSJjbG9zZSIgYXJpYS1sYWJlbD0iQ2xvc2UgZGlhbG9nIj4mdGltZXM7PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGlkPSJhcHBseUNvbnRlbnQiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj4KICAgICAgICA8YSBpZD0iYXBwbHlVcmxCdG4iIGhyZWY9IiMiIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCI+T3BlbiBKb2IgUGFnZTwvYT4KICAgICAgICA8YnV0dG9uIGlkPSJtYXJrQXBwbGllZEJ0biIgY2xhc3M9ImJ0biBidG4tcHJpbWFyeSIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pIj5NYXJrIGFzIEFwcGxpZWQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICA8L2Rpdj4KCiAgPGRpdiBpZD0idG9hc3QiIGNsYXNzPSJ0b2FzdCI+PC9kaXY+CiAgPHNjcmlwdCBzcmM9Ii9hcHAuanM/dD1fX1RJTUVTVEFNUF9fIj48L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg==';

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
