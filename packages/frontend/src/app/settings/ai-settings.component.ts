import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import {
  FormField,
  form,
  min,
  required,
  submit,
} from "@angular/forms/signals";
import { firstValueFrom } from "rxjs";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatSelectModule } from "@angular/material/select";

import { ApiService } from "../core/api.service";
import { NotifyService, describeError } from "../core/notify.service";
import type { AiConfig } from "../core/models";

@Component({
  selector: "app-ai-settings",
  imports: [
    DatePipe,
    FormField,
      MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
  ],
  template: `
    <div class="page narrow">
      <div class="page-header">
        <h1>Anthropic API key</h1>
      </div>

      <p class="muted">
        There is deliberately no shared key on the server — each household
        brings its own and pays for its own usage. The key is encrypted before
        it is stored, and no screen or endpoint will ever show it again.
      </p>

      @if (busy()) {
        <mat-progress-bar mode="indeterminate" />
      }

      @if (config(); as c) {
        <mat-card>
          <mat-card-content>
            @if (c.configured) {
              <div class="row status">
                <mat-icon class="ok-text">check_circle</mat-icon>
                <span class="grow">
                  A key ending <code>••••{{ c.keyLastFour }}</code> is stored.
                  @if (c.verifiedOn) {
                    <div class="muted small">
                      Checked against Anthropic on
                      {{ c.verifiedOn | date: "d MMM y, HH:mm" }}
                    </div>
                  }
                </span>
              </div>
            } @else {
              <p class="muted">
                No key yet, so the “Ideas” tab will not do anything.
              </p>
            }

            <mat-form-field appearance="outline" class="full">
              <mat-label>{{
                c.configured ? "Replace the key" : "API key"
              }}</mat-label>
              <input
                matInput
                type="password"
                autocomplete="off"
                [formField]="keyForm.apiKey"
                placeholder="sk-ant-..."
              />
              <mat-hint>
                Checked against the real API before it is saved, so a bad key
                fails here rather than later.
              </mat-hint>
            </mat-form-field>

            <div class="row">
              <mat-form-field appearance="outline">
                <mat-label>Model</mat-label>
                <mat-select [formField]="keyForm.model">
                  <mat-option value="claude-opus-5">Claude Opus 5</mat-option>
                  <mat-option value="claude-sonnet-5"
                    >Claude Sonnet 5</mat-option
                  >
                  <mat-option value="claude-haiku-4-5"
                    >Claude Haiku 4.5</mat-option
                  >
                </mat-select>
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Effort</mat-label>
                <mat-select [formField]="keyForm.effort">
                  <mat-option value="low">Low — cheapest</mat-option>
                  <mat-option value="medium">Medium</mat-option>
                  <mat-option value="high">High</mat-option>
                </mat-select>
              </mat-form-field>
            </div>

            @if (error()) {
              <p class="warn-text" role="alert">{{ error() }}</p>
            }

            <div class="row actions">
              <button mat-flat-button (click)="save()" [disabled]="busy()">
                Save
              </button>
              @if (c.configured) {
                <button
                  mat-stroked-button
                  (click)="clear()"
                  [disabled]="busy()"
                >
                  Remove the key
                </button>
              }
            </div>
          </mat-card-content>
        </mat-card>

        <p class="muted small">
          Rotating the server's <code>AI_ENCRYPTION_KEY</code> makes every
          stored household key unreadable; each household then enters its own
          again.
        </p>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .narrow {
      max-width: 640px;
    }
    .full {
      width: 100%;
    }
    .small {
      font-size: 0.85rem;
    }
    .status {
      margin-bottom: 1rem;
    }
    .actions {
      margin-top: 0.5rem;
    }
    code {
      background: var(--mat-sys-surface-container-high);
      padding: 0.1rem 0.3rem;
      border-radius: 4px;
    }
  `,
})
export class AiSettingsComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  readonly config = signal<AiConfig | null>(null);
  readonly busy = signal(false);
  readonly error = signal("");

  /**
   * The key is write-only by design: it is never read back from the server, so
   * this model starts empty on every visit and an empty value on save means
   * "leave the stored key alone" rather than "clear it".
   */
  private readonly keyModel = signal({
    apiKey: "",
    model: "claude-opus-5",
    effort: "medium",
  });

  readonly keyForm = form(this.keyModel, (path) => {
    required(path.model, { message: "Pick a model." });
    required(path.effort, { message: "Pick an effort level." });
  });

  /** The first message worth showing, once the user has actually been there. */
  firstError(state: {
    touched: () => boolean;
    errors: () => readonly { message?: string }[];
  }): string | undefined {
    if (!state.touched()) return undefined;
    return state.errors().find((e) => e.message)?.message;
  }


  constructor() {
    this.load();
  }

  save(): void {
    // Gate on validity here rather than in a <form>: this submits from a
    // button, so there is no submit event for FormRoot to intercept.
    this.keyForm().markAsTouched();
    if (this.keyForm().invalid()) return;

    this.busy.set(true);
    this.error.set("");

    this.api
      .saveAiConfig({
        // Only sent when the user actually typed one — an empty box means
        // "leave the stored key alone", not "clear it".
        ...(this.keyModel().apiKey.trim() ? { apiKey: this.keyModel().apiKey.trim() } : {}),
        model: this.keyModel().model,
        effort: this.keyModel().effort,
      })
      .subscribe({
        next: (config) => {
          this.keyModel.update((m) => ({ ...m, apiKey: "" }));
          this.config.set(config);
          this.busy.set(false);
          this.notify.success("Saved.");
        },
        error: (error: unknown) => {
          this.busy.set(false);
          this.error.set(describeError(error, "Could not save that key."));
        },
      });
  }

  clear(): void {
    this.busy.set(true);
    this.api.clearAiConfig().subscribe({
      next: (config) => {
        this.config.set(config);
        this.busy.set(false);
        this.notify.success("Key removed.");
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not remove the key.");
      },
    });
  }

  private load(): void {
    this.api.aiConfig().subscribe({
      next: (config) => {
        this.config.set(config);
        this.keyModel.update((m) => ({ ...m, model: config.model, effort: config.effort }));
      },
      error: (error: unknown) =>
        this.notify.error(error, "Could not load the AI settings."),
    });
  }
}
