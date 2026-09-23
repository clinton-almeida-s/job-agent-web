# Job Agent — Automated Cloud Engineering Job Search

An automated job search agent that scrapes 25+ engineering career boards, ranks roles against your profile using a multi-signal scoring engine, and delivers daily email digests. Runs locally or on GitHub Actions — no manual effort required.

**Target:** GCP / Cloud / Platform / SRE roles, remote-first, India.

---

## What It Does

1. **Scrapes 25+ free job boards** — Greenhouse APIs (Cloudflare, Stripe, Datadog, Databricks, MongoDB, etc.), LinkedIn RSS, all without paywalls or subscriptions
2. **Ranks jobs intelligently** — Multi-signal scoring: title match, skills overlap, remote/hybrid fit, salary, recency, deal-breaker filtering (sales/PE roles blocked)
3. **Web dashboard** — Interactive UI at http://localhost:3000 with filters, scores, one-click apply prep
4. **Daily email digest** — Automatically emailed every morning at 8 AM IST via GitHub Actions, even when your computer is off
5. **Persistent tracking** — Jobs, applications, and scrape history stored locally; survives across runs

---

## Architecture

```
job-agent-web/
├── server.js              # Express server + REST API
├── main.js                # CLI entry point (supports --no-ai, --open)
├── .env                   # API keys and email config (NOT committed)
├── data/
│   └── jobs.db.json       # SQLite fallback JSON database
├── public/                # Web dashboard (HTML/CSS/JS)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── src/
│   ├── db.js              # Database layer (SQLite/JSON fallback)
│   ├── scraper.js         # 25+ Greenhouse boards + LinkedIn RSS/cookies
│   ├── matcher.js         # Multi-signal scoring engine (0–120+ pts)
│   ├── runner.js          # Pipeline: scrape → rank → save → report → email
│   ├── onboarding.js      # Interactive CLI wizard
│   ├── coverLetter.js     # AI cover letter generation (optional)
│   ├── email.js           # Resend API email delivery
│   ├── reporter.js        # HTML report generator
│   ├── normalizer.js      # Source standardization
│   └── tracker.js         # Application state tracking
└── .github/workflows/
    └── daily-jobs.yml     # GitHub Actions: daily run at 8 AM IST
```

---

## Installation

```bash
git clone https://github.com/clinton-almeida-s/job-agent-web.git
cd job-agent-web
npm install
```

### Requirements

- Node.js 20+
- `.env` file for API keys (see Setup below)
- No paid subscriptions required — all sources are free

---

## Setup (First-Time Users)

### 1. Run the setup wizard

```bash
node main.js --setup
```

The wizard collects:
- Name, email, phone, LinkedIn handle
- Location preference (Mumbai / Remote / specific cities)
- Years of experience, current role
- Key skills (comma-separated)
- Target job titles (e.g., "GCP Engineer", "Cloud Architect")
- Salary expectations (min in lakhs INR)
- Professional summary for cover letters

This saves to `data/profile.json` and your database.

### 2. Create `.env` for optional features

Create a `.env` file in the project root:

```bash
# Email notifications (required for daily digest)
RESEND_API_KEY=your-resend-api-key
EMAIL_TO=your@email.com
EMAIL_FROM=Job Agent <onboarding@resend.dev>

# AI cover letters (optional — requires Anthropic API)
ANTHROPIC_API_KEY=your-anthropic-key

# LinkedIn Mumbai results (optional — cookies expire in ~3 days)
LINKEDIN_COOKIES=your-session-cookies
```

**Getting a Resend API key:** Sign up free at https://resend.com → API Keys → Create API Key. Free tier gives 100 emails/day.

### 3. Run your first scrape

```bash
node main.js --no-ai
```

This will:
- Scrape all 25 Greenhouse boards + LinkedIn
- Rank jobs against your profile
- Generate an HTML report
- Email the digest (if RESEND_API_KEY is set)

---

## Usage

### Web Dashboard (recommended)

```bash
npm start
```

Opens http://localhost:3000

**Dashboard features:**
- **Job queue** — Cards showing match score, reasons, salary, source
- **Filters** — By status (new/saved/applied/skipped), source, sort by score or date
- **One-click apply** — Opens job page + shows checklist overlay with your details pre-filled
- **Profile editor** — Edit preferences without re-running the wizard
- **Stats bar** — Total jobs, new, applied, skipped counts
- **Scrape Now** — Trigger a fresh scrape from the dashboard

### CLI Mode

```bash
# Quick run (no AI cover letters)
node main.js --no-ai

# With AI cover letters (slow, needs ANTHROPIC_API_KEY)
node main.js

# Open generated report in browser
node main.js --no-ai --open

# Trigger scrape via API (from another terminal)
curl -X POST http://localhost:3000/api/scrape
```

### Stop the dashboard

```bash
# Find the process
netstat -ano | findstr :3000

# Kill it (replace PID)
taskkill /PID <pid> /F
```

---

## How It Ranks Jobs

Jobs score 0–120+ based on weighted signals:

| Signal | Weight | Description |
|--------|--------|-------------|
| Title exact match | 40 pts | Matches target titles exactly |
| Title similarity | 25 pts | Fuzzy match (Jaccard + Levenshtein) |
| Required skills | 15 pts | Matches your required keywords |
| Bonus skills | 5 pts | Matches your bonus keywords |
| Remote | 20 pts | Confirmed remote role |
| Hybrid | 10 pts | Hybrid role in preferred location |
| Location | 15 pts | Matches your preferred locations |
| Employment type | 10 pts | Full-time / permanent |
| Salary fit | 10 pts | Meets minimum salary requirement |
| Recency | 10 pts | Posted within last 7 days |

Jobs below score 20 or matching deal-breakers are filtered out.

### Deal-Breaker Logic

**Hard blockers (always excluded):**
- `sales engineer`, `solutions architect - sales`, `pre-sales`, `technical sales`
- `accounting`, `recruiter`, `hr`, `marketing`, `business development`

**Soft blockers (bypassed for technical titles):**
- Non-technical roles get lower scores automatically

---

## Available Job Sources

| Source | Status | Notes |
|--------|--------|-------|
| **Greenhouse (25 companies)** | ✅ Working | Cloudflare, Stripe, Datadog, Databricks, MongoDB, Elastic, Okta, Block, Roku, Roblox, Pinterest, Coinbase, Robinhood, Brex, Dropbox, Asana, Intercom, Mixpanel, Amplitude, Monzo, Chime, GoCardless, Fastly, PlanetScale, Netlify |
| **LinkedIn RSS** | ✅ Working | Soft approach, limited results |
| **LinkedIn Cookies** | ⚠️ Optional | Needs browser session cookies, works better |
| **Naukri / Indeed** | ❌ Blocked | Sites block automated access |
| **RemoteOK / WWR / Remotive** | ❌ Removed | Paywalled sources removed |

To add more Greenhouse companies, edit `src/scraper.js` line 272 and add the company name to the `boards` array.

---

## Daily Email Automation (GitHub Actions)

The workflow runs automatically every day at **8:00 AM IST** — your computer doesn't need to be on.

### 1. Add GitHub secrets

Go to your repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|--------|-------|
| `RESEND_API_KEY` | Your Resend API key |
| `EMAIL_TO` | `your@email.com` |

Optional secrets:
| Secret | Value |
|--------|-------|
| `ANTHROPIC_API_KEY` | For AI cover letters |
| `LINKEDIN_COOKIES` | For LinkedIn results |

### 2. Trigger manually (for testing)

https://github.com/yourusername/job-agent-web/actions/workflows/daily-jobs.yml → "Run workflow"

### 3. What happens each run

1. Checks out code
2. Installs dependencies
3. Creates a default profile (if none exists)
4. Scrapes all 25 Greenhouse boards + LinkedIn
5. Ranks jobs and generates HTML report
6. Emails digest with top matches
7. Attaches full HTML report
8. Uploads artifact (retained 7 days)

---

## Cloudflare Workers Deployment (Optional)

For a free, always-on cloud deployment:

```bash
npm install -g wrangler
wrangler login

# Create KV namespace
wrangler kv namespace create JOBS_KV

# Set secrets
wrangler secret put RESEND_API_KEY
wrangler secret put EMAIL_TO

# Deploy
wrangler deploy
```

Your dashboard will be live at `https://job-agent-web.<your-subdomain>.workers.dev`

---

## File Structure

| File | Purpose |
|------|---------|
| `server.js` | Express server — REST API + static file serving |
| `main.js` | CLI entry point — routes to setup or runner |
| `.env` | API keys and email config (keep secret!) |
| `data/jobs.db.json` | Persistent database of all jobs |
| `data/profile.json` | Your job search preferences |
| `src/db.js` | Database layer — SQLite with JSON fallback |
| `src/scraper.js` | Source registry — fetches from job boards |
| `src/matcher.js` | Scoring engine — ranks jobs against profile |
| `src/runner.js` | Pipeline orchestrator — scrape → rank → save → email |
| `src/email.js` | Resend API email delivery |
| `src/reporter.js` | HTML report generator |
| `src/onboarding.js` | Interactive CLI wizard |
| `public/index.html` | Dashboard HTML |
| `public/app.js` | Dashboard JavaScript |
| `.github/workflows/daily-jobs.yml` | GitHub Actions daily schedule |

---

## Troubleshooting

### No jobs found

```bash
# Test scraping directly
node -e "const { scrapeAllSources } = require('./src/scraper'); scrapeAllSources(['GCP']).then(j => console.log(j.length, 'jobs'))"
```

### Dashboard not loading

```bash
# Check if server is running
netstat -ano | findstr :3000

# Kill stale processes
taskkill /IM node.exe /F
npm start
```

### Email not sending

1. Verify `.env` has `RESEND_API_KEY=your-actual-key`
2. Check Resend dashboard for sent emails
3. Look at spam folder

### LinkedIn returns no results

Your cookies have expired. Refresh them following the LinkedIn Cookie Setup section below.

### LinkedIn Cookie Setup

LinkedIn blocks automated access. To get results:

1. Open LinkedIn while logged in
2. Press F12 → Network tab → Refresh page
3. Click any `linkedin.com` request
4. Go to **Headers** → **Request Headers** → find `cookie:`
5. Copy the entire value
6. Add to `.env`: `LINKEDIN_COOKIES=your-cookie-string-here`

> Note: LinkedIn cookies expire after a few days. Update periodically.

---

## License

ISC
