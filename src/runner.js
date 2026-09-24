/**
 * Runner — orchestrates scrape → rank → update DB → generate report
 * This is the core pipeline, called by both CLI and server
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { scrapeAllSources, parseSalaryMin } = require('./scraper');
const { rankJobs } = require('./matcher');
const { saveReport } = require('./reporter');
const {
  getProfile, upsertJob, getNewJobCount,
  startScrapeRun, finishScrapeRun, getStats
} = require('./db');
const { generateCoverLetter } = require('./coverLetter');
const { sendDailyDigest } = require('./email');

async function run(options = {}) {
  const { headless = true, noAI = false, openReport = false, topN = 40, detailEnrich = 15 } = options;
  const profile = getProfile();
  if (!profile) {
    console.log('⚠️  No profile found. Run `node main.js --setup` first.');
    process.exit(1);
  }

  console.log('\n🔎 Job Agent starting —', new Date().toLocaleString());
  console.log(`   Searching: ${profile.target_titles.slice(0, 4).join(', ')}...\n`);

  // 1. Scrape
  console.log('📡 Scraping job boards...');
  const runId = startScrapeRun();
  let allJobs;
  try {
    allJobs = await scrapeAllSources(profile.required_keywords);
  } catch (e) {
    console.error('❌ Scraping failed:', e.message);
    finishScrapeRun(runId, { totalFetched: 0, totalNew: 0, totalMatched: 0 });
    return { jobs: [], reportPath: null, stats: getStats() };
  }
  console.log(`   Found ${allJobs.length} raw listings`);

  // 2. Save to DB
  let savedCount = 0;
  for (const job of allJobs) {
    upsertJob(job);
    savedCount++;
  }
  console.log(`   Saved ${savedCount} jobs to database`);

  // 3. Enrich details for top candidates
  if (detailEnrich > 0 && allJobs.length > 0) {
    console.log(`   Enriching top ${Math.min(detailEnrich, allJobs.length)} jobs with additional details...`);
    // Detail enrichment would go here (fetch individual job pages)
  }

  // 4. Rank
  console.log('\n📊 Ranking jobs against your profile...');
  const ranked = rankJobs(allJobs, topN * 3); // get more than topN to filter down
  const topJobs = ranked.filter(j => j.score >= 20).slice(0, topN);
  console.log(`   ${topJobs.length} relevant jobs found (from ${allJobs.length} total)`);

  // 5. Cover letters (optional)
  if (!noAI && process.env.ANTHROPIC_API_KEY) {
    console.log('\n✍️  Generating cover letters...');
    for (let i = 0; i < topJobs.length; i++) {
      process.stdout.write(`   [${i + 1}/${topJobs.length}] ${topJobs[i].title.slice(0, 40)}...`);
      try {
        topJobs[i].cover_letter = await generateCoverLetter(topJobs[i]);
        console.log(' ✅');
      } catch (e) {
        console.log(` ⚠️ (${e.message})`);
      }
      if (i < topJobs.length - 1) await new Promise(r => setTimeout(r, 300));
    }
  } else {
    console.log('\n✋ Skipping cover letter generation (--no-ai or no API key)');
  }

  // 6. Update job statuses in DB
  topJobs.forEach(j => upsertJob({ ...j, score: j.score, match_reasons: j.match_reasons, warnings: j.warnings || [] }));

  // 7. Generate report
  console.log('\n📄 Generating HTML report...');
  const reportPath = saveReport(topJobs, getStats());
  console.log(`   Report: ${reportPath}`);

  // 8. Finish scrape run
  finishScrapeRun(runId, {
    totalFetched: allJobs.length,
    totalNew: topJobs.length,
    totalMatched: ranked.filter(j => j.score >= 20).length
  });

  // 9. Console summary
  console.log('\n' + '━'.repeat(60));
  console.log(`🏆 TOP ${topJobs.length} JOBS:`);
  console.log('━'.repeat(60));
  topJobs.slice(0, 10).forEach((j, i) => {
    console.log(`\n${i + 1}. ${j.title} — ${j.company}`);
    console.log(`   Score: ${j.score} pts | Source: ${j.source}`);
    console.log(`   ${j.url}`);
    j.match_reasons.slice(0, 3).forEach(r => console.log(`   ✅ ${r}`));
  });
  console.log('\n' + '━'.repeat(60));
  console.log(`✨ Done! ${topJobs.length} jobs found.`);
  console.log(`   Dashboard: http://localhost:3000`);
  console.log(`   Report: ${reportPath}\n`);

  // 10. Send email digest if configured
  if (profile?.email && process.env.RESEND_API_KEY) {
    console.log('\n📧 Sending daily email digest...');
    try {
      const emailResult = await sendDailyDigest(topJobs, getStats(), profile.email);
      console.log(`   Email ${emailResult.success ? 'sent successfully' : 'failed: ' + emailResult.reason}`);
    } catch (e) {
      console.log('   Email error:', e.message);
    }
  } else {
    console.log('\n✉️  Skipping email (no RESEND_API_KEY or email in profile)');
  }

  return { jobs: topJobs, reportPath, stats: getStats() };
}

module.exports = { run };
