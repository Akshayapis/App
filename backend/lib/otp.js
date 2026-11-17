'use strict';
const crypto = require('crypto');
const { db, admin, bad } = require('./firebase');
const { getSettings } = require('./settings');

/* NOTE ON THE EXTERNAL OTP_API_BASE CONTRACT (otpapi-seven.vercel.app):
 * No request/response format was given for this API (unlike the AI API, which came with an
 * exact spec). This module therefore generates and checks the OTP itself (code, hash, TTL,
 * attempts, resend cooldown all live here and in Firestore), and only uses the external API
 * to actually deliver the email, as a plain POST with a JSON body:
 *   POST {otpApiBase}{otpSendPath}   body: { email, otp, purpose: "login" }
 * If the real API expects a different shape (e.g. query params, a different field name,
 * an API key), only the sendEmail() function below needs to change — everything else
 * (hashing, TTL, attempts, resend cooldown) is independent of it. Verify this against
 * the API's real docs before relying on it in production.
 */

function hash(code) { return crypto.createHash('sha256').update(code).digest('hex'); }
function genCode() { return String(crypto.randomInt(100000, 999999)); }

async function sendEmail(settings, email, code) {
  const url = `${settings.otpApiBase.replace(/\/$/, '')}${settings.otpSendPath}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, otp: code, purpose: 'login' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) bad(502, `OTP email service returned HTTP ${r.status}`);
}

async function requestOtp(email) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad(400, 'Enter a valid email');
  const settings = await getSettings();
  const ref = db.collection('otps').doc(email.toLowerCase());
  const snap = await ref.get();
  const now = Date.now();
  if (snap.exists) {
    const d = snap.data();
    if (d.lastSentAt && now - d.lastSentAt < settings.otpResendSeconds * 1000) {
      bad(429, `Please wait ${Math.ceil((settings.otpResendSeconds * 1000 - (now - d.lastSentAt)) / 1000)}s before resending`);
    }
  }
  const code = genCode();
  await ref.set({
    codeHash: hash(code), expiresAt: now + settings.otpTtlSeconds * 1000,
    attempts: 0, lastSentAt: now,
  });
  await sendEmail(settings, email, code);
  return { expiresInSeconds: settings.otpTtlSeconds };
}

async function verifyOtp(email, code) {
  if (!email || !code) bad(400, 'Email and code are required');
  const settings = await getSettings();
  const ref = db.collection('otps').doc(String(email).toLowerCase());
  const snap = await ref.get();
  if (!snap.exists) bad(400, 'Request a new code first');
  const d = snap.data();
  if (Date.now() > d.expiresAt) bad(400, 'Code expired, request a new one');
  if (d.attempts >= settings.otpMaxAttempts) bad(429, 'Too many wrong attempts, request a new code');
  if (hash(String(code)) !== d.codeHash) {
    await ref.set({ attempts: d.attempts + 1 }, { merge: true });
    bad(400, 'Wrong code');
  }
  await ref.delete();

  // Code is correct: find or create the Firebase Auth user for this email, mint a custom token.
  let user;
  try { user = await admin.auth().getUserByEmail(email); }
  catch (e) { user = await admin.auth().createUser({ email, emailVerified: true }); }
  const customToken = await admin.auth().createCustomToken(user.uid);
  return { customToken };
}

module.exports = { requestOtp, verifyOtp };
