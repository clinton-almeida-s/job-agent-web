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
const STYLES_CSS_B64 = 'LyogTWlzc2lvbiBDb250cm9sIERhc2hib2FyZCAqLw0KQGltcG9ydCB1cmwoJ2h0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20vY3NzMj9mYW1pbHk9SW50ZXI6d2dodEA0MDA7NTAwOzYwMDs3MDAmZmFtaWx5PUpldEJyYWlucytNb25vOndnaHRANDAwOzUwMDs2MDAmZGlzcGxheT1zd2FwJyk7DQoNCjpyb290IHsNCiAgLS1iZzogIzA4MDkwRDsNCiAgLS1zdXJmYWNlOiAjMTExMzE4Ow0KICAtLXN1cmZhY2UyOiAjMUExRDI3Ow0KICAtLWJvcmRlcjogIzFGMjkzNzsNCiAgLS1ib3JkZXItc3VidGxlOiAjMjUyQzNCOw0KICAtLXRleHQ6ICNFNUU3RUI7DQogIC0tbXV0ZWQ6ICM3Mjc5ODY7DQogIC0tbXV0ZWQtZGltOiAjNUI2MzcwOw0KICAtLWFjY2VudDogIzAwRDRGRjsNCiAgLS1hY2NlbnQtZGltOiByZ2JhKDAsIDIxMiwgMjU1LCAwLjEyKTsNCiAgLS1ncmVlbjogIzEwQjk4MTsNCiAgLS1ncmVlbi1kaW06IHJnYmEoMTYsIDE4NSwgMTI5LCAwLjEyKTsNCiAgLS1hbWJlcjogI0Y1OUUwQjsNCiAgLS1hbWJlci1kaW06IHJnYmEoMjQ1LCAxNTgsIDExLCAwLjEyKTsNCiAgLS1yZWQ6ICNFRjQ0NDQ7DQogIC0tcmVkLWRpbTogcmdiYSgyMzksIDY4LCA2OCwgMC4xMik7DQp9DQoNCiogeyBib3gtc2l6aW5nOiBib3JkZXItYm94OyBtYXJnaW46IDA7IHBhZGRpbmc6IDA7IH0NCg0KLyogR2xvYmFsIGZvY3VzLXZpc2libGUgZm9yIGtleWJvYXJkIG5hdmlnYXRpb24gKi8NCio6Zm9jdXMtdmlzaWJsZSB7DQogIG91dGxpbmU6IDJweCBzb2xpZCB2YXIoLS1hY2NlbnQpOw0KICBvdXRsaW5lLW9mZnNldDogMnB4Ow0KICBib3JkZXItcmFkaXVzOiAycHg7DQp9DQpidXR0b246Zm9jdXMtdmlzaWJsZSwgYTpmb2N1cy12aXNpYmxlIHsNCiAgb3V0bGluZTogMnB4IHNvbGlkIHZhcigtLWFjY2VudCk7DQogIG91dGxpbmUtb2Zmc2V0OiAycHg7DQp9DQoNCmJvZHkgew0KICBmb250LWZhbWlseTogJ0ludGVyJywgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBzYW5zLXNlcmlmOw0KICBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7DQogIGNvbG9yOiB2YXIoLS10ZXh0KTsNCiAgbWluLWhlaWdodDogMTAwdmg7DQogIGZvbnQtc2l6ZTogMTRweDsNCiAgbGluZS1oZWlnaHQ6IDEuNTsNCn0NCg0KLyog4pSA4pSAIFRvcCBCYXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovDQoudG9wYmFyIHsNCiAgZGlzcGxheTogZmxleDsNCiAgYWxpZ24taXRlbXM6IGNlbnRlcjsNCiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOw0KICBwYWRkaW5nOiAwIDEuNXJlbTsNCiAgaGVpZ2h0OiA0OHB4Ow0KICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsNCiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7DQogIHBvc2l0aW9uOiBzdGlja3k7DQogIHRvcDogMDsNCiAgei1pbmRleDogMTA7DQp9DQoNCi50b3BiYXItYnJhbmQgew0KICBkaXNwbGF5OiBmbGV4Ow0KICBhbGlnbi1pdGVtczogYmFzZWxpbmU7DQogIGdhcDogLjc1cmVtOw0KfQ0KDQoudG9wYmFyLWJyYW5kIGgxIHsNCiAgZm9udC1zaXplOiAxM3B4Ow0KICBmb250LXdlaWdodDogNzAwOw0KICBsZXR0ZXItc3BhY2luZzogLjA4ZW07DQogIGNvbG9yOiB2YXIoLS1hY2NlbnQpOw0KICB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlOw0KfQ0KDQoudG9wYmFyLW1ldGEgew0KICBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOw0KICBmb250LXNpemU6IDExcHg7DQogIGNvbG9yOiB2YXIoLS1tdXRlZCk7DQogIGRpc3BsYXk6IGZsZXg7DQogIGdhcDogMXJlbTsNCiAgYWxpZ24taXRlbXM6IGNlbnRlcjsNCn0NCg0KLnRvcGJhci1tZXRhIC5kb3Qgew0KICB3aWR0aDogM3B4Ow0KICBoZWlnaHQ6IDNweDsNCiAgYm9yZGVyLXJhZGl1czogNTAlOw0KICBiYWNrZ3JvdW5kOiB2YXIoLS1tdXRlZC1kaW0pOw0KfQ0KDQoudG9wYmFyLW1ldGEgLmxpdmUtZG90IHsNCiAgd2lkdGg6IDZweDsNCiAgaGVpZ2h0OiA2cHg7DQogIGJvcmRlci1yYWRpdXM6IDUwJTsNCiAgYmFja2dyb3VuZDogdmFyKC0tZ3JlZW4pOw0KICBib3gtc2hhZG93OiAwIDAgNnB4IHZhcigtLWdyZWVuKTsNCn0NCg0KLnRvcGJhci1hY3Rpb25zIHsNCiAgZGlzcGxheTogZmxleDsNCiAgZ2FwOiAuNXJlbTsNCn0NCg0KLyog4pSA4pSAIEJ1dHRvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovDQouYnRuIHsNCiAgZm9udC1mYW1pbHk6ICdJbnRlcicsIHNhbnMtc2VyaWY7DQogIGZvbnQtc2l6ZTogMTJweDsNCiAgZm9udC13ZWlnaHQ6IDUwMDsNCiAgcGFkZGluZzogLjM3NXJlbSAuNzVyZW07DQogIGJvcmRlci1yYWRpdXM6IDRweDsNCiAgY3Vyc29yOiBwb2ludGVyOw0KICBib3JkZXI6IG5vbmU7DQogIHRyYW5zaXRpb246IGJhY2tncm91bmQgLjE1cywgYm9yZGVyLWNvbG9yIC4xNXM7DQp9DQoNCi5idG4tcHJpbWFyeSB7DQogIGJhY2tncm91bmQ6IHZhcigtLWFjY2VudCk7DQogIGNvbG9yOiB2YXIoLS1iZyk7DQp9DQouYnRuLXByaW1hcnk6aG92ZXIgeyBiYWNrZ3JvdW5kOiAjMzNERkZGOyB9DQoNCi5idG4tZ2hvc3Qgew0KICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsNCiAgY29sb3I6IHZhcigtLW11dGVkKTsNCiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsNCn0NCi5idG4tZ2hvc3Q6aG92ZXIgew0KICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlMik7DQogIGNvbG9yOiB2YXIoLS10ZXh0KTsNCiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1ib3JkZXItc3VidGxlKTsNCn0NCg0KLyog4pSA4pSAIFN0YXQgU3RyaXAg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovDQouc3RhdC1zdHJpcCB7DQogIGRpc3BsYXk6IGZsZXg7DQogIGdhcDogMDsNCiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7DQogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOw0KfQ0KDQouc3RhdC1jZWxsIHsNCiAgZmxleDogMTsNCiAgcGFkZGluZzogLjc1cmVtIDEuMjVyZW07DQogIGJvcmRlci1yaWdodDogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7DQogIGRpc3BsYXk6IGZsZXg7DQogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47DQogIGdhcDogMnB4Ow0KfQ0KLnN0YXQtY2VsbDpsYXN0LWNoaWxkIHsgYm9yZGVyLXJpZ2h0OiBub25lOyB9DQoNCi5zdGF0LWNlbGwgLm51bSB7DQogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7DQogIGZvbnQtc2l6ZTogMjBweDsNCiAgZm9udC13ZWlnaHQ6IDYwMDsNCiAgY29sb3I6IHZhcigtLXRleHQpOw0KICBsaW5lLWhlaWdodDogMTsNCn0NCg0KLnN0YXQtY2VsbCAubnVtLmFjY2VudCB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9DQouc3RhdC1jZWxsIC5udW0uZ3JlZW4geyBjb2xvcjogdmFyKC0tZ3JlZW4pOyB9DQouc3RhdC1jZWxsIC5udW0uYW1iZXIgeyBjb2xvcjogdmFyKC0tYW1iZXIpOyB9DQouc3RhdC1jZWxsIC5udW0ucmVkIHsgY29sb3I6IHZhcigtLXJlZCk7IH0NCg0KLnN0YXQtY2VsbCAubGFiZWwgew0KICBmb250LXNpemU6IDEwcHg7DQogIGZvbnQtd2VpZ2h0OiA1MDA7DQogIGxldHRlci1zcGFjaW5nOiAuMDRlbTsNCiAgY29sb3I6IHZhcigtLW11dGVkKTsNCn0NCg0KLyog4pSA4pSAIEZpbHRlciBCYXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovDQouZmlsdGVyLWJhciB7DQogIGRpc3BsYXk6IGZsZXg7DQogIGFsaWduLWl0ZW1zOiBjZW50ZXI7DQogIGdhcDogLjVyZW07DQogIHBhZGRpbmc6IC42MjVyZW0gMS41cmVtOw0KICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsNCiAgYmFja2dyb3VuZDogdmFyKC0tYmcpOw0KICBmbGV4LXdyYXA6IHdyYXA7DQp9DQoNCi5maWx0ZXItYmFyIHNlbGVjdCwNCi5maWx0ZXItYmFyIGlucHV0IHsNCiAgZm9udC1mYW1pbHk6ICdJbnRlcicsIHNhbnMtc2VyaWY7DQogIGZvbnQtc2l6ZTogMTJweDsNCiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7DQogIGNvbG9yOiB2YXIoLS10ZXh0KTsNCiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsNCiAgcGFkZGluZzogLjNyZW0gLjZyZW07DQogIGJvcmRlci1yYWRpdXM6IDNweDsNCiAgb3V0bGluZTogbm9uZTsNCn0NCi5maWx0ZXItYmFyIHNlbGVjdDpmb2N1cywNCi5maWx0ZXItYmFyIGlucHV0OmZvY3VzIHsNCiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOw0KICBib3gtc2hhZG93OiAwIDAgMCAycHggdmFyKC0tYWNjZW50LWRpbSk7DQp9DQoNCi5maWx0ZXItYmFyIHNlbGVjdCB7IG1pbi13aWR0aDogMTIwcHg7IGN1cnNvcjogcG9pbnRlcjsgfQ0KLmZpbHRlci1iYXIgaW5wdXRbdHlwZT0idGV4dCJdIHsgbWluLXdpZHRoOiAyMDBweDsgfQ0KDQouZmlsdGVyLWJhciAuc3BhY2VyIHsgZmxleDogMTsgfQ0KDQovKiDilIDilIAgSm9iIExpc3Qg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovDQouam9iLWxpc3Qgew0KICBwYWRkaW5nOiAwOw0KfQ0KDQouam9iLXJvdyB7DQogIGRpc3BsYXk6IGdyaWQ7DQogIGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyIGF1dG8gMTYwcHggMjAwcHg7DQogIGFsaWduLWl0ZW1zOiBjZW50ZXI7DQogIGdhcDogMDsNCiAgcGFkZGluZzogMDsNCiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdWJ0bGUpOw0KICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsNCiAgdHJhbnNpdGlvbjogYmFja2dyb3VuZCAuMXM7DQogIGN1cnNvcjogZGVmYXVsdDsNCn0NCg0KLmpvYi1yb3c6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlMik7IH0NCi5qb2Itcm93LmFwcGxpZWQgeyBib3JkZXItbGVmdDogMnB4IHNvbGlkIHZhcigtLWdyZWVuKTsgfQ0KLmpvYi1yb3cuc2F2ZWQgeyBib3JkZXItbGVmdDogMnB4IHNvbGlkIHZhcigtLWFtYmVyKTsgfQ0KLmpvYi1yb3cuc2tpcHBlZCB7IGJhY2tncm91bmQ6IHJnYmEoMjM5LCA2OCwgNjgsIDAuMDQpOyBib3JkZXItbGVmdDogMnB4IHNvbGlkIHJnYmEoMjM5LCA2OCwgNjgsIDAuMyk7IH0NCi5qb2Itcm93LnNraXBwZWQgLmpvYi10aXRsZSwNCi5qb2Itcm93LnNraXBwZWQgLmpvYi1jb21wYW55LA0KLmpvYi1yb3cuc2tpcHBlZCAuam9iLWRldGFpbHMgLmxvY2F0aW9uIHsgY29sb3I6IHZhcigtLW11dGVkKTsgfQ0KLmpvYi1yb3cuaWdub3JlZCB7IGJhY2tncm91bmQ6IHJnYmEoMTA3LCAxMTQsIDEyOCwgMC4wNik7IGJvcmRlci1sZWZ0OiAycHggc29saWQgcmdiYSgxMDcsIDExNCwgMTI4LCAwLjMpOyB9DQouam9iLXJvdy5pZ25vcmVkIC5qb2ItdGl0bGUsDQouam9iLXJvdy5pZ25vcmVkIC5qb2ItY29tcGFueSwNCi5qb2Itcm93Lmlnbm9yZWQgLmpvYi1kZXRhaWxzIC5sb2NhdGlvbiB7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0NCg0KLmpvYi1yYW5rIHsNCiAgZm9udC1mYW1pbHk6ICdKZXRCcmFpbnMgTW9ubycsIG1vbm9zcGFjZTsNCiAgZm9udC1zaXplOiAxMXB4Ow0KICBjb2xvcjogdmFyKC0tbXV0ZWQtZGltKTsNCiAgcGFkZGluZzogLjc1cmVtIDFyZW07DQogIHRleHQtYWxpZ246IGNlbnRlcjsNCiAgYm9yZGVyLXJpZ2h0OiAxcHggc29saWQgdmFyKC0tYm9yZGVyLXN1YnRsZSk7DQp9DQouam9iLXJhbmsgLnJhbmstbnVtIHsNCiAgZm9udC1zaXplOiAxNHB4Ow0KICBmb250LXdlaWdodDogNjAwOw0KICBjb2xvcjogdmFyKC0tbXV0ZWQpOw0KfQ0KDQouam9iLWluZm8gew0KICBwYWRkaW5nOiAuNzVyZW0gMXJlbTsNCiAgYm9yZGVyLXJpZ2h0OiAxcHggc29saWQgdmFyKC0tYm9yZGVyLXN1YnRsZSk7DQp9DQoNCi5qb2ItdGl0bGUgew0KICBmb250LXNpemU6IDEzcHg7DQogIGZvbnQtd2VpZ2h0OiA2MDA7DQogIGNvbG9yOiB2YXIoLS10ZXh0KTsNCiAgbWFyZ2luLWJvdHRvbTogM3B4Ow0KICBkaXNwbGF5OiBmbGV4Ow0KICBhbGlnbi1pdGVtczogY2VudGVyOw0KICBnYXA6IC41cmVtOw0KfQ0KDQouam9iLXRpdGxlIC5zdGF0dXMtdGFnIHsNCiAgZm9udC1mYW1pbHk6ICdKZXRCcmFpbnMgTW9ubycsIG1vbm9zcGFjZTsNCiAgZm9udC1zaXplOiA5cHg7DQogIGZvbnQtd2VpZ2h0OiA1MDA7DQogIHBhZGRpbmc6IDFweCA2cHg7DQogIGJvcmRlci1yYWRpdXM6IDJweDsNCiAgbGV0dGVyLXNwYWNpbmc6IC4wNWVtOw0KICBmbGV4LXNocmluazogMDsNCn0NCi5zdGF0dXMtdGFnLm5ldyB7IGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1kaW0pOyBjb2xvcjogdmFyKC0tYWNjZW50KTsgfQ0KLnN0YXR1cy10YWcuYXBwbGllZCB7IGJhY2tncm91bmQ6IHZhcigtLWdyZWVuLWRpbSk7IGNvbG9yOiB2YXIoLS1ncmVlbik7IH0NCi5zdGF0dXMtdGFnLnNhdmVkIHsgYmFja2dyb3VuZDogdmFyKC0tYW1iZXItZGltKTsgY29sb3I6IHZhcigtLWFtYmVyKTsgfQ0KLnN0YXR1cy10YWcuc2tpcHBlZCB7IGJhY2tncm91bmQ6IHZhcigtLXJlZC1kaW0pOyBjb2xvcjogdmFyKC0tcmVkKTsgfQ0KLnN0YXR1cy10YWcuaWdub3JlZCB7IGJhY2tncm91bmQ6IHZhcigtLWJvcmRlcik7IGNvbG9yOiB2YXIoLS1tdXRlZCk7IH0NCg0KLmpvYi1jb21wYW55IHsNCiAgZm9udC1zaXplOiAxMnB4Ow0KICBjb2xvcjogdmFyKC0tbXV0ZWQpOw0KICBtYXJnaW4tYm90dG9tOiA0cHg7DQp9DQoNCi5qb2ItdGFncyB7DQogIGRpc3BsYXk6IGZsZXg7DQogIGdhcDogLjM1cmVtOw0KICBmbGV4LXdyYXA6IHdyYXA7DQp9DQouam9iLXRhZyB7DQogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7DQogIGZvbnQtc2l6ZTogMTBweDsNCiAgcGFkZGluZzogMXB4IDZweDsNCiAgYm9yZGVyLXJhZGl1czogMnB4Ow0KICBiYWNrZ3JvdW5kOiB2YXIoLS1ib3JkZXIpOw0KICBjb2xvcjogdmFyKC0tbXV0ZWQpOw0KfQ0KLmpvYi10YWcucmVtb3RlIHsgYmFja2dyb3VuZDogdmFyKC0tZ3JlZW4tZGltKTsgY29sb3I6IHZhcigtLWdyZWVuKTsgfQ0KLmpvYi10YWcuc2FsYXJ5IHsgYmFja2dyb3VuZDogdmFyKC0tYW1iZXItZGltKTsgY29sb3I6IHZhcigtLWFtYmVyKTsgfQ0KDQouam9iLWRldGFpbHMgew0KICBwYWRkaW5nOiAuNzVyZW0gMXJlbTsNCiAgYm9yZGVyLXJpZ2h0OiAxcHggc29saWQgdmFyKC0tYm9yZGVyLXN1YnRsZSk7DQp9DQouam9iLWRldGFpbHMgLmxvY2F0aW9uIHsNCiAgZm9udC1zaXplOiAxMnB4Ow0KICBjb2xvcjogdmFyKC0tdGV4dCk7DQogIG1hcmdpbi1ib3R0b206IDJweDsNCn0NCi5qb2ItZGV0YWlscyAuc291cmNlIHsNCiAgZm9udC1mYW1pbHk6ICdKZXRCcmFpbnMgTW9ubycsIG1vbm9zcGFjZTsNCiAgZm9udC1zaXplOiAxMHB4Ow0KICBjb2xvcjogdmFyKC0tbXV0ZWQpOw0KfQ0KDQouam9iLXNjb3JlIHsNCiAgcGFkZGluZzogLjc1cmVtIDFyZW07DQogIGJvcmRlci1yaWdodDogMXB4IHNvbGlkIHZhcigtLWJvcmRlci1zdWJ0bGUpOw0KICBkaXNwbGF5OiBmbGV4Ow0KICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOw0KICBhbGlnbi1pdGVtczogZmxleC1lbmQ7DQogIGdhcDogNHB4Ow0KfQ0KLnNjb3JlLWJhci10cmFjayB7DQogIHdpZHRoOiAxMDAlOw0KICBoZWlnaHQ6IDNweDsNCiAgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsNCiAgYm9yZGVyLXJhZGl1czogMnB4Ow0KICBvdmVyZmxvdzogaGlkZGVuOw0KfQ0KLnNjb3JlLWJhci1maWxsIHsNCiAgaGVpZ2h0OiAxMDAlOw0KICBib3JkZXItcmFkaXVzOiAycHg7DQogIHRyYW5zaXRpb246IHdpZHRoIC4zcyBlYXNlOw0KfQ0KLnNjb3JlLWJhci1maWxsLmhpZ2ggeyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7IH0NCi5zY29yZS1iYXItZmlsbC5taWQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1hbWJlcik7IH0NCi5zY29yZS1iYXItZmlsbC5sb3cgeyBiYWNrZ3JvdW5kOiB2YXIoLS1yZWQpOyB9DQouc2NvcmUtdmFsIHsNCiAgZm9udC1mYW1pbHk6ICdKZXRCcmFpbnMgTW9ubycsIG1vbm9zcGFjZTsNCiAgZm9udC1zaXplOiAxMXB4Ow0KICBjb2xvcjogdmFyKC0tbXV0ZWQpOw0KfQ0KDQouam9iLWFjdGlvbnMgew0KICBwYWRkaW5nOiAuNzVyZW0gMXJlbTsNCiAgZGlzcGxheTogZmxleDsNCiAgZ2FwOiAuMzVyZW07DQogIGFsaWduLWl0ZW1zOiBjZW50ZXI7DQp9DQouYWN0aW9uLWxpbmsgew0KICBmb250LWZhbWlseTogJ0ludGVyJywgc2Fucy1zZXJpZjsNCiAgZm9udC1zaXplOiAxMXB4Ow0KICBmb250LXdlaWdodDogNTAwOw0KICBwYWRkaW5nOiAuM3JlbSAuNnJlbTsNCiAgYm9yZGVyLXJhZGl1czogM3B4Ow0KICBjdXJzb3I6IHBvaW50ZXI7DQogIGJvcmRlcjogbm9uZTsNCiAgdGV4dC1kZWNvcmF0aW9uOiBub25lOw0KICB0cmFuc2l0aW9uOiBhbGwgLjE1czsNCiAgZGlzcGxheTogaW5saW5lLWZsZXg7DQogIGFsaWduLWl0ZW1zOiBjZW50ZXI7DQogIGdhcDogLjI1cmVtOw0KfQ0KLmFjdGlvbi1saW5rLnZpZXcgew0KICBiYWNrZ3JvdW5kOiB2YXIoLS1hY2NlbnQtZGltKTsNCiAgY29sb3I6IHZhcigtLWFjY2VudCk7DQp9DQouYWN0aW9uLWxpbmsudmlldzpob3ZlciB7IGJhY2tncm91bmQ6IHJnYmEoMCwyMTIsMjU1LDAuMik7IH0NCi5hY3Rpb24tbGluay5hcHBseSB7DQogIGJhY2tncm91bmQ6IHZhcigtLWdyZWVuLWRpbSk7DQogIGNvbG9yOiB2YXIoLS1ncmVlbik7DQp9DQouYWN0aW9uLWxpbmsuYXBwbHk6aG92ZXIgeyBiYWNrZ3JvdW5kOiByZ2JhKDE2LDE4NSwxMjksMC4yKTsgfQ0KLmFjdGlvbi1saW5rLnNhdmUgew0KICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlMik7DQogIGNvbG9yOiB2YXIoLS1tdXRlZCk7DQogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7DQp9DQouYWN0aW9uLWxpbmsuc2F2ZTpob3ZlciB7IGNvbG9yOiB2YXIoLS10ZXh0KTsgYm9yZGVyLWNvbG9yOiB2YXIoLS1ib3JkZXItc3VidGxlKTsgfQ0KLmFjdGlvbi1saW5rLnNraXAgew0KICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlMik7DQogIGNvbG9yOiB2YXIoLS1tdXRlZCk7DQogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7DQp9DQouYWN0aW9uLWxpbmsuc2tpcDpob3ZlciB7IGNvbG9yOiB2YXIoLS1yZWQpOyBib3JkZXItY29sb3I6IHZhcigtLXJlZC1kaW0pOyB9DQoNCi8qIOKUgOKUgCBUYWJsZSBIZWFkZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovDQoubGlzdC1oZWFkZXIgew0KICBkaXNwbGF5OiBncmlkOw0KICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmciBhdXRvIDE2MHB4IDIwMHB4Ow0KICBhbGlnbi1pdGVtczogY2VudGVyOw0KICBnYXA6IDA7DQogIHBhZGRpbmc6IC41cmVtIDA7DQogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOw0KICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsNCiAgcG9zaXRpb246IHN0aWNreTsNCiAgdG9wOiA0OHB4Ow0KICB6LWluZGV4OiA1Ow0KfQ0KLmxpc3QtaGVhZGVyIHNwYW4gew0KICBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOw0KICBmb250LXNpemU6IDEwcHg7DQogIGZvbnQtd2VpZ2h0OiA1MDA7DQogIGxldHRlci1zcGFjaW5nOiAuMDZlbTsNCiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsNCiAgY29sb3I6IHZhcigtLW11dGVkLWRpbSk7DQogIHBhZGRpbmc6IDAgMXJlbTsNCn0NCi5saXN0LWhlYWRlciBzcGFuOm50aC1jaGlsZCgyKSB7IHBhZGRpbmc6IDAgMXJlbTsgfQ0KLmxpc3QtaGVhZGVyIHNwYW46bnRoLWNoaWxkKDMpIHsgdGV4dC1hbGlnbjogcmlnaHQ7IHBhZGRpbmctcmlnaHQ6IDFyZW07IH0NCi5saXN0LWhlYWRlciBzcGFuOm50aC1jaGlsZCg0KSB7IHRleHQtYWxpZ246IHJpZ2h0OyBwYWRkaW5nLXJpZ2h0OiAxcmVtOyB9DQoNCi8qIOKUgOKUgCBFbXB0eSBTdGF0ZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8NCi5lbXB0eS1zdGF0ZSB7DQogIHRleHQtYWxpZ246IGNlbnRlcjsNCiAgcGFkZGluZzogNHJlbSAycmVtOw0KICBjb2xvcjogdmFyKC0tbXV0ZWQpOw0KfQ0KLmVtcHR5LXN0YXRlIC5pY29uIHsgZm9udC1zaXplOiAycmVtOyBtYXJnaW4tYm90dG9tOiAuNzVyZW07IH0NCi5lbXB0eS1zdGF0ZSBwIHsgZm9udC1zaXplOiAxM3B4OyB9DQoNCi8qIOKUgOKUgCBNb2RhbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8NCi5tb2RhbCB7DQogIHBvc2l0aW9uOiBmaXhlZDsgaW5zZXQ6IDA7DQogIGJhY2tncm91bmQ6IHJnYmEoMCwwLDAsLjYpOw0KICB6LWluZGV4OiAxMDA7DQogIGRpc3BsYXk6IGZsZXg7DQogIGFsaWduLWl0ZW1zOiBjZW50ZXI7DQogIGp1c3RpZnktY29udGVudDogY2VudGVyOw0KfQ0KLm1vZGFsLWNvbnRlbnQgew0KICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsNCiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsNCiAgYm9yZGVyLXJhZGl1czogOHB4Ow0KICB3aWR0aDogOTAlOw0KICBtYXgtd2lkdGg6IDYwMHB4Ow0KICBtYXgtaGVpZ2h0OiA5MHZoOw0KICBvdmVyZmxvdy15OiBhdXRvOw0KfQ0KLm1vZGFsLWhlYWRlciB7DQogIGRpc3BsYXk6IGZsZXg7DQogIGFsaWduLWl0ZW1zOiBjZW50ZXI7DQogIGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjsNCiAgcGFkZGluZzogMXJlbSAxLjVyZW07DQogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOw0KfQ0KLm1vZGFsLWhlYWRlciBoMiB7DQogIGZvbnQtc2l6ZTogMTNweDsNCiAgZm9udC13ZWlnaHQ6IDYwMDsNCiAgbGV0dGVyLXNwYWNpbmc6IC4wMmVtOw0KICBjb2xvcjogdmFyKC0tdGV4dCk7DQp9DQoubW9kYWwtaGVhZGVyIC5jbG9zZSB7DQogIGJhY2tncm91bmQ6IG5vbmU7DQogIGJvcmRlcjogbm9uZTsNCiAgY29sb3I6IHZhcigtLW11dGVkKTsNCiAgZm9udC1zaXplOiAxOHB4Ow0KICBjdXJzb3I6IHBvaW50ZXI7DQp9DQoubW9kYWwtaGVhZGVyIC5jbG9zZTpob3ZlciB7IGNvbG9yOiB2YXIoLS10ZXh0KTsgfQ0KLm1vZGFsLWNvbnRlbnQgZm9ybSB7IHBhZGRpbmc6IDEuNXJlbTsgfQ0KLmZvcm0tZ3JpZCB7DQogIGRpc3BsYXk6IGdyaWQ7DQogIGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyIDFmcjsNCiAgZ2FwOiAxcmVtOw0KfQ0KLmZvcm0tZ3JpZCBsYWJlbCB7DQogIGRpc3BsYXk6IGZsZXg7DQogIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47DQogIGdhcDogLjI1cmVtOw0KICBmb250LXNpemU6IDExcHg7DQogIGZvbnQtd2VpZ2h0OiA1MDA7DQogIGxldHRlci1zcGFjaW5nOiAuMDJlbTsNCiAgY29sb3I6IHZhcigtLW11dGVkKTsNCn0NCi5mb3JtLWdyaWQgbGFiZWwgaW5wdXQsDQouZm9ybS1ncmlkIGxhYmVsIHNlbGVjdCwNCi5mb3JtLWdyaWQgbGFiZWwgdGV4dGFyZWEgew0KICBiYWNrZ3JvdW5kOiB2YXIoLS1iZyk7DQogIGNvbG9yOiB2YXIoLS10ZXh0KTsNCiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsNCiAgcGFkZGluZzogLjVyZW07DQogIGJvcmRlci1yYWRpdXM6IDNweDsNCiAgZm9udC1zaXplOiAxM3B4Ow0KICBmb250LWZhbWlseTogJ0ludGVyJywgc2Fucy1zZXJpZjsNCiAgb3V0bGluZTogbm9uZTsNCn0NCi5mb3JtLWdyaWQgbGFiZWwgaW5wdXQ6Zm9jdXMsDQouZm9ybS1ncmlkIGxhYmVsIHNlbGVjdDpmb2N1cywNCi5mb3JtLWdyaWQgbGFiZWwgdGV4dGFyZWE6Zm9jdXMgew0KICBib3JkZXItY29sb3I6IHZhcigtLWFjY2VudCk7DQogIGJveC1zaGFkb3c6IDAgMCAwIDJweCB2YXIoLS1hY2NlbnQtZGltKTsNCn0NCi5mb3JtLWdyaWQgbGFiZWwgdGV4dGFyZWEgeyByZXNpemU6IHZlcnRpY2FsOyBtaW4taGVpZ2h0OiA2MHB4OyB9DQoubW9kYWwtYWN0aW9ucyB7DQogIGRpc3BsYXk6IGZsZXg7DQogIGdhcDogLjVyZW07DQogIGp1c3RpZnktY29udGVudDogZmxleC1lbmQ7DQogIHBhZGRpbmc6IDFyZW0gMS41cmVtOw0KICBib3JkZXItdG9wOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsNCn0NCi5hcHBseS1jaGVja2xpc3QgeyBsaXN0LXN0eWxlOiBub25lOyBwYWRkaW5nOiAwOyB9DQouYXBwbHktY2hlY2tsaXN0IGxpIHsNCiAgcGFkZGluZzogLjVyZW0gMDsNCiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7DQogIGRpc3BsYXk6IGZsZXg7DQogIGFsaWduLWl0ZW1zOiBjZW50ZXI7DQogIGdhcDogLjVyZW07DQogIGZvbnQtc2l6ZTogMTNweDsNCn0NCi5hcHBseS1jaGVja2xpc3QgLnZhbCB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOyBmb250LXNpemU6IDEycHg7IH0NCg0KLyog4pSA4pSAIFRvYXN0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLw0KLnRvYXN0IHsNCiAgcG9zaXRpb246IGZpeGVkOw0KICBib3R0b206IDEuNXJlbTsNCiAgcmlnaHQ6IDEuNXJlbTsNCiAgYmFja2dyb3VuZDogdmFyKC0tZ3JlZW4pOw0KICBjb2xvcjogIzAwMDsNCiAgcGFkZGluZzogLjYyNXJlbSAxLjEyNXJlbTsNCiAgYm9yZGVyLXJhZGl1czogNHB4Ow0KICBmb250LXNpemU6IDEycHg7DQogIGZvbnQtd2VpZ2h0OiA2MDA7DQogIGRpc3BsYXk6IG5vbmU7DQogIHotaW5kZXg6IDIwMDsNCiAgbGV0dGVyLXNwYWNpbmc6IC4wMmVtOw0KfQ0KDQovKiDilIDilIAgUmVzcG9uc2l2ZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8NCkBtZWRpYSAobWF4LXdpZHRoOiA5MDBweCkgew0KICAuam9iLXJvdyB7DQogICAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgYXV0bzsNCiAgfQ0KICAuam9iLWRldGFpbHMgeyBkaXNwbGF5OiBub25lOyB9DQogIC5saXN0LWhlYWRlciBzcGFuOm50aC1jaGlsZCgzKSB7IGRpc3BsYXk6IG5vbmU7IH0NCn0NCkBtZWRpYSAobWF4LXdpZHRoOiA2MDBweCkgew0KICAuam9iLWFjdGlvbnMgeyBkaXNwbGF5OiBub25lOyB9DQogIC5saXN0LWhlYWRlciBzcGFuOm50aC1jaGlsZCg0KSB7IGRpc3BsYXk6IG5vbmU7IH0NCiAgLnN0YXQtY2VsbCB7IHBhZGRpbmc6IC41cmVtIC43NXJlbTsgfQ0KICAuc3RhdC1jZWxsIC5udW0geyBmb250LXNpemU6IDE2cHg7IH0NCn0NCg0KLyog4pSA4pSAIFNjcm9sbGJhciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8NCjo6LXdlYmtpdC1zY3JvbGxiYXIgeyB3aWR0aDogNnB4OyB9DQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRyYWNrIHsgYmFja2dyb3VuZDogdmFyKC0tYmcpOyB9DQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1iIHsgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsgYm9yZGVyLXJhZGl1czogM3B4OyB9DQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1iOmhvdmVyIHsgYmFja2dyb3VuZDogdmFyKC0tbXV0ZWQtZGltKTsgfQ0K';
const APP_JS_B64 = 'LyoqDQogKiBhcHAuanMg4oCUIERhc2hib2FyZCBjbGllbnQtc2lkZSBsb2dpYw0KICovDQpjb25zdCBBUEkgPSAnL2FwaSc7DQpsZXQgYWxsSm9icyA9IFtdOw0KbGV0IGN1cnJlbnRKb2JJZCA9IG51bGw7DQoNCi8vIOKUgOKUgCBJbml0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignRE9NQ29udGVudExvYWRlZCcsIGFzeW5jICgpID0+IHsNCiAgYXdhaXQgbG9hZFByb2ZpbGUoKTsNCiAgYXdhaXQgbG9hZFN0YXRzKCk7DQogIGF3YWl0IGxvYWRTb3VyY2VzKCk7DQogIGF3YWl0IGxvYWRKb2JzKCk7DQogIGJpbmRFdmVudHMoKTsNCiAgc3RhcnRVdGNDbG9jaygpOw0KfSk7DQoNCi8vIOKUgOKUgCBVVEMgQ2xvY2sg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQpmdW5jdGlvbiBzdGFydFV0Y0Nsb2NrKCkgew0KICBmdW5jdGlvbiB0aWNrKCkgew0KICAgIGNvbnN0IGQgPSBuZXcgRGF0ZSgpOw0KICAgIGNvbnN0IGggPSBTdHJpbmcoZC5nZXRVVENIb3VycygpKS5wYWRTdGFydCgyLCAnMCcpOw0KICAgIGNvbnN0IG0gPSBTdHJpbmcoZC5nZXRVVENNaW51dGVzKCkpLnBhZFN0YXJ0KDIsICcwJyk7DQogICAgY29uc3QgcyA9IFN0cmluZyhkLmdldFVUQ1NlY29uZHMoKSkucGFkU3RhcnQoMiwgJzAnKTsNCiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd1dGNUaW1lJyk7DQogICAgaWYgKGVsKSBlbC50ZXh0Q29udGVudCA9IGggKyAnOicgKyBtICsgJzonICsgcyArICcgVVRDJzsNCiAgfQ0KICB0aWNrKCk7DQogIHNldEludGVydmFsKHRpY2ssIDEwMDApOw0KfQ0KDQovLyDilIDilIAgUHJvZmlsZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCmFzeW5jIGZ1bmN0aW9uIGxvYWRQcm9maWxlKCkgew0KICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCk7DQogIGNvbnN0IHAgPSBhd2FpdCByLmpzb24oKTsNCiAgd2luZG93Ll9wcm9maWxlID0gcDsNCn0NCg0KYXN5bmMgZnVuY3Rpb24gbG9hZFNvdXJjZXMoKSB7DQogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgJHtBUEl9L2pvYnM/bGltaXQ9NTAwMGApOw0KICBjb25zdCBqb2JzID0gYXdhaXQgci5qc29uKCk7DQogIGNvbnN0IHNvdXJjZXMgPSBbLi4ubmV3IFNldChqb2JzLm1hcChqID0+IGouc291cmNlKSldLnNvcnQoKTsNCiAgY29uc3Qgc2VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NvdXJjZUZpbHRlcicpOw0KICBzb3VyY2VzLmZvckVhY2gocyA9PiB7DQogICAgY29uc3Qgb3B0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7DQogICAgb3B0LnZhbHVlID0gczsgb3B0LnRleHRDb250ZW50ID0gczsNCiAgICBzZWwuYXBwZW5kQ2hpbGQob3B0KTsNCiAgfSk7DQoNCiAgY29uc3QgY29tcGFuaWVzID0gWy4uLm5ldyBTZXQoam9icy5tYXAoaiA9PiBqLmNvbXBhbnkpKV0uc29ydCgpOw0KICBjb25zdCBjb21wYW55U2VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKTsNCiAgY29tcGFuaWVzLmZvckVhY2goYyA9PiB7DQogICAgY29uc3Qgb3B0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnb3B0aW9uJyk7DQogICAgb3B0LnZhbHVlID0gYzsgb3B0LnRleHRDb250ZW50ID0gYzsNCiAgICBjb21wYW55U2VsLmFwcGVuZENoaWxkKG9wdCk7DQogIH0pOw0KfQ0KDQovLyDilIDilIAgU3RhdHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQphc3luYyBmdW5jdGlvbiBsb2FkU3RhdHMoKSB7DQogIGNvbnN0IHMgPSBhd2FpdCAoYXdhaXQgZmV0Y2goYCR7QVBJfS9zdGF0c2ApKS5qc29uKCk7DQogIGNvbnN0IGNlbGxzID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnN0YXQtc3RyaXAgLnN0YXQtY2VsbCcpOw0KICBpZiAoY2VsbHNbMF0pIGNlbGxzWzBdLnF1ZXJ5U2VsZWN0b3IoJy5udW0nKS50ZXh0Q29udGVudCA9IHMudG90YWxfam9iczsNCiAgaWYgKGNlbGxzWzFdKSBjZWxsc1sxXS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLm5ld19qb2JzOw0KICBpZiAoY2VsbHNbMl0pIGNlbGxzWzJdLnF1ZXJ5U2VsZWN0b3IoJy5udW0nKS50ZXh0Q29udGVudCA9IHMuc2F2ZWRfam9iczsNCiAgaWYgKGNlbGxzWzNdKSBjZWxsc1szXS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLmFwcGxpZWRfam9iczsNCiAgaWYgKGNlbGxzWzRdKSBjZWxsc1s0XS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLnNraXBwZWRfam9iczsNCiAgaWYgKGNlbGxzWzVdKSBjZWxsc1s1XS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLmlnbm9yZWRfam9icyB8fCAwOw0KICBjb25zdCB0bSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0b3BiYXJNYXRjaGVkJyk7DQogIGNvbnN0IHR0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RvcGJhclRvdGFsJyk7DQogIGlmICh0bSkgdG0udGV4dENvbnRlbnQgPSAocy5tYXRjaGVkX2pvYnMgfHwgcy5uZXdfam9icykgKyAnIG1hdGNoZWQnOw0KICBpZiAodHQpIHR0LnRleHRDb250ZW50ID0gcy50b3RhbF9qb2JzICsgJyB0b3RhbCc7DQp9DQoNCi8vIOKUgOKUgCBKb2JzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KYXN5bmMgZnVuY3Rpb24gbG9hZEpvYnMoKSB7DQogIGNvbnN0IHN0YXR1cyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0dXNGaWx0ZXInKS52YWx1ZTsNCiAgY29uc3QgY29tcGFueSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJykudmFsdWU7DQogIGNvbnN0IHJlZ2lvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZTsNCiAgY29uc3Qgam9iVHlwZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykudmFsdWU7DQogIGNvbnN0IHNvdXJjZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3VyY2VGaWx0ZXInKS52YWx1ZTsNCiAgY29uc3Qgc29ydCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3J0RmlsdGVyJykudmFsdWU7DQogIGNvbnN0IHNlYXJjaCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZWFyY2hJbnB1dCcpLnZhbHVlLnRvTG93ZXJDYXNlKCk7DQoNCiAgbGV0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoeyBzdGF0dXMsIHNvcnQsIGxpbWl0OiA1MDAgfSk7DQogIGlmIChjb21wYW55KSBwYXJhbXMuc2V0KCdjb21wYW55JywgY29tcGFueSk7DQogIGlmIChyZWdpb24pIHBhcmFtcy5zZXQoJ3JlZ2lvbicsIHJlZ2lvbik7DQogIGlmIChqb2JUeXBlKSBwYXJhbXMuc2V0KCdqb2JUeXBlJywgam9iVHlwZSk7DQogIGlmIChzb3VyY2UpIHBhcmFtcy5zZXQoJ3NvdXJjZScsIHNvdXJjZSk7DQogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgJHtBUEl9L2pvYnM/JHtwYXJhbXN9YCk7DQogIGFsbEpvYnMgPSBhd2FpdCByLmpzb24oKTsNCg0KICBpZiAoc2VhcmNoKSB7DQogICAgYWxsSm9icyA9IGFsbEpvYnMuZmlsdGVyKGogPT4NCiAgICAgIChqLnRpdGxlIHx8ICcnKS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHNlYXJjaCkgfHwNCiAgICAgIChqLmNvbXBhbnkgfHwgJycpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKSB8fA0KICAgICAgKGouZGVzY3JpcHRpb24gfHwgJycpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKQ0KICAgICk7DQogIH0NCg0KICByZW5kZXJKb2JzKGFsbEpvYnMpOw0KICBhd2FpdCBsb2FkU3RhdHMoKTsNCiAgdXBkYXRlQ2xlYXJCdXR0b24oKTsNCn0NCg0KZnVuY3Rpb24gdXBkYXRlQ2xlYXJCdXR0b24oKSB7DQogIGNvbnN0IGhhc0ZpbHRlciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJykudmFsdWUgfHwNCiAgICAgICAgICAgICAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlZ2lvbkZpbHRlcicpLnZhbHVlIHx8DQogICAgICAgICAgICAgICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykudmFsdWUgfHwNCiAgICAgICAgICAgICAgICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NlYXJjaElucHV0JykudmFsdWU7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbGVhckZpbHRlcnMnKS5zdHlsZS5kaXNwbGF5ID0gaGFzRmlsdGVyID8gJycgOiAnbm9uZSc7DQp9DQoNCmZ1bmN0aW9uIHJlbmRlckpvYnMoam9icykgew0KICBjb25zdCBxID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlF1ZXVlJyk7DQogIGlmIChqb2JzLmxlbmd0aCA9PT0gMCkgew0KICAgIHEuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9ImVtcHR5LXN0YXRlIj48ZGl2IGNsYXNzPSJpY29uIj7ijpM8L2Rpdj48cD5ObyBqb2JzIGZvdW5kLiBDbGljayAiU2NyYXBlIE5vdyIgdG8gZmV0Y2ggZnJlc2ggbGlzdGluZ3MuPC9wPjwvZGl2Pic7DQogICAgcmV0dXJuOw0KICB9DQogIHEuaW5uZXJIVE1MID0gam9icy5tYXAoKGosIGkpID0+IGpvYlJvdyhqLCBpKSkuam9pbignJyk7DQp9DQoNCmZ1bmN0aW9uIGpvYlJvdyhqb2IsIGluZGV4KSB7DQogIGNvbnN0IHNhbGFyeUJhZGdlID0gam9iLnNhbGFyeSA/IGA8c3BhbiBjbGFzcz0iam9iLXRhZyBzYWxhcnkiPiR7ZXNjYXBlSHRtbChqb2Iuc2FsYXJ5KX08L3NwYW4+YCA6ICcnOw0KICBjb25zdCByZW1vdGVCYWRnZSA9IGpvYi5yZW1vdGUgfHwgam9iLnNvdXJjZSA9PT0gJ1JlbW90ZU9LJyB8fCBqb2Iuc291cmNlID09PSAnUmVtb3RpdmUnIHx8IGpvYi5zb3VyY2UgPT09ICdXZVdvcmtSZW1vdGVseScNCiAgICA/IGA8c3BhbiBjbGFzcz0iam9iLXRhZyByZW1vdGUiPlJlbW90ZTwvc3Bhbj5gIDogJyc7DQogIGNvbnN0IHN0YXR1cyA9IGpvYi5zdGF0dXMgfHwgJ25ldyc7DQogIGNvbnN0IHN0YXR1c0NsYXNzID0gYHN0YXR1cy0ke3N0YXR1c31gOyAvLyBzdGF0dXNDbGFzcyBmb3Igc3RhdHVzLWJhZGdlIGNsYXNzDQogIGNvbnN0IHJvd0NsYXNzID0gc3RhdHVzID09PSAnYXBwbGllZCcgPyAnYXBwbGllZCcgOiBzdGF0dXMgPT09ICdzYXZlZCcgPyAnc2F2ZWQnDQogICAgOiBzdGF0dXMgPT09ICdza2lwcGVkJyA/ICdza2lwcGVkJyA6IHN0YXR1cyA9PT0gJ2lnbm9yZWQnID8gJ2lnbm9yZWQnIDogJyc7DQogIGNvbnN0IHBjdCA9IE1hdGgubWluKDEwMCwgTWF0aC5yb3VuZCgoam9iLnNjb3JlIHx8IDApIC8gMTIwICogMTAwKSk7DQogIGNvbnN0IHNjb3JlQ2xhc3MgPSBwY3QgPj0gNzAgPyAnaGlnaCcgOiBwY3QgPj0gNDAgPyAnbWlkJyA6ICdsb3cnOw0KICBjb25zdCBsb2NhdGlvbiA9IGpvYi5sb2NhdGlvbiB8fCBqb2IucmVnaW9uIHx8ICfigJQnOw0KICBjb25zdCBzb3VyY2VMYWJlbCA9IGpvYi5zb3VyY2UgfHwgJyc7DQoNCiAgbGV0IGFjdGlvbnNIdG1sID0gJyc7DQogIGlmIChzdGF0dXMgPT09ICduZXcnKSB7DQogICAgYWN0aW9uc0h0bWwgPSBgDQogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYWN0aW9uLWxpbmsgdmlldyIgYXJpYS1sYWJlbD0iVmlldyBqb2IgZGV0YWlscyI+VmlldzwvYT4NCiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJvcGVuQXBwbHkoJyR7am9iLmlkfScpIiBjbGFzcz0iYWN0aW9uLWxpbmsgYXBwbHkiIGFyaWEtbGFiZWw9IkFwcGx5IHRvIHRoaXMgam9iIj5BcHBseTwvYT4NCiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdzYXZlZCcpIiBjbGFzcz0iYWN0aW9uLWxpbmsgc2F2ZSIgYXJpYS1sYWJlbD0iU2F2ZSB0aGlzIGpvYiI+U2F2ZTwvYT4NCiAgICAgIGA7DQogIH0gZWxzZSBpZiAoc3RhdHVzID09PSAnYXBwbGllZCcpIHsNCiAgICBhY3Rpb25zSHRtbCA9IGANCiAgICAgICAgPGEgaHJlZj0iJHtlc2NhcGVIdG1sKGpvYi51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJhY3Rpb24tbGluayB2aWV3IiBhcmlhLWxhYmVsPSJWaWV3IGpvYiBkZXRhaWxzIj5WaWV3PC9hPg0KICAgICAgICA8YSBocmVmPSJqYXZhc2NyaXB0OnZvaWQoMCkiIG9uY2xpY2s9Im9wZW5BcHBseSgnJHtqb2IuaWR9JykiIGNsYXNzPSJhY3Rpb24tbGluayBhcHBseSIgYXJpYS1sYWJlbD0iUmUtYXBwbHkgdG8gdGhpcyBqb2IiPkFwcGx5PC9hPg0KICAgICAgICA8YSBocmVmPSJqYXZhc2NyaXB0OnZvaWQoMCkiIG9uY2xpY2s9Im1hcmtBY3Rpb24oJyR7am9iLmlkfScsJ3NraXBwZWQnKSIgY2xhc3M9ImFjdGlvbi1saW5rIHNraXAiIGFyaWEtbGFiZWw9IlJldm9rZSBhcHBsaWNhdGlvbiBhbmQgc2tpcCI+UmV2b2tlPC9hPg0KICAgICAgYDsNCiAgfSBlbHNlIGlmIChzdGF0dXMgPT09ICdzYXZlZCcpIHsNCiAgICBhY3Rpb25zSHRtbCA9IGANCiAgICAgICAgPGEgaHJlZj0iJHtlc2NhcGVIdG1sKGpvYi51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJhY3Rpb24tbGluayB2aWV3IiBhcmlhLWxhYmVsPSJWaWV3IGpvYiBkZXRhaWxzIj5WaWV3PC9hPg0KICAgICAgICA8YSBocmVmPSJqYXZhc2NyaXB0OnZvaWQoMCkiIG9uY2xpY2s9Im9wZW5BcHBseSgnJHtqb2IuaWR9JykiIGNsYXNzPSJhY3Rpb24tbGluayBhcHBseSIgYXJpYS1sYWJlbD0iQXBwbHkgdG8gdGhpcyBqb2IiPkFwcGx5PC9hPg0KICAgICAgICA8YSBocmVmPSJqYXZhc2NyaXB0OnZvaWQoMCkiIG9uY2xpY2s9Im1hcmtBY3Rpb24oJyR7am9iLmlkfScsJ3NraXBwZWQnKSIgY2xhc3M9ImFjdGlvbi1saW5rIHNraXAiIGFyaWEtbGFiZWw9Ik1vdmUgdG8gc2tpcHBlZCI+U2tpcDwvYT4NCiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCdpZ25vcmVkJykiIGNsYXNzPSJhY3Rpb24tbGluayBza2lwIiBhcmlhLWxhYmVsPSJNb3ZlIHRvIGlnbm9yZWQiPklnbm9yZTwvYT4NCiAgICAgIGA7DQogIH0gZWxzZSBpZiAoc3RhdHVzID09PSAnc2tpcHBlZCcpIHsNCiAgICBhY3Rpb25zSHRtbCA9IGANCiAgICAgICAgPGEgaHJlZj0iJHtlc2NhcGVIdG1sKGpvYi51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJhY3Rpb24tbGluayB2aWV3IiBhcmlhLWxhYmVsPSJWaWV3IGpvYiBkZXRhaWxzIj5WaWV3PC9hPg0KICAgICAgICA8YSBocmVmPSJqYXZhc2NyaXB0OnZvaWQoMCkiIG9uY2xpY2s9Im1hcmtBY3Rpb24oJyR7am9iLmlkfScsJ25ldycpIiBjbGFzcz0iYWN0aW9uLWxpbmsgc2F2ZSIgYXJpYS1sYWJlbD0iUmVvcGVuIHRoaXMgam9iIj5SZW9wZW48L2E+DQogICAgICBgOw0KICB9IGVsc2UgaWYgKHN0YXR1cyA9PT0gJ2lnbm9yZWQnKSB7DQogICAgYWN0aW9uc0h0bWwgPSBgDQogICAgICAgIDxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBjbGFzcz0iYWN0aW9uLWxpbmsgdmlldyIgYXJpYS1sYWJlbD0iVmlldyBqb2IgZGV0YWlscyI+VmlldzwvYT4NCiAgICAgICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJtYXJrQWN0aW9uKCcke2pvYi5pZH0nLCduZXcnKSIgY2xhc3M9ImFjdGlvbi1saW5rIHNhdmUiIGFyaWEtbGFiZWw9IlJlb3BlbiB0aGlzIGpvYiI+UmVvcGVuPC9hPg0KICAgICAgYDsNCiAgfQ0KDQogIHJldHVybiBgDQogIDxkaXYgY2xhc3M9ImpvYi1yb3cgJHtyb3dDbGFzc30iIGlkPSJqb2ItJHtqb2IuaWR9Ij4NCiAgICA8ZGl2IGNsYXNzPSJqb2ItaW5mbyI+DQogICAgICA8ZGl2IGNsYXNzPSJqb2ItdGl0bGUiPg0KICAgICAgICAke2VzY2FwZUh0bWwoam9iLnRpdGxlKX0NCiAgICAgICAgPHNwYW4gY2xhc3M9InN0YXR1cy10YWcgJHtzdGF0dXNDbGFzc30iPiR7c3RhdHVzfTwvc3Bhbj4NCiAgICAgIDwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iam9iLWNvbXBhbnkiPiR7ZXNjYXBlSHRtbChqb2IuY29tcGFueSB8fCAnJyl9ICZtaWRkb3Q7ICR7ZXNjYXBlSHRtbChzb3VyY2VMYWJlbCl9PC9kaXY+DQogICAgICA8ZGl2IGNsYXNzPSJqb2ItdGFncyI+JHtyZW1vdGVCYWRnZX0ke3NhbGFyeUJhZGdlfTwvZGl2Pg0KICAgIDwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9ImpvYi1kZXRhaWxzIj4NCiAgICAgIDxkaXYgY2xhc3M9ImxvY2F0aW9uIj4ke2VzY2FwZUh0bWwobG9jYXRpb24pfTwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0ic291cmNlIj4ke2VzY2FwZUh0bWwoc291cmNlTGFiZWwpfTwvZGl2Pg0KICAgIDwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9ImpvYi1zY29yZSI+DQogICAgICA8ZGl2IGNsYXNzPSJzY29yZS1iYXItdHJhY2siPjxkaXYgY2xhc3M9InNjb3JlLWJhci1maWxsICR7c2NvcmVDbGFzc30iIHN0eWxlPSJ3aWR0aDoke3BjdH0lIj48L2Rpdj48L2Rpdj4NCiAgICAgIDxzcGFuIGNsYXNzPSJzY29yZS12YWwiPiR7am9iLnNjb3JlfSBwdHM8L3NwYW4+DQogICAgPC9kaXY+DQogICAgPGRpdiBjbGFzcz0iam9iLWFjdGlvbnMiPiR7YWN0aW9uc0h0bWx9PC9kaXY+DQogIDwvZGl2PmA7DQp9DQoNCi8vIOKUgOKUgCBBY3Rpb25zIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KYXN5bmMgZnVuY3Rpb24gbWFya0FjdGlvbihqb2JJZCwgYWN0aW9uKSB7DQogIGNvbnN0IGVuZHBvaW50TWFwID0geyBhcHBsaWVkOiAnYXBwbHknLCBza2lwcGVkOiAnc2tpcCcsIHNhdmVkOiAnc2F2ZScsIGlnbm9yZWQ6ICdpZ25vcmUnLCBuZXc6ICduZXcnIH07DQogIGNvbnN0IGVuZHBvaW50ID0gZW5kcG9pbnRNYXBbYWN0aW9uXSB8fCBhY3Rpb247DQogIGxldCBwYXlsb2FkID0geyBqb2JJZCB9Ow0KICBpZiAoYWN0aW9uID09PSAnc2tpcHBlZCcgfHwgYWN0aW9uID09PSAnaWdub3JlZCcpIHsNCiAgICBjb25zdCBqb2IgPSBhbGxKb2JzLmZpbmQoaiA9PiBqLmlkID09PSBqb2JJZCk7DQogICAgaWYgKGpvYiAmJiBqb2IudGl0bGUpIHBheWxvYWQudGl0bGUgPSBqb2IudGl0bGU7DQogIH0NCiAgdHJ5IHsNCiAgICBjb25zdCByZXNwID0gYXdhaXQgZmV0Y2goYCR7QVBJfS8ke2VuZHBvaW50fWAsIHsNCiAgICAgIG1ldGhvZDogJ1BPU1QnLA0KICAgICAgaGVhZGVyczogeyAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sDQogICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShwYXlsb2FkKQ0KICAgIH0pOw0KICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXNwLnRleHQoKTsNCiAgICBpZiAoIXJlc3Aub2spIHRocm93IG5ldyBFcnJvcignSFRUUCAnICsgcmVzcC5zdGF0dXMgKyAnOiAnICsgdGV4dCk7DQogICAgSlNPTi5wYXJzZSh0ZXh0KTsNCiAgICB0b2FzdChgJHthY3Rpb24uY2hhckF0KDApLnRvVXBwZXJDYXNlKCkgKyBhY3Rpb24uc2xpY2UoMSl9ZCBqb2JgKTsNCiAgICBhd2FpdCBsb2FkSm9icygpOw0KICB9IGNhdGNoIChlcnIpIHsNCiAgICB0b2FzdCgnRXJyb3I6ICcgKyBlcnIubWVzc2FnZSk7DQogIH0NCn0NCg0KLy8g4pSA4pSAIEFwcGx5IE1vZGFsIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgA0KZnVuY3Rpb24gb3BlbkFwcGx5KGpvYklkKSB7DQogIGN1cnJlbnRKb2JJZCA9IGpvYklkOw0KICBjb25zdCBqb2IgPSBhbGxKb2JzLmZpbmQoaiA9PiBqLmlkID09PSBqb2JJZCk7DQogIGlmICgham9iKSByZXR1cm47DQogIGNvbnN0IHAgPSB3aW5kb3cuX3Byb2ZpbGUgfHwge307DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHBseUNvbnRlbnQnKS5pbm5lckhUTUwgPSBgDQogICAgPGRpdiBzdHlsZT0icGFkZGluZzoxLjVyZW0iPg0KICAgICAgPGgzIHN0eWxlPSJmb250LXNpemU6MTRweDtmb250LXdlaWdodDo2MDA7bWFyZ2luLWJvdHRvbTouMjVyZW0iPiR7ZXNjYXBlSHRtbChqb2IudGl0bGUpfSBAICR7ZXNjYXBlSHRtbChqb2IuY29tcGFueSl9PC9oMz4NCiAgICAgIDxwIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luOi41cmVtIDA7Zm9udC1zaXplOjEzcHgiPiR7ZXNjYXBlSHRtbChqb2IuZGVzY3JpcHRpb24/LnNsaWNlKDAsIDIwMCkpIHx8ICdObyBkZXNjcmlwdGlvbiBhdmFpbGFibGUuJ308L3A+DQogICAgICA8cCBzdHlsZT0ibWFyZ2luOi41cmVtIDA7Zm9udC1zaXplOjEzcHgiPjxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBzdHlsZT0iY29sb3I6dmFyKC0tYWNjZW50KSI+VmlldyBmdWxsIGpvYiBsaXN0aW5nIOKGkjwvYT48L3A+DQogICAgICA8aDQgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0OjUwMDtsZXR0ZXItc3BhY2luZzouMDZlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Y29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbjoxcmVtIDAgLjVyZW0iPkFwcGxpY2F0aW9uIENoZWNrbGlzdDo8L2g0Pg0KICAgICAgPHVsIGNsYXNzPSJhcHBseS1jaGVja2xpc3QiPg0KICAgICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBOYW1lOiA8c3BhbiBjbGFzcz0idmFsIj4ke2VzY2FwZUh0bWwocC5uYW1lIHx8ICfigJQnKX08L3NwYW4+PC9saT4NCiAgICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gRW1haWw6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLmVtYWlsIHx8ICfigJQnKX08L3NwYW4+PC9saT4NCiAgICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gUGhvbmU6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7ZXNjYXBlSHRtbChwLnBob25lIHx8ICfigJQnKX08L3NwYW4+PC9saT4NCiAgICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gUmVzdW1lOiA8c3BhbiBjbGFzcz0idmFsIj4ke2VzY2FwZUh0bWwocC5yZXN1bWVfcGF0aCB8fCAnbm90IHNldCcpfTwvc3Bhbj48L2xpPg0KICAgICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBDb3ZlciBsZXR0ZXI6IDxzcGFuIGNsYXNzPSJ2YWwiPiR7am9iLmNvdmVyX2xldHRlciA/ICfinJMgR2VuZXJhdGVkJyA6ICdSdW4gd2l0aCBBTlRIUk9QSUNfQVBJX0tFWSd9PC9zcGFuPjwvbGk+DQogICAgICA8L3VsPg0KICAgIDwvZGl2Pg0KICBgOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlVcmxCdG4nKS5ocmVmID0gam9iLnVybDsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21hcmtBcHBsaWVkQnRuJykub25jbGljayA9IGFzeW5jICgpID0+IHsNCiAgICBhd2FpdCBtYXJrQWN0aW9uKGpvYklkLCAnYXBwbGllZCcpOw0KICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHBseU1vZGFsJykuc3R5bGUuZGlzcGxheSA9ICdub25lJzsNCiAgICB0b2FzdCgnTWFya2VkIGFzIGFwcGxpZWQhJyk7DQogIH07DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHBseU1vZGFsJykuc3R5bGUuZGlzcGxheSA9ICdmbGV4JzsNCn0NCg0KLy8g4pSA4pSAIFByb2ZpbGUgTW9kYWwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJvZmlsZUJ0bicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7DQogIGNvbnN0IHAgPSBhd2FpdCAoYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCkpLmpzb24oKTsNCiAgd2luZG93Ll9wcm9maWxlID0gcDsNCiAgT2JqZWN0LmtleXMocCkuZm9yRWFjaChrID0+IHsNCiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwXycgKyBrKTsNCiAgICBpZiAoZWwpIGVsLnZhbHVlID0gQXJyYXkuaXNBcnJheShwW2tdKSA/IHBba10uam9pbignLCAnKSA6IChwW2tdIHx8ICcnKTsNCiAgfSk7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ2ZsZXgnOw0KfTsNCg0KZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVGb3JtJykub25zdWJtaXQgPSBhc3luYyAoZSkgPT4gew0KICBlLnByZXZlbnREZWZhdWx0KCk7DQogIGNvbnN0IGZkID0gbmV3IEZvcm1EYXRhKGUudGFyZ2V0KTsNCiAgY29uc3QgcCA9IHt9Ow0KICBmZC5mb3JFYWNoKCh2LCBrKSA9PiB7IHBba10gPSB2OyB9KTsNCiAgZm9yIChjb25zdCBrZXkgb2YgWydza2lsbHMnLCAndGFyZ2V0X3RpdGxlcycsICdyZXF1aXJlZF9rZXl3b3JkcycsICdib251c19rZXl3b3JkcycsICdkZWFsX2JyZWFrZXJzJywgJ3ByZWZlcnJlZF93b3JrX3R5cGUnLCAncHJlZmVycmVkX2xvY2F0aW9ucycsICdwcmVmZXJyZWRfZW1wbG95bWVudCddKSB7DQogICAgcFtrZXldID0gKHBba2V5XSB8fCAnJykuc3BsaXQoJywnKS5tYXAocyA9PiBzLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pOw0KICB9DQogIHAuZXhwZXJpZW5jZV95ZWFycyA9IHBhcnNlSW50KHAuZXhwZXJpZW5jZV95ZWFycykgfHwgMDsNCiAgcC5zYWxhcnlfbWluX2xha2hzID0gcGFyc2VGbG9hdChwLnNhbGFyeV9taW5fbGFraHMpIHx8IDM1Ow0KICBwLnRhcmdldF9zYWxhcnkgPSB7IGN1cnJlbmN5OiBwLnNhbGFyeV9jdXJyZW5jeSB8fCAnSU5SJywgbWluX2xha2hzOiBwLnNhbGFyeV9taW5fbGFraHMgfTsNCiAgYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCwgeyBtZXRob2Q6ICdQVVQnLCBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwgYm9keTogSlNPTi5zdHJpbmdpZnkocCkgfSk7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOw0KICB0b2FzdCgnUHJvZmlsZSBzYXZlZCEnKTsNCiAgbG9hZFByb2ZpbGUoKTsNCn07DQoNCi8vIOKUgOKUgCBFdmVudHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSADQpmdW5jdGlvbiBiaW5kRXZlbnRzKCkgew0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NyYXBlQnRuJykub25jbGljayA9IGFzeW5jICgpID0+IHsNCiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NyYXBlQnRuJykuZGlzYWJsZWQgPSB0cnVlOw0KICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS50ZXh0Q29udGVudCA9ICdTY3JhcGluZy4uLic7DQogICAgYXdhaXQgZmV0Y2goYCR7QVBJfS9zY3JhcGVgLCB7IG1ldGhvZDogJ1BPU1QnIH0pOw0KICAgIHNldFRpbWVvdXQoKCkgPT4gew0KICAgICAgbG9hZEpvYnMoKTsNCiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS5kaXNhYmxlZCA9IGZhbHNlOw0KICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjcmFwZUJ0bicpLnRleHRDb250ZW50ID0gJ1NjcmFwZSBOb3cnOw0KICAgIH0sIDIwMDApOw0KICB9Ow0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xlYXJGaWx0ZXJzJykub25jbGljayA9ICgpID0+IHsNCiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY29tcGFueUZpbHRlcicpLnZhbHVlID0gJyc7DQogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlZ2lvbkZpbHRlcicpLnZhbHVlID0gJyc7DQogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlR5cGVGaWx0ZXInKS52YWx1ZSA9ICcnOw0KICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZWFyY2hJbnB1dCcpLnZhbHVlID0gJyc7DQogICAgbG9hZEpvYnMoKTsNCiAgfTsNCg0KICBmdW5jdGlvbiBvbkZpbHRlckNoYW5nZSgpIHsgbG9hZEpvYnMoKTsgdXBkYXRlQ2xlYXJCdXR0b24oKTsgfQ0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RhdHVzRmlsdGVyJykub25jaGFuZ2UgPSBsb2FkSm9iczsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKS5vbmNoYW5nZSA9IG9uRmlsdGVyQ2hhbmdlOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVnaW9uRmlsdGVyJykub25jaGFuZ2UgPSBvbkZpbHRlckNoYW5nZTsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlR5cGVGaWx0ZXInKS5vbmNoYW5nZSA9IG9uRmlsdGVyQ2hhbmdlOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc291cmNlRmlsdGVyJykub25jaGFuZ2UgPSBsb2FkSm9iczsNCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NvcnRGaWx0ZXInKS5vbmNoYW5nZSA9IGxvYWRKb2JzOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2VhcmNoSW5wdXQnKS5vbmlucHV0ID0gKCkgPT4gew0KICAgIGNsZWFyVGltZW91dCh3aW5kb3cuX3NlYXJjaFRpbWVyKTsNCiAgICB3aW5kb3cuX3NlYXJjaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IGxvYWRKb2JzKCk7IHVwZGF0ZUNsZWFyQnV0dG9uKCk7IH0sIDMwMCk7DQogIH07DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbG9zZVByb2ZpbGVCdG4nKS5vbmNsaWNrID0gKCkgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7DQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjYW5jZWxQcm9maWxlQnRuJykub25jbGljayA9ICgpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOw0KICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xvc2VBcHBseUJ0bicpLm9uY2xpY2sgPSAoKSA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7DQp9DQoNCi8vIOKUgOKUgCBVdGlscyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIANCmZ1bmN0aW9uIHRvYXN0KG1zZykgew0KICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0b2FzdCcpOw0KICBlbC50ZXh0Q29udGVudCA9IG1zZzsgZWwuc3R5bGUuZGlzcGxheSA9ICdibG9jayc7DQogIHNldFRpbWVvdXQoKCkgPT4gZWwuc3R5bGUuZGlzcGxheSA9ICdub25lJywgMjUwMCk7DQp9DQoNCmZ1bmN0aW9uIGVzY2FwZUh0bWwocykgew0KICBpZiAoIXMpIHJldHVybiAnJzsNCiAgcmV0dXJuIFN0cmluZyhzKS5yZXBsYWNlKC8mL2csJyZhbXA7JykucmVwbGFjZSgvPC9nLCcmbHQ7JykucmVwbGFjZSgvPi9nLCcmZ3Q7JykucmVwbGFjZSgvIi9nLCcmcXVvdDsnKTsNCn0NCg0Kd2luZG93Lm1hcmtBY3Rpb24gPSBtYXJrQWN0aW9uOw0Kd2luZG93Lm9wZW5BcHBseSA9IG9wZW5BcHBseTsNCg==';

const DASHBOARD_HTML_B64 = 'PCFET0NUWVBFIGh0bWw+DQo8aHRtbCBsYW5nPSJlbiI+DQo8aGVhZD4NCiAgPG1ldGEgY2hhcnNldD0iVVRGLTgiLz4NCiAgPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAiLz4NCiAgPHRpdGxlPkpvYiBBZ2VudDwvdGl0bGU+DQogIDxsaW5rIHJlbD0ic3R5bGVzaGVldCIgaHJlZj0iL3N0eWxlcy5jc3M/dD1fX1NUWUxFU19WRVJTSU9OX18iLz4NCjwvaGVhZD4NCjxib2R5Pg0KICA8IS0tIFRvcCBCYXIgLS0+DQogIDxoZWFkZXIgY2xhc3M9InRvcGJhciI+DQogICAgPGRpdiBjbGFzcz0idG9wYmFyLWJyYW5kIj4NCiAgICAgIDxoMT5Kb2IgQWdlbnQ8L2gxPg0KICAgICAgPGRpdiBjbGFzcz0idG9wYmFyLW1ldGEiPg0KICAgICAgICA8c3BhbiBjbGFzcz0ibGl2ZS1kb3QiPjwvc3Bhbj4NCiAgICAgICAgPHNwYW4gaWQ9InRvcGJhck1hdGNoZWQiPuKAlCBtYXRjaGVkPC9zcGFuPg0KICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+DQogICAgICAgIDxzcGFuIGlkPSJ0b3BiYXJUb3RhbCI+4oCUIHRvdGFsPC9zcGFuPg0KICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+DQogICAgICAgIDxzcGFuIGlkPSJ1dGNUaW1lIj4tLTotLSBVVEM8L3NwYW4+DQogICAgICA8L2Rpdj4NCiAgICA8L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJ0b3BiYXItYWN0aW9ucyI+DQogICAgICA8YnV0dG9uIGlkPSJzY3JhcGVCdG4iIGNsYXNzPSJidG4gYnRuLXByaW1hcnkiPlNjcmFwZSBOb3c8L2J1dHRvbj4NCiAgICAgIDxidXR0b24gaWQ9InByb2ZpbGVCdG4iIGNsYXNzPSJidG4gYnRuLWdob3N0Ij5Qcm9maWxlPC9idXR0b24+DQogICAgPC9kaXY+DQogIDwvaGVhZGVyPg0KDQogIDwhLS0gU3RhdCBTdHJpcCAtLT4NCiAgPGRpdiBjbGFzcz0ic3RhdC1zdHJpcCI+DQogICAgPGRpdiBjbGFzcz0ic3RhdC1jZWxsIj48c3BhbiBjbGFzcz0ibnVtIj7igJQ8L3NwYW4+PHNwYW4gY2xhc3M9ImxhYmVsIj50b3RhbCBqb2JzPC9zcGFuPjwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9InN0YXQtY2VsbCI+PHNwYW4gY2xhc3M9Im51bSBhY2NlbnQiPuKAlDwvc3Bhbj48c3BhbiBjbGFzcz0ibGFiZWwiPm5ldzwvc3Bhbj48L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJzdGF0LWNlbGwiPjxzcGFuIGNsYXNzPSJudW0gYW1iZXIiPuKAlDwvc3Bhbj48c3BhbiBjbGFzcz0ibGFiZWwiPnNhdmVkPC9zcGFuPjwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9InN0YXQtY2VsbCI+PHNwYW4gY2xhc3M9Im51bSBncmVlbiI+4oCUPC9zcGFuPjxzcGFuIGNsYXNzPSJsYWJlbCI+YXBwbGllZDwvc3Bhbj48L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJzdGF0LWNlbGwiPjxzcGFuIGNsYXNzPSJudW0gcmVkIj7igJQ8L3NwYW4+PHNwYW4gY2xhc3M9ImxhYmVsIj5za2lwcGVkPC9zcGFuPjwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9InN0YXQtY2VsbCI+PHNwYW4gY2xhc3M9Im51bSIgc3R5bGU9ImNvbG9yOnZhcigtLW11dGVkKSI+4oCUPC9zcGFuPjxzcGFuIGNsYXNzPSJsYWJlbCI+aWdub3JlZDwvc3Bhbj48L2Rpdj4NCiAgPC9kaXY+DQoNCiAgPCEtLSBGaWx0ZXIgQmFyIC0tPg0KICA8ZGl2IGNsYXNzPSJmaWx0ZXItYmFyIj4NCiAgICA8c2VsZWN0IGlkPSJzdGF0dXNGaWx0ZXIiIHRpdGxlPSJGaWx0ZXIgYnkgc3RhdHVzIiBhcmlhLWxhYmVsPSJGaWx0ZXIgYnkgc3RhdHVzIj4NCiAgICAgIDxvcHRpb24gdmFsdWU9Im5ldyI+TmV3IEpvYnM8L29wdGlvbj4NCiAgICAgIDxvcHRpb24gdmFsdWU9InNhdmVkIj5TYXZlZDwvb3B0aW9uPg0KICAgICAgPG9wdGlvbiB2YWx1ZT0iYXBwbGllZCI+QXBwbGllZDwvb3B0aW9uPg0KICAgICAgPG9wdGlvbiB2YWx1ZT0ic2tpcHBlZCI+U2tpcHBlZDwvb3B0aW9uPg0KICAgICAgPG9wdGlvbiB2YWx1ZT0iaWdub3JlZCI+SWdub3JlZDwvb3B0aW9uPg0KICAgIDwvc2VsZWN0Pg0KICAgIDxzZWxlY3QgaWQ9ImNvbXBhbnlGaWx0ZXIiIHRpdGxlPSJGaWx0ZXIgYnkgY29tcGFueSIgYXJpYS1sYWJlbD0iRmlsdGVyIGJ5IGNvbXBhbnkiPg0KICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgQ29tcGFuaWVzPC9vcHRpb24+DQogICAgPC9zZWxlY3Q+DQogICAgPHNlbGVjdCBpZD0icmVnaW9uRmlsdGVyIiB0aXRsZT0iRmlsdGVyIGJ5IHJlZ2lvbiIgYXJpYS1sYWJlbD0iRmlsdGVyIGJ5IHJlZ2lvbiI+DQogICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBSZWdpb25zPC9vcHRpb24+DQogICAgICA8b3B0aW9uIHZhbHVlPSJpbmRpYSI+SW5kaWE8L29wdGlvbj4NCiAgICAgIDxvcHRpb24gdmFsdWU9InJlbW90ZSI+UmVtb3RlPC9vcHRpb24+DQogICAgICA8b3B0aW9uIHZhbHVlPSJ1c2EiPlVTQTwvb3B0aW9uPg0KICAgICAgPG9wdGlvbiB2YWx1ZT0iZXVyb3BlIj5FdXJvcGU8L29wdGlvbj4NCiAgICAgIDxvcHRpb24gdmFsdWU9ImFzaWEtcGFjaWZpYyI+QXNpYS1QYWNpZmljPC9vcHRpb24+DQogICAgPC9zZWxlY3Q+DQogICAgPHNlbGVjdCBpZD0iam9iVHlwZUZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBqb2IgdHlwZSIgYXJpYS1sYWJlbD0iRmlsdGVyIGJ5IGpvYiB0eXBlIj4NCiAgICAgIDxvcHRpb24gdmFsdWU9IiI+QWxsIFR5cGVzPC9vcHRpb24+DQogICAgICA8b3B0aW9uIHZhbHVlPSJyZW1vdGUiPlJlbW90ZSBPbmx5PC9vcHRpb24+DQogICAgICA8b3B0aW9uIHZhbHVlPSJvbnNpdGUiPk9uLXNpdGUgT25seTwvb3B0aW9uPg0KICAgIDwvc2VsZWN0Pg0KICAgIDxzZWxlY3QgaWQ9InNvdXJjZUZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBzb3VyY2UiIGFyaWEtbGFiZWw9IkZpbHRlciBieSBzb3VyY2UiPg0KICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgU291cmNlczwvb3B0aW9uPg0KICAgIDwvc2VsZWN0Pg0KICAgIDxzZWxlY3QgaWQ9InNvcnRGaWx0ZXIiIHRpdGxlPSJTb3J0IGJ5IiBhcmlhLWxhYmVsPSJTb3J0IGJ5Ij4NCiAgICAgIDxvcHRpb24gdmFsdWU9InNjb3JlIj5TY29yZSAoZGVzYyk8L29wdGlvbj4NCiAgICAgIDxvcHRpb24gdmFsdWU9InBvc3RlZCI+TmV3ZXN0PC9vcHRpb24+DQogICAgPC9zZWxlY3Q+DQogICAgPGRpdiBjbGFzcz0ic3BhY2VyIj48L2Rpdj4NCiAgICA8aW5wdXQgaWQ9InNlYXJjaElucHV0IiB0eXBlPSJ0ZXh0IiBwbGFjZWhvbGRlcj0iU2VhcmNoIHRpdGxlLCBjb21wYW55Li4uIi8+DQogICAgPGJ1dHRvbiBpZD0iY2xlYXJGaWx0ZXJzIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCIgc3R5bGU9ImRpc3BsYXk6bm9uZSI+Q2xlYXI8L2J1dHRvbj4NCiAgPC9kaXY+DQoNCiAgPCEtLSBKb2IgTGlzdCBIZWFkZXIgLS0+DQogIDxkaXYgY2xhc3M9Imxpc3QtaGVhZGVyIj4NCiAgICA8c3Bhbj5Kb2I8L3NwYW4+DQogICAgPHNwYW4+RGV0YWlsczwvc3Bhbj4NCiAgICA8c3Bhbj5TY29yZTwvc3Bhbj4NCiAgICA8c3Bhbj5BY3Rpb25zPC9zcGFuPg0KICA8L2Rpdj4NCg0KICA8IS0tIEpvYiBMaXN0IC0tPg0KICA8ZGl2IGNsYXNzPSJqb2ItbGlzdCIgaWQ9ImpvYlF1ZXVlIj4NCiAgICA8ZGl2IGNsYXNzPSJlbXB0eS1zdGF0ZSI+PHA+TG9hZGluZyBqb2JzLi4uPC9wPjwvZGl2Pg0KICA8L2Rpdj4NCg0KICA8IS0tIFByb2ZpbGUgTW9kYWwgLS0+DQogIDxkaXYgaWQ9InByb2ZpbGVNb2RhbCIgY2xhc3M9Im1vZGFsIiBzdHlsZT0iZGlzcGxheTpub25lIiByb2xlPSJkaWFsb2ciIGFyaWEtbW9kYWw9InRydWUiIGFyaWEtbGFiZWw9IkVkaXQgcHJvZmlsZSI+DQogICAgPGRpdiBjbGFzcz0ibW9kYWwtY29udGVudCI+DQogICAgICA8ZGl2IGNsYXNzPSJtb2RhbC1oZWFkZXIiPg0KICAgICAgICA8aDI+RWRpdCBwcm9maWxlPC9oMj4NCiAgICAgICAgPGJ1dHRvbiBpZD0iY2xvc2VQcm9maWxlQnRuIiBjbGFzcz0iY2xvc2UiIGFyaWEtbGFiZWw9IkNsb3NlIGRpYWxvZyI+JnRpbWVzOzwvYnV0dG9uPg0KICAgICAgPC9kaXY+DQogICAgICA8Zm9ybSBpZD0icHJvZmlsZUZvcm0iPg0KICAgICAgICA8ZGl2IGNsYXNzPSJmb3JtLWdyaWQiPg0KICAgICAgICAgIDxsYWJlbD5OYW1lPGlucHV0IGlkPSJwX25hbWUiIG5hbWU9Im5hbWUiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5FbWFpbDxpbnB1dCBpZD0icF9lbWFpbCIgbmFtZT0iZW1haWwiIHR5cGU9ImVtYWlsIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+UGhvbmU8aW5wdXQgaWQ9InBfcGhvbmUiIG5hbWU9InBob25lIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+TGlua2VkSW48aW5wdXQgaWQ9InBfbGlua2VkaW4iIG5hbWU9ImxpbmtlZGluIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+TG9jYXRpb248aW5wdXQgaWQ9InBfbG9jYXRpb24iIG5hbWU9ImxvY2F0aW9uIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+UmVzdW1lIFBhdGg8aW5wdXQgaWQ9InBfcmVzdW1lX3BhdGgiIG5hbWU9InJlc3VtZV9wYXRoIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+RXhwZXJpZW5jZSAoeWVhcnMpPGlucHV0IGlkPSJwX2V4cCIgbmFtZT0iZXhwZXJpZW5jZV95ZWFycyIgdHlwZT0ibnVtYmVyIi8+PC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+Q3VycmVudCBSb2xlPGlucHV0IGlkPSJwX3JvbGUiIG5hbWU9ImN1cnJlbnRfcm9sZSIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPkN1cnJlbnQgQ29tcGFueTxpbnB1dCBpZD0icF9jb21wYW55IiBuYW1lPSJjdXJyZW50X2NvbXBhbnkiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5Ta2lsbHMgKGNvbW1hLXNlcGFyYXRlZCk8aW5wdXQgaWQ9InBfc2tpbGxzIiBuYW1lPSJza2lsbHMiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5UYXJnZXQgVGl0bGVzIChjb21tYS1zZXBhcmF0ZWQpPGlucHV0IGlkPSJwX3RpdGxlcyIgbmFtZT0idGFyZ2V0X3RpdGxlcyIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPlJlcXVpcmVkIEtleXdvcmRzPGlucHV0IGlkPSJwX3JlcV9rdyIgbmFtZT0icmVxdWlyZWRfa2V5d29yZHMiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5Cb251cyBLZXl3b3JkczxpbnB1dCBpZD0icF9ib251c19rdyIgbmFtZT0iYm9udXNfa2V5d29yZHMiLz48L2xhYmVsPg0KICAgICAgICAgIDxsYWJlbD5NaW4gU2FsYXJ5IChMYWtocyBJTlIpPGlucHV0IGlkPSJwX21pbl9zYWxhcnkiIG5hbWU9InNhbGFyeV9taW5fbGFraHMiIHR5cGU9Im51bWJlciIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPkN1cnJlbmN5DQogICAgICAgICAgICA8c2VsZWN0IGlkPSJwX2N1cnJlbmN5IiBuYW1lPSJzYWxhcnlfY3VycmVuY3kiPg0KICAgICAgICAgICAgICA8b3B0aW9uPklOUjwvb3B0aW9uPjxvcHRpb24+VVNEPC9vcHRpb24+PG9wdGlvbj5FVVI8L29wdGlvbj48b3B0aW9uPkdCUDwvb3B0aW9uPg0KICAgICAgICAgICAgPC9zZWxlY3Q+DQogICAgICAgICAgPC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+V29yayBUeXBlDQogICAgICAgICAgICA8c2VsZWN0IGlkPSJwX3dvcmtfdHlwZSIgbmFtZT0id29ya190eXBlIiBtdWx0aXBsZSBzaXplPSIzIj4NCiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icmVtb3RlIj5SZW1vdGU8L29wdGlvbj4NCiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iaHlicmlkIj5IeWJyaWQ8L29wdGlvbj4NCiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ib24tc2l0ZSI+T24tc2l0ZTwvb3B0aW9uPg0KICAgICAgICAgICAgPC9zZWxlY3Q+DQogICAgICAgICAgPC9sYWJlbD4NCiAgICAgICAgICA8bGFiZWw+UHJlZmVycmVkIExvY2F0aW9uczxpbnB1dCBpZD0icF9sb2NhdGlvbnMiIG5hbWU9ImxvY2F0aW9ucyIvPjwvbGFiZWw+DQogICAgICAgICAgPGxhYmVsPlN1bW1hcnk8dGV4dGFyZWEgaWQ9InBfc3VtbWFyeSIgbmFtZT0ic3VtbWFyeSIgcm93cz0iMyI+PC90ZXh0YXJlYT48L2xhYmVsPg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtYWN0aW9ucyI+DQogICAgICAgICAgPGJ1dHRvbiB0eXBlPSJzdWJtaXQiIGNsYXNzPSJidG4gYnRuLXByaW1hcnkiPlNhdmUgUHJvZmlsZTwvYnV0dG9uPg0KICAgICAgICAgIDxidXR0b24gdHlwZT0iYnV0dG9uIiBpZD0iY2FuY2VsUHJvZmlsZUJ0biIgY2xhc3M9ImJ0biBidG4tZ2hvc3QiPkNhbmNlbDwvYnV0dG9uPg0KICAgICAgICA8L2Rpdj4NCiAgICAgIDwvZm9ybT4NCiAgICA8L2Rpdj4NCiAgPC9kaXY+DQoNCiAgPCEtLSBBcHBseSBNb2RhbCAtLT4NCiAgPGRpdiBpZD0iYXBwbHlNb2RhbCIgY2xhc3M9Im1vZGFsIiBzdHlsZT0iZGlzcGxheTpub25lIiByb2xlPSJkaWFsb2ciIGFyaWEtbW9kYWw9InRydWUiIGFyaWEtbGFiZWw9IlByZXBhcmUgYXBwbGljYXRpb24iPg0KICAgIDxkaXYgY2xhc3M9Im1vZGFsLWNvbnRlbnQiPg0KICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtaGVhZGVyIj4NCiAgICAgICAgPGgyPlByZXBhcmUgYXBwbGljYXRpb248L2gyPg0KICAgICAgICA8YnV0dG9uIGlkPSJjbG9zZUFwcGx5QnRuIiBjbGFzcz0iY2xvc2UiIGFyaWEtbGFiZWw9IkNsb3NlIGRpYWxvZyI+JnRpbWVzOzwvYnV0dG9uPg0KICAgICAgPC9kaXY+DQogICAgICA8ZGl2IGlkPSJhcHBseUNvbnRlbnQiPjwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtYWN0aW9ucyI+DQogICAgICAgIDxhIGlkPSJhcHBseVVybEJ0biIgaHJlZj0iIyIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJidG4gYnRuLWdob3N0Ij5PcGVuIEpvYiBQYWdlPC9hPg0KICAgICAgICA8YnV0dG9uIGlkPSJtYXJrQXBwbGllZEJ0biIgY2xhc3M9ImJ0biBidG4tcHJpbWFyeSIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tZ3JlZW4pIj5NYXJrIGFzIEFwcGxpZWQ8L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KICAgIDwvZGl2Pg0KICA8L2Rpdj4NCg0KICA8ZGl2IGlkPSJ0b2FzdCIgY2xhc3M9InRvYXN0Ij48L2Rpdj4NCiAgPHNjcmlwdCBzcmM9Ii9hcHAuanM/dD1fX1RJTUVTVEFNUF9fIj48L3NjcmlwdD4NCjwvYm9keT4NCjwvaHRtbD4NCg==';

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
