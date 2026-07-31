#!/usr/bin/env node
// Brings up everything needed to work on the app locally:
//
//   1. the Postgres container defined in docker-compose.yml
//   2. any migrations that have not been applied
//   3. the seeded ingredient catalog
//   4. `npm run dev` (backend + frontend, watched)
//
// Steps 2 and 3 are what make this different from `docker compose up`: on a
// fresh clone the database is empty, and an empty catalog makes every
// conversion feature look broken rather than merely unpopulated.
'use strict';

const { execFileSync, spawn } = require('node:child_process');
const { existsSync, copyFileSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVICE = 'postgres';
const READY_TIMEOUT_MS = 60_000;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    cwd: ROOT,
    ...opts,
  });
}

function tryRun(cmd, args, opts = {}) {
  try {
    return run(cmd, args, opts);
  } catch {
    return null;
  }
}

/**
 * Did the command succeed?
 *
 * Deliberately separate from tryRun: execFileSync only *returns* stdout when
 * stdio is piped, so with 'inherit' or 'ignore' it returns null on success too.
 * Testing the return value there silently treats every success as a failure.
 */
function runOk(cmd, args, opts = {}) {
  try {
    run(cmd, args, opts);
    return true;
  } catch {
    return false;
  }
}

/** A real sleep. A busy-wait loop here would peg a core for the whole wait. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `docker compose` (v2 plugin) with a fallback to the legacy `docker-compose`
 * binary, so this works on older Docker installs too.
 */
function composeCommand() {
  if (tryRun('docker', ['compose', 'version'], { stdio: 'pipe' }) !== null) {
    return { cmd: 'docker', prefix: ['compose'] };
  }
  if (tryRun('docker-compose', ['version'], { stdio: 'pipe' }) !== null) {
    return { cmd: 'docker-compose', prefix: [] };
  }
  return null;
}

function waitForPostgres(compose) {
  const started = Date.now();
  process.stdout.write('Waiting for Postgres to accept connections');

  while (Date.now() - started < READY_TIMEOUT_MS) {
    // pg_isready inside the container, rather than probing the host port:
    // the port can be listening while the server is still starting up, and
    // this avoids needing a Postgres client on the host at all.
    const ok = runOk(
      compose.cmd,
      [...compose.prefix, 'exec', '-T', SERVICE, 'pg_isready', '-q'],
      { stdio: 'ignore' },
    );
    if (ok) {
      process.stdout.write(' ready\n');
      return true;
    }
    process.stdout.write('.');
    sleepMs(1000);
  }

  process.stdout.write('\n');
  return false;
}

function main() {
  if (tryRun('docker', ['--version'], { stdio: 'pipe' }) === null) {
    console.error('docker is not on PATH. Install Docker Desktop and try again.');
    process.exit(1);
  }

  const compose = composeCommand();
  if (compose === null) {
    console.error('Neither `docker compose` nor `docker-compose` is available.');
    process.exit(1);
  }

  // compose interpolates ${POSTGRES_USER} and friends from .env, so without it
  // the container comes up with a blank password and confusing errors later.
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) {
    const examplePath = path.join(ROOT, '.env.example');
    console.error('No .env found — docker-compose reads the database credentials from it.');
    if (existsSync(examplePath)) {
      copyFileSync(examplePath, envPath);
      console.error('Copied .env.example to .env. Fill in JWT_SECRET and');
      console.error('AI_ENCRYPTION_KEY (both have generator commands in the file), then re-run.');
    }
    process.exit(1);
  }

  console.log(`Starting the ${SERVICE} container...`);
  run(compose.cmd, [...compose.prefix, 'up', '-d', SERVICE], { stdio: 'inherit' });

  if (!waitForPostgres(compose)) {
    console.error(`Postgres was not ready within ${READY_TIMEOUT_MS / 1000}s.`);
    console.error(`Check it with: ${compose.cmd} ${[...compose.prefix, 'logs', SERVICE].join(' ')}`);
    process.exit(1);
  }

  // Fatal: running the API against a schema it does not match produces
  // confusing runtime errors instead of one obvious failure here.
  console.log('\nApplying migrations...');
  try {
    run('npm', ['exec', '-w', 'packages/backend', '--', 'prisma', 'migrate', 'deploy'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } catch {
    console.error('Migrations failed. Fix the error above and re-run.');
    process.exit(1);
  }

  // Non-fatal: idempotent, and a stale catalog should not stop you working.
  console.log('\nSeeding the ingredient catalog...');
  try {
    run('npm', ['run', 'seed'], { stdio: 'inherit', shell: process.platform === 'win32' });
  } catch {
    console.warn('WARNING: seeding failed; continuing. Conversions may look incomplete.');
  }

  console.log('\nStarting backend + frontend...\n');
  const child = spawn('npm', ['run', 'dev'], {
    stdio: 'inherit',
    cwd: ROOT,
    shell: process.platform === 'win32',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

main();
