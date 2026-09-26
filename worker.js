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
const STYLES_CSS_B64 = 'LyogTWlzc2lvbiBDb250cm9sIERhc2hib2FyZCAqLwpAaW1wb3J0IHVybCgnaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbS9jc3MyP2ZhbWlseT1HZWlzdDp3Z2h0QDQwMDs1MDA7NjAwOzcwMCZmYW1pbHk9SmV0QnJhaW5zK01vbm86d2dodEA0MDA7NTAwOzYwMCZkaXNwbGF5PXN3YXAnKTsKCjpyb290IHsKICAtLWJnOiAjMDgwOTBEOwogIC0tc3VyZmFjZTogIzExMTMxODsKICAtLXN1cmZhY2UyOiAjMUExRDI3OwogIC0tYm9yZGVyOiAjMUYyOTM3OwogIC0tYm9yZGVyLXN1YnRsZTogIzI1MkMzQjsKICAtLXRleHQ6ICNFNUU3RUI7CiAgLS1tdXRlZDogIzcyNzk4NjsKICAtLW11dGVkLWRpbTogIzVCNjM3MDsKICAtLWFjY2VudDogIzAwRDRGRjsKICAtLWFjY2VudC1kaW06IHJnYmEoMCwgMjEyLCAyNTUsIDAuMTIpOwogIC0tZ3JlZW46ICMxMEI5ODE7CiAgLS1ncmVlbi1kaW06IHJnYmEoMTYsIDE4NSwgMTI5LCAwLjEyKTsKICAtLWFtYmVyOiAjRjU5RTBCOwogIC0tYW1iZXItZGltOiByZ2JhKDI0NSwgMTU4LCAxMSwgMC4xMik7CiAgLS1yZWQ6ICNFRjQ0NDQ7CiAgLS1yZWQtZGltOiByZ2JhKDIzOSwgNjgsIDY4LCAwLjEyKTsKfQoKKiB7IGJveC1zaXppbmc6IGJvcmRlci1ib3g7IG1hcmdpbjogMDsgcGFkZGluZzogMDsgfQoKLyogR2xvYmFsIGZvY3VzLXZpc2libGUgZm9yIGtleWJvYXJkIG5hdmlnYXRpb24gKi8KKjpmb2N1cy12aXNpYmxlIHsKICBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tYWNjZW50KTsKICBvdXRsaW5lLW9mZnNldDogMnB4OwogIGJvcmRlci1yYWRpdXM6IDJweDsKfQpidXR0b246Zm9jdXMtdmlzaWJsZSwgYTpmb2N1cy12aXNpYmxlIHsKICBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tYWNjZW50KTsKICBvdXRsaW5lLW9mZnNldDogMnB4Owp9Cgpib2R5IHsKICBmb250LWZhbWlseTogJ0dlaXN0JywgJ0ludGVyJywgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBzYW5zLXNlcmlmOwogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgbWluLWhlaWdodDogMTAwdmg7CiAgZm9udC1zaXplOiAxNHB4OwogIGxpbmUtaGVpZ2h0OiAxLjU7CiAgZm9udC12YXJpYW50LW51bWVyaWM6IHRhYnVsYXItbnVtczsKfQoKYm9keTo6YmVmb3JlIHsKICBjb250ZW50OiAnJzsKICBwb3NpdGlvbjogZml4ZWQ7CiAgaW5zZXQ6IDA7CiAgcG9pbnRlci1ldmVudHM6IG5vbmU7CiAgYmFja2dyb3VuZC1pbWFnZTogdXJsKCJkYXRhOmltYWdlL3N2Zyt4bWwsJTNDc3ZnIHZpZXdCb3g9JzAgMCAyMDAgMjAwJyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnJTNFJTNDZmlsdGVyIGlkPSdub2lzZUZpbHRlciclM0UlM0NmZVR1cmJ1bGVuY2UgdHlwZT0nZnJhY3RhbE5vaXNlJyBiYXNlRnJlcXVlbmN5PScwLjY1JyBudW1PY3RhdmVzPSczJyBzdGl0Y2hUaWxlcz0nc3RpdGNoJy8lM0UlM0MvZmlsdGVyJTNFJTNDcmVjdCB3aWR0aD0nMTAwJScgaGVpZ2h0PScxMDAlJyBmaWx0ZXI9J3VybCglMjNub2lzZUZpbHRlciknLyUzRSUzQy9zdmclM0UiKTsKICBvcGFjaXR5OiAwLjAzOwogIHotaW5kZXg6IDE7Cn0KCi8qIOKUgOKUgCBUb3AgQmFyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwoudG9wYmFyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuOwogIHBhZGRpbmc6IDAgMnJlbTsKICBoZWlnaHQ6IDUycHg7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgcG9zaXRpb246IHN0aWNreTsKICB0b3A6IDA7CiAgei1pbmRleDogMTA7Cn0KCi50b3BiYXItYnJhbmQgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGJhc2VsaW5lOwogIGdhcDogLjc1cmVtOwp9CgoudG9wYmFyLWJyYW5kIGgxIHsKICBmb250LXNpemU6IDEzcHg7CiAgZm9udC13ZWlnaHQ6IDcwMDsKICBsZXR0ZXItc3BhY2luZzogLjA4ZW07CiAgY29sb3I6IHZhcigtLWFjY2VudCk7CiAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTsKfQoKLnRvcGJhci1tZXRhIHsKICBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOwogIGZvbnQtc2l6ZTogMTFweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwogIGRpc3BsYXk6IGZsZXg7CiAgZ2FwOiAxcmVtOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7Cn0KCi50b3BiYXItbWV0YSAuZG90IHsKICB3aWR0aDogM3B4OwogIGhlaWdodDogM3B4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1tdXRlZC1kaW0pOwp9CgoudG9wYmFyLW1ldGEgLmxpdmUtZG90IHsKICB3aWR0aDogNnB4OwogIGhlaWdodDogNnB4OwogIGJvcmRlci1yYWRpdXM6IDUwJTsKICBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbik7CiAgYm94LXNoYWRvdzogMCAwIDhweCB2YXIoLS1ncmVlbik7CiAgYW5pbWF0aW9uOiBwdWxzZSAycyBlYXNlLWluLW91dCBpbmZpbml0ZTsKfQoKQGtleWZyYW1lcyBwdWxzZSB7CiAgMCUsIDEwMCUgeyBvcGFjaXR5OiAxOyB9CiAgNTAlIHsgb3BhY2l0eTogMC42OyB9Cn0KCi50b3BiYXItYWN0aW9ucyB7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IC41cmVtOwp9CgovKiDilIDilIAgQnV0dG9ucyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KLmJ0biB7CiAgZm9udC1mYW1pbHk6ICdHZWlzdCcsICdJbnRlcicsIHNhbnMtc2VyaWY7CiAgZm9udC1zaXplOiAxMnB4OwogIGZvbnQtd2VpZ2h0OiA1MDA7CiAgcGFkZGluZzogLjRyZW0gLjg3NXJlbTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgY3Vyc29yOiBwb2ludGVyOwogIGJvcmRlcjogbm9uZTsKICB0cmFuc2l0aW9uOiBhbGwgMC4ycyBlYXNlOwogIHRyYW5zZm9ybTogdHJhbnNsYXRlWigwKTsKfQoKLmJ0bjphY3RpdmUgewogIHRyYW5zZm9ybTogc2NhbGUoMC45Nyk7Cn0KCi5idG4tcHJpbWFyeSB7CiAgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50KTsKICBjb2xvcjogdmFyKC0tYmcpOwp9Ci5idG4tcHJpbWFyeTpob3ZlciB7CiAgYmFja2dyb3VuZDogIzMzREZGRjsKICBib3gtc2hhZG93OiAwIDAgMjBweCByZ2JhKDAsIDIxMiwgMjU1LCAwLjMpOwp9CgouYnRuLWdob3N0IHsKICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmJ0bi1naG9zdDpob3ZlciB7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZTIpOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBib3JkZXItY29sb3I6IHZhcigtLWJvcmRlci1zdWJ0bGUpOwp9CgovKiDilIDilIAgU3RhdCBTdHJpcCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KLnN0YXQtc3RyaXAgewogIGRpc3BsYXk6IGZsZXg7CiAgZ2FwOiAwOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJhY2tncm91bmQ6IHZhcigtLXN1cmZhY2UpOwp9Cgouc3RhdC1jZWxsIHsKICBmbGV4OiAxOwogIHBhZGRpbmc6IDFyZW0gMS41cmVtOwogIGJvcmRlci1yaWdodDogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgZGlzcGxheTogZmxleDsKICBmbGV4LWRpcmVjdGlvbjogY29sdW1uOwogIGdhcDogNHB4Owp9Ci5zdGF0LWNlbGw6bGFzdC1jaGlsZCB7IGJvcmRlci1yaWdodDogbm9uZTsgfQoKLnN0YXQtY2VsbCAubnVtIHsKICBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOwogIGZvbnQtc2l6ZTogMjRweDsKICBmb250LXdlaWdodDogNjAwOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBsaW5lLWhlaWdodDogMTsKfQoKLnN0YXQtY2VsbCAubnVtLmFjY2VudCB7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5zdGF0LWNlbGwgLm51bS5ncmVlbiB7IGNvbG9yOiB2YXIoLS1ncmVlbik7IH0KLnN0YXQtY2VsbCAubnVtLmFtYmVyIHsgY29sb3I6IHZhcigtLWFtYmVyKTsgfQouc3RhdC1jZWxsIC5udW0ucmVkIHsgY29sb3I6IHZhcigtLXJlZCk7IH0KCi5zdGF0LWNlbGwgLmxhYmVsIHsKICBmb250LXNpemU6IDEwcHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBsZXR0ZXItc3BhY2luZzogLjA2ZW07CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQoKLnN0YXQtY2VsbC5oaWdobGlnaHQgewogIGJhY2tncm91bmQ6IHZhcigtLWFjY2VudC1kaW0pOwp9Ci5zdGF0LWNlbGwuaGlnaGxpZ2h0IC5udW0gewogIGZvbnQtc2l6ZTogMjhweDsKfQoKLyog4pSA4pSAIEZpbHRlciBCYXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5maWx0ZXItYmFyIHsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAuNjI1cmVtOwogIHBhZGRpbmc6IC43NXJlbSAycmVtOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJhY2tncm91bmQ6IHZhcigtLWJnKTsKICBmbGV4LXdyYXA6IHdyYXA7Cn0KCi5maWx0ZXItYmFyIHNlbGVjdCwKLmZpbHRlci1iYXIgaW5wdXQgewogIGZvbnQtZmFtaWx5OiAnR2Vpc3QnLCAnSW50ZXInLCBzYW5zLXNlcmlmOwogIGZvbnQtc2l6ZTogMTJweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBjb2xvcjogdmFyKC0tdGV4dCk7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBwYWRkaW5nOiAuMzc1cmVtIC43NXJlbTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgb3V0bGluZTogbm9uZTsKICB0cmFuc2l0aW9uOiBhbGwgMC4ycyBlYXNlOwp9Ci5maWx0ZXItYmFyIHNlbGVjdDpmb2N1cywKLmZpbHRlci1iYXIgaW5wdXQ6Zm9jdXMgewogIGJvcmRlci1jb2xvcjogdmFyKC0tYWNjZW50KTsKICBib3gtc2hhZG93OiAwIDAgMCAzcHggdmFyKC0tYWNjZW50LWRpbSk7Cn0KCi5maWx0ZXItYmFyIHNlbGVjdCB7IG1pbi13aWR0aDogMTIwcHg7IGN1cnNvcjogcG9pbnRlcjsgfQouZmlsdGVyLWJhciBpbnB1dFt0eXBlPSJ0ZXh0Il0geyBtaW4td2lkdGg6IDIyMHB4OyB9CgouZmlsdGVyLWJhciAuc3BhY2VyIHsgZmxleDogMTsgfQoKLyog4pSA4pSAIEpvYiBMaXN0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwouam9iLWxpc3QgewogIHBhZGRpbmc6IDA7Cn0KCi5qb2Itcm93IHsKICBkaXNwbGF5OiBncmlkOwogIGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyIGF1dG8gMTYwcHggMjIwcHg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDA7CiAgcGFkZGluZzogMXJlbSAxLjI1cmVtOwogIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCByZ2JhKDMxLCA0MSwgNTUsIDAuNSk7CiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7CiAgdHJhbnNpdGlvbjogYmFja2dyb3VuZCAwLjJzIGVhc2UsIHRyYW5zZm9ybSAwLjE1cyBlYXNlOwogIGN1cnNvcjogZGVmYXVsdDsKICBhbmltYXRpb246IHNsaWRlSW4gMC4zcyBlYXNlIGZvcndhcmRzOwogIG9wYWNpdHk6IDA7CiAgdHJhbnNmb3JtOiB0cmFuc2xhdGVZKDhweCk7Cn0KCkBrZXlmcmFtZXMgc2xpZGVJbiB7CiAgdG8gewogICAgb3BhY2l0eTogMTsKICAgIHRyYW5zZm9ybTogdHJhbnNsYXRlWSgwKTsKICB9Cn0KCi5qb2Itcm93Om50aC1jaGlsZCgxKSB7IGFuaW1hdGlvbi1kZWxheTogMC4wNXM7IH0KLmpvYi1yb3c6bnRoLWNoaWxkKDIpIHsgYW5pbWF0aW9uLWRlbGF5OiAwLjFzOyB9Ci5qb2Itcm93Om50aC1jaGlsZCgzKSB7IGFuaW1hdGlvbi1kZWxheTogMC4xNXM7IH0KLmpvYi1yb3c6bnRoLWNoaWxkKDQpIHsgYW5pbWF0aW9uLWRlbGF5OiAwLjJzOyB9Ci5qb2Itcm93Om50aC1jaGlsZCg1KSB7IGFuaW1hdGlvbi1kZWxheTogMC4yNXM7IH0KCi5qb2Itcm93OmhvdmVyIHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICB0cmFuc2Zvcm06IHRyYW5zbGF0ZVgoNHB4KTsKfQouam9iLXJvdy5hcHBsaWVkIHsgYm9yZGVyLWxlZnQ6IDNweCBzb2xpZCB2YXIoLS1ncmVlbik7IH0KLmpvYi1yb3cuc2F2ZWQgeyBib3JkZXItbGVmdDogM3B4IHNvbGlkIHZhcigtLWFtYmVyKTsgfQouam9iLXJvdy5za2lwcGVkIHsgYmFja2dyb3VuZDogcmdiYSgyMzksIDY4LCA2OCwgMC4wMyk7IGJvcmRlci1sZWZ0OiAzcHggc29saWQgcmdiYSgyMzksIDY4LCA2OCwgMC40KTsgfQouam9iLXJvdy5za2lwcGVkIC5qb2ItdGl0bGUsCi5qb2Itcm93LnNraXBwZWQgLmpvYi1jb21wYW55LAouam9iLXJvdy5za2lwcGVkIC5qb2ItZGV0YWlscyAubG9jYXRpb24geyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB9Ci5qb2Itcm93Lmlnbm9yZWQgeyBiYWNrZ3JvdW5kOiByZ2JhKDEwNywgMTE0LCAxMjgsIDAuMDQpOyBib3JkZXItbGVmdDogM3B4IHNvbGlkIHJnYmEoMTA3LCAxMTQsIDEyOCwgMC4zKTsgfQouam9iLXJvdy5pZ25vcmVkIC5qb2ItdGl0bGUsCi5qb2Itcm93Lmlnbm9yZWQgLmpvYi1jb21wYW55LAouam9iLXJvdy5pZ25vcmVkIC5qb2ItZGV0YWlscyAubG9jYXRpb24geyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB9Cgouam9iLXJhbmsgewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiAxMXB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZC1kaW0pOwogIHBhZGRpbmc6IC43NXJlbSAxcmVtOwogIHRleHQtYWxpZ246IGNlbnRlcjsKICBib3JkZXItcmlnaHQ6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXItc3VidGxlKTsKfQouam9iLXJhbmsgLnJhbmstbnVtIHsKICBmb250LXNpemU6IDE0cHg7CiAgZm9udC13ZWlnaHQ6IDYwMDsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwp9Cgouam9iLWluZm8gewogIHBhZGRpbmc6IDA7Cn0KCi5qb2ItdGl0bGUgewogIGZvbnQtc2l6ZTogMTRweDsKICBmb250LXdlaWdodDogNjAwOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBtYXJnaW4tYm90dG9tOiA0cHg7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogLjYyNXJlbTsKICB0ZXh0LXdyYXA6IGJhbGFuY2U7Cn0KCi5qb2ItdGl0bGUgLnN0YXR1cy10YWcgewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiA5cHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBwYWRkaW5nOiAycHggOHB4OwogIGJvcmRlci1yYWRpdXM6IDJweDsKICBsZXR0ZXItc3BhY2luZzogLjA1ZW07CiAgZmxleC1zaHJpbms6IDA7Cn0KLnN0YXR1cy10YWcubmV3IHsgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LWRpbSk7IGNvbG9yOiB2YXIoLS1hY2NlbnQpOyB9Ci5zdGF0dXMtdGFnLmFwcGxpZWQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbi1kaW0pOyBjb2xvcjogdmFyKC0tZ3JlZW4pOyB9Ci5zdGF0dXMtdGFnLnNhdmVkIHsgYmFja2dyb3VuZDogdmFyKC0tYW1iZXItZGltKTsgY29sb3I6IHZhcigtLWFtYmVyKTsgfQouc3RhdHVzLXRhZy5za2lwcGVkIHsgYmFja2dyb3VuZDogdmFyKC0tcmVkLWRpbSk7IGNvbG9yOiB2YXIoLS1yZWQpOyB9Ci5zdGF0dXMtdGFnLmlnbm9yZWQgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ib3JkZXIpOyBjb2xvcjogdmFyKC0tbXV0ZWQpOyB9Cgouam9iLWNvbXBhbnkgewogIGZvbnQtc2l6ZTogMTJweDsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwogIG1hcmdpbi1ib3R0b206IDZweDsKICB0ZXh0LXdyYXA6IGJhbGFuY2U7Cn0KCi5qb2ItdGFncyB7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IC4zNzVyZW07CiAgZmxleC13cmFwOiB3cmFwOwp9Ci5qb2ItdGFnIHsKICBmb250LWZhbWlseTogJ0pldEJyYWlucyBNb25vJywgbW9ub3NwYWNlOwogIGZvbnQtc2l6ZTogMTBweDsKICBwYWRkaW5nOiAycHggOHB4OwogIGJvcmRlci1yYWRpdXM6IDJweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlMik7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQouam9iLXRhZy5yZW1vdGUgeyBiYWNrZ3JvdW5kOiB2YXIoLS1ncmVlbi1kaW0pOyBjb2xvcjogdmFyKC0tZ3JlZW4pOyB9Ci5qb2ItdGFnLnNhbGFyeSB7IGJhY2tncm91bmQ6IHZhcigtLWFtYmVyLWRpbSk7IGNvbG9yOiB2YXIoLS1hbWJlcik7IH0KCi5qb2ItZGV0YWlscyB7CiAgcGFkZGluZzogMCAxLjVyZW07Cn0KLmpvYi1kZXRhaWxzIC5sb2NhdGlvbiB7CiAgZm9udC1zaXplOiAxMnB4OwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBtYXJnaW4tYm90dG9tOiAycHg7Cn0KLmpvYi1kZXRhaWxzIC5zb3VyY2UgewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiAxMHB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7Cn0KCi5qb2Itc2NvcmUgewogIHBhZGRpbmc6IDAgMS41cmVtOwogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBhbGlnbi1pdGVtczogZmxleC1lbmQ7CiAgZ2FwOiA2cHg7Cn0KLnNjb3JlLWJhci10cmFjayB7CiAgd2lkdGg6IDEwMCU7CiAgaGVpZ2h0OiA0cHg7CiAgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsKICBib3JkZXItcmFkaXVzOiAycHg7CiAgb3ZlcmZsb3c6IGhpZGRlbjsKfQouc2NvcmUtYmFyLWZpbGwgewogIGhlaWdodDogMTAwJTsKICBib3JkZXItcmFkaXVzOiAycHg7CiAgdHJhbnNpdGlvbjogd2lkdGggMC40cyBlYXNlOwp9Ci5zY29yZS1iYXItZmlsbC5oaWdoIHsKICBiYWNrZ3JvdW5kOiBsaW5lYXItZ3JhZGllbnQoOTBkZWcsIHZhcigtLWdyZWVuKSwgIzM0RDM5OSk7CiAgYm94LXNoYWRvdzogMCAwIDhweCByZ2JhKDE2LCAxODUsIDEyOSwgMC40KTsKfQouc2NvcmUtYmFyLWZpbGwubWlkIHsgYmFja2dyb3VuZDogdmFyKC0tYW1iZXIpOyB9Ci5zY29yZS1iYXItZmlsbC5sb3cgeyBiYWNrZ3JvdW5kOiB2YXIoLS1yZWQpOyB9Ci5zY29yZS12YWwgewogIGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7CiAgZm9udC1zaXplOiAxMXB4OwogIGNvbG9yOiB2YXIoLS1tdXRlZCk7Cn0KCi5qb2ItYWN0aW9ucyB7CiAgcGFkZGluZzogMCAxLjVyZW07CiAgZGlzcGxheTogZmxleDsKICBnYXA6IC41cmVtOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7Cn0KLmFjdGlvbi1saW5rIHsKICBmb250LWZhbWlseTogJ0dlaXN0JywgJ0ludGVyJywgc2Fucy1zZXJpZjsKICBmb250LXNpemU6IDExcHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBwYWRkaW5nOiAuMzc1cmVtIC43NXJlbTsKICBib3JkZXItcmFkaXVzOiA0cHg7CiAgY3Vyc29yOiBwb2ludGVyOwogIGJvcmRlcjogbm9uZTsKICB0ZXh0LWRlY29yYXRpb246IG5vbmU7CiAgdHJhbnNpdGlvbjogYWxsIDAuMnMgZWFzZTsKICBkaXNwbGF5OiBpbmxpbmUtZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogLjM3NXJlbTsKICB0cmFuc2Zvcm06IHRyYW5zbGF0ZVooMCk7Cn0KLmFjdGlvbi1saW5rOmFjdGl2ZSB7CiAgdHJhbnNmb3JtOiBzY2FsZSgwLjk1KTsKfQouYWN0aW9uLWxpbmsudmlldyB7CiAgYmFja2dyb3VuZDogdmFyKC0tYWNjZW50LWRpbSk7CiAgY29sb3I6IHZhcigtLWFjY2VudCk7Cn0KLmFjdGlvbi1saW5rLnZpZXc6aG92ZXIgewogIGJhY2tncm91bmQ6IHJnYmEoMCwyMTIsMjU1LDAuMik7CiAgYm94LXNoYWRvdzogMCAwIDEycHggcmdiYSgwLCAyMTIsIDI1NSwgMC4yKTsKfQouYWN0aW9uLWxpbmsuYXBwbHkgewogIGJhY2tncm91bmQ6IHZhcigtLWdyZWVuLWRpbSk7CiAgY29sb3I6IHZhcigtLWdyZWVuKTsKfQouYWN0aW9uLWxpbmsuYXBwbHk6aG92ZXIgewogIGJhY2tncm91bmQ6IHJnYmEoMTYsMTg1LDEyOSwwLjIpOwogIGJveC1zaGFkb3c6IDAgMCAxMnB4IHJnYmEoMTYsIDE4NSwgMTI5LCAwLjIpOwp9Ci5hY3Rpb24tbGluay5zYXZlIHsKICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmFjdGlvbi1saW5rLnNhdmU6aG92ZXIgewogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBib3JkZXItY29sb3I6IHZhcigtLWFjY2VudCk7CiAgYm94LXNoYWRvdzogMCAwIDhweCByZ2JhKDAsIDIxMiwgMjU1LCAwLjE1KTsKfQouYWN0aW9uLWxpbmsuc2tpcCB7CiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwp9Ci5hY3Rpb24tbGluay5za2lwOmhvdmVyIHsKICBjb2xvcjogdmFyKC0tcmVkKTsKICBib3JkZXItY29sb3I6IHZhcigtLXJlZC1kaW0pOwogIGJveC1zaGFkb3c6IDAgMCA4cHggcmdiYSgyMzksIDY4LCA2OCwgMC4xNSk7Cn0KLmFjdGlvbi1saW5rLmlnbm9yZSB7CiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7CiAgY29sb3I6IHZhcigtLW11dGVkLWRpbSk7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBmb250LXNpemU6IDEwcHg7Cn0KLmFjdGlvbi1saW5rLmlnbm9yZTpob3ZlciB7IGNvbG9yOiB2YXIoLS1yZWQpOyBib3JkZXItY29sb3I6IHZhcigtLXJlZC1kaW0pOyB9CgovKiDilIDilIAgVGFibGUgSGVhZGVyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwoubGlzdC1oZWFkZXIgewogIGRpc3BsYXk6IGdyaWQ7CiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgYXV0byAxNjBweCAyMjBweDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGdhcDogMDsKICBwYWRkaW5nOiAuNjI1cmVtIDEuMjVyZW07CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7CiAgYmFja2dyb3VuZDogdmFyKC0tc3VyZmFjZSk7CiAgcG9zaXRpb246IHN0aWNreTsKICB0b3A6IDUycHg7CiAgei1pbmRleDogNTsKfQoubGlzdC1oZWFkZXIgc3BhbiB7CiAgZm9udC1mYW1pbHk6ICdKZXRCcmFpbnMgTW9ubycsIG1vbm9zcGFjZTsKICBmb250LXNpemU6IDEwcHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBsZXR0ZXItc3BhY2luZzogLjA4ZW07CiAgdGV4dC10cmFuc2Zvcm06IGxvd2VyY2FzZTsKICBjb2xvcjogdmFyKC0tbXV0ZWQtZGltKTsKICBwYWRkaW5nOiAwIC43NXJlbTsKfQoubGlzdC1oZWFkZXIgc3BhbjpudGgtY2hpbGQoMykgeyB0ZXh0LWFsaWduOiByaWdodDsgcGFkZGluZy1yaWdodDogLjc1cmVtOyB9Ci5saXN0LWhlYWRlciBzcGFuOm50aC1jaGlsZCg0KSB7IHRleHQtYWxpZ246IHJpZ2h0OyBwYWRkaW5nLXJpZ2h0OiAuNzVyZW07IH0KCi8qIOKUgOKUgCBTa2VsZXRvbiBMb2FkZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5za2VsZXRvbiB7CiAgYmFja2dyb3VuZDogbGluZWFyLWdyYWRpZW50KDkwZGVnLCB2YXIoLS1zdXJmYWNlKSAyNSUsIHZhcigtLXN1cmZhY2UyKSA1MCUsIHZhcigtLXN1cmZhY2UpIDc1JSk7CiAgYmFja2dyb3VuZC1zaXplOiAyMDAlIDEwMCU7CiAgYW5pbWF0aW9uOiBzaGltbWVyIDEuNXMgaW5maW5pdGU7CiAgYm9yZGVyLXJhZGl1czogNHB4Owp9CkBrZXlmcmFtZXMgc2hpbW1lciB7CiAgMCUgeyBiYWNrZ3JvdW5kLXBvc2l0aW9uOiAyMDAlIDA7IH0KICAxMDAlIHsgYmFja2dyb3VuZC1wb3NpdGlvbjogLTIwMCUgMDsgfQp9Ci5za2VsZXRvbi1yb3cgewogIGRpc3BsYXk6IGdyaWQ7CiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnIgYXV0byAxNjBweCAyMjBweDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIHBhZGRpbmc6IDFyZW0gMS4yNXJlbTsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgcmdiYSgzMSwgNDEsIDU1LCAwLjUpOwogIGdhcDogMDsKfQouc2tlbGV0b24tdGV4dCB7IGhlaWdodDogMTRweDsgd2lkdGg6IDcwJTsgbWFyZ2luLWJvdHRvbTogLjVyZW07IH0KLnNrZWxldG9uLXN1YiB7IGhlaWdodDogMTJweDsgd2lkdGg6IDUwJTsgfQouc2tlbGV0b24tYmFyIHsgaGVpZ2h0OiA0cHg7IHdpZHRoOiA2MCU7IG1hcmdpbi10b3A6IC41cmVtOyB9CgovKiDilIDilIAgRW1wdHkgU3RhdGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5lbXB0eS1zdGF0ZSB7CiAgdGV4dC1hbGlnbjogY2VudGVyOwogIHBhZGRpbmc6IDRyZW0gMnJlbTsKICBjb2xvcjogdmFyKC0tbXV0ZWQpOwp9Ci5lbXB0eS1zdGF0ZSAuaWNvbiB7IGZvbnQtc2l6ZTogMnJlbTsgbWFyZ2luLWJvdHRvbTogLjc1cmVtOyB9Ci5lbXB0eS1zdGF0ZSBwIHsgZm9udC1zaXplOiAxM3B4OyB9CgovKiDilIDilIAgTW9kYWwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovCi5tb2RhbCB7CiAgcG9zaXRpb246IGZpeGVkOyBpbnNldDogMDsKICBiYWNrZ3JvdW5kOiByZ2JhKDAsMCwwLC42KTsKICB6LWluZGV4OiAxMDA7CiAgZGlzcGxheTogZmxleDsKICBhbGlnbi1pdGVtczogY2VudGVyOwogIGp1c3RpZnktY29udGVudDogY2VudGVyOwp9Ci5tb2RhbC1jb250ZW50IHsKICBiYWNrZ3JvdW5kOiB2YXIoLS1zdXJmYWNlKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIGJvcmRlci1yYWRpdXM6IDhweDsKICB3aWR0aDogOTAlOwogIG1heC13aWR0aDogNjAwcHg7CiAgbWF4LWhlaWdodDogOTB2aDsKICBvdmVyZmxvdy15OiBhdXRvOwp9Ci5tb2RhbC1oZWFkZXIgewogIGRpc3BsYXk6IGZsZXg7CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47CiAgcGFkZGluZzogMXJlbSAxLjVyZW07CiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLm1vZGFsLWhlYWRlciBoMiB7CiAgZm9udC1zaXplOiAxM3B4OwogIGZvbnQtd2VpZ2h0OiA2MDA7CiAgbGV0dGVyLXNwYWNpbmc6IC4wMmVtOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKfQoubW9kYWwtaGVhZGVyIC5jbG9zZSB7CiAgYmFja2dyb3VuZDogbm9uZTsKICBib3JkZXI6IG5vbmU7CiAgY29sb3I6IHZhcigtLW11dGVkKTsKICBmb250LXNpemU6IDE4cHg7CiAgY3Vyc29yOiBwb2ludGVyOwp9Ci5tb2RhbC1oZWFkZXIgLmNsb3NlOmhvdmVyIHsgY29sb3I6IHZhcigtLXRleHQpOyB9Ci5tb2RhbC1jb250ZW50IGZvcm0geyBwYWRkaW5nOiAxLjVyZW07IH0KLmZvcm0tZ3JpZCB7CiAgZGlzcGxheTogZ3JpZDsKICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmciAxZnI7CiAgZ2FwOiAxcmVtOwp9Ci5mb3JtLWdyaWQgbGFiZWwgewogIGRpc3BsYXk6IGZsZXg7CiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjsKICBnYXA6IC4yNXJlbTsKICBmb250LXNpemU6IDExcHg7CiAgZm9udC13ZWlnaHQ6IDUwMDsKICBsZXR0ZXItc3BhY2luZzogLjAyZW07CiAgY29sb3I6IHZhcigtLW11dGVkKTsKfQouZm9ybS1ncmlkIGxhYmVsIGlucHV0LAouZm9ybS1ncmlkIGxhYmVsIHNlbGVjdCwKLmZvcm0tZ3JpZCBsYWJlbCB0ZXh0YXJlYSB7CiAgYmFja2dyb3VuZDogdmFyKC0tYmcpOwogIGNvbG9yOiB2YXIoLS10ZXh0KTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1ib3JkZXIpOwogIHBhZGRpbmc6IC41cmVtOwogIGJvcmRlci1yYWRpdXM6IDNweDsKICBmb250LXNpemU6IDEzcHg7CiAgZm9udC1mYW1pbHk6ICdJbnRlcicsIHNhbnMtc2VyaWY7CiAgb3V0bGluZTogbm9uZTsKfQouZm9ybS1ncmlkIGxhYmVsIGlucHV0OmZvY3VzLAouZm9ybS1ncmlkIGxhYmVsIHNlbGVjdDpmb2N1cywKLmZvcm0tZ3JpZCBsYWJlbCB0ZXh0YXJlYTpmb2N1cyB7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1hY2NlbnQpOwogIGJveC1zaGFkb3c6IDAgMCAwIDJweCB2YXIoLS1hY2NlbnQtZGltKTsKfQouZm9ybS1ncmlkIGxhYmVsIHRleHRhcmVhIHsgcmVzaXplOiB2ZXJ0aWNhbDsgbWluLWhlaWdodDogNjBweDsgfQoubW9kYWwtYWN0aW9ucyB7CiAgZGlzcGxheTogZmxleDsKICBnYXA6IC41cmVtOwogIGp1c3RpZnktY29udGVudDogZmxleC1lbmQ7CiAgcGFkZGluZzogMXJlbSAxLjVyZW07CiAgYm9yZGVyLXRvcDogMXB4IHNvbGlkIHZhcigtLWJvcmRlcik7Cn0KLmFwcGx5LWNoZWNrbGlzdCB7IGxpc3Qtc3R5bGU6IG5vbmU7IHBhZGRpbmc6IDA7IH0KLmFwcGx5LWNoZWNrbGlzdCBsaSB7CiAgcGFkZGluZzogLjVyZW0gMDsKICBib3JkZXItYm90dG9tOiAxcHggc29saWQgdmFyKC0tYm9yZGVyKTsKICBkaXNwbGF5OiBmbGV4OwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAuNXJlbTsKICBmb250LXNpemU6IDEzcHg7Cn0KLmFwcGx5LWNoZWNrbGlzdCAudmFsIHsgY29sb3I6IHZhcigtLWFjY2VudCk7IGZvbnQtZmFtaWx5OiAnSmV0QnJhaW5zIE1vbm8nLCBtb25vc3BhY2U7IGZvbnQtc2l6ZTogMTJweDsgfQoKLyog4pSA4pSAIFRvYXN0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwoudG9hc3QgewogIHBvc2l0aW9uOiBmaXhlZDsKICBib3R0b206IDEuNXJlbTsKICByaWdodDogMS41cmVtOwogIGJhY2tncm91bmQ6IHZhcigtLWdyZWVuKTsKICBjb2xvcjogIzAwMDsKICBwYWRkaW5nOiAuNjI1cmVtIDEuMTI1cmVtOwogIGJvcmRlci1yYWRpdXM6IDRweDsKICBmb250LXNpemU6IDEycHg7CiAgZm9udC13ZWlnaHQ6IDYwMDsKICBkaXNwbGF5OiBub25lOwogIHotaW5kZXg6IDIwMDsKICBsZXR0ZXItc3BhY2luZzogLjAyZW07Cn0KCi8qIOKUgOKUgCBSZXNwb25zaXZlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqLwpAbWVkaWEgKG1heC13aWR0aDogOTAwcHgpIHsKICAuam9iLXJvdyB7CiAgICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IDFmciBhdXRvOwogIH0KICAuam9iLWRldGFpbHMgeyBkaXNwbGF5OiBub25lOyB9CiAgLmxpc3QtaGVhZGVyIHNwYW46bnRoLWNoaWxkKDMpIHsgZGlzcGxheTogbm9uZTsgfQp9CkBtZWRpYSAobWF4LXdpZHRoOiA2MDBweCkgewogIC5qb2ItYWN0aW9ucyB7IGRpc3BsYXk6IG5vbmU7IH0KICAubGlzdC1oZWFkZXIgc3BhbjpudGgtY2hpbGQoNCkgeyBkaXNwbGF5OiBub25lOyB9CiAgLnN0YXQtY2VsbCB7IHBhZGRpbmc6IC43NXJlbSAxcmVtOyB9CiAgLnN0YXQtY2VsbCAubnVtIHsgZm9udC1zaXplOiAyMHB4OyB9CiAgLnRvcGJhciB7IHBhZGRpbmc6IDAgMXJlbTsgfQogIC5maWx0ZXItYmFyIHsgcGFkZGluZzogLjc1cmVtIDFyZW07IH0KfQoKLyog4pSA4pSAIFNjcm9sbGJhciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi8KOjotd2Via2l0LXNjcm9sbGJhciB7IHdpZHRoOiA2cHg7IH0KOjotd2Via2l0LXNjcm9sbGJhci10cmFjayB7IGJhY2tncm91bmQ6IHZhcigtLWJnKTsgfQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1iIHsgYmFja2dyb3VuZDogdmFyKC0tYm9yZGVyKTsgYm9yZGVyLXJhZGl1czogM3B4OyB9Cjo6LXdlYmtpdC1zY3JvbGxiYXItdGh1bWI6aG92ZXIgeyBiYWNrZ3JvdW5kOiB2YXIoLS1tdXRlZC1kaW0pOyB9Cg==';
const APP_JS_B64 = 'LyoqCiAqIGFwcC5qcyDigJQgRGFzaGJvYXJkIGNsaWVudC1zaWRlIGxvZ2ljCiAqLwpjb25zdCBBUEkgPSAnL2FwaSc7CmxldCBhbGxKb2JzID0gW107CmxldCBjdXJyZW50Sm9iSWQgPSBudWxsOwoKLy8g4pSA4pSAIEluaXQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ0RPTUNvbnRlbnRMb2FkZWQnLCBhc3luYyAoKSA9PiB7CiAgc2hvd1NrZWxldG9uKCk7CiAgYXdhaXQgbG9hZFByb2ZpbGUoKTsKICBhd2FpdCBsb2FkU3RhdHMoKTsKICBhd2FpdCBsb2FkU291cmNlcygpOwogIGF3YWl0IGxvYWRKb2JzKCk7CiAgYmluZEV2ZW50cygpOwogIHN0YXJ0VXRjQ2xvY2soKTsKfSk7CgovLyDilIDilIAgVVRDIENsb2NrIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApmdW5jdGlvbiBzdGFydFV0Y0Nsb2NrKCkgewogIGZ1bmN0aW9uIHRpY2soKSB7CiAgICBjb25zdCBkID0gbmV3IERhdGUoKTsKICAgIGNvbnN0IGggPSBTdHJpbmcoZC5nZXRVVENIb3VycygpKS5wYWRTdGFydCgyLCAnMCcpOwogICAgY29uc3QgbSA9IFN0cmluZyhkLmdldFVUQ01pbnV0ZXMoKSkucGFkU3RhcnQoMiwgJzAnKTsKICAgIGNvbnN0IHMgPSBTdHJpbmcoZC5nZXRVVENTZWNvbmRzKCkpLnBhZFN0YXJ0KDIsICcwJyk7CiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd1dGNUaW1lJyk7CiAgICBpZiAoZWwpIGVsLnRleHRDb250ZW50ID0gaCArICc6JyArIG0gKyAnOicgKyBzICsgJyBVVEMnOwogIH0KICB0aWNrKCk7CiAgc2V0SW50ZXJ2YWwodGljaywgMTAwMCk7Cn0KCi8vIOKUgOKUgCBQcm9maWxlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgAphc3luYyBmdW5jdGlvbiBsb2FkUHJvZmlsZSgpIHsKICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCk7CiAgY29uc3QgcCA9IGF3YWl0IHIuanNvbigpOwogIHdpbmRvdy5fcHJvZmlsZSA9IHA7Cn0KCmFzeW5jIGZ1bmN0aW9uIGxvYWRTb3VyY2VzKCkgewogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgJHtBUEl9L2pvYnM/bGltaXQ9NTAwMGApOwogIGNvbnN0IGpvYnMgPSBhd2FpdCByLmpzb24oKTsKICBjb25zdCBzb3VyY2VzID0gWy4uLm5ldyBTZXQoam9icy5tYXAoaiA9PiBqLnNvdXJjZSkpXS5zb3J0KCk7CiAgY29uc3Qgc2VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NvdXJjZUZpbHRlcicpOwogIHNvdXJjZXMuZm9yRWFjaChzID0+IHsKICAgIGNvbnN0IG9wdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ29wdGlvbicpOwogICAgb3B0LnZhbHVlID0gczsgb3B0LnRleHRDb250ZW50ID0gczsKICAgIHNlbC5hcHBlbmRDaGlsZChvcHQpOwogIH0pOwoKICBjb25zdCBjb21wYW5pZXMgPSBbLi4ubmV3IFNldChqb2JzLm1hcChqID0+IGouY29tcGFueSkpXS5zb3J0KCk7CiAgY29uc3QgY29tcGFueVNlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJyk7CiAgY29tcGFuaWVzLmZvckVhY2goYyA9PiB7CiAgICBjb25zdCBvcHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdvcHRpb24nKTsKICAgIG9wdC52YWx1ZSA9IGM7IG9wdC50ZXh0Q29udGVudCA9IGM7CiAgICBjb21wYW55U2VsLmFwcGVuZENoaWxkKG9wdCk7CiAgfSk7Cn0KCi8vIOKUgOKUgCBTdGF0cyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKYXN5bmMgZnVuY3Rpb24gbG9hZFN0YXRzKCkgewogIGNvbnN0IHMgPSBhd2FpdCAoYXdhaXQgZmV0Y2goYCR7QVBJfS9zdGF0c2ApKS5qc29uKCk7CiAgY29uc3QgY2VsbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc3RhdC1zdHJpcCAuc3RhdC1jZWxsJyk7CiAgaWYgKGNlbGxzWzBdKSBjZWxsc1swXS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLnRvdGFsX2pvYnM7CiAgaWYgKGNlbGxzWzFdKSBjZWxsc1sxXS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLm5ld19qb2JzOwogIGlmIChjZWxsc1syXSkgY2VsbHNbMl0ucXVlcnlTZWxlY3RvcignLm51bScpLnRleHRDb250ZW50ID0gcy5zYXZlZF9qb2JzOwogIGlmIChjZWxsc1szXSkgY2VsbHNbM10ucXVlcnlTZWxlY3RvcignLm51bScpLnRleHRDb250ZW50ID0gcy5hcHBsaWVkX2pvYnM7CiAgaWYgKGNlbGxzWzRdKSBjZWxsc1s0XS5xdWVyeVNlbGVjdG9yKCcubnVtJykudGV4dENvbnRlbnQgPSBzLnNraXBwZWRfam9iczsKICBpZiAoY2VsbHNbNV0pIGNlbGxzWzVdLnF1ZXJ5U2VsZWN0b3IoJy5udW0nKS50ZXh0Q29udGVudCA9IHMuaWdub3JlZF9qb2JzIHx8IDA7CiAgY29uc3QgdG0gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndG9wYmFyTWF0Y2hlZCcpOwogIGNvbnN0IHR0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3RvcGJhclRvdGFsJyk7CiAgaWYgKHRtKSB0bS50ZXh0Q29udGVudCA9IChzLm1hdGNoZWRfam9icyB8fCBzLm5ld19qb2JzKSArICcgbWF0Y2hlZCc7CiAgaWYgKHR0KSB0dC50ZXh0Q29udGVudCA9IHMudG90YWxfam9icyArICcgdG90YWwnOwp9CgovLyDilIDilIAgSm9icyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKYXN5bmMgZnVuY3Rpb24gbG9hZEpvYnMoKSB7CiAgY29uc3Qgc3RhdHVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3N0YXR1c0ZpbHRlcicpLnZhbHVlOwogIGNvbnN0IGNvbXBhbnkgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY29tcGFueUZpbHRlcicpLnZhbHVlOwogIGNvbnN0IHJlZ2lvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZTsKICBjb25zdCBqb2JUeXBlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlR5cGVGaWx0ZXInKS52YWx1ZTsKICBjb25zdCBzb3VyY2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc291cmNlRmlsdGVyJykudmFsdWU7CiAgY29uc3Qgc29ydCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzb3J0RmlsdGVyJykudmFsdWU7CiAgY29uc3Qgc2VhcmNoID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NlYXJjaElucHV0JykudmFsdWUudG9Mb3dlckNhc2UoKTsKCiAgbGV0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoeyBzdGF0dXMsIHNvcnQsIGxpbWl0OiA1MDAgfSk7CiAgaWYgKGNvbXBhbnkpIHBhcmFtcy5zZXQoJ2NvbXBhbnknLCBjb21wYW55KTsKICBpZiAocmVnaW9uKSBwYXJhbXMuc2V0KCdyZWdpb24nLCByZWdpb24pOwogIGlmIChqb2JUeXBlKSBwYXJhbXMuc2V0KCdqb2JUeXBlJywgam9iVHlwZSk7CiAgaWYgKHNvdXJjZSkgcGFyYW1zLnNldCgnc291cmNlJywgc291cmNlKTsKICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7QVBJfS9qb2JzPyR7cGFyYW1zfWApOwogIGFsbEpvYnMgPSBhd2FpdCByLmpzb24oKTsKCiAgaWYgKHNlYXJjaCkgewogICAgYWxsSm9icyA9IGFsbEpvYnMuZmlsdGVyKGogPT4KICAgICAgKGoudGl0bGUgfHwgJycpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKSB8fAogICAgICAoai5jb21wYW55IHx8ICcnKS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHNlYXJjaCkgfHwKICAgICAgKGouZGVzY3JpcHRpb24gfHwgJycpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoc2VhcmNoKQogICAgKTsKICB9CgogIHJlbmRlckpvYnMoYWxsSm9icyk7CiAgYXdhaXQgbG9hZFN0YXRzKCk7CiAgdXBkYXRlQ2xlYXJCdXR0b24oKTsKfQoKZnVuY3Rpb24gdXBkYXRlQ2xlYXJCdXR0b24oKSB7CiAgY29uc3QgaGFzRmlsdGVyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKS52YWx1ZSB8fAogICAgICAgICAgICAgICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyZWdpb25GaWx0ZXInKS52YWx1ZSB8fAogICAgICAgICAgICAgICAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdqb2JUeXBlRmlsdGVyJykudmFsdWUgfHwKICAgICAgICAgICAgICAgICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2VhcmNoSW5wdXQnKS52YWx1ZTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xlYXJGaWx0ZXJzJykuc3R5bGUuZGlzcGxheSA9IGhhc0ZpbHRlciA/ICcnIDogJ25vbmUnOwp9Cgpjb25zdCBTS0VMRVRPTl9IVE1MID0gYAogICAgPGRpdiBjbGFzcz0ic2tlbGV0b24tcm93Ij48ZGl2IHN0eWxlPSJwYWRkaW5nOjFyZW0gMS4yNXJlbSI+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tdGV4dCI+PC9kaXY+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tc3ViIj48L2Rpdj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi1iYXIiPjwvZGl2PjwvZGl2PjxkaXYgc3R5bGU9InBhZGRpbmc6MXJlbSAxLjI1cmVtIj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi10ZXh0IiBzdHlsZT0id2lkdGg6NDAlIj48L2Rpdj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi1zdWIiPjwvZGl2PjwvZGl2PjxkaXYgc3R5bGU9InBhZGRpbmc6MXJlbSAxLjI1cmVtIj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi1iYXIiIHN0eWxlPSJ3aWR0aDo4MCUiPjwvZGl2PjwvZGl2PjxkaXYgc3R5bGU9InBhZGRpbmc6MXJlbSAxLjI1cmVtO2Rpc3BsYXk6ZmxleDtnYXA6LjVyZW0iPjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLWJhciIgc3R5bGU9IndpZHRoOjUwcHgiPjwvZGl2PjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLWJhciIgc3R5bGU9IndpZHRoOjUwcHgiPjwvZGl2PjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLWJhciIgc3R5bGU9IndpZHRoOjUwcHgiPjwvZGl2PjwvZGl2PjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic2tlbGV0b24tcm93Ij48ZGl2IHN0eWxlPSJwYWRkaW5nOjFyZW0gMS4yNXJlbSI+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tdGV4dCI+PC9kaXY+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tc3ViIj48L2Rpdj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi1iYXIiPjwvZGl2PjwvZGl2PjxkaXYgc3R5bGU9InBhZGRpbmc6MXJlbSAxLjI1cmVtIj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi10ZXh0IiBzdHlsZT0id2lkdGg6NDAlIj48L2Rpdj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi1zdWIiPjwvZGl2PjwvZGl2PjxkaXYgc3R5bGU9InBhZGRpbmc6MXJlbSAxLjI1cmVtIj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi1iYXIiIHN0eWxlPSJ3aWR0aDo4MCUiPjwvZGl2PjwvZGl2PjxkaXYgc3R5bGU9InBhZGRpbmc6MXJlbSAxLjI1cmVtO2Rpc3BsYXk6ZmxleDtnYXA6LjVyZW0iPjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLWJhciIgc3R5bGU9IndpZHRoOjUwcHgiPjwvZGl2PjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLWJhciIgc3R5bGU9IndpZHRoOjUwcHgiPjwvZGl2PjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLWJhciIgc3R5bGU9IndpZHRoOjUwcHgiPjwvZGl2PjwvZGl2PjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic2tlbGV0b24tcm93Ij48ZGl2IHN0eWxlPSJwYWRkaW5nOjFyZW0gMS4yNXJlbSI+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tdGV4dCI+PC9kaXY+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tc3ViIj48L2Rpdj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi1iYXIiPjwvZGl2PjwvZGl2PjxkaXYgc3R5bGU9InBhZGRpbmc6MXJlbSAxLjI1cmVtIj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi10ZXh0IiBzdHlsZT0id2lkdGg6NDAlIj48L2Rpdj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi1zdWIiPjwvZGl2PjwvZGl2PjxkaXYgc3R5bGU9InBhZGRpbmc6MXJlbSAxLjI1cmVtIj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi1iYXIiIHN0eWxlPSJ3aWR0aDo4MCUiPjwvZGl2PjwvZGl2PjxkaXYgc3R5bGU9InBhZGRpbmc6MXJlbSAxLjI1cmVtO2Rpc3BsYXk6ZmxleDtnYXA6LjVyZW0iPjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLWJhciIgc3R5bGU9IndpZHRoOjUwcHgiPjwvZGl2PjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLWJhciIgc3R5bGU9IndpZHRoOjUwcHgiPjwvZGl2PjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLWJhciIgc3R5bGU9IndpZHRoOjUwcHgiPjwvZGl2PjwvZGl2PjwvZGl2PgogIGA7CgpmdW5jdGlvbiByZW5kZXJKb2JzKGpvYnMpIHsKICBjb25zdCBxID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlF1ZXVlJyk7CiAgaWYgKGpvYnMubGVuZ3RoID09PSAwKSB7CiAgICBxLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJlbXB0eS1zdGF0ZSI+PGRpdiBjbGFzcz0iaWNvbiI+4o6TPC9kaXY+PHA+Tm8gam9icyBmb3VuZC4gQ2xpY2sgIlNjcmFwZSBOb3ciIHRvIGZldGNoIGZyZXNoIGxpc3RpbmdzLjwvcD48L2Rpdj4nOwogICAgcmV0dXJuOwogIH0KICBxLmlubmVySFRNTCA9IGpvYnMubWFwKChqLCBpKSA9PiBqb2JSb3coaiwgaSkpLmpvaW4oJycpOwp9CgpmdW5jdGlvbiBzaG93U2tlbGV0b24oKSB7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2pvYlF1ZXVlJykuaW5uZXJIVE1MID0gU0tFTEVUT05fSFRNTDsKfQoKZnVuY3Rpb24gam9iUm93KGpvYiwgaW5kZXgpIHsKICBjb25zdCBzYWxhcnlCYWRnZSA9IGpvYi5zYWxhcnkgPyBgPHNwYW4gY2xhc3M9ImpvYi10YWcgc2FsYXJ5Ij4ke2VzY2FwZUh0bWwoam9iLnNhbGFyeSl9PC9zcGFuPmAgOiAnJzsKICBjb25zdCByZW1vdGVCYWRnZSA9IGpvYi5yZW1vdGUgfHwgam9iLnNvdXJjZSA9PT0gJ1JlbW90ZU9LJyB8fCBqb2Iuc291cmNlID09PSAnUmVtb3RpdmUnIHx8IGpvYi5zb3VyY2UgPT09ICdXZVdvcmtSZW1vdGVseScKICAgID8gYDxzcGFuIGNsYXNzPSJqb2ItdGFnIHJlbW90ZSI+UmVtb3RlPC9zcGFuPmAgOiAnJzsKICBjb25zdCBzdGF0dXMgPSBqb2Iuc3RhdHVzIHx8ICduZXcnOwogIGNvbnN0IHN0YXR1c0NsYXNzID0gYHN0YXR1cy0ke3N0YXR1c31gOyAvLyBzdGF0dXNDbGFzcyBmb3Igc3RhdHVzLWJhZGdlIGNsYXNzCiAgY29uc3Qgcm93Q2xhc3MgPSBzdGF0dXMgPT09ICdhcHBsaWVkJyA/ICdhcHBsaWVkJyA6IHN0YXR1cyA9PT0gJ3NhdmVkJyA/ICdzYXZlZCcKICAgIDogc3RhdHVzID09PSAnc2tpcHBlZCcgPyAnc2tpcHBlZCcgOiBzdGF0dXMgPT09ICdpZ25vcmVkJyA/ICdpZ25vcmVkJyA6ICcnOwogIGNvbnN0IHBjdCA9IE1hdGgubWluKDEwMCwgTWF0aC5yb3VuZCgoam9iLnNjb3JlIHx8IDApIC8gMTIwICogMTAwKSk7CiAgY29uc3Qgc2NvcmVDbGFzcyA9IHBjdCA+PSA3MCA/ICdoaWdoJyA6IHBjdCA+PSA0MCA/ICdtaWQnIDogJ2xvdyc7CiAgY29uc3QgbG9jYXRpb24gPSBqb2IubG9jYXRpb24gfHwgam9iLnJlZ2lvbiB8fCAn4oCUJzsKICBjb25zdCBzb3VyY2VMYWJlbCA9IGpvYi5zb3VyY2UgfHwgJyc7CgogIGNvbnN0IGFjdGlvbnNIdG1sID0gYAogICAgPGEgaHJlZj0iJHtlc2NhcGVIdG1sKGpvYi51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJhY3Rpb24tbGluayB2aWV3IiBhcmlhLWxhYmVsPSJWaWV3IGpvYiBkZXRhaWxzIj5WaWV3PC9hPgogICAgPGEgaHJlZj0iamF2YXNjcmlwdDp2b2lkKDApIiBvbmNsaWNrPSJvcGVuQXBwbHkoJyR7am9iLmlkfScpIiBjbGFzcz0iYWN0aW9uLWxpbmsgYXBwbHkiIGFyaWEtbGFiZWw9IkFwcGx5IHRvIHRoaXMgam9iIj5BcHBseTwvYT4KICAgIDxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9Jywnc2F2ZWQnKSIgY2xhc3M9ImFjdGlvbi1saW5rIHNhdmUiIGFyaWEtbGFiZWw9IlNhdmUgdGhpcyBqb2IiPlNhdmU8L2E+CiAgICA8YSBocmVmPSJqYXZhc2NyaXB0OnZvaWQoMCkiIG9uY2xpY2s9Im1hcmtBY3Rpb24oJyR7am9iLmlkfScsJ3NraXBwZWQnKSIgY2xhc3M9ImFjdGlvbi1saW5rIHNraXAiIGFyaWEtbGFiZWw9Ik1vdmUgdG8gc2tpcHBlZCI+U2tpcDwvYT4KICAgIDxhIGhyZWY9ImphdmFzY3JpcHQ6dm9pZCgwKSIgb25jbGljaz0ibWFya0FjdGlvbignJHtqb2IuaWR9JywnaWdub3JlZCcpIiBjbGFzcz0iYWN0aW9uLWxpbmsgaWdub3JlIiBhcmlhLWxhYmVsPSJNb3ZlIHRvIGlnbm9yZWQiPklnbm9yZTwvYT4KICBgOwoKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9ImpvYi1yb3cgJHtyb3dDbGFzc30iIGlkPSJqb2ItJHtqb2IuaWR9Ij4KICAgIDxkaXYgY2xhc3M9ImpvYi1pbmZvIj4KICAgICAgPGRpdiBjbGFzcz0iam9iLXRpdGxlIj4KICAgICAgICAke2VzY2FwZUh0bWwoam9iLnRpdGxlKX0KICAgICAgICA8c3BhbiBjbGFzcz0ic3RhdHVzLXRhZyAke3N0YXR1c0NsYXNzfSI+JHtzdGF0dXN9PC9zcGFuPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iam9iLWNvbXBhbnkiPiR7ZXNjYXBlSHRtbChqb2IuY29tcGFueSB8fCAnJyl9ICZtaWRkb3Q7ICR7ZXNjYXBlSHRtbChzb3VyY2VMYWJlbCl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImpvYi10YWdzIj4ke3JlbW90ZUJhZGdlfSR7c2FsYXJ5QmFkZ2V9PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImpvYi1kZXRhaWxzIj4KICAgICAgPGRpdiBjbGFzcz0ibG9jYXRpb24iPiR7ZXNjYXBlSHRtbChsb2NhdGlvbil9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InNvdXJjZSI+JHtlc2NhcGVIdG1sKHNvdXJjZUxhYmVsKX08L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iam9iLXNjb3JlIj4KICAgICAgPGRpdiBjbGFzcz0ic2NvcmUtYmFyLXRyYWNrIj48ZGl2IGNsYXNzPSJzY29yZS1iYXItZmlsbCAke3Njb3JlQ2xhc3N9IiBzdHlsZT0id2lkdGg6JHtwY3R9JSI+PC9kaXY+PC9kaXY+CiAgICAgIDxzcGFuIGNsYXNzPSJzY29yZS12YWwiPiR7am9iLnNjb3JlID8/IDB9IHB0czwvc3Bhbj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iam9iLWFjdGlvbnMiPiR7YWN0aW9uc0h0bWx9PC9kaXY+CiAgPC9kaXY+YDsKfQoKLy8g4pSA4pSAIEFjdGlvbnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmFzeW5jIGZ1bmN0aW9uIG1hcmtBY3Rpb24oam9iSWQsIGFjdGlvbikgewogIGNvbnN0IGVuZHBvaW50TWFwID0geyBhcHBsaWVkOiAnYXBwbHknLCBza2lwcGVkOiAnc2tpcCcsIHNhdmVkOiAnc2F2ZScsIGlnbm9yZWQ6ICdpZ25vcmUnLCBuZXc6ICduZXcnIH07CiAgY29uc3QgZW5kcG9pbnQgPSBlbmRwb2ludE1hcFthY3Rpb25dIHx8IGFjdGlvbjsKICBsZXQgcGF5bG9hZCA9IHsgam9iSWQgfTsKICBpZiAoYWN0aW9uID09PSAnc2tpcHBlZCcgfHwgYWN0aW9uID09PSAnaWdub3JlZCcpIHsKICAgIGNvbnN0IGpvYiA9IGFsbEpvYnMuZmluZChqID0+IGouaWQgPT09IGpvYklkKTsKICAgIGlmIChqb2IgJiYgam9iLnRpdGxlKSBwYXlsb2FkLnRpdGxlID0gam9iLnRpdGxlOwogIH0KICB0cnkgewogICAgY29uc3QgcmVzcCA9IGF3YWl0IGZldGNoKGAke0FQSX0vJHtlbmRwb2ludH1gLCB7CiAgICAgIG1ldGhvZDogJ1BPU1QnLAogICAgICBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwKICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkKICAgIH0pOwogICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlc3AudGV4dCgpOwogICAgaWYgKCFyZXNwLm9rKSB0aHJvdyBuZXcgRXJyb3IoJ0hUVFAgJyArIHJlc3Auc3RhdHVzICsgJzogJyArIHRleHQpOwogICAgSlNPTi5wYXJzZSh0ZXh0KTsKICAgIHRvYXN0KGAke2FjdGlvbi5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIGFjdGlvbi5zbGljZSgxKX1kIGpvYmApOwogICAgYXdhaXQgbG9hZEpvYnMoKTsKICB9IGNhdGNoIChlcnIpIHsKICAgIHRvYXN0KCdFcnJvcjogJyArIGVyci5tZXNzYWdlKTsKICB9Cn0KCi8vIOKUgOKUgCBBcHBseSBNb2RhbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAKZnVuY3Rpb24gb3BlbkFwcGx5KGpvYklkKSB7CiAgY3VycmVudEpvYklkID0gam9iSWQ7CiAgY29uc3Qgam9iID0gYWxsSm9icy5maW5kKGogPT4gai5pZCA9PT0gam9iSWQpOwogIGlmICgham9iKSByZXR1cm47CiAgY29uc3QgcCA9IHdpbmRvdy5fcHJvZmlsZSB8fCB7fTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlDb250ZW50JykuaW5uZXJIVE1MID0gYAogICAgPGRpdiBzdHlsZT0icGFkZGluZzoxLjVyZW0iPgogICAgICA8aDMgc3R5bGU9ImZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjYwMDttYXJnaW4tYm90dG9tOi4yNXJlbSI+JHtlc2NhcGVIdG1sKGpvYi50aXRsZSl9IEAgJHtlc2NhcGVIdG1sKGpvYi5jb21wYW55KX08L2gzPgogICAgICA8cCBzdHlsZT0iY29sb3I6dmFyKC0tbXV0ZWQpO21hcmdpbjouNXJlbSAwO2ZvbnQtc2l6ZToxM3B4Ij4ke2VzY2FwZUh0bWwoam9iLmRlc2NyaXB0aW9uPy5zbGljZSgwLCAyMDApKSB8fCAnTm8gZGVzY3JpcHRpb24gYXZhaWxhYmxlLid9PC9wPgogICAgICA8cCBzdHlsZT0ibWFyZ2luOi41cmVtIDA7Zm9udC1zaXplOjEzcHgiPjxhIGhyZWY9IiR7ZXNjYXBlSHRtbChqb2IudXJsKX0iIHRhcmdldD0iX2JsYW5rIiBzdHlsZT0iY29sb3I6dmFyKC0tYWNjZW50KSI+VmlldyBmdWxsIGpvYiBsaXN0aW5nIOKGkjwvYT48L3A+CiAgICAgIDxoNCBzdHlsZT0iZm9udC1zaXplOjExcHg7Zm9udC13ZWlnaHQ6NTAwO2xldHRlci1zcGFjaW5nOi4wNmVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luOjFyZW0gMCAuNXJlbSI+QXBwbGljYXRpb24gQ2hlY2tsaXN0OjwvaDQ+CiAgICAgIDx1bCBjbGFzcz0iYXBwbHktY2hlY2tsaXN0Ij4KICAgICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBOYW1lOiA8c3BhbiBjbGFzcz0idmFsIj4ke2VzY2FwZUh0bWwocC5uYW1lIHx8ICfigJQnKX08L3NwYW4+PC9saT4KICAgICAgICA8bGk+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBjaGVja2VkIGRpc2FibGVkPiBFbWFpbDogPHNwYW4gY2xhc3M9InZhbCI+JHtlc2NhcGVIdG1sKHAuZW1haWwgfHwgJ+KAlCcpfTwvc3Bhbj48L2xpPgogICAgICAgIDxsaT48aW5wdXQgdHlwZT0iY2hlY2tib3giIGNoZWNrZWQgZGlzYWJsZWQ+IFBob25lOiA8c3BhbiBjbGFzcz0idmFsIj4ke2VzY2FwZUh0bWwocC5waG9uZSB8fCAn4oCUJyl9PC9zcGFuPjwvbGk+CiAgICAgICAgPGxpPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgY2hlY2tlZCBkaXNhYmxlZD4gUmVzdW1lOiA8c3BhbiBjbGFzcz0idmFsIj4ke2VzY2FwZUh0bWwocC5yZXN1bWVfcGF0aCB8fCAnbm90IHNldCcpfTwvc3Bhbj48L2xpPgogICAgICAgIDxsaT48aW5wdXQgdHlwZT0iY2hlY2tib3giIGNoZWNrZWQgZGlzYWJsZWQ+IENvdmVyIGxldHRlcjogPHNwYW4gY2xhc3M9InZhbCI+JHtqb2IuY292ZXJfbGV0dGVyID8gJ+KckyBHZW5lcmF0ZWQnIDogJ1J1biB3aXRoIEFOVEhST1BJQ19BUElfS0VZJ308L3NwYW4+PC9saT4KICAgICAgPC91bD4KICAgIDwvZGl2PgogIGA7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcGx5VXJsQnRuJykuaHJlZiA9IGpvYi51cmw7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ21hcmtBcHBsaWVkQnRuJykub25jbGljayA9IGFzeW5jICgpID0+IHsKICAgIGF3YWl0IG1hcmtBY3Rpb24oam9iSWQsICdhcHBsaWVkJyk7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgICB0b2FzdCgnTWFya2VkIGFzIGFwcGxpZWQhJyk7CiAgfTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwbHlNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnZmxleCc7Cn0KCi8vIOKUgOKUgCBQcm9maWxlIE1vZGFsIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJvZmlsZUJ0bicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgY29uc3QgcCA9IGF3YWl0IChhd2FpdCBmZXRjaChgJHtBUEl9L3Byb2ZpbGVgKSkuanNvbigpOwogIHdpbmRvdy5fcHJvZmlsZSA9IHA7CiAgT2JqZWN0LmtleXMocCkuZm9yRWFjaChrID0+IHsKICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3BfJyArIGspOwogICAgaWYgKGVsKSBlbC52YWx1ZSA9IEFycmF5LmlzQXJyYXkocFtrXSkgPyBwW2tdLmpvaW4oJywgJykgOiAocFtrXSB8fCAnJyk7CiAgfSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnZmxleCc7Cn07Cgpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncHJvZmlsZUZvcm0nKS5vbnN1Ym1pdCA9IGFzeW5jIChlKSA9PiB7CiAgZS5wcmV2ZW50RGVmYXVsdCgpOwogIGNvbnN0IGZkID0gbmV3IEZvcm1EYXRhKGUudGFyZ2V0KTsKICBjb25zdCBwID0ge307CiAgZmQuZm9yRWFjaCgodiwgaykgPT4geyBwW2tdID0gdjsgfSk7CiAgZm9yIChjb25zdCBrZXkgb2YgWydza2lsbHMnLCAndGFyZ2V0X3RpdGxlcycsICdyZXF1aXJlZF9rZXl3b3JkcycsICdib251c19rZXl3b3JkcycsICdkZWFsX2JyZWFrZXJzJywgJ3ByZWZlcnJlZF93b3JrX3R5cGUnLCAncHJlZmVycmVkX2xvY2F0aW9ucycsICdwcmVmZXJyZWRfZW1wbG95bWVudCddKSB7CiAgICBwW2tleV0gPSAocFtrZXldIHx8ICcnKS5zcGxpdCgnLCcpLm1hcChzID0+IHMudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7CiAgfQogIHAuZXhwZXJpZW5jZV95ZWFycyA9IHBhcnNlSW50KHAuZXhwZXJpZW5jZV95ZWFycykgfHwgMDsKICBwLnNhbGFyeV9taW5fbGFraHMgPSBwYXJzZUZsb2F0KHAuc2FsYXJ5X21pbl9sYWtocykgfHwgMzU7CiAgcC50YXJnZXRfc2FsYXJ5ID0geyBjdXJyZW5jeTogcC5zYWxhcnlfY3VycmVuY3kgfHwgJ0lOUicsIG1pbl9sYWtoczogcC5zYWxhcnlfbWluX2xha2hzIH07CiAgYXdhaXQgZmV0Y2goYCR7QVBJfS9wcm9maWxlYCwgeyBtZXRob2Q6ICdQVVQnLCBoZWFkZXJzOiB7ICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSwgYm9keTogSlNPTi5zdHJpbmdpZnkocCkgfSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Byb2ZpbGVNb2RhbCcpLnN0eWxlLmRpc3BsYXkgPSAnbm9uZSc7CiAgdG9hc3QoJ1Byb2ZpbGUgc2F2ZWQhJyk7CiAgbG9hZFByb2ZpbGUoKTsKfTsKCi8vIOKUgOKUgCBFdmVudHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSACmZ1bmN0aW9uIGJpbmRFdmVudHMoKSB7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjcmFwZUJ0bicpLm9uY2xpY2sgPSBhc3luYyAoKSA9PiB7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NyYXBlQnRuJykuZGlzYWJsZWQgPSB0cnVlOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NjcmFwZUJ0bicpLnRleHRDb250ZW50ID0gJ1NjcmFwaW5nLi4uJzsKICAgIHNob3dTa2VsZXRvbigpOwogICAgYXdhaXQgZmV0Y2goYCR7QVBJfS9zY3JhcGVgLCB7IG1ldGhvZDogJ1BPU1QnIH0pOwogICAgc2V0VGltZW91dCgoKSA9PiB7CiAgICAgIGxvYWRKb2JzKCk7CiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzY3JhcGVCdG4nKS5kaXNhYmxlZCA9IGZhbHNlOwogICAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2NyYXBlQnRuJykudGV4dENvbnRlbnQgPSAnU2NyYXBlIE5vdyc7CiAgICB9LCAyMDAwKTsKICB9OwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbGVhckZpbHRlcnMnKS5vbmNsaWNrID0gKCkgPT4gewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2NvbXBhbnlGaWx0ZXInKS52YWx1ZSA9ICcnOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3JlZ2lvbkZpbHRlcicpLnZhbHVlID0gJyc7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnam9iVHlwZUZpbHRlcicpLnZhbHVlID0gJyc7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc2VhcmNoSW5wdXQnKS52YWx1ZSA9ICcnOwogICAgbG9hZEpvYnMoKTsKICB9OwoKICBmdW5jdGlvbiBvbkZpbHRlckNoYW5nZSgpIHsgbG9hZEpvYnMoKTsgdXBkYXRlQ2xlYXJCdXR0b24oKTsgfQogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzdGF0dXNGaWx0ZXInKS5vbmNoYW5nZSA9IGxvYWRKb2JzOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjb21wYW55RmlsdGVyJykub25jaGFuZ2UgPSBvbkZpbHRlckNoYW5nZTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncmVnaW9uRmlsdGVyJykub25jaGFuZ2UgPSBvbkZpbHRlckNoYW5nZTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnam9iVHlwZUZpbHRlcicpLm9uY2hhbmdlID0gb25GaWx0ZXJDaGFuZ2U7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NvdXJjZUZpbHRlcicpLm9uY2hhbmdlID0gbG9hZEpvYnM7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3NvcnRGaWx0ZXInKS5vbmNoYW5nZSA9IGxvYWRKb2JzOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdzZWFyY2hJbnB1dCcpLm9uaW5wdXQgPSAoKSA9PiB7CiAgICBjbGVhclRpbWVvdXQod2luZG93Ll9zZWFyY2hUaW1lcik7CiAgICB3aW5kb3cuX3NlYXJjaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7IGxvYWRKb2JzKCk7IHVwZGF0ZUNsZWFyQnV0dG9uKCk7IH0sIDMwMCk7CiAgfTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnY2xvc2VQcm9maWxlQnRuJykub25jbGljayA9ICgpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjYW5jZWxQcm9maWxlQnRuJykub25jbGljayA9ICgpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdwcm9maWxlTW9kYWwnKS5zdHlsZS5kaXNwbGF5ID0gJ25vbmUnOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdjbG9zZUFwcGx5QnRuJykub25jbGljayA9ICgpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHBseU1vZGFsJykuc3R5bGUuZGlzcGxheSA9ICdub25lJzsKfQoKLy8g4pSA4pSAIFV0aWxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgApmdW5jdGlvbiB0b2FzdChtc2cpIHsKICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0b2FzdCcpOwogIGVsLnRleHRDb250ZW50ID0gbXNnOyBlbC5zdHlsZS5kaXNwbGF5ID0gJ2Jsb2NrJzsKICBzZXRUaW1lb3V0KCgpID0+IGVsLnN0eWxlLmRpc3BsYXkgPSAnbm9uZScsIDI1MDApOwp9CgpmdW5jdGlvbiBlc2NhcGVIdG1sKHMpIHsKICBpZiAoIXMpIHJldHVybiAnJzsKICByZXR1cm4gU3RyaW5nKHMpLnJlcGxhY2UoLyYvZywnJmFtcDsnKS5yZXBsYWNlKC88L2csJyZsdDsnKS5yZXBsYWNlKC8+L2csJyZndDsnKS5yZXBsYWNlKC8iL2csJyZxdW90OycpOwp9Cgp3aW5kb3cubWFya0FjdGlvbiA9IG1hcmtBY3Rpb247CndpbmRvdy5vcGVuQXBwbHkgPSBvcGVuQXBwbHk7Cg==';

const DASHBOARD_HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0iVVRGLTgiLz4KICA8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEuMCIvPgogIDx0aXRsZT5Kb2IgQWdlbnQ8L3RpdGxlPgogIDxsaW5rIHJlbD0ic3R5bGVzaGVldCIgaHJlZj0iL3N0eWxlcy5jc3M/dD1fX1NUWUxFU19WRVJTSU9OX18iLz4KPC9oZWFkPgo8Ym9keT4KICA8IS0tIFRvcCBCYXIgLS0+CiAgPGhlYWRlciBjbGFzcz0idG9wYmFyIj4KICAgIDxkaXYgY2xhc3M9InRvcGJhci1icmFuZCI+CiAgICAgIDxoMT5Kb2IgQWdlbnQ8L2gxPgogICAgICA8ZGl2IGNsYXNzPSJ0b3BiYXItbWV0YSI+CiAgICAgICAgPHNwYW4gY2xhc3M9ImxpdmUtZG90Ij48L3NwYW4+CiAgICAgICAgPHNwYW4gaWQ9InRvcGJhck1hdGNoZWQiPuKAlCBtYXRjaGVkPC9zcGFuPgogICAgICAgIDxzcGFuIGNsYXNzPSJkb3QiPjwvc3Bhbj4KICAgICAgICA8c3BhbiBpZD0idG9wYmFyVG90YWwiPuKAlCB0b3RhbDwvc3Bhbj4KICAgICAgICA8c3BhbiBjbGFzcz0iZG90Ij48L3NwYW4+CiAgICAgICAgPHNwYW4gaWQ9InV0Y1RpbWUiPi0tOi0tIFVUQzwvc3Bhbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InRvcGJhci1hY3Rpb25zIj4KICAgICAgPGJ1dHRvbiBpZD0ic2NyYXBlQnRuIiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5Ij5TY3JhcGUgTm93PC9idXR0b24+CiAgICAgIDxidXR0b24gaWQ9InByb2ZpbGVCdG4iIGNsYXNzPSJidG4gYnRuLWdob3N0Ij5Qcm9maWxlPC9idXR0b24+CiAgICA8L2Rpdj4KICA8L2hlYWRlcj4KCiAgPCEtLSBTdGF0IFN0cmlwIC0tPgogIDxkaXYgY2xhc3M9InN0YXQtc3RyaXAiPgogICAgPGRpdiBjbGFzcz0ic3RhdC1jZWxsIj48c3BhbiBjbGFzcz0ibnVtIj7igJQ8L3NwYW4+PHNwYW4gY2xhc3M9ImxhYmVsIj50b3RhbCBqb2JzPC9zcGFuPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdC1jZWxsIj48c3BhbiBjbGFzcz0ibnVtIGFjY2VudCI+4oCUPC9zcGFuPjxzcGFuIGNsYXNzPSJsYWJlbCI+bmV3PC9zcGFuPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdC1jZWxsIj48c3BhbiBjbGFzcz0ibnVtIGFtYmVyIj7igJQ8L3NwYW4+PHNwYW4gY2xhc3M9ImxhYmVsIj5zYXZlZDwvc3Bhbj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXQtY2VsbCI+PHNwYW4gY2xhc3M9Im51bSBncmVlbiI+4oCUPC9zcGFuPjxzcGFuIGNsYXNzPSJsYWJlbCI+YXBwbGllZDwvc3Bhbj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXQtY2VsbCI+PHNwYW4gY2xhc3M9Im51bSByZWQiPuKAlDwvc3Bhbj48c3BhbiBjbGFzcz0ibGFiZWwiPnNraXBwZWQ8L3NwYW4+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzdGF0LWNlbGwiPjxzcGFuIGNsYXNzPSJudW0iIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXRlZCkiPuKAlDwvc3Bhbj48c3BhbiBjbGFzcz0ibGFiZWwiPmlnbm9yZWQ8L3NwYW4+PC9kaXY+CiAgPC9kaXY+CgogIDwhLS0gRmlsdGVyIEJhciAtLT4KICA8ZGl2IGNsYXNzPSJmaWx0ZXItYmFyIj4KICAgIDxzZWxlY3QgaWQ9InN0YXR1c0ZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBzdGF0dXMiIGFyaWEtbGFiZWw9IkZpbHRlciBieSBzdGF0dXMiPgogICAgICA8b3B0aW9uIHZhbHVlPSJuZXciPk5ldyBKb2JzPC9vcHRpb24+CiAgICAgIDxvcHRpb24gdmFsdWU9InNhdmVkIj5TYXZlZDwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJhcHBsaWVkIj5BcHBsaWVkPC9vcHRpb24+CiAgICAgIDxvcHRpb24gdmFsdWU9InNraXBwZWQiPlNraXBwZWQ8L29wdGlvbj4KICAgICAgPG9wdGlvbiB2YWx1ZT0iaWdub3JlZCI+SWdub3JlZDwvb3B0aW9uPgogICAgPC9zZWxlY3Q+CiAgICA8c2VsZWN0IGlkPSJjb21wYW55RmlsdGVyIiB0aXRsZT0iRmlsdGVyIGJ5IGNvbXBhbnkiIGFyaWEtbGFiZWw9IkZpbHRlciBieSBjb21wYW55Ij4KICAgICAgPG9wdGlvbiB2YWx1ZT0iIj5BbGwgQ29tcGFuaWVzPC9vcHRpb24+CiAgICA8L3NlbGVjdD4KICAgIDxzZWxlY3QgaWQ9InJlZ2lvbkZpbHRlciIgdGl0bGU9IkZpbHRlciBieSByZWdpb24iIGFyaWEtbGFiZWw9IkZpbHRlciBieSByZWdpb24iPgogICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBSZWdpb25zPC9vcHRpb24+CiAgICAgIDxvcHRpb24gdmFsdWU9ImluZGlhIj5JbmRpYTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJyZW1vdGUiPlJlbW90ZTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJ1c2EiPlVTQTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJldXJvcGUiPkV1cm9wZTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJhc2lhLXBhY2lmaWMiPkFzaWEtUGFjaWZpYzwvb3B0aW9uPgogICAgPC9zZWxlY3Q+CiAgICA8c2VsZWN0IGlkPSJqb2JUeXBlRmlsdGVyIiB0aXRsZT0iRmlsdGVyIGJ5IGpvYiB0eXBlIiBhcmlhLWxhYmVsPSJGaWx0ZXIgYnkgam9iIHR5cGUiPgogICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBUeXBlczwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJyZW1vdGUiPlJlbW90ZSBPbmx5PC9vcHRpb24+CiAgICAgIDxvcHRpb24gdmFsdWU9Im9uc2l0ZSI+T24tc2l0ZSBPbmx5PC9vcHRpb24+CiAgICA8L3NlbGVjdD4KICAgIDxzZWxlY3QgaWQ9InNvdXJjZUZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBzb3VyY2UiIGFyaWEtbGFiZWw9IkZpbHRlciBieSBzb3VyY2UiPgogICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBTb3VyY2VzPC9vcHRpb24+CiAgICA8L3NlbGVjdD4KICAgIDxzZWxlY3QgaWQ9InNvcnRGaWx0ZXIiIHRpdGxlPSJTb3J0IGJ5IiBhcmlhLWxhYmVsPSJTb3J0IGJ5Ij4KICAgICAgPG9wdGlvbiB2YWx1ZT0ic2NvcmUiPlNjb3JlIChkZXNjKTwvb3B0aW9uPgogICAgICA8b3B0aW9uIHZhbHVlPSJwb3N0ZWQiPk5ld2VzdDwvb3B0aW9uPgogICAgPC9zZWxlY3Q+CiAgICA8ZGl2IGNsYXNzPSJzcGFjZXIiPjwvZGl2PgogICAgPGlucHV0IGlkPSJzZWFyY2hJbnB1dCIgdHlwZT0idGV4dCIgcGxhY2Vob2xkZXI9IlNlYXJjaCB0aXRsZSwgY29tcGFueS4uLiIvPgogICAgPGJ1dHRvbiBpZD0iY2xlYXJGaWx0ZXJzIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCIgc3R5bGU9ImRpc3BsYXk6bm9uZSI+Q2xlYXI8L2J1dHRvbj4KICA8L2Rpdj4KCiAgPCEtLSBKb2IgTGlzdCBIZWFkZXIgLS0+CiAgPGRpdiBjbGFzcz0ibGlzdC1oZWFkZXIiPgogICAgPHNwYW4+Sm9iPC9zcGFuPgogICAgPHNwYW4+RGV0YWlsczwvc3Bhbj4KICAgIDxzcGFuPlNjb3JlPC9zcGFuPgogICAgPHNwYW4+QWN0aW9uczwvc3Bhbj4KICA8L2Rpdj4KCiAgPCEtLSBKb2IgTGlzdCAtLT4KICA8ZGl2IGNsYXNzPSJqb2ItbGlzdCIgaWQ9ImpvYlF1ZXVlIj4KICAgIDxkaXYgY2xhc3M9InNrZWxldG9uLXJvdyI+CiAgICAgIDxkaXYgc3R5bGU9InBhZGRpbmc6IDFyZW0gMS4yNXJlbSI+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tdGV4dCI+PC9kaXY+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tc3ViIj48L2Rpdj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi1iYXIiPjwvZGl2PjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJwYWRkaW5nOiAxcmVtIDEuMjVyZW0iPjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLXRleHQiIHN0eWxlPSJ3aWR0aDo0MCUiPjwvZGl2PjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLXN1YiI+PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9InBhZGRpbmc6IDFyZW0gMS4yNXJlbSI+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tYmFyIiBzdHlsZT0id2lkdGg6ODAlIj48L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0icGFkZGluZzogMXJlbSAxLjI1cmVtOyBkaXNwbGF5OmZsZXg7IGdhcDouNXJlbSI+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tYmFyIiBzdHlsZT0id2lkdGg6NTBweCI+PC9kaXY+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tYmFyIiBzdHlsZT0id2lkdGg6NTBweCI+PC9kaXY+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tYmFyIiBzdHlsZT0id2lkdGg6NTBweCI+PC9kaXY+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InNrZWxldG9uLXJvdyI+CiAgICAgIDxkaXYgc3R5bGU9InBhZGRpbmc6IDFyZW0gMS4yNXJlbSI+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tdGV4dCI+PC9kaXY+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tc3ViIj48L2Rpdj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi1iYXIiPjwvZGl2PjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJwYWRkaW5nOiAxcmVtIDEuMjVyZW0iPjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLXRleHQiIHN0eWxlPSJ3aWR0aDo0MCUiPjwvZGl2PjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLXN1YiI+PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9InBhZGRpbmc6IDFyZW0gMS4yNXJlbSI+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tYmFyIiBzdHlsZT0id2lkdGg6ODAlIj48L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0icGFkZGluZzogMXJlbSAxLjI1cmVtOyBkaXNwbGF5OmZsZXg7IGdhcDouNXJlbSI+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tYmFyIiBzdHlsZT0id2lkdGg6NTBweCI+PC9kaXY+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tYmFyIiBzdHlsZT0id2lkdGg6NTBweCI+PC9kaXY+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tYmFyIiBzdHlsZT0id2lkdGg6NTBweCI+PC9kaXY+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InNrZWxldG9uLXJvdyI+CiAgICAgIDxkaXYgc3R5bGU9InBhZGRpbmc6IDFyZW0gMS4yNXJlbSI+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tdGV4dCI+PC9kaXY+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tc3ViIj48L2Rpdj48ZGl2IGNsYXNzPSJza2VsZXRvbiBza2VsZXRvbi1iYXIiPjwvZGl2PjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJwYWRkaW5nOiAxcmVtIDEuMjVyZW0iPjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLXRleHQiIHN0eWxlPSJ3aWR0aDo0MCUiPjwvZGl2PjxkaXYgY2xhc3M9InNrZWxldG9uIHNrZWxldG9uLXN1YiI+PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9InBhZGRpbmc6IDFyZW0gMS4yNXJlbSI+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tYmFyIiBzdHlsZT0id2lkdGg6ODAlIj48L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0icGFkZGluZzogMXJlbSAxLjI1cmVtOyBkaXNwbGF5OmZsZXg7IGdhcDouNXJlbSI+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tYmFyIiBzdHlsZT0id2lkdGg6NTBweCI+PC9kaXY+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tYmFyIiBzdHlsZT0id2lkdGg6NTBweCI+PC9kaXY+PGRpdiBjbGFzcz0ic2tlbGV0b24gc2tlbGV0b24tYmFyIiBzdHlsZT0id2lkdGg6NTBweCI+PC9kaXY+PC9kaXY+CiAgICA8L2Rpdj4KICA8L2Rpdj4KCiAgPCEtLSBQcm9maWxlIE1vZGFsIC0tPgogIDxkaXYgaWQ9InByb2ZpbGVNb2RhbCIgY2xhc3M9Im1vZGFsIiBzdHlsZT0iZGlzcGxheTpub25lIiByb2xlPSJkaWFsb2ciIGFyaWEtbW9kYWw9InRydWUiIGFyaWEtbGFiZWw9IkVkaXQgcHJvZmlsZSI+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1jb250ZW50Ij4KICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtaGVhZGVyIj4KICAgICAgICA8aDI+RWRpdCBwcm9maWxlPC9oMj4KICAgICAgICA8YnV0dG9uIGlkPSJjbG9zZVByb2ZpbGVCdG4iIGNsYXNzPSJjbG9zZSIgYXJpYS1sYWJlbD0iQ2xvc2UgZGlhbG9nIj4mdGltZXM7PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8Zm9ybSBpZD0icHJvZmlsZUZvcm0iPgogICAgICAgIDxkaXYgY2xhc3M9ImZvcm0tZ3JpZCI+CiAgICAgICAgICA8bGFiZWw+TmFtZTxpbnB1dCBpZD0icF9uYW1lIiBuYW1lPSJuYW1lIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5FbWFpbDxpbnB1dCBpZD0icF9lbWFpbCIgbmFtZT0iZW1haWwiIHR5cGU9ImVtYWlsIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5QaG9uZTxpbnB1dCBpZD0icF9waG9uZSIgbmFtZT0icGhvbmUiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkxpbmtlZEluPGlucHV0IGlkPSJwX2xpbmtlZGluIiBuYW1lPSJsaW5rZWRpbiIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+TG9jYXRpb248aW5wdXQgaWQ9InBfbG9jYXRpb24iIG5hbWU9ImxvY2F0aW9uIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5SZXN1bWUgUGF0aDxpbnB1dCBpZD0icF9yZXN1bWVfcGF0aCIgbmFtZT0icmVzdW1lX3BhdGgiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkV4cGVyaWVuY2UgKHllYXJzKTxpbnB1dCBpZD0icF9leHAiIG5hbWU9ImV4cGVyaWVuY2VfeWVhcnMiIHR5cGU9Im51bWJlciIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+Q3VycmVudCBSb2xlPGlucHV0IGlkPSJwX3JvbGUiIG5hbWU9ImN1cnJlbnRfcm9sZSIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+Q3VycmVudCBDb21wYW55PGlucHV0IGlkPSJwX2NvbXBhbnkiIG5hbWU9ImN1cnJlbnRfY29tcGFueSIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+U2tpbGxzIChjb21tYS1zZXBhcmF0ZWQpPGlucHV0IGlkPSJwX3NraWxscyIgbmFtZT0ic2tpbGxzIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5UYXJnZXQgVGl0bGVzIChjb21tYS1zZXBhcmF0ZWQpPGlucHV0IGlkPSJwX3RpdGxlcyIgbmFtZT0idGFyZ2V0X3RpdGxlcyIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+UmVxdWlyZWQgS2V5d29yZHM8aW5wdXQgaWQ9InBfcmVxX2t3IiBuYW1lPSJyZXF1aXJlZF9rZXl3b3JkcyIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+Qm9udXMgS2V5d29yZHM8aW5wdXQgaWQ9InBfYm9udXNfa3ciIG5hbWU9ImJvbnVzX2tleXdvcmRzIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5NaW4gU2FsYXJ5IChMYWtocyBJTlIpPGlucHV0IGlkPSJwX21pbl9zYWxhcnkiIG5hbWU9InNhbGFyeV9taW5fbGFraHMiIHR5cGU9Im51bWJlciIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+Q3VycmVuY3kKICAgICAgICAgICAgPHNlbGVjdCBpZD0icF9jdXJyZW5jeSIgbmFtZT0ic2FsYXJ5X2N1cnJlbmN5Ij4KICAgICAgICAgICAgICA8b3B0aW9uPklOUjwvb3B0aW9uPjxvcHRpb24+VVNEPC9vcHRpb24+PG9wdGlvbj5FVVI8L29wdGlvbj48b3B0aW9uPkdCUDwvb3B0aW9uPgogICAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICAgIDwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+V29yayBUeXBlCiAgICAgICAgICAgIDxzZWxlY3QgaWQ9InBfd29ya190eXBlIiBuYW1lPSJ3b3JrX3R5cGUiIG11bHRpcGxlIHNpemU9IjMiPgogICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9InJlbW90ZSI+UmVtb3RlPC9vcHRpb24+CiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iaHlicmlkIj5IeWJyaWQ8L29wdGlvbj4KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJvbi1zaXRlIj5Pbi1zaXRlPC9vcHRpb24+CiAgICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgICAgPC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5QcmVmZXJyZWQgTG9jYXRpb25zPGlucHV0IGlkPSJwX2xvY2F0aW9ucyIgbmFtZT0ibG9jYXRpb25zIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5TdW1tYXJ5PHRleHRhcmVhIGlkPSJwX3N1bW1hcnkiIG5hbWU9InN1bW1hcnkiIHJvd3M9IjMiPjwvdGV4dGFyZWE+PC9sYWJlbD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtb2RhbC1hY3Rpb25zIj4KICAgICAgICAgIDxidXR0b24gdHlwZT0ic3VibWl0IiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5Ij5TYXZlIFByb2ZpbGU8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gdHlwZT0iYnV0dG9uIiBpZD0iY2FuY2VsUHJvZmlsZUJ0biIgY2xhc3M9ImJ0biBidG4tZ2hvc3QiPkNhbmNlbDwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Zvcm0+CiAgICA8L2Rpdj4KICA8L2Rpdj4KCiAgPCEtLSBBcHBseSBNb2RhbCAtLT4KICA8ZGl2IGlkPSJhcHBseU1vZGFsIiBjbGFzcz0ibW9kYWwiIHN0eWxlPSJkaXNwbGF5Om5vbmUiIHJvbGU9ImRpYWxvZyIgYXJpYS1tb2RhbD0idHJ1ZSIgYXJpYS1sYWJlbD0iUHJlcGFyZSBhcHBsaWNhdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1jb250ZW50Ij4KICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtaGVhZGVyIj4KICAgICAgICA8aDI+UHJlcGFyZSBhcHBsaWNhdGlvbjwvaDI+CiAgICAgICAgPGJ1dHRvbiBpZD0iY2xvc2VBcHBseUJ0biIgY2xhc3M9ImNsb3NlIiBhcmlhLWxhYmVsPSJDbG9zZSBkaWFsb2ciPiZ0aW1lczs8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgaWQ9ImFwcGx5Q29udGVudCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im1vZGFsLWFjdGlvbnMiPgogICAgICAgIDxhIGlkPSJhcHBseVVybEJ0biIgaHJlZj0iIyIgdGFyZ2V0PSJfYmxhbmsiIGNsYXNzPSJidG4gYnRuLWdob3N0Ij5PcGVuIEpvYiBQYWdlPC9hPgogICAgICAgIDxidXR0b24gaWQ9Im1hcmtBcHBsaWVkQnRuIiBjbGFzcz0iYnRuIGJ0bi1wcmltYXJ5IiBzdHlsZT0iYmFja2dyb3VuZDp2YXIoLS1ncmVlbikiPk1hcmsgYXMgQXBwbGllZDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvZGl2PgoKICA8ZGl2IGlkPSJ0b2FzdCIgY2xhc3M9InRvYXN0Ij48L2Rpdj4KICA8c2NyaXB0IHNyYz0iL2FwcC5qcz90PV9fVElNRVNUQU1QX18iPjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K';

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
