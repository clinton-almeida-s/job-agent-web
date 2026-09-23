/**
 * Cloudflare Worker — Job Agent
 * Runs the scraper on a daily cron and serves the dashboard API
 */

// ── Data layer (KV-based) ───────────────────────────────────────────────────

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
  const url = 'https://boards-api.greenhouse.io/v1/boards/' + board + '/jobs?content=true&limit=30';
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
        const desc = j.content ? cleanText(j.content).slice(0, 200) : '';
        return {
          id: 'greenhouse-' + board + '-' + j.id,
          source: 'Greenhouse:' + board,
          title: j.title || '',
          company: board,
          location: location,
          remote: isRemote,
          description: desc,
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
  const boards = ['Cloudflare', 'Stripe', 'Datadog', 'Databricks', 'MongoDB', 'Elastic', 'Okta', 'Block', 'Roku', 'Roblox', 'Pinterest', 'Coinbase', 'Robinhood', 'Brex', 'Dropbox', 'Asana', 'Intercom', 'Mixpanel', 'Amplitude', 'Monzo', 'Chime', 'GoCardless', 'Fastly', 'PlanetScale', 'Netlify'];
  const allResults = await Promise.allSettled(
    boards.map(function(board) { return scrapeGreenhouse(board, kv); })
  );
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

  const allJobs = jobList.concat(newJobs);
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
    let filtered;
    if (status === 'all') {
      filtered = allJobs;
    } else {
      filtered = allJobs.filter(function(j) { return j.status === status; });
    }
    filtered = filtered.slice(0, limit);
    return new Response(JSON.stringify(filtered), { headers: { 'Content-Type': 'application/json' } });
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

  // Serve dashboard HTML for SPA fallback
  return new Response(getDashboardHtml(), {
    headers: { 'Content-Type': 'text/html' }
  });
}

// Dashboard HTML (base64 encoded to avoid require issues)
const DASHBOARD_HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CiAgPG1ldGEgY2hhcnNldD0iVVRGLTgiLz4KICA8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEuMCIvPgogIDx0aXRsZT5Kb2IgQWdlbnQgRGFzaGJvYXJkPC90aXRsZT4KICA8bGluayByZWw9InN0eWxlc2hlZXQiIGhyZWY9Ii9zdHlsZXMuY3NzIi8+CjwvaGVhZD4KPGJvZHk+CiAgPGhlYWRlciBjbGFzcz0idG9wYmFyIj4KICAgIDxkaXYgY2xhc3M9ImJyYW5kIj4KICAgICAgPGgxPuKIjSBJb2IgQWdlbnQ8L2gxPgogICAgICA8c3BhbiBjbGFzcz0ic3ViIiBpZD0icHJvZmlsZU5hbWUiPkxvYWRpbmcuLi48L3NwYW4+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPgogICAgICA8YnV0dG9uIGlkPSJzY3JhcGVCdG4iIGNsYXNzPSJidG4tcHJpbWFyeSI+8J+UkCBTY3JhcGUgTm93PC9idXR0b24+CiAgICAgIDxidXR0b24gaWQ9InByb2ZpbGVCdG4iIGNsYXNzPSJidG4tZ2hvc3QiPuKUiyDQrZIgUHJvZmlsZTwvYnV0dG9uPgogICAgPC9kaXY+CiAgPC9oZWFkZXI+CgogIDxtYWluPgogICAgPHNlY3Rpb24gY2xhc3M9InN0YXRzIiBpZD0ic3RhdHNCYXIiPgogICAgICA8ZGl2IGNsYXNzPSJzdGF0Ij48Yj7wn5OUMjwvYj48c3Bhbj5Ub3RhbCBKb2JzPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0Ij48Yj7wn5OUMjwvYj48c3Bhbj5OZXc8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxiPuifk5Q8L2I+PHNwYW4+U2F2ZWQ8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXQiPjxiPuifk5Q8L2I+PHNwYW4+QXBwbGllZDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdCI+PGI+8J+TlDI8L2I+PHNwYW4+U2tpcHBlZDwvc3Bhbj48L2Rpdj4KICAgIDwvc2VjdGlvbj4KCiAgICA8c2VjdGlvbiBjbGFzcz0idG9vbGJhciI+CiAgICAgIDxkaXYgY2xhc3M9ImZpbHRlcnMiPgogICAgICAgIDxzZWxlY3QgaWQ9InN0YXR1c0ZpbHRlciIgdGl0bGU9IkZpbHRlciBieSBzdGF0dXMiPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ibmV3Ij5OZXcgSm9iczwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2F2ZWQiPlNhdmVkPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhcHBsaWVkIj5BcHBsaWVkPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJza2lwcGVkIj5Ta2lwcGVkPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJpZ25vcmVkIj5JZ25vcmVkPC9vcHRpb24+CiAgICAgIDwvc2VsZWN0PgogICAgICA8c2VsZWN0IGlkPSJzb3VyY2VGaWx0ZXIiIHRpdGxlPSJGaWx0ZXIgYnkgc291cmNlIj4KICAgICAgICA8b3B0aW9uIHZhbHVlPSIiPkFsbCBTb3VyY2VzPC9vcHRpb24+CiAgICAgIDwvc2VsZWN0PgogICAgICA8c2VsZWN0IGlkPSJzb3J0RmlsdGVyIiB0aXRsZT0iU29ydCBieSI+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2NvcmUiPlNvcnQ6IFNjb3JlIChkZXNjKTwvb3B0aW9uPgogICAgICAgIDxvcHRpb24gdmFsdWU9InBvc3RlZCI+U29ydDogTmV3ZXN0PC9vcHRpb24+CiAgICAgIDwvc2VsZWN0PgogICAgICA8aW5wdXQgaWQ9InNlYXJjaElucHV0IiB0eXBlPSJ0ZXh0IiBwbGFjZWhvbGRlcj0i8J+UpyBUaXRsZSwgY29tcGFueSwga2V5d29yZHMuLi4iLz4KICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJidWxrLWFjdGlvbnMiPgogICAgICAgIDxidXR0b24gaWQ9ImJ1bGtTYXZlIiBjbGFzcz0iYnRuLWdob3N0Ij5TYXZlIEFsbCBWaXNpYmxlPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBpZD0iYnVsa1NraXAiIGNsYXNzPSJidG4tZ2hvc3QiPlNraXAgQWxsIEJlbG93IDMwPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9zZWN0aW9uPgoKICAgIDxzZWN0aW9uIGNsYXNzPSJxdWV1ZSIgaWQ9ImpvYlF1ZXVlIj4KICAgICAgPGRpdiBjbGFzcz0iZW1wdHktc3RhdGUiPkxvYWRpbmcgam9icy4uLjwvZGl2PgogICAgPC9zZWN0aW9uPgogIDwvbWFpbj4KCiAgPCEtLSBQcm9maWxlIE1vZGFsIC0tPgogIDxkaXYgaWQ9InByb2ZpbGVNb2RhbCIgY2xhc3M9Im1vZGFsIiBzdHlsZT0iZGlzcGxheTpub25lIj4KICAgIDxkaXYgY2xhc3M9Im1vZGFsLWNvbnRlbnQiPgogICAgICA8ZGl2IGNsYXNzPSJtb2RhbC1oZWFkZXIiPgogICAgICAgIDxoMj7Io5MgRWRpdCBQcm9maWxlPC9oMj4KICAgICAgICA8YnV0dG9uIGlkPSJjbG9zZVByb2ZpbGVCdG4iIGNsYXNzPSJjbG9zZSI+8J+WgTwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGZvcm0gaWQ9InByb2ZpbGVGb3JtIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmb3JtLWdyaWQiPgogICAgICAgICAgPGxhYmVsPk5hbWU8aW5wdXQgaWQ9InBfbmFtZSIgbmFtZT0ibmFtZSIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+RW1haWw8aW5wdXQgaWQ9InBfZW1haWwiIG5hbWU9ImVtYWlsIiB0eXBlPSJlbWFpbCIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+UGhvbmU8aW5wdXQgaWQ9InBfcGhvbmUiIG5hbWU9InBob25lIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5MaW5rZWRJbjxpbnB1dCBpZD0icF9saW5rZWRpbiIgbmFtZT0ibGlua2VkaW4iLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkxvY2F0aW9uPGlucHV0IGlkPSJwX2xvY2F0aW9uIiBuYW1lPSJsb2NhdGlvbiIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+UmVzdW1lIFBhdGg8aW5wdXQgaWQ9InBfcmVzdW1lX3BhdGgiIG5hbWU9InJlc3VtZV9wYXRoIi8+PC9sYWJlbD4KICAgICAgICAgIDxsYWJlbD5FeHBlcmllbmNlICh5ZWFycyk8aW5wdXQgaWQ9InBfZXhwIiBuYW1lPSJleHBlcmllbmNlX3llYXJzIiB0eXBlPSJudW1iZXIiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkN1cnJlbnQgUm9sZTxpbnB1dCBpZD0icF9yb2xlIiBuYW1lPSJjdXJyZW50X3JvbGUiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkN1cnJlbnQgQ29tcGFueTxpbnB1dCBpZD0icF9jb21wYW55IiBuYW1lPSJjdXJyZW50X2NvbXBhbnkiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPlNraWxscyAoY29tbWEtc2VwYXJhdGVkKTxpbnB1dCBpZD0icF9za2lsbHMiIG5hbWU9InNraWxscyIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+VGFyZ2V0IFRpdGxlcyAoY29tbWEtc2VwYXJhdGVkKTxpbnB1dCBpZD0icF90aXRsZXMiIG5hbWU9InRhcmdldF90aXRsZXMiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPlJlcXVpcmVkIEtleXdvcmRzPGlucHV0IGlkPSJwX3JlcV9rdyIgbmFtZT0icmVxdWlyZWRfa2V5d29yZHMiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPkJvbnVzIEtleXdvcmRzPGlucHV0IGlkPSJwX2JvbnVzX2t3IiBuYW1lPSJib251c19rZXl3b3JkcyIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+TWluIFNhbGFyeSAoTGtraHMgSU5SKTxpbnB1dCBpZD0icF9taW5fc2FsYXJ5IiBuYW1lPSJzYWxhcnlfbWluX2xha2hzIiB0eXBlPSJudW1iZXIiLz48L2xhYmVsPgogICAgICAgICAgPGxhYmVsPlNhbGFyeSBDdXJyZW5jeTsKICAgICAgICAgICAgPHNlbGVjdCBpZD0icF9jdXJyZW5jeSIgbmFtZT0ic2FsYXJ5X2N1cnJlbmN5Ij4KICAgICAgICAgICAgICA8b3B0aW9uPlBST1VTRUQ+PC9vcHRpb24+CiAgICAgICAgICAgICAgPG9wdGlvbj5JTkU8L29wdGlvbj4KICAgICAgICAgICAgICA8b3B0aW9uPlVESFM8L29wdGlvbj4KICAgICAgICAgICAgICA8b3B0aW9uPlRVUjwvb3B0aW9uPgogICAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICAgIDwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+V29yayBUeXBlOwogICAgICAgICAgICA8c2VsZWN0IGlkPSJwX3dvcmtfdHlwZSIgbmFtZT0id29ya190eXBlIiBtdWx0aXBsZSBzaXplPSIzIj4KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJyZW1vdGUiPlJlbW90ZTwvb3B0aW9uPgogICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9Imh5YnJpZCI+SHlicmlkPC9vcHRpb24+CiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ib24tc2l0ZSI+T24tc2l0ZTwvb3B0aW9uPgogICAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICAgIDwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+UHJlZmVycmVkIExvY2F0aW9uczxpbnB1dCBpZD0icF9sb2NhdGlvbnMiIG5hbWU9ImxvY2F0aW9ucyIvPjwvbGFiZWw+CiAgICAgICAgICA8bGFiZWw+U3VtbWFyeTx0ZXh0YXJlYSBpZD0icF9zdW1tYXJ5IiBuYW1lPSJzdW1tYXJ5IiByb3dzPSIzIj48L3RleHRhcmVhPjwvbGFiZWw+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtYWN0aW9ucyI+CiAgICAgICAgICA8YnV0dG9uIHR5cGU9InN1Ym1pdCIgY2xhc3M9ImJ0bi1wcmltYXJ5Ij5TYXZlIFByb2ZpbGU8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gdHlwZT0iYnV0dG9uIiBpZD0iY2FuY2VsUHJvZmlsZUJ0biIgY2xhc3M9ImJ0bi1naG9zdCI+Q2FuY2VsPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZm9ybT4KICAgIDwvZGl2PgogIDwvZGl2PgoKICA8IS0tIEFwcGx5IE1vZGFsIC0tPgogIDxkaXYgaWQ9ImFwcGx5TW9kYWwiIGNsYXNzPSJtb2RhbCIgc3R5bGU9ImRpc3BsYXk6bm9uZSI+CiAgICA8ZGl2IGNsYXNzPSJtb2RhbC1jb250ZW50Ij4KICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtaGVhZGVyIj4KICAgICAgICA8aDI+8J+UlyBQcmVwYXJlIEFwcGxpY2F0aW9uPC9oMj4KICAgICAgICA8YnV0dG9uIGlkPSJjbG9zZUFwcGx5QnRuIiBjbGFzcz0iY2xvc2UiPsilnI8vYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBpZD0iYXBwbHlDb250ZW50Ij48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibW9kYWwtYWN0aW9ucyI+CiAgICAgICAgPGEgaWQ9ImFwcGx5VXJsQnRuIiBocmVmPSIjIiB0YXJnZXQ9Il9ibGFuayIgY2xhc3M9ImJ0bi1wcmltYXJ5Ij5PcGVuIEpvYiBQYWdlPC9hPgogICAgICAgIDxidXR0b24gaWQ9Im1hcmtBcHBsaWVkQnRuIiBjbGFzcz0iYnRuLXN1Y2Nlc3MiPsipgZBNYXJrIGFzIEFwcGxpZWQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICA8L2Rpdj4KCiAgPGRpdiBpZD0idG9hc3QiIGNsYXNzPSJ0b2FzdCI+PC9kaXY+CiAgPHNjcmlwdCBzcmM9Ii9hcHAuanMiPjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4=';

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
