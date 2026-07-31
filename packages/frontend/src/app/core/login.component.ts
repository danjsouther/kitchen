import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";

import { AuthService } from "./auth.service";
import { describeError } from "./notify.service";

@Component({
  selector: "app-login",
  imports: [
    FormsModule,
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
          <h1>{{ registering() ? "Create a household" : "Sign in" }}</h1>
          <p class="muted">
            {{
              registering()
                ? "The first account in a household is its administrator."
                : "Recipes, pantry and meal planning for your kitchen."
            }}
          </p>

          <form (ngSubmit)="submit()" class="stack">
            @if (registering()) {
              <mat-form-field appearance="outline">
                <mat-label>Your name</mat-label>
                <input
                  matInput
                  name="displayName"
                  [(ngModel)]="displayName"
                  required
                />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Household name</mat-label>
                <input
                  matInput
                  name="householdName"
                  [(ngModel)]="householdName"
                  required
                />
              </mat-form-field>
            }

            <mat-form-field appearance="outline">
              <mat-label>Email</mat-label>
              <input
                matInput
                type="email"
                name="email"
                autocomplete="email"
                [(ngModel)]="email"
                required
              />
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Password</mat-label>
              <input
                matInput
                type="password"
                name="password"
                [autocomplete]="
                  registering() ? 'new-password' : 'current-password'
                "
                [(ngModel)]="password"
                required
              />
              @if (registering()) {
                <mat-hint
                  >At least 12 characters. Length beats punctuation.</mat-hint
                >
              }
            </mat-form-field>

            @if (error()) {
              <p class="warn-text" role="alert">{{ error() }}</p>
            }

            <button mat-flat-button type="submit" [disabled]="busy()">
              {{ registering() ? "Create household" : "Sign in" }}
            </button>
          </form>
        </mat-card-content>

        <mat-card-actions>
          <button mat-button type="button" (click)="toggle()">
            {{
              registering()
                ? "I already have an account"
                : "Create a new household"
            }}
          </button>
        </mat-card-actions>
      </mat-card>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
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
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly registering = signal(false);
  readonly busy = signal(false);
  readonly error = signal("");

  email = "";
  password = "";
  displayName = "";
  householdName = "";

  toggle(): void {
    this.registering.update((value) => !value);
    this.error.set("");
  }

  submit(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set("");

    const request = this.registering()
      ? this.auth.register({
          email: this.email,
          password: this.password,
          displayName: this.displayName,
          householdName: this.householdName,
        })
      : this.auth.login(this.email, this.password);

    request.subscribe({
      next: () => {
        // Land back where they were headed before the guard intervened.
        const next =
          this.route.snapshot.queryParamMap.get("next") ?? "/recipes";
        void this.router.navigateByUrl(next);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.error.set(describeError(error, "Could not sign in."));
      },
    });
  }
}
