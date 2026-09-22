/**
 * extract-resume.js — one-off: parse Resume_Clint.pdf into resume-text.txt
 * Run: node src/extract-resume.js
 */
const fs = require('fs');
const path = require('path');

async function main() {
  const { PDFParse } = await import('pdf-parse');
  const resumePath = process.env.RESUME_PATH || path.join(__dirname, '..', 'Resume_Clint.pdf');
  const outPath = path.join(__dirname, '..', 'resume-text.txt');
  if (!fs.existsSync(resumePath)) {
    console.error('Resume not found at', resumePath);
    process.exit(1);
  }
  const buf = new Uint8Array(fs.readFileSync(resumePath));
  const parser = new PDFParse(buf);
  const data = await parser;
  const r = await data.getText();
  const text = r.pages.map(p => p.text).join('\n');
  fs.writeFileSync(outPath, text);
  console.log(`Wrote ${text.length} chars → ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });