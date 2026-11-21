'use strict';

/**
 * Web Push: how the partner's phone hears about a note/doodle while the app is closed.
 * Uses the free, standard VAPID protocol – no Firebase account or paid key needed.
 * Keys come from env vars, or are generated once and saved to data/vapid.json.
 */

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const db = require('./db');

let publicKey = null;
let enabled = false;

function init(dataDir = path.join(__dirname, '..', 'data')) {
  let keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const file = path.join(dataDir, 'vapid.json');
    try {
      keys = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      keys = webpush.generateVAPIDKeys();
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
      console.log('[push] generated new VAPID keys in', file);
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', keys.publicKey, keys.privateKey);
  publicKey = keys.publicKey;
  enabled = true;
}

/** Fire-and-forget. Drops subscriptions the push service says are gone. */
async function notify(member, { title, body, tag }) {
  if (!enabled || !member || !member.push_sub) return false;
  let sub;
  try { sub = JSON.parse(member.push_sub); } catch { return false; }
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title, body, tag }), { TTL: 60 * 60 * 24, urgency: 'high' });
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) db.setPushSubscription(member.id, null);
    else console.warn('[push] send failed:', err.statusCode || err.message);
    return false;
  }
}

module.exports = { init, notify, getPublicKey: () => publicKey };
