'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { db, FV, HttpErr, bad, authUser, requireAdmin } = require('./lib/firebase');
const { getSettings, updateSettings, redacted } = require('./lib/settings');
const otp = require('./lib/otp');
const upi = require('./lib/upi');
const gh = require('./lib/github');
const { rateLimit } = require('./lib/ratelimit');

const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'builds');
const ICON_DIR = path.join(__dirname, 'data', 'icons');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(ICON_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/icons', express.static(ICON_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: ICON_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString('hex') + path.extname(file.originalname || '.png')),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\/(png|jpe?g)/.test(file.mimetype)),
});

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).then(
  (data) => { if (!res.headersSent) res.json({ success: true, ...(data || {}) }); },
  (e) => {
    if (e instanceof HttpErr) return res.status(e.code).json({ success: false, message: e.message });
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
);

/* ===================== OTP login ===================== */
app.post('/api/otp/send', wrap(async (req) => otp.requestOtp(String(req.body.email || ''))));
app.post('/api/otp/verify', wrap(async (req) => otp.verifyOtp(req.body.email, req.body.code)));

/* ===================== account ===================== */
app.post('/api/auth/sync', wrap(async (req) => {
  const u = await authUser(req);
  const isAdmin = (await db.collection('admins').doc(u.uid).get()).exists;
  return { user: { email: u.email, accountStatus: u.user.accountStatus }, isAdmin };
}));
app.post('/api/admin/bootstrap', wrap(async (req) => {
  const u = await authUser(req);
  const s = await getSettings();
  const key = process.env.ADMIN_SETUP_KEY || '';
  if (!key) bad(500, 'ADMIN_SETUP_KEY is not set on the server');
  if (String(req.body.code || '') !== key) bad(403, 'Wrong admin setup key');
  await db.collection('admins').doc(u.uid).set({ email: u.email, grantedAt: FV.serverTimestamp() });
  return {};
}));

/* ===================== admin settings ===================== */
app.get('/api/admin/settings', wrap(async (req) => {
  await requireAdmin(req);
  return { settings: redacted(await getSettings(true)) };
}));
app.post('/api/admin/settings', wrap(async (req) => {
  await requireAdmin(req);
  const s = await updateSettings(req.body || {});
  return { settings: redacted(s) };
}));
app.get('/api/admin/overview', wrap(async (req) => {
  await requireAdmin(req);
  const [users, reqs] = await Promise.all([db.collection('users').get(), db.collection('buildRequests').get()]);
  const byStatus = {};
  reqs.docs.forEach((d) => { const st = d.data().status; byStatus[st] = (byStatus[st] || 0) + 1 });
  return { totalUsers: users.size, totalBuilds: reqs.size, byStatus };
}));
app.get('/api/admin/builds', wrap(async (req) => {
  await requireAdmin(req);
  const snap = await db.collection('buildRequests').orderBy('createdAt', 'desc').limit(200).get();
  return { builds: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}));
app.get('/api/admin/payments/pending', wrap(async (req) => { await requireAdmin(req); return { payments: await upi.listPending() }; }));
app.post('/api/admin/payments/approve', wrap(async (req) => { await requireAdmin(req); return upi.approvePayment(String(req.body.orderId || '')); }));

/* ===================== build requests (web UI, logged-in user) ===================== */
function validPackageName(p) { return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/i.test(p); }
function validUrl(u) { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } }

async function createBuildRequest(uid, { websiteUrl, appName, packageName, iconUrl }) {
  if (!validUrl(websiteUrl)) bad(400, 'Enter a valid website URL (http:// or https://)');
  appName = String(appName || '').trim().slice(0, 50) || 'My App';
  packageName = String(packageName || '').trim().toLowerCase();
  if (!validPackageName(packageName)) bad(400, 'Package name must look like com.example.myapp');
  const s = await getSettings();
  const ref = db.collection('buildRequests').doc();
  const price = Number(s.buildPriceInr) || 0;
  const doc = {
    uid, websiteUrl, appName, packageName, iconUrl: iconUrl || '',
    status: price > 0 ? 'pending_payment' : 'queued',
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  await ref.set(doc);
  return { id: ref.id, ...doc };
}

app.post('/api/apps', upload.single('icon'), wrap(async (req) => {
  const u = await authUser(req);
  const iconUrl = req.file ? `${APP_URL}/icons/${req.file.filename}` : '';
  const b = await createBuildRequest(u.uid, { ...req.body, iconUrl });
  if (b.status === 'pending_payment') {
    const order = await upi.createOrder(b.id, u.uid);
    return { build: b, payUrl: `${APP_URL}/pay/${order.id}` };
  }
  return { build: b };
}));
app.get('/api/apps', wrap(async (req) => {
  const u = await authUser(req);
  const snap = await db.collection('buildRequests').where('uid', '==', u.uid).orderBy('createdAt', 'desc').limit(100).get();
  return { builds: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}));
app.get('/api/apps/:id', wrap(async (req) => {
  const u = await authUser(req);
  const snap = await db.collection('buildRequests').doc(req.params.id).get();
  if (!snap.exists || snap.data().uid !== u.uid) bad(404, 'Not found');
  return { build: { id: snap.id, ...snap.data() } };
}));

/* ===================== public developer API (API key, no login) ===================== */
async function authApiKey(p) {
  const uname = String(p.username || ''), key = String(p.key || '');
  if (!uname || !key) bad(401, 'username and key are required');
  const uid = await (async () => {
    const snap = await db.collection('apiUsers').doc(uname).get();
    return snap.exists ? snap.data().uid : null;
  })();
  const user = uid && (await db.collection('users').doc(uid).get()).data();
  if (!user || user.apiKey !== key) bad(401, 'Invalid username or key');
  return { uid };
}
app.post('/api/v1/build', wrap(async (req) => {
  const { uid } = await authApiKey(req.body);
  const b = await createBuildRequest(uid, req.body);
  return { build: b };
}));
app.get('/api/v1/status', wrap(async (req) => {
  const { uid } = await authApiKey(req.query);
  const snap = await db.collection('buildRequests').doc(String(req.query.id || '')).get();
  if (!snap.exists || snap.data().uid !== uid) bad(404, 'Not found');
  return { build: { id: snap.id, ...snap.data() } };
}));
app.post('/api/me/api-key', wrap(async (req) => {
  const u = await authUser(req);
  let apiUser = u.user.apiUser;
  if (!apiUser) { do { apiUser = 'U' + crypto.randomInt(100000, 999999); } while ((await db.collection('apiUsers').doc(apiUser).get()).exists); }
  const apiKey = 'uak_' + crypto.randomBytes(16).toString('hex');
  await db.collection('apiUsers').doc(apiUser).set({ uid: u.uid });
  await u.ref.set({ apiUser, apiKey }, { merge: true });
  return { apiUser, apiKey };
}));

/* ===================== payment page (public) ===================== */
const PAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pay</title><style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#0b0f1a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.card{background:#131a2b;border:1px solid #232c45;border-radius:22px;max-width:380px;width:100%;padding:24px;text-align:center;color:#e6e8f0}
.amt{font-size:38px;font-weight:800;margin:6px 0}
#qr{display:inline-block;padding:10px;background:#fff;border-radius:14px;margin:10px 0}
.state{margin:10px 0;padding:10px;border-radius:12px;font-weight:600;font-size:14px;background:#1b2440}
.btn{display:block;width:100%;padding:13px;border:0;border-radius:12px;background:#7c5cff;color:#fff;font-weight:700;margin:8px 0;text-decoration:none}
input{width:100%;padding:12px;border:1px solid #232c45;border-radius:10px;background:#0e1424;color:#fff;font-size:15px;text-align:center;letter-spacing:.1em}
</style></head><body><div class="card" id="c">Loading...</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
var ID="__ID__";
function $(i){return document.getElementById(i)}
function poll(){ fetch('/api/pay/status?order_id='+ID).then(r=>r.json()).then(function(d){
  if(!d.success){$('c').textContent=d.message;return} draw(d.order)
}); setTimeout(poll,4000) }
function draw(o){
  if(o.status==='SUCCESS'){ $('c').innerHTML='<h2>Payment received \u2713</h2><p>Your app build has been queued.</p>'; return }
  if(!$('amt'))$('c').innerHTML='<div class="amt" id="amt"></div><div id="qr"></div><a class="btn" id="go">Pay with UPI app</a>'+
    '<div class="state" id="st"></div><p style="font-size:13px">Already paid? Enter 12-digit UTR</p><input id="utr" maxlength="12"><button class="btn" style="background:#1b2440" onclick="sub()">Submit UTR</button><div id="m" style="font-size:12px;margin-top:6px"></div>';
  $('amt').textContent='\\u20B9'+o.amount.toFixed(2); $('go').href=o.upiLink;
  if(!$('qr').firstChild) new QRCode($('qr'),{text:o.upiLink,width:200,height:200});
  $('st').textContent=o.status==='UTR_SUBMITTED'?'UTR received, waiting for admin to confirm...':'Waiting for payment...';
}
function sub(){ var u=$('utr').value.replace(/\\D/g,''); if(u.length!==12){$('m').textContent='Enter a valid UTR';return}
  fetch('/api/pay/utr',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order_id:ID,utr:u})})
  .then(r=>r.json()).then(function(d){$('m').textContent=d.message||'Submitted';poll()}) }
poll();
</script></body></html>`;
app.get('/pay/:id', (req, res) => { res.type('html').send(PAY_HTML.replace('__ID__', req.params.id.replace(/[^A-Za-z0-9]/g, ''))); });
app.get('/api/pay/status', wrap(async (req) => {
  const order = await upi.getOrder(String(req.query.order_id || ''));
  if (!order) bad(404, 'Order not found');
  const s = await getSettings();
  return { order: { ...order, upiLink: upi.upiLink(s, order) } };
}));
app.post('/api/pay/utr', wrap(async (req) => upi.submitUtr(String(req.body.order_id || ''), req.body.utr)));

/* ===================== download ===================== */
app.get('/download/:token', (req, res) => {
  const rec = downloadTokens.get(req.params.token);
  if (!rec || Date.now() > rec.expiresAt) return res.status(410).send('This download link has expired.');
  res.download(rec.path, rec.name);
});

/* ===================== background build worker ===================== */
const downloadTokens = new Map(); // token -> { path, name, expiresAt }

async function processOneQueued() {
  const snap = await db.collection('buildRequests').where('status', '==', 'queued').orderBy('createdAt', 'asc').limit(1).get();
  if (snap.empty) return;
  const doc = snap.docs[0];
  const b = { id: doc.id, ...doc.data() };
  try {
    await doc.ref.set({ status: 'dispatching', updatedAt: Date.now() }, { merge: true });
    const s = await getSettings();
    await gh.dispatchBuild(s, b.id, b);
    await doc.ref.set({ status: 'building', updatedAt: Date.now() }, { merge: true });
  } catch (e) {
    await doc.ref.set({ status: 'failed', error: e.message, updatedAt: Date.now() }, { merge: true });
  }
}

async function processOneBuilding() {
  const snap = await db.collection('buildRequests').where('status', '==', 'building').limit(1).get();
  if (snap.empty) return;
  const doc = snap.docs[0];
  const b = { id: doc.id, ...doc.data() };
  try {
    const s = await getSettings();
    const run = await gh.findRunByRequestId(s, b.id, 1, 0);
    if (!run) return; // not visible on GitHub yet, try again on the next tick
    await doc.ref.set({ runId: run.id, runUrl: run.html_url }, { merge: true });
    const done = await gh.pollRunUntilDone(s, run.id, 60000, 4000); // short budget per tick; resumes next tick if needed
    if (done.conclusion !== 'success') {
      await doc.ref.set({ status: 'failed', error: `GitHub build ${done.conclusion}`, updatedAt: Date.now() }, { merge: true });
      return;
    }
    const apkPath = await gh.downloadApk(s, run.id, UPLOAD_DIR, `${b.id}.apk`);
    const token = crypto.randomBytes(16).toString('hex');
    downloadTokens.set(token, { path: apkPath, name: `${b.appName || 'app'}.apk`, expiresAt: Date.now() + (s.downloadTtlSeconds || 540) * 1000 });
    await doc.ref.set({ status: 'success', downloadToken: token, downloadUrl: `${APP_URL}/download/${token}`, updatedAt: Date.now() }, { merge: true });
  } catch (e) {
    await doc.ref.set({ status: 'failed', error: e.message, updatedAt: Date.now() }, { merge: true });
  }
}

setInterval(() => { processOneQueued().catch(() => {}); }, 6000).unref();
setInterval(() => { processOneBuilding().catch(() => {}); }, 10000).unref();
setInterval(() => { // clean expired APKs off disk
  const now = Date.now();
  for (const [token, rec] of downloadTokens) {
    if (now > rec.expiresAt) { downloadTokens.delete(token); fs.unlink(rec.path, () => {}); }
  }
}, 60000).unref();

app.listen(PORT, () => console.log('U APP backend listening on ' + PORT));
