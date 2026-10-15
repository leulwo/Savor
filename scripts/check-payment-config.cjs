const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const values = {};
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
}
Object.assign(values, process.env);

const errors = [];
const origin = String(values.APP_URL || '').trim().replace(/\/$/, '');
if (!origin) errors.push('APP_URL is missing.');
let app;
try { app = new URL(origin); } catch { errors.push('APP_URL must be a valid absolute URL.'); }
if (app && app.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(app.hostname)) errors.push('APP_URL must use HTTPS outside localhost.');

const expected = app ? {
  CHAPA_DASHBOARD_WEBHOOK_URL: `${origin}/api/chapa/webhook`,
  CHAPA_DASHBOARD_CALLBACK_URL: `${origin}/api/chapa/callback`,
  CHAPA_DASHBOARD_RETURN_URL: `${origin}/?payment_return=1`
} : {};
for (const [key, value] of Object.entries(expected)) {
  if (!values[key]) errors.push(`${key} is missing; compare it with the Chapa dashboard value ${value}.`);
  else if (String(values[key]).trim().replace(/\/$/, '') !== value.replace(/\/$/, '')) errors.push(`${key} does not match the URL derived from APP_URL.`);
}

const authDomain = String(values.VITE_FIREBASE_AUTH_DOMAIN || '').trim();
const firebaseDomains = String(values.FIREBASE_AUTHORIZED_DOMAINS || '').split(',').map(x => x.trim()).filter(Boolean);
if (!authDomain) errors.push('VITE_FIREBASE_AUTH_DOMAIN is missing.');
if (!firebaseDomains.length) errors.push('FIREBASE_AUTHORIZED_DOMAINS is missing; include the APP_URL hostname and Firebase auth domain.');
else {
  if (app && !firebaseDomains.includes(app.hostname)) errors.push('FIREBASE_AUTHORIZED_DOMAINS does not include the APP_URL hostname.');
  if (authDomain && !firebaseDomains.includes(authDomain)) errors.push('FIREBASE_AUTHORIZED_DOMAINS does not include VITE_FIREBASE_AUTH_DOMAIN.');
}
const expectedGoogleRedirect = authDomain ? `https://${authDomain}/__/auth/handler` : '';
const googleRedirects = String(values.GOOGLE_OAUTH_REDIRECT_URIS || '').split(',').map(x => x.trim()).filter(Boolean);
if (!googleRedirects.length) errors.push(`GOOGLE_OAUTH_REDIRECT_URIS is missing; verify ${expectedGoogleRedirect || 'the Firebase auth handler'} in Google Cloud OAuth settings.`);
else if (expectedGoogleRedirect && !googleRedirects.includes(expectedGoogleRedirect)) errors.push('GOOGLE_OAUTH_REDIRECT_URIS does not include the Firebase auth handler URI.');

if (errors.length) {
  console.error('Payment configuration check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('Payment URL configuration matches APP_URL. No credentials were displayed.');
}
