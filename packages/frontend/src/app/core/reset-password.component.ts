import { Component, inject, signal } from "@angular/core";
import { form, submit, validate, FormField, FormRoot } from "@angular/forms/signals";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { firstValueFrom } from "rxjs";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";

import { AuthService } from "./auth.service";
import { describeError } from "./notify.service";

@Component({
  selector: "app-reset-password",
  imports: [
    FormField,
    FormRoot,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
  ],
  template: `
    <div class="wrap">
      <mat-card>
        @if (busy()) {
          <mat-progress-bar mode="indeterminate" />
        }
        <mat-card-content>
          @if (!token()) {
            <h1>Link missing its token</h1>
            <p class="muted">
              This reset link is missing its token. Request a new one.
            </p>
          } @else {
            <h1>Set a new password</h1>
            <p class="muted">Choose a new password for your account.</p>

            <form [formRoot]="resetForm" (submit)="onSubmit($event)" class="stack">
              <mat-form-field appearance="outline">
                <mat-label>New password</mat-label>
                <input
                  matInput
                  type="password"
                  autocomplete="new-password"
                  [formField]="resetForm.newPassword"
                />
                @if (firstError(resetForm.newPassword()); as message) {
                  <mat-error>{{ message }}</mat-error>
                } @else {
                  <mat-hint>At least 12 characters. Length beats punctuation.</mat-hint>
                }
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Confirm new password</mat-label>
                <input
                  matInput
                  type="password"
                  autocomplete="new-password"
                  [formField]="resetForm.confirmPassword"
                />
                @if (firstError(resetForm.confirmPassword()); as message) {
                  <mat-error>{{ message }}</mat-error>
                }
              </mat-form-field>

              @if (error()) {
                <p class="warn-text" role="alert">{{ error() }}</p>
              }

              <button mat-flat-button type="submit" [disabled]="busy()">
                Set new password
              </button>
            </form>
          }
        </mat-card-content>

        <mat-card-actions>
          <a mat-button routerLink="/forgot-password">Request a new link</a>
        </mat-card-actions>
      </mat-card>
    </div>
  `,
  styles: `
    .wrap {
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 1rem;
    }
    mat-card {
      width: min(420px, 100%);
    }
    h1 {
      margin: 0.5rem 0 0.25rem;
      font-size: 1.4rem;
    }
    p {
      margin-top: 0;
    }
    form {
      margin-top: 1rem;
    }
    button[type="submit"] {
      padding: 0.5rem;
    }
  `,
})
export class ResetPasswordComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly busy = signal(false);
  readonly error = signal("");
  readonly token = signal(this.route.snapshot.queryParamMap.get("token") ?? "");

  /** Empty strings, never null — see login.component.ts. */
  private readonly model = signal({ newPassword: "", confirmPassword: "" });

  readonly resetForm = form(this.model, (path) => {
    validate(path.newPassword, ({ value }) => {
      if (value().length >= 12) return undefined;
      return {
        kind: "tooShort",
        message: "At least 12 characters. Length beats punctuation.",
      };
    });
    validate(path.confirmPassword, ({ value, valueOf }) => {
      if (value() === valueOf(path.newPassword)) return undefined;
      return { kind: "mismatch", message: "Passwords do not match." };
    });
  });

  firstError(state: { touched: () => boolean; errors: () => readonly { message?: string }[] }):
    | string
    | undefined {
    if (!state.touched()) return undefined;
    return state.errors().find((e) => e.message)?.message;
  }

  onSubmit(event: Event): void {
    event.preventDefault();
    if (this.busy()) return;
    this.error.set("");

    this.resetForm().markAsTouched();

    void submit(this.resetForm, async () => {
      this.busy.set(true);
      const { newPassword } = this.model();

      try {
        await firstValueFrom(
          this.auth.resetPassword({ token: this.token(), newPassword }),
        );
        // The server rotated the session cookie in the same request, so this
        // browser is already signed in under the new password.
        await this.router.navigateByUrl("/recipes");
      } catch (error: unknown) {
        this.busy.set(false);
        this.error.set(describeError(error, "Could not reset your password."));
      }
    });
  }
}
