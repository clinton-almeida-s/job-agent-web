/**
 * Matcher — multi-signal job scoring engine
 * Replaces the old keyword-only ranker with weighted signal scoring
 */

const profile = require('../profile.json');
const { parseSalaryMin } = require('./scraper');

// ── Scoring weights ──────────────────────────────────────────────────────────

const SIGNALS = {
  titleExact:       { weight: 40, label: 'Title match' },
  titleSimilar:     { weight: 25, label: 'Title similarity' },
  requiredSkills:   { weight: 15, label: 'Required skills' },
  bonusSkills:      { weight: 5,  label: 'Bonus skills' },
  remote:           { weight: 20, label: 'Remote' },
  hybrid:           { weight: 10, label: 'Hybrid' },
  location:         { weight: 15, label: 'Location match' },
  employmentType:   { weight: 10, label: 'Employment type' },
  salary:           { weight: 10, label: 'Salary fit' },
  recency:          { weight: 10, label: 'Recency' },
  cloudSignal:      { weight: 12, label: 'Cloud signal' },
};

const MIN_SCORE = 20;
const DEAL_BREAKER_PENALTY = -999;
const SOFT_BREAKERS = ['sales', 'marketing', 'business development', 'customer service', 'customer success'];
const HARD_BREAKERS = ['sales engineer', 'sales engineering', 'pre-sales', 'presales', 'solutions engineer', 'solutions architect - sales', 'technical sales', 'field sales'];
const TECH_TITLE_KEYWORDS = ['engineer', 'architect', 'developer', 'technical', 'consultant', 'lead', 'manager'];

function normalize(str) {
  if (Array.isArray(str)) str = str.join(' ');
  return String(str || '').toLowerCase().replace(/[^\w\s]/g, ' ');
}

function containsAny(text, keywords, loose = false) {
  const t = normalize(text);
  return keywords.filter(kw => {
    const n = normalize(kw);
    if (loose) return t.includes(n);
    const regex = new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    return regex.test(t);
  });
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
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
    // Word-overlap Jaccard
    const tWords = new Set(t.split(/\s+/));
    const targetWords = new Set(targetNorm.split(/\s+/));
    const intersection = [...tWords].filter(w => targetWords.has(w)).length;
    const union = new Set([...tWords, ...targetWords]).size;
    const jaccard = union > 0 ? intersection / union : 0;
    // Levenshtein ratio on first words
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
  return containsAny(title, TECH_TITLE_KEYWORDS, true).length > 0;
}

function checkDealBreakers(job) {
  const text = [job.title, job.company].join(' ');
  const breakers = containsAny(text, (profile.deal_breakers || []), true);
  if (breakers.length === 0) return null;

  const hardBlockers = breakers.filter(b => !SOFT_BREAKERS.includes(b));
  if (hardBlockers.length > 0) {
    return { blocked: true, reason: `Deal-breaker: ${hardBlockers.join(', ')}` };
  }
  if (!isTechnicalTitle(job.title)) {
    return { blocked: true, reason: `Deal-breaker: ${breakers.join(', ')}` };
  }
  // Additional hard blockers for sales engineer roles that slip through
  const titleLower = normalize(job.title);
  const salesEngineerBlocks = containsAny(titleLower, HARD_BREAKERS, true);
  if (salesEngineerBlocks.length > 0) {
    return { blocked: true, reason: `Deal-breaker: ${salesEngineerBlocks.join(', ')}` };
  }
  return { blocked: false, softBreakers: breakers };
}

/**
 * Score a single job against the user profile.
 * Returns job with score, match_reasons, and warnings.
 */
function scoreJob(job) {
  const fullText = [job.title, job.description, job.tags, job.company, job.location].join(' ');
  let score = 0;
  const reasons = [];
  const warnings = [];

  // Deal-breaker check (title + company only)
  const breakerResult = checkDealBreakers(job);
  if (breakerResult?.blocked) {
    return { ...job, score: DEAL_BREAKER_PENALTY, match_reasons: [], warnings: [breakerResult.reason] };
  }
  if (breakerResult?.softBreakers) {
    warnings.push(`Contains soft-breaker keywords: ${breakerResult.softBreakers.join(', ')}`);
  }

  // 1. Title exact match
  const titleMatch = containsAny(job.title, profile.target_titles, false);
  if (titleMatch.length > 0) {
    score += SIGNALS.titleExact.weight;
    reasons.push(`${SIGNALS.titleExact.label}: "${titleMatch[0]}"`);
  }

  // 2. Title similarity (fuzzy)
  if (titleMatch.length === 0) {
    const simScore = titleSimilarity(job.title, profile.target_titles);
    if (simScore > 0.3) {
      const bonus = Math.round(SIGNALS.titleSimilar.weight * simScore);
      score += bonus;
      reasons.push(`${SIGNALS.titleSimilar.label}: ${Math.round(simScore * 100)}%`);
    }
  }

  // 3. Required skills
  const reqMatches = containsAny(fullText, profile.required_keywords, false);
  score += reqMatches.length * 8;
  if (reqMatches.length > 0) {
    reasons.push(`${SIGNALS.requiredSkills.label}: ${reqMatches.slice(0, 4).join(', ')}${reqMatches.length > 4 ? '...' : ''}`);
  }

  // 4. Bonus skills
  const bonusMatches = containsAny(fullText, profile.bonus_keywords, false);
  score += bonusMatches.length * SIGNALS.bonusSkills.weight;
  if (bonusMatches.length > 0) {
    reasons.push(`${SIGNALS.bonusSkills.label}: ${bonusMatches.slice(0, 3).join(', ')}`);
  }

  // 5. Cloud signal (fallback when no exact title match)
  const cloudTerms = ['cloud', 'gcp', 'google cloud', 'aws', 'azure', 'bigquery', 'pub/sub', 'terraform', 'kubernetes', 'airflow', 'migration'];
  const cloudMatches = containsAny(fullText, cloudTerms, true);
  if (cloudMatches.length > 0 && titleMatch.length === 0) {
    const bonus = Math.min(SIGNALS.cloudSignal.weight, cloudMatches.length * 4);
    score += bonus;
    if (isTechnicalTitle(job.title)) {
      reasons.push(`${SIGNALS.cloudSignal.label}: ${cloudMatches.slice(0, 3).join(', ')}`);
    }
  }

  // 6. Remote / Hybrid / Location
  const isRemote = job.remote || normalize(job.location).includes('remote') || containsAny(fullText, ['remote', 'work from home', 'wfh']).length > 0;
  const isHybrid = normalize(job.location).includes('hybrid') || containsAny(fullText, ['hybrid']).length > 0;
  const isMumbai = containsAny(job.location + ' ' + fullText, ['mumbai'], true).length > 0;

  if (isRemote) {
    score += SIGNALS.remote.weight;
    reasons.push(SIGNALS.remote.label);
  } else if (isHybrid && isMumbai) {
    score += SIGNALS.hybrid.weight;
    reasons.push(SIGNALS.hybrid.label);
  } else if (isMumbai) {
    score += SIGNALS.location.weight;
    reasons.push(`${SIGNALS.location.label}: Mumbai`);
  } else if (!isRemote && !isHybrid) {
    warnings.push('Not remote and not in Mumbai — verify location');
  }

  // 7. Employment type
  const workType = normalize(job.location).includes('contract') || normalize(fullText).includes('contract') ? 'contract' : 'full-time';
  const employmentMatch = containsAny([workType], profile.preferred_employment || ['full-time'], false);
  if (employmentMatch.length > 0) {
    score += SIGNALS.employmentType.weight;
    reasons.push(`${SIGNALS.employmentType.label}: ${employmentMatch[0]}`);
  } else if (workType === 'contract') {
    warnings.push('Contract role — preferred is permanent');
  }

  // 8. Salary
  const salaryMin = parseSalaryMin(job.salary);
  const minSalaryReq = (profile.target_salary?.min_lakhs || 35) * 100000;
  if (salaryMin > 0) {
    if (salaryMin < minSalaryReq) {
      return { ...job, score: DEAL_BREAKER_PENALTY, match_reasons: [], warnings: [`Salary below threshold: ${job.salary} (min ₹${profile.target_salary?.min_lakhs || 35} LPA)`] };
    }
    score += SIGNALS.salary.weight;
    reasons.push(`${SIGNALS.salary.label}: ${job.salary}`);
  }

  // 9. Recency
  if (isRecent(job.posted_at)) {
    score += SIGNALS.recency.weight;
    reasons.push(SIGNALS.recency.label);
  }

  if (score < MIN_SCORE) {
    warnings.push('Low relevance score');
  }

  return { ...job, score, match_reasons: reasons, warnings };
}

/**
 * Rank all jobs, filter deal-breakers, return top N
 */
function rankJobs(jobs, topN = 40) {
  return jobs
    .map(scoreJob)
    .filter(j => j.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

module.exports = { scoreJob, rankJobs, MIN_SCORE, DEAL_BREAKER_PENALTY };
