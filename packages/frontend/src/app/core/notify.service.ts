import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { HttpErrorResponse } from '@angular/common/http';

/**
 * User-facing messages.
 *
 * The backend writes its validation errors for people to read — "Ingredient line
 * 2 has a unit but no quantity" — so the job here is to surface that text rather
 * than replace it with something generic.
 */
@Injectable({ providedIn: 'root' })
export class NotifyService {
  private readonly snackBar = inject(MatSnackBar);

  success(message: string): void {
    this.snackBar.open(message, 'OK', { duration: 3000 });
  }

  error(error: unknown, fallback = 'Something went wrong.'): void {
    this.snackBar.open(describeError(error, fallback), 'Dismiss', { duration: 7000 });
  }
}

/** Pulls the most useful sentence out of whatever the server sent back. */
export function describeError(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) {
      return 'Could not reach the server. Is the backend running?';
    }

    const message = (error.error as { message?: string | string[] } | null)?.message;
    if (Array.isArray(message)) return message.join(' ');
    if (typeof message === 'string') return message;

    if (error.status === 401) return 'Your session has expired. Please sign in again.';
    if (error.status === 403) return 'You do not have permission to do that.';
  }

  return fallback;
}
