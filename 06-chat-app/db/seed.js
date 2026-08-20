'use strict';

/**
 * Seeds the default rooms. Safe to run repeatedly — existing rooms are skipped.
 * Invoked automatically at server start, and available as `npm run seed`.
 */

require('dotenv').config();
const db = require('../lib/db');

const DEFAULT_ROOMS = [
  { name: 'general', topic: 'Everything and anything.' },
  { name: 'random', topic: 'Off-topic chatter and links.' },
  { name: 'dev', topic: 'Build logs, bugs and code talk.' }
];

function seed({ quiet = false } = {}) {
  db.open();
  const created = [];
  for (const room of DEFAULT_ROOMS) {
    const existing = db.getRoomByName(room.name);
    if (existing) {
      // Keep the default flag accurate even if the row predates a change.
      if (!existing.is_default) {
        db.handle().prepare('UPDATE rooms SET is_default = 1 WHERE id = ?').run(existing.id);
      }
      continue;
    }
    const res = db.createRoom(room.name, { topic: room.topic, isDefault: 1 });
    if (res.ok) created.push(res.room.name);
  }
  if (!quiet) {
    console.log(created.length ? `Seeded rooms: ${created.map((n) => '#' + n).join(', ')}` : 'Default rooms already present.');
  }
  return created;
}

if (require.main === module) {
  seed();
  db.close();
}

module.exports = { seed, DEFAULT_ROOMS };
