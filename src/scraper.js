/**
 * Source registry — one module per job board, unified output format
 * All sources return [{id, source, title, company, location, remote, description, tags, salary, salary_min_inr, url, posted_at}]
 */

const https = require('https');
const http  = require('http');

// ── fetch helper ──────────────────────────────────────────────────────────────

function fetchUrl(url, ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36') {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': ua } }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', () => resolve({ status: 0, body: '' }));
  });
}

function cleanText(str) {
  if (!str) return '';
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseSalaryMin(salaryStr) {
  if (!salaryStr) return 0;
  const s = salaryStr.trim();
  const inrMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:LPA|L\s*PA|Lakhs?)/i);
  if (inrMatch) return parseFloat(inrMatch[1]) * 100000;
  const rangeMatch = s.match(/(\d+)[\s-]*(\d+)\s*L/i);
  if (rangeMatch) return parseFloat(rangeMatch[1]) * 100000;
  const isHourly = s.toLowerCase().includes('/hour') || s.toLowerCase().includes('per hour');
  if (isHourly) {
    const hourlyMatch = s.match(/\$(\d+)/i);
    if (hourlyMatch) return parseInt(hourlyMatch[1]) * 2080 * 83;
  }
  const usdMatch = s.match(/\$(\d+)\s*k/i);
  if (usdMatch) return parseInt(usdMatch[1]) * 1000 * 83;
  // Range like $90k-$120k — take min
  const rangeUsd = s.match(/\$?(\d+)\s*k.*\$?(\d+)\s*k/i);
  if (rangeUsd) return Math.min(parseInt(rangeUsd[1]), parseInt(rangeUsd[2])) * 1000 * 83;
  const plainMatch = s.match(/(\d+)/);
  if (plainMatch) {
    const num = parseFloat(plainMatch[1]);
    if (num < 100) return num * 100000;
    return num;
  }
  return 0;
}

function rssItemToJob(item, sourceName, extras = {}) {
  const title = cleanText(item.title || '');
  const link = item.link || '';
  return {
    id: `src-${Buffer.from(link || item.description || '').toString('base64').slice(0, 12)}`,
    source: sourceName,
    title,
    company: cleanText(item.company || item['job:company'] || item['wwr:company_name'] || ''),
    location: cleanText(item.location || item['georss:point'] || 'Remote'),
    remote: cleanText(item.location || '').toLowerCase().includes('remote') || !!item.remote,
    description: cleanText(item.description || ''),
    tags: item.tags ? (Array.isArray(item.tags) ? item.tags.join(', ') : item.tags) : '',
    salary: cleanText(item.salary || ''),
    salary_min_inr: parseSalaryMin(item.salary || ''),
    url: link,
    posted_at: item.pubDate || new Date().toISOString(),
    ...extras,
  };
}

function parseRssXml(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const extract = tag => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i');
      const m = itemXml.match(r);
      if (!m) return '';
      let content = m[1].trim();
      if (content.startsWith('<![CDATA[')) {
        content = content.replace(/^<!\[CDATA\[(.*)\]\]>$/s, '$1');
      }
      return content;
    };
    const tags = {};
    for (const tag of ['title', 'link', 'description', 'pubDate', 'company', 'location', 'salary', 'tags', 'source']) {
      tags[tag] = extract(tag);
    }
    // namespace-prefixed tags
    for (const [ns, tag] of [['job', 'company'], ['job', 'location'], ['job', 'salary'], ['wwr', 'company_name'], ['jobboard', 'company']]) {
      const val = extract(`${ns}:${tag}`);
      if (val) tags[tag] = val;
    }
    items.push(tags);
  }
  return items;
}

// ── source modules ────────────────────────────────────────────────────────────

async function scrapeRemoteOK() {
  const { status, body } = await fetchUrl('https://remoteok.com/api');
  if (status !== 200) return [];
  try {
    const jobs = JSON.parse(body).filter(j => j.position && j.position.length > 3);
    return jobs.map(j => ({
      id: `remoteok-${j.id}`, source: 'RemoteOK', title: j.position || '',
      company: j.company || '', location: 'Remote', remote: true,
      description: cleanText(j.description || ''),
      tags: (j.tags || []).join(', '), salary: j.salary || '',
      salary_min_inr: parseSalaryMin(j.salary || ''),
      url: j.url || `https://remoteok.com/remote-jobs/${j.slug}`,
      posted_at: j.date || new Date().toISOString(),
    }));
  } catch { return []; }
}

async function scrapeRemotive(keyword) {
  const { status, body } = await fetchUrl(
    `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(keyword)}&limit=50`
  );
  if (status !== 200) return [];
  try {
    const { jobs = [] } = JSON.parse(body);
    return jobs.map(j => ({
      id: `remotive-${j.id}`, source: 'Remotive',
      title: j.title || '', company: j.company_name || '',
      location: j.candidate_required_location || 'Remote', remote: true,
      description: cleanText(j.description || ''),
      tags: (j.tags || []).join(', '), salary: j.salary || '',
      salary_min_inr: parseSalaryMin(j.salary || ''),
      url: j.url || '', posted_at: j.publication_date || new Date().toISOString(),
    }));
  } catch { return []; }
}

async function scrapeWeWorkRemotely() {
  const { status, body } = await fetchUrl('https://weworkremotely.com/remote-jobs.rss',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  if (status !== 200) return [];
  try {
    const items = parseRssXml(body);
    return items.map(item => ({
      id: `wwr-${Buffer.from(item.link).toString('base64').slice(0, 12)}`,
      source: 'WeWorkRemotely', title: item.title || '',
      company: item.company || item['wwr:company_name'] || '',
      location: 'Remote', remote: true,
      description: cleanText(item.description || ''),
      tags: '', salary: '', salary_min_inr: 0,
      url: item.link || '', posted_at: item.pubDate || new Date().toISOString(),
    }));
  } catch { return []; }
}

async function scrapeLinkedInRSS(keyword) {
  const { status, body } = await fetchUrl(
    `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}&f_JT=F&sortBy=DD&format=rss`
  );
  if (status !== 200) return [];
  try {
    const items = parseRssXml(body);
    return items.slice(0, 30).map(item => ({
      id: `linkedin-rss-${Buffer.from(item.link).toString('base64').slice(0, 12)}`,
      source: 'LinkedIn', title: item.title || '', company: item.source || '',
      location: 'Remote', remote: true,
      description: cleanText(item.description || ''),
      tags: '', salary: '', salary_min_inr: 0,
      url: item.link || '', posted_at: item.pubDate || new Date().toISOString(),
    }));
  } catch { return []; }
}

async function scrapeLinkedInCookie(keyword) {
  const cookieStr = process.env.LINKEDIN_COOKIES || '';
  if (!cookieStr || cookieStr.length < 20) return [];
  const urls = [
    `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(keyword)}&location=Mumbai&f_JT=F&sortBy=DD`,
    `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(keyword)}&location=Mumbai&f_WT=2&f_JT=F&sortBy=DD`,
  ];
  for (const url of urls) {
    const { status, body } = await fetchUrl(url, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', cookieStr);
    if (status !== 200) continue;
    const jobs = [];
    // JSON-LD extraction
    const jsonLdMatches = body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
    for (const match of jsonLdMatches) {
      try {
        const json = JSON.parse(match[1]);
        if (json['@graph']?.length) {
          for (const item of json['@graph']) {
            if (item['@type'] === 'JobPosting' && item.jobTitle) {
              jobs.push({
                id: `linkedin-cookie-${Buffer.from(item.url || item.jobTitle).toString('base64').slice(0, 12)}`,
                source: 'LinkedIn', title: item.jobTitle || '',
                company: item.hiringOrganization?.name || '',
                location: item.workplaceLocation?.address || 'Mumbai, India',
                remote: item.jobLocationType === 'REMOTE',
                description: cleanText(item.description || ''),
                tags: Array.isArray(item.skills) ? item.skills.join(', ') : '',
                salary: item.baseSalary?.value?.minValue ? `$${item.baseSalary.value.minValue}` : '',
                salary_min_inr: parseSalaryMin(item.baseSalary?.value?.minValue ? `$${item.baseSalary.value.minValue}` : ''),
                url: item.url || '', posted_at: new Date(item.datePosted || Date.now()).toISOString(),
              });
            }
          }
        }
      } catch { /* skip */ }
    }
    if (jobs.length > 0) return jobs.slice(0, 30);
  }
  return [];
}

async function scrapeRemoteCo() {
  // Remote.co is currently returning 404; placeholder for when it recovers
  return [];
}

async function scrapeWorkingNomads() {
  // Currently returning 403; placeholder
  return [];
}

async function scrapeNaukri() {
  // Blocks automated access; placeholder
  return [];
}

async function scrapeIndeedIndia() {
  // Blocks automated access; placeholder
  return [];
}

// ── Free-to-apply sources (Greenhouse/Lever/Workable APIs) ────────────────────────

async function scrapeGreenhouse(board, keyword) {
  const { status, body } = await fetchUrl(
    `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true&limit=50`
  );
  if (status !== 200) return [];
  try {
    const { jobs = [] } = JSON.parse(body);
    return jobs
      .filter(j => j.title && j.title.length > 3)
      .map(j => {
        const location = j.location?.name || 'Remote';
        const isRemote = location.toLowerCase().includes('remote');
        return {
          id: `greenhouse-${board}-${j.id}`,
          source: `Greenhouse:${board}`,
          title: j.title || '',
          company: board,
          location: location,
          remote: isRemote,
          description: cleanText(j.content || '').slice(0, 500),
          tags: (j.departments || []).join(', '),
          salary: '',
          salary_min_inr: 0,
          url: j.absolute_url || '',
          posted_at: j.updated_at || new Date().toISOString(),
        };
      });
  } catch { return []; }
}

async function scrapeGreenhouseFiltered(keyword) {
  // Companies using Greenhouse with cloud/GCP/engineering roles
  const boards = [
    'Cloudflare', 'Stripe', 'Datadog', 'Databricks', 'MongoDB', 'Elastic', 'Okta', 'Block',
    'Roku', 'Roblox', 'Pinterest', 'Coinbase', 'Robinhood', 'Brex', 'Dropbox', 'Asana',
    'Intercom', 'Mixpanel', 'Amplitude', 'Monzo', 'Chime', 'GoCardless', 'Fastly', 'Netlify',
    // Added 2026-09-23
    'Twilio', 'Lyft', 'Airbnb', 'Discord', 'Twitch', 'Reddit', 'Instacart',
    'Figma', 'Vercel', 'NewRelic', 'SumoLogic', 'PagerDuty',
    'Baidu', 'DiDi', 'Coupang', 'Mercari'
  ];
  const allResults = await Promise.allSettled(
    boards.map(board => scrapeGreenhouse(board, keyword))
  );
  return allResults
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value.filter(Boolean));
}

async function scrapeLever(board, keyword) {
  const { status, body } = await fetchUrl(
    `https://lever.co/${board}/feed.xml`
  );
  if (status !== 200 && status !== 308) return [];
  try {
    const items = parseRssXml(body);
    return items.map(item => ({
      id: `lever-${board}-${Buffer.from(item.link).toString('base64').slice(0, 12)}`,
      source: `Lever:${board}`,
      title: item.title || '',
      company: board,
      location: item.location || 'Remote',
      remote: (item.location || '').toLowerCase().includes('remote'),
      description: cleanText(item.description || ''),
      tags: '', salary: '', salary_min_inr: 0,
      url: item.link || '', posted_at: item.pubDate || new Date().toISOString(),
    }));
  } catch { return []; }
}

async function scrapeLeverFiltered(keyword) {
  const boards = ['airbnb', 'uber', 'spotify', 'shopify', 'coinbase', 'discord', 'slack', 'netflix'];
  const allResults = await Promise.allSettled(
    boards.map(board => scrapeLever(board, keyword))
  );
  return allResults
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value.filter(Boolean));
}

async function scrapeWorkable(board, keyword) {
  const { status, body } = await fetchUrl(
    `https://wblinks.workable.com/previews/${board}/feed.xml`
  );
  if (status !== 200) return [];
  try {
    const items = parseRssXml(body);
    return items.map(item => ({
      id: `workable-${board}-${Buffer.from(item.link).toString('base64').slice(0, 12)}`,
      source: `Workable:${board}`,
      title: item.title || '',
      company: board,
      location: item.location || 'Remote',
      remote: (item.location || '').toLowerCase().includes('remote'),
      description: cleanText(item.description || ''),
      tags: '', salary: '', salary_min_inr: 0,
      url: item.link || '', posted_at: item.pubDate || new Date().toISOString(),
    }));
  } catch { return []; }
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

async function scrapeAllSources(keywords) {
  const keyword = keywords?.[0] || 'GCP Engineer';

  const results = await Promise.allSettled([
    scrapeLinkedInRSS(keyword),
    scrapeLinkedInCookie(keyword),
    // Free-to-apply sources (direct company APIs - no paywall)
    scrapeGreenhouseFiltered(keyword),
    // Placeholders for blocked sources — they return empty gracefully
    scrapeNaukri(),
    scrapeIndeedIndia(),
  ]);

  const all = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value.filter(Boolean));

  // Deduplicate by URL
  const seen = new Set();
  return all.filter(job => {
    const key = job.url || job.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { scrapeAllSources, parseSalaryMin, scrapeLinkedInCookie, scrapeGreenhouseFiltered, scrapeLeverFiltered };
