# Job Agent — Interactive Cloud Job Search

An interactive job search agent that scrapes GCP / Cloud / Platform Engineering roles, ranks them against your profile, and presents them in a web dashboard with one-click apply preparation.

**Target:** Mumbai-based or remote cloud roles with salary ₹35 LPA+.

---

## What It Does

1. **Scrapes job boards** — RemoteOK, Remotive, We Work Remotely, LinkedIn RSS (and cookie-based), with graceful fallbacks for blocked sources
2. **Ranks jobs** — Multi-signal scoring: title similarity, skill overlap, remote/hybrid fit, salary, recency, deal-breaker filtering
3. **Web dashboard** — Review queue with filters, scores, match reasons, and one-click apply prep
4. **Interactive setup** — `node main.js --setup` wizard collects your preferences
5. **Email notifications** — Daily/weekly digests via Resend API (optional)
6. **Persistent tracking** — SQLite (or JSON fallback) stores jobs, applications, scrape history

---

## Architecture

```
job-agent/
├── server.js              # Express server + REST API
├── main.js                # CLI entry point
├── profile.json           # Your preferences (read by CLI/server)
├── data/
│   └── jobs.db.json       # SQLite fallback JSON (persistent)
├── public/                # Web dashboard
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── src/
│   ├── db.js              # Database layer (SQLite/JSON fallback)
│   ├── scraper.js         # Source registry — fetches from job boards
│   ├── matcher.js         # Multi-signal scoring engine
│   ├── runner.js          # Pipeline: scrape → rank → save → report
│   ├── onboarding.js      # Interactive CLI wizard
│   ├── coverLetter.js     # AI cover letter generation
│   └── email.js           # Resend email notifications
└── .github/workflows/
    └── daily-jobs.yml     # GitHub Actions schedule
```

---

## Installation

```bash
# Clone the repo
git clone https://github.com/clinton-almeida-s/job-agent-web.git
cd job-agent-web

# Install dependencies
npm install
```

### Requirements

- Node.js 20+
- `ANTHROPIC_API_KEY` — optional, for AI cover letters
- `RESEND_API_KEY` + `EMAIL_TO` — optional, for email notifications
- `LINKEDIN_COOKIES` — optional, for LinkedIn Mumbai results

---

## Setup

### 1. Run the setup wizard

```bash
node main.js --setup
```

The wizard will ask for:
- Name, email, phone, LinkedIn handle
- Location preference (Mumbai / Remote)
- Years of experience, current role, company
- Key skills (comma-separated)
- Target job titles
- Required and bonus keywords
- Preferred work types (remote, hybrid, on-site)
- Salary expectations (min/max in lakhs)
- Professional summary

This saves to `profile.json` and your database.

### 2. (Optional) Set up environment variables

Create a `.env` file:

```bash
# AI cover letters (optional)
ANTHROPIC_API_KEY=your-key-here

# Email notifications (optional)
RESEND_API_KEY=your-key-here
EMAIL_TO=your@email.com
EMAIL_FROM=Job Agent <onboarding@resend.dev>

# LinkedIn cookies (optional, see below)
LINKEDIN_COOKIES=your-session-cookies
```

Or set them directly:

```bash
# Windows PowerShell
$env:ANTHROPIC_API_KEY = "your-key"
$env:RESEND_API_KEY = "your-key"
$env:EMAIL_TO = "your@email.com"

# Linux/Mac
export ANTHROPIC_API_KEY=your-key
export RESEND_API_KEY=your-key
export EMAIL_TO=your@email.com
```

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
# Full run (scrape → rank → report)
node main.js

# Skip AI cover letters (faster)
node main.js --no-ai

# Open report in browser
node main.js --open
```

### Check status

```bash
node -e "const db = require('./src/db'); db.init(); console.log(JSON.stringify(db.getStats()))"
```

---

## LinkedIn Cookie Setup

LinkedIn blocks automated access. To get Mumbai-specific results:

1. Open LinkedIn in Chrome/Firefox while logged in
2. Press F12 → Network tab → Refresh page
3. Click any request to `linkedin.com`
4. Go to **Headers** → **Request Headers** → find `cookie:`
5. Copy the entire value
6. Set as env var:

```bash
# Windows PowerShell
$env:LINKEDIN_COOKIES = 'your-cookie-string-here'

# Linux/Mac
export LINKEDIN_COOKIES='your-cookie-string-here'
```

> Note: LinkedIn cookies expire after a few days. Update periodically.

---

## Available Sources

| Source | Status | Notes |
|--------|--------|-------|
| RemoteOK | ✅ Working | JSON API, no auth needed |
| Remotive | ✅ Working | JSON API, keyword search |
| We Work Remotely | ✅ Working | RSS feed |
| LinkedIn RSS | ✅ Working | Soft approach, limited results |
| LinkedIn Cookie | ⚠️ Optional | Needs browser session cookies |
| Naukri / Indeed India | ❌ Blocked | Sites block automated access |
| Wellfound / Instahyre | ❌ Blocked | 403 errors from API |

---

## Scoring System

Jobs are scored (0–120+) based on:

| Signal | Weight | Description |
|--------|--------|-------------|
| Title exact match | 40 pts | Matches target titles exactly |
| Title similarity | 25 pts | Fuzzy match (Jaccard + Levenshtein) |
| Required skills | 15 pts | Matches your required keywords |
| Bonus skills | 5 pts | Matches your bonus keywords |
| Cloud signal | 12 pts | Mentions cloud tech when no title match |
| Remote | 20 pts | Confirmed remote role |
| Hybrid | 10 pts | Hybrid role in preferred location |
| Location | 15 pts | Matches your preferred locations |
| Employment type | 10 pts | Full-time / permanent |
| Salary fit | 10 pts | Meets minimum salary requirement |
| Recency | 10 pts | Posted within last 7 days |

Jobs below the minimum score threshold (20) or with deal-breakers are filtered out.

### Deal-Breaker Logic

Hard blockers (always excluded):
- `on-site only`, `contract`, `freelance`, `temporary`
- `accounting`, `recruiter`, `hr`, `sales`, `marketing`
- `customer service`, `business development`
- `mobile developer`, `ios`, `android`, `trader`

Soft blockers (bypassed for technical titles):
- Jobs with titles containing `engineer`, `architect`, `developer`, `technical`, `consultant`
- Example: "Sales Engineer" is valid, but "Sales Manager" is not

---

## Application Lifecycle

Jobs move through these statuses:

```
new → saved → applied
          ↘ skipped
          ↘ ignored
```

- **new** — Found by scraper, not yet reviewed
- **saved** — Saved for later review
- **applied** — You clicked "Mark as Applied"
- **skipped** — Not interested, hide from future reports
- **ignored** — Permanently ignore this job

---

## Email Notifications

When `RESEND_API_KEY` and `EMAIL_TO` are set:

- **Daily digest** — Top 5 jobs matching your profile
- **Weekly digest** — Summary stats + pending jobs

Emails are sent after each scrape run. Configure frequency in `src/email.js`.

---

## GitHub Actions

The workflow runs daily at 2:00 AM UTC (8:30 AM IST).

To enable:
1. Push code to GitHub
2. Add secrets in repo settings:
   - `ANTHROPIC_API_KEY` — for cover letters
   - `RESEND_API_KEY` — for email
   - `EMAIL_TO` — recipient address
   - `LINKEDIN_COOKIES` — optional, for LinkedIn results

The workflow:
1. Checks out code
2. Installs dependencies
3. Runs `node main.js --no-ai`
4. Uploads the HTML report as an artifact
5. Sends email with attachment (if keys are set)

---

## Cloudflare Workers Deployment (Free 24/7 Hosting)

For a free, always-on deployment that runs daily scrapes automatically:

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
```

### 2. Login to Cloudflare

```bash
wrangler login
```

### 3. Create KV Namespace for Storage

```bash
# Production namespace
wrangler kv namespace create JOBS_KV

# Preview namespace (for local development)
wrangler kv namespace create JOBS_KV --preview
```

### 4. Update `wrangler.toml` with your KV namespace IDs

```toml
[[kv_namespaces]]
binding = "JOBS_KV"
id = "YOUR_PRODUCTION_KV_ID"
preview_id = "YOUR_PREVIEW_KV_ID"
```

### 5. Set Secrets (Environment Variables)

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put EMAIL_TO
# Optional: for browser-based scraping
wrangler secret put LINKEDIN_COOKIES
```

### 6. Deploy

```bash
wrangler deploy
```

Your dashboard will be live at `https://job-agent-web.<your-subdomain>.workers.dev`

### Cron Schedule

The worker includes a daily cron trigger at `0 2 * * *` (2:00 AM UTC / 7:30 AM IST) in `wrangler.toml`:

```toml
[triggers]
crons = ["0 2 * * *"]
```

> **Note:** Free Cloudflare Workers plan allows up to 1 cron trigger. For production, upgrade to Workers Paid for 1,000 triggers/month.

### Worker API Endpoints

Once deployed, the same REST API is available:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/stats` | GET | Dashboard statistics |
| `/api/jobs` | GET | List jobs (filter: status, source, limit) |
| `/api/profile` | GET | Get profile |
| `/api/profile` | PUT | Update profile |
| `/api/apply` | POST | Mark job as applied |
| `/api/skip` | POST | Skip job |
| `/api/save` | POST | Save job for later |
| `/api/ignore` | POST | Ignore job |
| `/api/scrape` | POST | Trigger manual scrape |

### Local Development

```bash
# Start local dev server with KV
wrangler dev --test-scheduled
```

---

## File Structure

## File Structure

| File | Purpose |
|------|---------|
| `server.js` | Express server — REST API + static file serving |
| `main.js` | CLI entry point — routes to setup or runner |
| `profile.json` | Your job search preferences |
| `src/db.js` | Database layer — SQLite with JSON fallback |
| `src/scraper.js` | Source registry — fetches from job boards |
| `src/matcher.js` | Scoring engine — ranks jobs against profile |
| `src/runner.js` | Pipeline orchestrator — scrape → rank → save |
| `src/onboarding.js` | Interactive CLI wizard |
| `src/coverLetter.js` | AI cover letter generation |
| `src/email.js` | Resend email notifications |
| `public/index.html` | Dashboard HTML |
| `public/app.js` | Dashboard JavaScript |
| `public/styles.css` | Dashboard styling |
| `.github/workflows/daily-jobs.yml` | GitHub Actions schedule |
| `worker.js` | Cloudflare Worker — API + scheduled scraping |
| `wrangler.toml` | Cloudflare Worker configuration |

---

## Troubleshooting

### Dashboard not loading

```bash
# Check if server is running
curl http://localhost:3000/api/stats

# Kill any stale processes
pkill -f "node server"
npm start
```

### No jobs found

```bash
# Run a manual scrape to debug
node -e "const { scrapeAllSources } = require('./src/scraper'); scrapeAllSources(['GCP']).then(j => console.log(j.length, 'jobs'))"
```

### SQLite not available (Windows)

The JSON fallback is used automatically. Data persists in `data/jobs.db.json`.

### LinkedIn returns no results

Check your cookies are valid:
```bash
node -e "
process.env.LINKEDIN_COOKIES = 'your-cookies';
require('./src/scraper').scrapeLinkedInCookie('GCP Engineer').then(j => console.log(j.length, 'jobs'));
"
```

---

## License

ISC
