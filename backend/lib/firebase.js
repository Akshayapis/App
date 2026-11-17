'use strict';
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_ADMIN_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();
const FV = admin.firestore.FieldValue;

class HttpErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (c, m) => { throw new HttpErr(c, m); };

/** Verifies the Firebase ID token on the Authorization header, creates the user doc on first sight. */
async function authUser(req) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) bad(401, 'Login required');
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(token); }
  catch (e) { bad(401, 'Session expired, please login again'); }
  const uid = decoded.uid;
  const email = decoded.email || '';
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ email, createdAt: FV.serverTimestamp(), accountStatus: 'active' });
  }
  const user = (await ref.get()).data();
  if (user.accountStatus === 'disabled') bad(403, 'Your account has been disabled by an admin');
  return { uid, email, user, ref };
}

async function requireAdmin(req) {
  const u = await authUser(req);
  const a = await db.collection('admins').doc(u.uid).get();
  if (!a.exists) bad(403, 'Admin access only');
  return u;
}

module.exports = { admin, db, FV, HttpErr, bad, authUser, requireAdmin };
