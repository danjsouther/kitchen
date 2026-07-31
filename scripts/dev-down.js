#!/usr/bin/env node
// Stops the local containers started by dev-up.
//
//   npm run dev:down              stop containers, keep the data
//   npm run dev:down -- --destroy also delete the volume (wipes the database)
//
// The default keeps the volume. Losing a pantry and a month of meal plans to a
// routine "stop the thing" command would be a poor trade for the seconds saved
// re-seeding, so throwing the data away is opt-in and prints what it did.
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function tryRun(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts });
  } catch {
    return null;
  }
}

/**
 * Did the command succeed? execFileSync only returns stdout when stdio is
 * piped, so with 'inherit' a successful run also returns null — checking the
 * return value would report every success as a failure.
 */
function runOk(cmd, args, opts = {}) {
  try {
    execFileSync(cmd, args, { cwd: ROOT, ...opts });
    return true;
  } catch {
    return false;
  }
}

function composeCommand() {
  if (tryRun('docker', ['compose', 'version'], { stdio: 'pipe' }) !== null) {
    return { cmd: 'docker', prefix: ['compose'] };
  }
  if (tryRun('docker-compose', ['version'], { stdio: 'pipe' }) !== null) {
    return { cmd: 'docker-compose', prefix: [] };
  }
  return null;
}

function main() {
  const destroy = process.argv.slice(2).includes('--destroy');

  const compose = composeCommand();
  if (compose === null) {
    console.error('Neither `docker compose` nor `docker-compose` is available.');
    process.exit(1);
  }

  // `down` removes the containers but leaves named volumes alone; -v also
  // removes them, which is the destructive part.
  const args = [...compose.prefix, 'down'];
  if (destroy) args.push('--volumes');

  console.log(
    destroy
      ? 'Stopping containers and DELETING the database volume...'
      : 'Stopping containers (database volume kept)...',
  );

  if (!runOk(compose.cmd, args, { stdio: 'inherit' })) {
    console.error('docker compose down failed.');
    process.exit(1);
  }

  console.log(
    destroy
      ? 'Done. The next `npm run dev:up` will migrate and seed from scratch.'
      : 'Done. Data is preserved; `npm run dev:up` will pick up where you left off.',
  );
}

main();
