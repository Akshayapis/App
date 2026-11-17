'use strict';
const crypto = require('crypto');
const { db, FV, bad } = require('./firebase');
const { getSettings } = require('./settings');

const rnd = (n) => crypto.randomBytes(n).toString('hex');

/** Creates a payment order for one build request. Amount comes from the admin-set price;
 *  the UPI ID is whatever the admin pasted into the Admin Panel (never invented here). */
async function createOrder(buildId, uid) {
  const s = await getSettings();
  if (!s.upiId) bad(400, 'Payments are not configured yet (no UPI ID set in Admin Panel)');
  const amount = Number(s.buildPriceInr) || 0;
  const id = 'PAY' + Date.now().toString(36).toUpperCase() + rnd(2).toUpperCase();
  const order = { id, buildId, uid, amount, status: amount > 0 ? 'PENDING' : 'SUCCESS', utr: '', createdAt: Date.now() };
  await db.collection('payments').doc(id).set(order);
  return order;
}

function upiLink(s, order) {
  return `upi://pay?pa=${encodeURIComponent(s.upiId)}&pn=${encodeURIComponent(s.upiPayeeName || 'U APP')}` +
    `&am=${order.amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent('U APP build ' + order.buildId)}&tr=${order.id}`;
}

async function getOrder(id) {
  const snap = await db.collection('payments').doc(id).get();
  return snap.exists ? snap.data() : null;
}

async function submitUtr(orderId, utr) {
  utr = String(utr || '').replace(/\D/g, '');
  if (utr.length !== 12) bad(400, 'UTR must be 12 digits');
  const order = await getOrder(orderId);
  if (!order) bad(404, 'Order not found');
  if (order.status === 'SUCCESS') return { status: 'SUCCESS' };
  await db.collection('payments').doc(orderId).set({ utr, status: 'UTR_SUBMITTED', submittedAt: FV.serverTimestamp() }, { merge: true });
  return { status: 'UTR_SUBMITTED' };
}

/** Admin manually confirms the payment after checking their bank/UPI app (no SMS auto-read here —
 *  that would need a companion Android app on the admin's phone, like the earlier UPI Gateway project). */
async function approvePayment(orderId) {
  const order = await getOrder(orderId);
  if (!order) bad(404, 'Order not found');
  await db.collection('payments').doc(orderId).set({ status: 'SUCCESS', approvedAt: FV.serverTimestamp() }, { merge: true });
  await db.collection('buildRequests').doc(order.buildId).set({ status: 'queued' }, { merge: true });
  return {};
}

async function listPending() {
  const snap = await db.collection('payments').where('status', '==', 'UTR_SUBMITTED').limit(200).get();
  return snap.docs.map((d) => d.data());
}

module.exports = { createOrder, getOrder, upiLink, submitUtr, approvePayment, listPending };
