/**
 * Cover Letter Generator — uses Claude API to craft a tailored letter
 * per job listing based on Clinton's resume context
 */

const https = require('https');
const profile = require('../profile.json');

const RESUME_CONTEXT = `
Name: ${profile.name}
Current Role: ${profile.current_role} at ${profile.current_company}
Experience: ${profile.experience_years} years in GCP / Cloud / Middleware
Certifications: ${profile.certifications.join(', ')}
Key Skills: GCP, BigQuery, Cloud Composer, Apache Airflow, Terraform, Kubernetes, CI/CD (Cloud Build), IAM, Pub/Sub, WebLogic, ODI, webMethods, Oracle, MySQL, Linux
Key Experience:
- Led GCP Platform operations for Vodafone Italy (Teradata → BigQuery migration)
- Designed and maintained Cloud Composer environments with Terraform
- Executed Blue/Green deployment strategies for Cloud Composer upgrades
- Engineered CI/CD pipelines in Google Cloud Build
- Managed IAM, VPCs, GCS buckets, Pub/Sub topics, BigQuery datasets
- Remediated vulnerabilities across Dev and Production GCP projects
- Led teams using Agile methodologies, managed sprint deliveries
- L2/L3 support, incident/change/problem management (ITIL)
- Awarded Vodafone Star Award: 2020, 2022, 2024, 2025
Summary: ${profile.summary}
`;

function claudeAPICall(prompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      reject(new Error('ANTHROPIC_API_KEY environment variable not set'));
      return;
    }

    const body = JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.content?.[0]?.text || '');
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Generate a tailored cover letter for a specific job.
 */
async function generateCoverLetter(job) {
  const prompt = `You are writing a professional cover letter for ${profile.name}.

CANDIDATE PROFILE:
${RESUME_CONTEXT}

JOB DETAILS:
- Title: ${job.title}
- Company: ${job.company}
- Description excerpt: ${job.description.slice(0, 1000)}
- Why it matched: ${job.match_reasons.join('; ')}

INSTRUCTIONS:
- Write a concise, confident cover letter (3-4 short paragraphs, max 300 words)
- Highlight the 2-3 most relevant experiences that directly match this job's requirements
- Mention GCP certifications if the job needs cloud expertise
- Tone: ${profile.cover_letter_style}, ${profile.tone}
- Do NOT use generic filler phrases like "I am writing to apply for..."
- Open with a strong statement about what Clinton brings to the role
- End with a call to action for an interview
- Do not include placeholders like [Your Name] — use actual details

Write only the cover letter body — no subject line, no "Dear [name]" (Clinton will add the greeting manually).`;

  try {
    return await claudeAPICall(prompt);
  } catch (e) {
    return `[Cover letter generation failed: ${e.message}. Set ANTHROPIC_API_KEY to enable AI-generated letters.]\n\nManual template:\nI bring ${profile.experience_years} years of GCP architecture and platform engineering experience to the ${job.title} role at ${job.company}. Currently at ${profile.current_company} as ${profile.current_role}, I have led large-scale cloud migrations, designed Terraform-managed Cloud Composer environments, and delivered CI/CD pipelines on Google Cloud Build for Vodafone Italy. My GCP certifications and hands-on operational expertise make me a strong fit for your team. I would welcome the opportunity to discuss how I can contribute to ${job.company}'s cloud goals.`;
  }
}

module.exports = { generateCoverLetter };
