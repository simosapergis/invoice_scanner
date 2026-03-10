#!/usr/bin/env node

/**
 * One-time script to set displayName on Firebase Auth user accounts.
 *
 * Usage:
 *   node scripts/set_display_names.js
 *
 * Edit the USER_NAMES map below before running.
 * Requires: GOOGLE_APPLICATION_CREDENTIALS or Firebase Admin default credentials.
 */

import admin from 'firebase-admin';

// Map Firebase Auth UIDs to human-readable display names.
// Fill in your actual UIDs and desired names before running.
const USER_NAMES = {
  // 'uid-1-here': 'Simos',
  // 'uid-2-here': 'Maria',
};

async function main() {
  if (Object.keys(USER_NAMES).length === 0) {
    console.error('No users configured. Edit USER_NAMES in this script before running.');
    process.exit(1);
  }

  admin.initializeApp();

  for (const [uid, displayName] of Object.entries(USER_NAMES)) {
    try {
      await admin.auth().updateUser(uid, { displayName });
      console.log(`✔ ${uid} → ${displayName}`);
    } catch (err) {
      console.error(`✘ ${uid}: ${err.message}`);
    }
  }

  console.log('Done.');
  process.exit(0);
}

main();
