import {
  Component,
  inject,
  signal,
} from "@angular/core";
import { RouterLink } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatChipsModule } from "@angular/material/chips";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatTabsModule } from "@angular/material/tabs";
import { MatTooltipModule } from "@angular/material/tooltip";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { amountWithUnit } from "../shared/format";
import type { AiSuggestionResult, RecipeMatch, Unit } from "../core/models";

@Component({
  selector: "app-cook",
  imports: [
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatIconModule,
    MatProgressBarModule,
    MatTabsModule,
    MatTooltipModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>What can I cook?</h1>
      </div>

      <mat-tab-group>
        <!-- Tab one is arithmetic and is the source of truth about quantities. -->
        <mat-tab label="From the pantry">
          <div class="tab-body">
            @if (loading()) {
              <mat-progress-bar mode="indeterminate" />
            }

            @if (matches().length === 0 && !loading()) {
              <p class="empty muted">
                Nothing to compare yet — add some recipes and stock the pantry.
              </p>
            }

            @for (match of matches(); track match.recipeId) {
              <mat-card>
                <mat-card-content>
                  <div class="row">
                    <a
                      class="grow title"
                      [routerLink]="['/recipes', match.recipeId]"
                    >
                      {{ match.title }}
                    </a>
                    @if (match.canCook) {
                      <span class="ok-text row">
                        <mat-icon>check_circle</mat-icon> ready
                      </span>
                    } @else if (match.missing.length) {
                      <span class="muted">
                        {{ match.missing.length }} short
                      </span>
                    }
                  </div>

                  @if (match.missing.length) {
                    <div class="chip-row lines">
                      @for (line of match.missing; track line.ingredientId) {
                        <span class="pill missing">
                          {{ line.ingredientName ?? line.rawText }}
                          <span class="muted"
                            >need {{ amount(line.need, line.needUnit) }}</span
                          >
                        </span>
                      }
                    </div>
                  }

                  @if (match.unknown.length) {
                    <!--
                      Not folded into "missing": the app could not measure these,
                      which is not the same as knowing they are absent.
                    -->
                    <div class="chip-row lines">
                      @for (line of match.unknown; track line.ingredientId) {
                        <span
                          class="pill unknown"
                          [matTooltip]="'The pantry holds this, but not in units that can be compared with what the recipe asks for.'"
                        >
                          {{ line.ingredientName ?? line.rawText }}
                          <span class="muted">could not check</span>
                        </span>
                      }
                    </div>
                  }
                </mat-card-content>
              </mat-card>
            }
          </div>
        </mat-tab>

        <!-- Tab two adds judgement, and never recomputes the numbers above. -->
        <mat-tab label="Ideas">
          <div class="tab-body">
            <p class="muted">
              Sends the match above, plus your pantry and recipe titles, to
              Claude for substitutions and expiry-driven ideas. It costs your
              household money, so it only runs when you ask.
            </p>

            <button mat-flat-button (click)="askAi()" [disabled]="aiLoading()">
              <mat-icon>auto_awesome</mat-icon>
              Suggest something
            </button>

            @if (aiLoading()) {
              <mat-progress-bar mode="indeterminate" />
            }

            @if (aiError()) {
              <mat-card class="notice">
                <mat-card-content>{{ aiError() }}</mat-card-content>
              </mat-card>
            }

            @if (ai(); as result) {
              @if (!result.ok) {
                <mat-card class="notice">
                  <mat-card-content>
                    <strong>Showing the pantry match instead.</strong>
                    <div class="muted">{{ result.reason }}</div>
                  </mat-card-content>
                </mat-card>
              } @else if (result.ai) {
                <p>{{ result.ai.summary }}</p>

                @for (suggestion of result.ai.suggestions; track $index) {
                  <mat-card>
                    <mat-card-content>
                      <div class="row">
                        @if (suggestion.recipeId) {
                          <a
                            class="grow title"
                            [routerLink]="['/recipes', suggestion.recipeId]"
                          >
                            {{ suggestion.title }}
                          </a>
                        } @else {
                          <span class="grow title">{{ suggestion.title }}</span>
                        }
                        <span class="pill kind">{{
                          label(suggestion.kind)
                        }}</span>
                      </div>

                      <p class="why">{{ suggestion.why }}</p>

                      @for (swap of suggestion.substitutions; track $index) {
                        <div class="swap">
                          <strong>{{ swap.missing }}</strong> →
                          {{ swap.useInstead }}
                          <div class="muted small">{{ swap.note }}</div>
                        </div>
                      }

                      @if (suggestion.usesExpiring.length) {
                        <div class="chip-row">
                          @for (name of suggestion.usesExpiring; track name) {
                            <span class="pill expiring">uses {{ name }}</span>
                          }
                        </div>
                      }
                    </mat-card-content>
                  </mat-card>
                }

                @if (result.usage; as usage) {
                  <p class="muted small">
                    {{ usage.inputTokens }} in / {{ usage.outputTokens }} out
                    @if (usage.cacheReadTokens) {
                      · {{ usage.cacheReadTokens }} cached
                    }
                  </p>
                }
              }
            }
          </div>
        </mat-tab>
      </mat-tab-group>
    </div>
  `,
  styles: `
    .tab-body {
      padding-top: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      align-items: stretch;
    }
    .tab-body > button {
      align-self: flex-start;
    }
    .title {
      font-weight: 500;
      text-decoration: none;
      color: inherit;
    }
    a.title:hover {
      text-decoration: underline;
    }
    .lines {
      margin-top: 0.5rem;
    }
    .pill {
      display: inline-flex;
      gap: 0.35rem;
      align-items: baseline;
      padding: 0.2rem 0.6rem;
      border-radius: 999px;
      font-size: 0.85rem;
      background: var(--mat-sys-surface-container-high);
    }
    .pill.missing {
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    .pill.unknown {
      border: 1px dashed var(--mat-sys-outline);
    }
    .pill.expiring {
      background: var(--mat-sys-tertiary-container);
    }
    .pill.kind {
      font-size: 0.75rem;
      text-transform: lowercase;
    }
    .why {
      margin: 0.5rem 0;
    }
    .swap {
      margin: 0.35rem 0;
    }
    .small {
      font-size: 0.85rem;
    }
    .notice {
      background: var(--mat-sys-surface-container-high);
    }
  `,
})
export class CookComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  readonly matches = signal<RecipeMatch[]>([]);
  readonly loading = signal(true);

  readonly ai = signal<AiSuggestionResult | null>(null);
  readonly aiLoading = signal(false);
  readonly aiError = signal("");

  constructor() {
    this.api.pantrySuggestions().subscribe({
      next: (result) => {
        this.matches.set(result.matches);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.notify.error(error, "Could not work out what you can cook.");
      },
    });
  }

  amount(quantity: string, unit: Unit): string {
    return amountWithUnit(quantity, unit);
  }

  label(kind: string): string {
    if (kind === "SAVED_RECIPE") return "your recipe";
    if (kind === "SUBSTITUTION") return "with a swap";
    return "new idea";
  }

  askAi(): void {
    this.aiLoading.set(true);
    this.aiError.set("");

    this.api.aiSuggestions().subscribe({
      next: (result) => {
        this.ai.set(result);
        this.aiLoading.set(false);
      },
      error: (error: unknown) => {
        this.aiLoading.set(false);
        // A 409 here means the household has not set a key up — an ordinary
        // state with an obvious next step, not a failure to apologise for.
        this.aiError.set(
          (error as { status?: number }).status === 409
            ? "No Anthropic API key is set for this household yet. An admin can add one in Settings."
            : "Could not get suggestions just now.",
        );
      },
    });
  }
}
