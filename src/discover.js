/**
 * Board Discovery Engine — Finds new Greenhouse/Lever companies
 * Discovers new job boards by scanning public sources and validating them
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Seed companies (start here and expand outward) ──────────────────────────
const SEED_COMPANIES = [
  // Cloud/Platform
  'Cloudflare', 'Stripe', 'Datadog', 'Databricks', 'MongoDB', 'Elastic', 'Okta', 'Block',
  'Snowflake', 'Twilio', 'Vercel', 'Figma', 'Notion', 'Linear', 'Clerk', 'Supabase',

  // Social/Content
  'Discord', 'Twitch', 'Reddit', 'Pinterest', 'Instagram', 'Spotify', 'Netflix',

  // E-commerce/Retail
  'Shopify', 'Etsy', 'Wayfair', 'Instacart', 'DoorDash', 'Grubhub',

  // Fintech
  'Coinbase', 'Robinhood', 'Brex', 'Plaid', 'Square', 'PayPal', 'Venmo',

  // Productivity
  'Asana', 'Monday', 'Notion', 'Linear', 'Coda', 'Airtable',

  // Logistics
  'Uber', 'Lyft', 'Doordash', 'Grubhub', 'Postmates',

  // Healthcare
  'Teladoc', 'Amwell', 'Zocdoc', 'Oscar Health',

  // Real Estate
  'Zillow', 'Redfin', 'Compass', 'Realtor.com',

  // Education
  'Coursera', 'Udemy', 'Duolingo', 'Chegg',

  // Media/Entertainment
  'Spotify', 'Netflix', 'Hulu', 'Disney+',

  // Sports
  'ESPN', 'Strava', 'Nike', 'Adidas',

  // Food Delivery
  'DoorDash', 'Grubhub', 'UberEats', 'Postmates',

  // Travel
  'Airbnb', 'Booking.com', 'Expedia', 'Kayak',

  // News/Media
  'BuzzFeed', 'Vox', 'BuzzFeed', 'AOL',

  // Tech Companies (common Greenhouse users)
  'Nvidia', 'AMD', 'Intel', 'Cisco', 'Juniper', ' Palo Alto Networks',

  // Crypto/Web3
  'Coinbase', 'Kraken', 'Gemini', 'Blockchain.com',

  // E-commerce Platforms
  'Shopify', 'BigCommerce', 'Magento', 'WooCommerce'
];

// ── Public lists of Greenhouse customers (crowdsourced) ──────────────────────
const PUBLIC_LISTS = [
  // GitHub gist with popular Greenhouse customers
  'https://gist.githubusercontent.com/...', // You can add public gists here
];

// ── Helper functions ─────────────────────────────────────────────────────────

function fetchUrl(url, options = {}) {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : require('http');
    const req = protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ status: 0, error: 'Timeout' });
    });
  });
}

function isValidGreenhouseBoard(company) {
  // Validate if a company uses Greenhouse by checking their careers page
  const checks = [
    `https://boards.greenhouse.io/${company.toLowerCase()}`,
    `https://${company.toLowerCase()}.greenhouse.io`
  ];

  return checks.some(async url => {
    try {
      const resp = await fetchUrl(url);
      return resp.status === 200 && resp.body.includes('boards.greenhouse.io');
    } catch {
      return false;
    }
  });
}

async function discoverFromSeed(seedCompanies, existingBoards) {
  const newBoards = [];
  const validated = new Set(existingBoards);

  for (const company of seedCompanies) {
    const name = company.trim();
    if (validated.has(name)) continue;

    console.log(`  Checking ${name}...`);

    // Quick validation via Greenhouse API
    const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${name}/jobs?limit=1`;
    const resp = await fetchUrl(apiUrl);

    if (resp.status === 200) {
      console.log(`    ✓ ${name} uses Greenhouse`);
      newBoards.push(name);
      validated.add(name);
    } else {
      console.log(`    ✗ ${name} not found or not using Greenhouse`);
    }

    // Be polite - rate limit requests
    await new Promise(r => setTimeout(r, 500));
  }

  return newBoards;
}

async function discoverFromPublicLists() {
  // Fetch from public GitHub gists and other sources
  const discovered = new Set();

  // Example: Public Greenhouse customer lists
  const sources = [
    {
      name: 'Greenhouse Customer List (GitHub Gist)',
      url: 'https://api.github.com/gists/public', // This is just an example - replace with actual gists
      transform: (html) => {
        // Extract company names from HTML
        return html.match(/boards\.greenhouse\.io\/(\w+)/g)?.map(m => m.replace('boards.greenhouse.io/', '')) || [];
      }
    }
  ];

  for (const source of sources) {
    console.log(`  Fetching from ${source.name}...`);
    const resp = await fetchUrl(source.url);

    if (resp.status === 200 && source.transform) {
      const companies = source.transform(resp.body);
      companies.forEach(c => discovered.add(c));
    }
  }

  return Array.from(discovered);
}

// ── Main discovery function ──────────────────────────────────────────────────

async function discoverNewBoards() {
  console.log('🔍 Starting board discovery...\n');

  // Load existing boards
  let existingBoards = [];
  try {
    const boardsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'boards.json'), 'utf-8'));
    existingBoards = boardsData.greenhouse || [];
    console.log(`📋 Existing boards: ${existingBoards.length}\n`);
  } catch {
    console.log('⚠️ No existing boards found\n');
  }

  const newBoards = [];

  // Phase 1: Discover from seed companies
  console.log('🌱 Phase 1: Checking seed companies...');
  const seedResults = await discoverFromSeed(SEED_COMPANIES, existingBoards);
  newBoards.push(...seedResults);

  // Phase 2: Discover from public lists
  console.log('\n🌐 Phase 2: Scanning public lists...');
  const publicResults = await discoverFromPublicLists();
  newBoards.push(...publicResults);

  // Deduplicate
  const uniqueNewBoards = [...new Set(newBoards)];

  console.log(`\n✅ Discovery complete:`);
  console.log(`   New boards found: ${uniqueNewBoards.length}`);
  console.log(`   Total boards now: ${existingBoards.length + uniqueNewBoards.length}`);

  return {
    newBoards: uniqueNewBoards,
    totalBoards: existingBoards.length + uniqueNewBoards.length,
    timestamp: new Date().toISOString()
  };
}

// ── CLI entry point ─────────────────────────────────────────────────────────

if (require.main === module) {
  discoverNewBoards()
    .then(results => {
      // Save results for the next step
      fs.writeFileSync(
        path.join(__dirname, '..', 'data', 'discovery_results.json'),
        JSON.stringify(results, null, 2)
      );
      console.log('\n💾 Results saved to data/discovery_results.json');

      if (results.newBoards.length > 0) {
        console.log('\n📋 New boards to add:');
        results.newBoards.forEach(b => console.log(`  • ${b}`));
      }
    })
    .catch(err => {
      console.error('❌ Discovery failed:', err.message);
      process.exit(1);
    });
}

module.exports = { discoverNewBoards };
