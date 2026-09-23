/**
 * main.js — Job Agent CLI Entry Point
 * Handles onboarding setup (--setup), CLI running, and server launch triggers
 */

const { init: initDb, getProfile, saveProfile } = require('./src/db');
const { runSetup } = require('./src/onboarding');
const { run: runScraper } = require('./src/runner');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const SETUP = args.includes('--setup');
const NO_AI = args.includes('--no-ai');
const OPEN = args.includes('--open');
const PORT_ARG = args.find(a => a.startsWith('--port='));
const PORT = PORT_ARG ? parseInt(PORT_ARG.split('=')[1], 10) : 3000;
const CI_MODE = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

// Default profile for CI/CD (when user hasn't configured interactively)
const DEFAULT_PROFILE = {
  name: 'Clinton Almeida',
  email: process.env.EMAIL_TO || 'clinton.s.almeida@gmail.com',
  target_titles: [
    'GCP Engineer',
    'Cloud Engineer',
    'Cloud Architect',
    'Platform Engineer',
    'Site Reliability Engineer',
    'DevOps Engineer',
    'SRE'
  ],
  preferred_locations: ['Remote', 'India', 'Bangalore', 'Mumbai', 'Delhi', 'Hyderabad', 'Pune'],
  experience_years: 5,
  skills: [
    'gcp',
    'google cloud',
    'aws',
    'azure',
    'kubernetes',
    'docker',
    'terraform',
    'python',
    'java',
    'go',
    'ci/cd',
    'devops',
    'cloud'
  ],
  salary_min_inr: 1500000,
  deal_breakers: ['sales engineer', 'account executive', 'business development'],
  resume_path: '',
  created_at: new Date().toISOString()
};

async function main() {
  // Initialize Database (SQLite/JSON fallback)
  initDb();

  // If setup flag, run onboarding wizard
  if (SETUP) {
    await runSetup();
    process.exit(0);
  }

  // Ensure profile exists (auto-create in CI mode)
  let profile = getProfile();
  if (!profile || !profile.name) {
    if (CI_MODE) {
      console.log('\n📋 Profile not found — using CI defaults from main.js');
      saveProfile(DEFAULT_PROFILE);
      profile = DEFAULT_PROFILE;
    } else {
      console.log('\n⚠️  No user profile configured yet!');
      console.log('   Running onboarding setup wizard...\n');
      await runSetup();
      process.exit(0);
    }
  }

  // Default behaviour: run the scraping & ranking loop
  await runScraper({
    noAI: NO_AI,
    openReport: OPEN,
    topN: 40,
    detailEnrich: 15
  });

  process.exit(0);
}

main().catch(e => {
  console.error('\n❌ Fatal CLI error:', e.message);
  process.exit(1);
});
