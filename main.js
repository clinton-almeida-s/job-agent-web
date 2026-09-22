/**
 * main.js — Job Agent CLI Entry Point
 * Handles onboarding setup (--setup), CLI running, and server launch triggers
 */

const { init: initDb, getProfile } = require('./src/db');
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

async function main() {
  // Initialize Database (SQLite/JSON fallback)
  initDb();

  // If setup flag, run onboarding wizard
  if (SETUP) {
    await runSetup();
    process.exit(0);
  }

  // Ensure profile.json or DB profile exists, otherwise run setup
  const profile = getProfile();
  if (!profile || !profile.name) {
    console.log('\n⚠️  No user profile configured yet!');
    console.log('   Running onboarding setup wizard...\n');
    await runSetup();
    process.exit(0);
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
