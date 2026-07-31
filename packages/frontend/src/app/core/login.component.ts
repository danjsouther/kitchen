import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
} from "@angular/core";
import {
  FormField,
  FormRoot,
  email as emailRule,
  form,
  required,
  submit,
  validate,
} from "@angular/forms/signals";
import { ActivatedRoute, Router } from "@angular/router";
import { firstValueFrom } from "rxjs";
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
    FormField,
    FormRoot,
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

          <!--
            Signal Forms: fields bind with [formField] and are NOT called here.
            Calling a field (loginForm.email()) gives its state, which is how
            the error messages below read errors() and touched().
          -->
          <form [formRoot]="loginForm" (submit)="onSubmit($event)" class="stack">
            @if (registering()) {
              <mat-form-field appearance="outline">
                <mat-label>Your name</mat-label>
                <input matInput [formField]="loginForm.displayName" />
                @if (firstError(loginForm.displayName()); as message) {
                  <mat-error>{{ message }}</mat-error>
                }
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Household name</mat-label>
                <input matInput [formField]="loginForm.householdName" />
                @if (firstError(loginForm.householdName()); as message) {
                  <mat-error>{{ message }}</mat-error>
                }
              </mat-form-field>
            }

            <mat-form-field appearance="outline">
              <mat-label>Email</mat-label>
              <input
                matInput
                type="email"
                autocomplete="email"
                [formField]="loginForm.email"
              />
              @if (firstError(loginForm.email()); as message) {
                <mat-error>{{ message }}</mat-error>
              }
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Password</mat-label>
              <input
                matInput
                type="password"
                [autocomplete]="
                  registering() ? 'new-password' : 'current-password'
                "
                [formField]="loginForm.password"
              />
              @if (firstError(loginForm.password()); as message) {
                <mat-error>{{ message }}</mat-error>
              } @else if (registering()) {
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

  /**
   * Empty strings, never null or undefined. Signal Forms derives the form's
   * shape from this model, and a null initial value gives a field no type to
   * work from.
   */
  private readonly model = signal({
    displayName: "",
    householdName: "",
    email: "",
    password: "",
  });

  readonly loginForm = form(this.model, (path) => {
    required(path.email, { message: "An email address is required." });
    emailRule(path.email, { message: "That does not look like an email address." });
    required(path.password, { message: "A password is required." });

    // Only when creating a household — the two name fields are not on screen
    // when signing in, and requiring them would block a valid login.
    required(path.displayName, {
      message: "Your name is required.",
      when: () => this.registering(),
    });
    required(path.householdName, {
      message: "A household name is required.",
      when: () => this.registering(),
    });

    // Length is checked on the way in, not on the way back: an existing
    // account may predate this rule, and failing its login here would lock the
    // user out of their own data over a rule they cannot satisfy at that
    // screen. `when` is only available on required(), hence validate().
    validate(path.password, ({ value }) => {
      if (!this.registering()) return undefined;
      if (value().length >= 12) return undefined;
      return {
        kind: "tooShort",
        message: "At least 12 characters. Length beats punctuation.",
      };
    });
  });

  toggle(): void {
    this.registering.update((value) => !value);
    this.error.set("");
  }

  /** The first message worth showing, once the user has actually been there. */
  firstError(state: { touched: () => boolean; errors: () => readonly { message?: string }[] }):
    | string
    | undefined {
    if (!state.touched()) return undefined;
    return state.errors().find((e) => e.message)?.message;
  }

  onSubmit(event: Event): void {
    // Native `submit`, not `ngSubmit`: ngSubmit is an NgForm output from
    // FormsModule, which Signal Forms replaces. Left as (ngSubmit) it binds a
    // custom event that never fires, and the button silently does nothing —
    // which is exactly what it did until a browser check caught it.
    event.preventDefault();
    if (this.busy()) return;
    this.error.set("");

    // markAsTouched() first, explicitly. submit() runs the action only when the
    // form is valid, but in this version it does NOT mark fields touched on the
    // way — so a blank submit would silently do nothing, with no message,
    // because the errors below only show once a field has been touched.
    // Verified in a browser: without this the field is ng-invalid ng-untouched.
    this.loginForm().markAsTouched();

    void submit(this.loginForm, async () => {
      this.busy.set(true);
      const value = this.model();

      try {
        await firstValueFrom(
          this.registering()
            ? this.auth.register({
                email: value.email,
                password: value.password,
                displayName: value.displayName,
                householdName: value.householdName,
              })
            : this.auth.login(value.email, value.password),
        );

        // Land back where they were headed before the guard intervened.
        const next = this.route.snapshot.queryParamMap.get("next") ?? "/recipes";
        await this.router.navigateByUrl(next);
      } catch (error: unknown) {
        this.busy.set(false);
        this.error.set(describeError(error, "Could not sign in."));
      }
    });
  }
}
