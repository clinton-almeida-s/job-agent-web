/**
 * Onboarding CLI wizard — interactive profile setup
 * Usage: node main.js --setup
 */

const inquirer = require('inquirer');
const prompt = inquirer.createPromptModule();
const fs = require('fs');
const path = require('path');
const { saveProfile } = require('./db');

const DEFAULT_PROFILE = {
  name: '', email: '', phone: '', linkedin: '', location: 'Mumbai, India',
  resume_path: '', experience_years: 0, current_role: '', current_company: '',
  skills: [], target_titles: [
    'GCP Engineer', 'Cloud Architect', 'Platform Engineer', 'Cloud Engineer',
    'Site Reliability Engineer', 'DevOps Engineer', 'Infrastructure Engineer',
    'GCP Platform Engineer', 'Cloud Platform Engineer', 'Team Lead', 'Manager'
  ],
  required_keywords: ['GCP', 'Google Cloud', 'BigQuery', 'Airflow', 'CI/CD', 'Terraform', 'Kubernetes', 'Cloud'],
  bonus_keywords: ['Cloud Architect', 'MLOps', 'DataOps', 'Agile', 'IAM', 'Pub/Sub'],
  certifications: [], deal_breakers: [
    'on-site only', 'onsite only', 'no remote', 'must be located', 'in-office',
    'contract', 'freelance', 'temporary', 'accounting', 'recruiter', 'hr',
    'human resources', 'sales', 'marketing', 'customer service', 'customer success',
    'business development', 'qa tester', 'quality assurance', 'mobile developer',
    'ios', 'android', 'trader', 'trading'
  ],
  preferred_work_type: ['remote', 'hybrid', 'on-site (Mumbai)'],
  preferred_locations: ['remote', 'mumbai', 'india'],
  preferred_employment: ['permanent', 'full-time', 'full time'],
  target_salary: { currency: 'INR', min_lakhs: 35, note: 'Minimum annual CTC requirement' },
  summary: '', cover_letter_style: 'professional', tone: 'confident but collaborative'
};

async function runSetup() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║     Job Agent — Interactive Setup        ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Load existing profile or start fresh
  let profile;
  try {
    const existing = require('../profile.json');
    profile = { ...DEFAULT_PROFILE, ...existing };
  } catch {
    profile = { ...DEFAULT_PROFILE };
  }

  const answers = await prompt([
    {
      type: 'input', name: 'name', message: 'Your full name',
      default: profile.name || 'Clinton Almeida'
    },
    {
      type: 'input', name: 'email', message: 'Email address',
      default: profile.email || ''
    },
    {
      type: 'input', name: 'phone', message: 'Phone number (e.g., +91 9860831042)',
      default: profile.phone || ''
    },
    {
      type: 'input', name: 'linkedin', message: 'LinkedIn URL or handle',
      default: profile.linkedin || ''
    },
    {
      type: 'input', name: 'location', message: 'Preferred location (e.g., Mumbai, India / Remote)',
      default: profile.location || 'Mumbai, India'
    },
    {
      type: 'input', name: 'resume_path', message: 'Resume PDF path (for auto-fill)',
      default: profile.resume_path || 'C:/Users/clint/Resume_Clint.pdf'
    },
    {
      type: 'number', name: 'experience_years', message: 'Years of experience',
      default: profile.experience_years || 12
    },
    {
      type: 'input', name: 'current_role', message: 'Current role/title',
      default: profile.current_role || 'Manager / GCP Platform Engineer'
    },
    {
      type: 'input', name: 'current_company', message: 'Current company',
      default: profile.current_company || 'Vodafone Intelligent Solutions'
    },
    {
      type: 'editor', name: 'summary', message: 'Professional summary (opens in your default editor)',
      default: profile.summary || 'Google Cloud Platform Architect with over 12 years of experience designing, migrating, and optimizing cloud platforms. Specializing in GCP, infrastructure automation, and middleware administration. Google Professional Cloud Architect Certified, GCP Associate Cloud Engineer Certified, ITIL Foundation holder.'
    },
    {
      type: 'input', name: 'skills', message: 'Key skills (comma-separated)',
      default: profile.skills?.join(', ') || 'GCP, BigQuery, Cloud Composer, Airflow, Terraform, Kubernetes, CI/CD, IAM, Pub/Sub, MySQL, Linux'
    },
    {
      type: 'input', name: 'target_titles', message: 'Target job titles (comma-separated)',
      default: profile.target_titles?.join(', ') || 'GCP Engineer, Cloud Architect, Platform Engineer, Cloud Engineer, SRE, DevOps Engineer'
    },
    {
      type: 'input', name: 'required_keywords', message: 'Required skills/keywords (comma-separated)',
      default: profile.required_keywords?.join(', ') || 'GCP, Google Cloud, BigQuery, Cloud Composer, Airflow, CI/CD, Terraform, Kubernetes, Cloud Migration, Platform Ops'
    },
    {
      type: 'input', name: 'bonus_keywords', message: 'Bonus skills/keywords (comma-separated)',
      default: profile.bonus_keywords?.join(', ') || 'Cloud Architect, DataOps, MLOps, Agile, ITIL, Pub/Sub, WebLogic, ODI, Middleware'
    },
    {
      type: 'checkbox', name: 'work_types', message: 'Preferred work types',
      choices: ['Remote', 'Hybrid', 'On-site (Mumbai)'],
      default: profile.preferred_work_type || ['Remote', 'Hybrid']
    },
    {
      type: 'checkbox', name: 'locations', message: 'Preferred locations',
      choices: ['Remote', 'Mumbai', 'Bangalore', 'Delhi NCR', 'Pune', 'Hyderabad', 'Other India', 'International'],
      default: profile.preferred_locations || ['Remote', 'Mumbai']
    },
    {
      type: 'number', name: 'salary_min_lakhs', message: 'Minimum annual salary (in lakhs INR)',
      default: profile.target_salary?.min_lakhs || 35
    },
    {
      type: 'number', name: 'salary_max_lakhs', message: 'Desired maximum salary (in lakhs INR, leave blank for none)',
      default: undefined
    },
    {
      type: 'list', name: 'currency', message: 'Primary salary currency',
      choices: ['INR', 'USD', 'EUR', 'GBP'],
      default: profile.target_salary?.currency || 'INR'
    },
  ]);

  // Build profile object
  const finalProfile = {
    name: answers.name,
    email: answers.email,
    phone: answers.phone,
    linkedin: answers.linkedin,
    location: answers.location,
    resume_path: answers.resume_path,
    experience_years: answers.experience_years,
    current_role: answers.current_role,
    current_company: answers.current_company,
    skills: answers.skills.split(',').map(s => s.trim()).filter(Boolean),
    target_titles: answers.target_titles.split(',').map(s => s.trim()).filter(Boolean),
    required_keywords: answers.required_keywords.split(',').map(s => s.trim()).filter(Boolean),
    bonus_keywords: answers.bonus_keywords.split(',').map(s => s.trim()).filter(Boolean),
    certifications: profile.certifications || [],
    deal_breakers: profile.deal_breakers,
    preferred_work_type: answers.work_types.map(w => w.toLowerCase()),
    preferred_locations: answers.locations.map(l => l.toLowerCase()),
    preferred_employment: ['permanent', 'full-time', 'full time'],
    target_salary: {
      currency: answers.currency,
      min_lakhs: answers.salary_min_lakhs,
      max_lakhs: answers.salary_max_lakhs || null,
      note: 'Minimum annual CTC requirement'
    },
    summary: answers.summary,
    cover_letter_style: 'professional',
    tone: 'confident but collaborative'
  };

  // Save to both profile.json (for backwards compat) and db
  const profilePath = path.join(__dirname, '..', 'profile.json');
  fs.writeFileSync(profilePath, JSON.stringify(finalProfile, null, 2));

  const { saveProfile: saveToDb } = require('./db');
  saveToDb(finalProfile);

  console.log('\n✅ Profile saved!');
  console.log(`   Name: ${finalProfile.name}`);
  console.log(`   Location: ${finalProfile.location}`);
  console.log(`   Target salary: ₹${finalProfile.target_salary.min_lakhs} LPA+`);
  console.log(`   Resume: ${finalProfile.resume_path}`);
  console.log('\n   Run the agent: node main.js');
  console.log('   Or start the server: npm start\n');
}

module.exports = { runSetup };
