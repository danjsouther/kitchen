import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { runWithEmptyContext } from './household-context';

/**
 * Opens the AsyncLocalStorage scope for every request.
 *
 * Runs before guards, so the scope covers the whole request; the JWT strategy
 * fills in the household once it has authenticated the caller. A request that is
 * never authenticated keeps a null context, and any query against a scoped model
 * throws rather than reading across households.
 */
@Injectable()
export class HouseholdContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    runWithEmptyContext(() => next());
  }
}
