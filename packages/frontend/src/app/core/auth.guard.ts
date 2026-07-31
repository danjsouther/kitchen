import { inject } from '@angular/core';
import { Router, type CanActivateFn, type UrlTree } from '@angular/router';
import { map, of, type Observable } from 'rxjs';

import { AuthService } from './auth.service';

/**
 * Runs `decide` once the session state is actually known.
 *
 * On a cold load the session is a cookie we cannot inspect, so we ask the server
 * and wait for the answer rather than assuming either way — refreshing on
 * `/pantry` should land back on `/pantry`, not bounce to login.
 */
function whenResolved(
  decide: () => boolean | UrlTree,
): Observable<boolean | UrlTree> | boolean | UrlTree {
  const auth = inject(AuthService);
  if (auth.ready()) return decide();
  return auth.restore().pipe(map(() => decide()));
}

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return whenResolved(() =>
    auth.user() !== null
      ? true
      : router.createUrlTree(['/login'], { queryParams: { next: state.url } }),
  );
};

/**
 * For screens that manage the household rather than merely use it.
 *
 * Deliberately not built by calling `authGuard` and inspecting its result: that
 * returns an Observable on a cold load, and treating "not literally `true`" as
 * failure would skip the role check exactly when it matters most.
 */
export const adminGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return whenResolved(() => {
    if (auth.user() === null) {
      return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
    }
    // The server enforces this too; the guard only saves a pointless round trip
    // and a screen the user cannot act on.
    return auth.isAdmin() ? true : router.createUrlTree(['/recipes']);
  });
};

/** Sends an already-signed-in visitor away from the login screen. */
export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return whenResolved(() =>
    auth.user() === null ? true : router.createUrlTree(['/recipes']),
  );
};

export { of };
