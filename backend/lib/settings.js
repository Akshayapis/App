'use strict';
const { db } = require('./firebase');

/** Every one of these is editable from the Admin Panel (stored in Firestore config/settings).
 *  Nothing sensitive here is invented: upiId starts empty on purpose, the admin must paste the real one. */
const DEFAULTS = {
  // OTP email API (contract assumed: POST {base}{sendPath} {email}, POST {base}{verifyPath} {email,otp})
  otpApiBase: 'https://otpapi-seven.vercel.app',
  otpSendPath: '/send',
  otpVerifyPath: '/verify',
  otpTtlSeconds: 300,
  otpResendSeconds: 60,
  otpMaxAttempts: 5,
  supportEmail: '',

  // GitHub Actions build service (platform owner's own repo, users never see this)
  ghOwner: '',
  ghRepo: '',
  ghWorkflow: 'android-build.yml',
  ghRef: 'main',
  ghToken: '',

  // Build delivery
  downloadTtlSeconds: 540,
  maxUploadMb: 400,

  // Manual UPI payments (admin supplied — never invented)
  upiId: '',
  upiPayeeName: '',
  buildPriceInr: 0, // 0 = free builds, no payment step

  // API hardening
  apiKeyPepper: '',
  rateLimitWindowSeconds: 60,
  rateLimitMaxRequests: 60,
};

let cache = null, cacheAt = 0;
const CACHE_MS = 15000;

async function getSettings(force) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  const snap = await db.collection('config').doc('settings').get();
  cache = { ...DEFAULTS, ...(snap.exists ? snap.data() : {}) };
  cacheAt = Date.now();
  return cache;
}

async function updateSettings(patch) {
  const allowed = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) allowed[k] = patch[k];
  }
  await db.collection('config').doc('settings').set(allowed, { merge: true });
  cache = null;
  return getSettings(true);
}

/** Admin panel should never echo the GitHub token or API pepper back in full. */
function redacted(s) {
  const mask = (v) => (v ? v.slice(0, 4) + '...' + String(v).length + ' chars' : '');
  return { ...s, ghToken: mask(s.ghToken), apiKeyPepper: mask(s.apiKeyPepper) };
}

module.exports = { DEFAULTS, getSettings, updateSettings, redacted };
