/**
 * Fails any test that tries to leave the machine.
 *
 * The AI suggestion tests exercise real failure paths against the Anthropic SDK,
 * which makes it easy to write one that quietly depends on a live API call —
 * turning a unit suite into something that is slow, costs money, and goes red
 * when a third party has an outage. This makes that mistake loud instead.
 *
 * A test that genuinely needs a network round trip belongs in `scripts/`, run
 * deliberately, not in `npm test`.
 */

import http from 'node:http';
import https from 'node:https';

const refuse = (via: string) => () => {
  throw new Error(
    `Network call attempted in a unit test (via ${via}). Stub the client instead — ` +
      'see packages/backend/test/no-network.ts.',
  );
};

for (const [name, mod] of Object.entries({ http, https })) {
  for (const method of ['request', 'get'] as const) {
    (mod as unknown as Record<string, unknown>)[method] = refuse(`${name}.${method}`);
  }
}

globalThis.fetch = refuse('fetch') as unknown as typeof fetch;
