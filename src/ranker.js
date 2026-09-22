/**
 * Job Ranker — scores listings against Clinton's profile
 * Returns top N jobs sorted by relevance score
 */

const profile = require('../profile.json');
const { parseSalaryMin } = require('./scraper');

// ── scoring constants ─────────────────────────────────────────────────────────

const TITLE_MATCH_SCORE     = 45;   // job title matches a target title
const ENGINEER_TITLE_SCORE  = 30;   // job has "Engineer" or "Architect" in title (cloud domain)
const REQUIRED_KW_SCORE     = 20;   // per required keyword (increased for better relevance)
const BONUS_KW_SCORE        = 5;    // per bonus keyword found
const REMOTE_SCORE          = 20;   // confirmed remote role
const HYBRID_SCORE          = 10;   // hybrid work option
const RECENCY_SCORE         = 15;   // posted within last 7 days
const DEAL_BREAKER_PENALTY  = -999; // instant disqualify
const MIN_SCORE_THRESHOLD   = 15;   // lowered from 30 to surface more matching jobs
const SALARY_MIN_LAKHS      = profile.target_salary?.min_lakhs || 35; // Minimum salary requirement

// ── helpers ───────────────────────────────────────────────────────────────────

function normalize(str) {
  return (str || '').toLowerCase();
}

function containsAny(text, keywords) {
  const t = normalize(text);
  return keywords.filter(kw => {
    const n = normalize(kw);
    // word-boundary match to avoid partial hits (e.g., "contract" in "contractor")
    const regex = new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    return regex.test(t);
  });
}

function isRecent(dateStr) {
  if (!dateStr) return false;
  const posted = new Date(dateStr);
  const diffDays = (Date.now() - posted.getTime()) / 86400000;
  return diffDays <= 7;
}

/**
 * Score a single job against the profile.
 * Returns the job object with `score` and `match_reasons` added.
 */
function scoreJob(job) {
  const fullText = [job.title, job.description, job.tags, job.company, job.location].join(' ');
  let score = 0;
  const reasons = [];
  const warnings = [];

  // 1. deal-breaker check — only check title and company, not full description
  // (descriptions often mention sales/marketing in context of tools used)
  const textForDealBreakers = [job.title, job.company].join(' ');
  const breakers = containsAny(textForDealBreakers, profile.deal_breakers);

  // Smart blocking: if title has engineering keywords, don't block for sales/marketing mentions
  // (e.g., "Sales Engineer" is valid, but "Sales Manager" is not)
  const isTechnicalTitle = containsAny(job.title, ['engineer', 'architect', 'developer', 'technical', 'consultant']);
  if (breakers.length > 0) {
    const softBreakers = ['sales', 'marketing', 'business development', 'customer service', 'customer success'];
    const hardBlockers = breakers.filter(b => !softBreakers.includes(b));

    // Block immediately for hard deal-breakers
    if (hardBlockers.length > 0) {
      return { ...job, score: DEAL_BREAKER_PENALTY, match_reasons: [], warnings: [`Deal-breaker: ${hardBlockers.join(', ')}`] };
    }

    // For soft breakers, only block if title doesn't look technical
    if (!isTechnicalTitle) {
      return { ...job, score: DEAL_BREAKER_PENALTY, match_reasons: [], warnings: [`Deal-breaker: ${breakers.join(', ')}`] };
    }
    // If technical title, continue scoring (e.g., Sales Engineer is valid)
  }

  // 2. title match
  const matchedTitles = containsAny(job.title, profile.target_titles);
  if (matchedTitles.length > 0) {
    score += TITLE_MATCH_SCORE;
    reasons.push(`Title match: ${matchedTitles.join(', ')}`);
  }

  // 3. required keywords
  const matchedRequired = containsAny(fullText, profile.required_keywords);
  score += matchedRequired.length * REQUIRED_KW_SCORE;
  if (matchedRequired.length > 0) {
    reasons.push(`Keywords: ${matchedRequired.slice(0, 4).join(', ')}${matchedRequired.length > 4 ? '...' : ''}`);
  }

  // 4. Title match bonus for general cloud/IT roles
  // Even without exact title match, cloud-related roles get credit
  if (matchedTitles.length === 0) {
    const isEngineerArchitect = containsAny(job.title, ['engineer', 'architect', 'platform', 'infrastructure', 'sre', 'devops', 'ops', 'support']);
    const isCloudRelated = containsAny(fullText, ['cloud', 'gcp', 'google cloud', 'aws', 'azure', 'migration', 'bigquery']);

    if (isEngineerArchitect && isCloudRelated) {
      score += ENGINEER_TITLE_SCORE;
      reasons.push('Cloud engineering role');
    } else if (isCloudRelated) {
      score += 15;
      reasons.push('Cloud-related content');
    }
  }

  // 4. bonus keywords
  const matchedBonus = containsAny(fullText, profile.bonus_keywords);
  score += matchedBonus.length * BONUS_KW_SCORE;
  if (matchedBonus.length > 0) {
    reasons.push(`Bonus keywords: ${matchedBonus.slice(0, 3).join(', ')}`);
  }

  // 5. location confirmation (Remote or Mumbai)
  const isRemote = job.remote ||
    normalize(job.location).includes('remote') ||
    containsAny(fullText, ['remote', 'work from home', 'wfh']).length > 0;

  const isMumbai = containsAny(job.location + ' ' + fullText, ['mumbai']);
  const isHybrid = normalize(job.location).includes('hybrid') ||
    containsAny(fullText, ['hybrid']).length > 0;

  if (isRemote) {
    score += REMOTE_SCORE;
    reasons.push('Remote confirmed');
  } else if (isHybrid && isMumbai) {
    score += HYBRID_SCORE;
    reasons.push('Hybrid role in Mumbai');
  } else if (isMumbai) {
    score += REMOTE_SCORE;
    reasons.push('Location match: Mumbai');
  } else {
    warnings.push('Not remote and not in Mumbai — verify location before applying');
  }

  // 6. Salary filtering
  const salaryMin = parseSalaryMin(job.salary);
  const minSalaryRequired = SALARY_MIN_LAKHS * 100000;
  if (salaryMin > 0 && salaryMin < minSalaryRequired) {
    return { ...job, score: DEAL_BREAKER_PENALTY, match_reasons: [], warnings: [`Salary below threshold: ${job.salary} (min ₹${SALARY_MIN_LAKHS} LPA)`] };
  }
  if (salaryMin >= minSalaryRequired) {
    score += 10;
    reasons.push(`Salary meets requirement: ${job.salary}`);
  }

  // 6. recency bonus
  if (isRecent(job.posted_at)) {
    score += RECENCY_SCORE;
    reasons.push('Posted within last 7 days');
  }

  // 7. zero-score jobs must at least mention some cloud tech
  if (score < MIN_SCORE_THRESHOLD) {
    warnings.push('Low cloud tech signal — likely irrelevant');
  }

  return { ...job, score, match_reasons: reasons, warnings };
}

/**
 * Rank all jobs and return top N, filtering out deal-breakers.
 */
function rankJobs(jobs, topN = 10) {
  return jobs
    .map(scoreJob)
    .filter(j => j.score >= MIN_SCORE_THRESHOLD) // Strict filter for high relevance
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

module.exports = { rankJobs, scoreJob };
