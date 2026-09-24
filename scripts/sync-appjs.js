/**
 * Sync public/app.js into the embedded base64 string in worker.js
 * Run this after editing app.js before deploying.
 */
const fs = require('fs');
const path = require('path');

const WORKER_PATH = path.join(__dirname, '..', 'worker.js');
const APP_JS_PATH = path.join(__dirname, '..', 'public', 'app.js');

const appJs = fs.readFileSync(APP_JS_PATH, 'utf8');
const newB64 = Buffer.from(appJs).toString('base64');

let w = fs.readFileSync(WORKER_PATH, 'utf8');
const match = w.match(/const APP_JS_B64 = '([^']+)'/);
if (!match) {
  console.error('ERROR: Could not find APP_JS_B64 in worker.js');
  process.exit(1);
}

w = w.replace(match[0], "const APP_JS_B64 = '" + newB64 + "'");
fs.writeFileSync(WORKER_PATH, w);

console.log('Synced app.js → worker.js (embedded JS updated)');
console.log('New base64 length:', newB64.length, 'chars');
