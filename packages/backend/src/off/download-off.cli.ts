/**
 * Fetches the monthly Open Food Facts JSONL export.
 *
 *   npm run off:download
 *   npm run off:download -- --out data/off
 *
 * Separate from the importer so a slow multi-gigabyte download is not repeated
 * every time an import is retried, and so the import itself can run with no
 * network at all — which is what lets the tests use fixtures.
 *
 * **This is the only thing in the app that talks to Open Food Facts.** There is
 * no live API lookup anywhere: OFF asks that bulk consumers use the dumps
 * rather than scraping the API, and a barcode scan at the fridge should not
 * depend on someone else's uptime.
 *
 * Attribution: the data is ODbL, images DbCL. See README.md.
 */

import { createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DUMP_URL = 'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz';
const DEFAULT_OUT = 'data/off';

async function main(): Promise<void> {
  const { outDir, url } = parseArgs(process.argv.slice(2));

  mkdirSync(outDir, { recursive: true });
  const finalPath = resolve(outDir, 'openfoodfacts-products.jsonl.gz');
  // Downloaded to a temporary name and renamed on success, so an interrupted
  // download cannot leave a truncated file that looks importable.
  const tempPath = `${finalPath}.partial`;

  console.log(`Downloading ${url}`);
  console.log(`         to ${finalPath}`);
  console.log('This is several gigabytes and will take a while.');

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const expected = Number(response.headers.get('content-length') ?? 0);
  if (expected > 0) {
    console.log(`Expecting ${(expected / 1_000_000_000).toFixed(2)} GB`);
  }

  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(tempPath),
  );

  // A silently short read is the failure this catches: the stream ends without
  // an error and the file looks fine until the importer hits a gunzip error
  // halfway through, hours later.
  const actual = statSync(tempPath).size;
  if (expected > 0 && actual !== expected) {
    throw new Error(
      `Incomplete download: expected ${expected} bytes, got ${actual}. ` +
        `The partial file is at ${tempPath}; delete it and retry.`,
    );
  }

  renameSync(tempPath, finalPath);

  console.log('');
  console.log(`Done: ${finalPath} (${(actual / 1_000_000_000).toFixed(2)} GB)`);
  console.log(`Downloaded on ${new Date().toISOString().slice(0, 10)}.`);
  console.log('');
  console.log('Next:');
  console.log(`  npm run off:import -w packages/backend -- --file ${finalPath}`);
}

function parseArgs(argv: readonly string[]): { outDir: string; url: string } {
  let outDir = DEFAULT_OUT;
  let url = DUMP_URL;

  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--out':
        outDir = argv[i + 1] ?? DEFAULT_OUT;
        i += 1;
        break;
      case '--url':
        url = argv[i + 1] ?? DUMP_URL;
        i += 1;
        break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}\n\n${USAGE}`);
        process.exit(1);
    }
  }

  return { outDir, url };
}

const USAGE = `Usage: npm run off:download [-- --out <dir>]

  --out <dir>   Where to save the dump (default: ${DEFAULT_OUT})
  --url <url>   Override the source URL

Refresh cadence is monthly. The dump is not part of dev:up or the Docker image.
`;

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
