import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

import { Prisma } from '../../generated/prisma/client';

/**
 * Renders Prisma `Decimal` values as JSON strings.
 *
 * Without this they serialize as `{"s":1,"e":0,"d":[2]}` — the internal shape of
 * the Decimal object — which is useless to a client.
 *
 * They become **strings**, not numbers, deliberately. This app stores quantities
 * like 0.3333 cups and prices like 3.99 in Decimal precisely because binary
 * floating point mangles them; handing them to JSON as numbers would undo that at
 * the last step. The frontend reads them back into decimal.js from the same
 * string, so the value that left the database is the value that reaches the form.
 */
function serializeDecimals(value: unknown): unknown {
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (Array.isArray(value)) return value.map(serializeDecimals);

  // Only plain objects are walked. Dates, Buffers and class instances are left
  // alone so their own serialization still applies.
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = serializeDecimals(entry);
    }
    return out;
  }

  return value;
}

@Injectable()
export class DecimalSerializerInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(serializeDecimals));
  }
}
