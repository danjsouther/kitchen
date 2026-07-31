import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, of, tap } from 'rxjs';

import { ApiService } from './api.service';
import type { AuthUser } from './models';

/**
 * Who is signed in.
 *
 * The session itself is an httpOnly cookie the browser sends automatically and
 * page JavaScript cannot read — so this holds only the *profile* the server
 * returned, and "am I logged in" is answered by asking the server, not by
 * inspecting a token.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  private readonly currentUser = signal<AuthUser | null>(null);
  /** Null until the first `restore()` resolves, so guards can wait rather than guess. */
  private readonly resolved = signal(false);

  readonly user = this.currentUser.asReadonly();
  readonly ready = this.resolved.asReadonly();
  readonly isAdmin = computed(() => this.currentUser()?.role === 'ADMIN');

  /** Asks the server who we are. Called once at startup. */
  restore() {
    return this.api.me().pipe(
      tap((user) => {
        this.currentUser.set(user);
        this.resolved.set(true);
      }),
      catchError(() => {
        // A 401 here is the ordinary "not signed in" case, not an error worth
        // surfacing — the guard will send them to the login screen.
        this.currentUser.set(null);
        this.resolved.set(true);
        return of(null);
      }),
    );
  }

  login(email: string, password: string) {
    return this.api.login({ email, password }).pipe(tap((user) => this.currentUser.set(user)));
  }

  register(body: {
    email: string;
    password: string;
    displayName: string;
    householdName: string;
  }) {
    return this.api.register(body).pipe(tap((user) => this.currentUser.set(user)));
  }

  logout() {
    this.api.logout().subscribe({
      // The cookie is cleared server-side either way; a failure here should still
      // leave the user on the login screen rather than stuck in a signed-in shell.
      next: () => this.finishLogout(),
      error: () => this.finishLogout(),
    });
  }

  private finishLogout(): void {
    this.currentUser.set(null);
    void this.router.navigate(['/login']);
  }
}
