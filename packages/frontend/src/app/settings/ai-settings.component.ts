import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
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
    FormsModule,
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
                [(ngModel)]="apiKey"
                name="apiKey"
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
                <mat-select [(ngModel)]="model" name="model">
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
                <mat-select [(ngModel)]="effort" name="effort">
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

  apiKey = "";
  model = "claude-opus-5";
  effort = "medium";

  constructor() {
    this.load();
  }

  save(): void {
    this.busy.set(true);
    this.error.set("");

    this.api
      .saveAiConfig({
        // Only sent when the user actually typed one — an empty box means
        // "leave the stored key alone", not "clear it".
        ...(this.apiKey.trim() ? { apiKey: this.apiKey.trim() } : {}),
        model: this.model,
        effort: this.effort,
      })
      .subscribe({
        next: (config) => {
          this.apiKey = "";
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
        this.model = config.model;
        this.effort = config.effort;
      },
      error: (error: unknown) =>
        this.notify.error(error, "Could not load the AI settings."),
    });
  }
}
