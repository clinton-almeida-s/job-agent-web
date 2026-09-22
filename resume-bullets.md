---
name: resume-project-summary
description: Professional resume bullets for the Job Agent project
metadata:
  type: project
---

Project: Job Agent (GitHub: clinton-almeida-s/job-agent)
Role context: Manager / GCP Platform Engineer (12+ yrs, Vodafone Intelligent Solutions)

**Professional Resume Bullets (brief):**

- Designed and deployed an automated job-scraping agent (Node.js) that aggregates remote/cloud roles from RemoteOK, Remotive, We Work Remotely, and Shine, producing a ranked HTML report via GitHub Actions.
- Implemented a profile-based ranking engine that scores listings against 40+ target titles, required keywords (GCP, BigQuery, DevOps), and deal-breakers; lowered false negatives with word-boundary matching and configurable thresholds.
- Integrated optional Claude AI cover-letter generation via Anthropic API, with graceful fallback when `ANTHROPIC_API_KEY` is unavailable; reduced manual application prep time.
- Fixed broken RSS endpoints (We Work Remotely URL/UA, LinkedIn cookie-based attempt) and replaced dead sources (Startup.jobs, Remote-io) with working alternatives; maintained ~200 raw listings → 25 ranked results.
- Scheduled daily execution at 2:00 AM UTC via `.github/workflows/daily-jobs.yml` with 15-minute timeout safeguards; committed all changes with proper attribution (`Co-Authored-By: Claude Code`).
