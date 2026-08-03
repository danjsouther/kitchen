import { Component, inject, signal } from "@angular/core";
import {
  FormField,
  FormRoot,
  email as emailRule,
  form,
  required,
  submit,
} from "@angular/forms/signals";
import { RouterLink } from "@angular/router";
import { firstValueFrom } from "rxjs";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";

import { ApiService } from "./api.service";
import { describeError } from "./notify.service";

@Component({
  selector: "app-forgot-password",
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
          @if (sent()) {
            <h1>Check your email</h1>
            <p class="muted">
              If an account exists for that email, a reset link is on its way.
              It expires in 1 hour.
            </p>
          } @else {
            <h1>Forgot password?</h1>
            <p class="muted">
              Enter your account's email and we'll send you a link to set a
              new password.
            </p>

            <form [formRoot]="requestForm" (submit)="onSubmit($event)" class="stack">
              <mat-form-field appearance="outline">
                <mat-label>Email</mat-label>
                <input
                  matInput
                  type="email"
                  autocomplete="email"
                  [formField]="requestForm.email"
                />
                @if (firstError(requestForm.email()); as message) {
                  <mat-error>{{ message }}</mat-error>
                }
              </mat-form-field>

              @if (error()) {
                <p class="warn-text" role="alert">{{ error() }}</p>
              }

              <button mat-flat-button type="submit" [disabled]="busy()">
                Send reset link
              </button>
            </form>
          }
        </mat-card-content>

        <mat-card-actions>
          <a mat-button routerLink="/login">Back to sign in</a>
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
export class ForgotPasswordComponent {
  private readonly api = inject(ApiService);

  readonly busy = signal(false);
  readonly error = signal("");
  readonly sent = signal(false);

  /** Empty string, never null — Signal Forms derives the field's type from this. */
  private readonly model = signal({ email: "" });

  readonly requestForm = form(this.model, (path) => {
    required(path.email, { message: "An email address is required." });
    emailRule(path.email, { message: "That does not look like an email address." });
  });

  /** Same rule as login.component.ts's firstError. */
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

    this.requestForm().markAsTouched();

    void submit(this.requestForm, async () => {
      this.busy.set(true);
      const { email } = this.model();

      try {
        await firstValueFrom(this.api.requestPasswordReset({ email }));
        // The backend's response is identical whether or not the email is
        // registered, so there is nothing "found" vs "not found" to show here
        // — showing anything else would undermine that.
        this.sent.set(true);
      } catch (error: unknown) {
        this.error.set(describeError(error, "Could not send the reset link."));
      } finally {
        this.busy.set(false);
      }
    });
  }
}
