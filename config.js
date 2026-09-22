/**
 * config.js — runtime configuration (env vars / secrets).
 * Loaded once at startup. Nothing here is committed to git.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const config = {
  // ── Anthropic (optional; agent works without it) ──────────────────────
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',

  // ── Email notifications (Resend) ──────────────────────────────────────
  resendKey:     process.env.RESEND_API_KEY || '',
  emailFrom:     process.env.EMAIL_FROM     || 'Job Agent <onboarding@resend.dev>',
  emailTo:       process.env.EMAIL_TO       || '',

  // ── LinkedIn (no cookies needed — Playwright guest scraping) ─────────
  // Kept for backwards compatibility; ignored by the new browser scraper.
  linkedinCookies: process.env.LINKEDIN_COOKIES || '',

  // ── Server ───────────────────────────────────────────────────────────
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',

  // ── Run behaviour ────────────────────────────────────────────────────
  // How many detail pages to enrich per source (salary/location/description).
  detailEnrich: parseInt(process.env.DETAIL_ENRICH, 10) || 15,
  // Max raw jobs to keep before ranking.
  maxRaw: parseInt(process.env.MAX_RAW, 10) || 400,
  // How many to surface in the review queue.
  topN: parseInt(process.env.TOP_N, 10) || 40,
  // Seconds to wait between browser page loads.
  browserDelayMs: parseInt(process.env.BROWSER_DELAY_MS, 10) || 600,
  // Use headless browser (false = visible window for debugging).
  headless: process.env.HEADLESS !== 'false',
};

module.exports = config;