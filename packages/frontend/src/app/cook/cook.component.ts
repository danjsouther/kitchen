import {
  Component,
  inject,
  signal,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import { Router, RouterLink } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatChipsModule } from "@angular/material/chips";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatTabsModule } from "@angular/material/tabs";
import { MatTooltipModule } from "@angular/material/tooltip";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { PagerComponent } from "../shared/pager.component";
import { amountWithUnit } from "../shared/format";
import type { AiSuggestionResult, AiSuggestionRun, Paged, RecipeMatch, Unit } from "../core/models";

type GeneratedSuggestionBody = NonNullable<
  NonNullable<AiSuggestionResult["ai"]>["suggestions"][number]["body"]
>;

/**
 * What the Ideas tab actually renders — a live `askAi()` result or a
 * persisted `AiSuggestionRun` both satisfy this structurally, so selecting a
 * past run needs no template changes.
 */
interface AiSuggestionView {
  ok: boolean;
  reason?: string;
  ai: AiSuggestionResult["ai"];
  usage?: AiSuggestionResult["usage"];
}

const HISTORY_LIMIT = 10;
const NOTES_MAX_LENGTH = 250;

@Component({
  selector: "app-cook",
  imports: [
    DatePipe,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatTabsModule,
    MatTooltipModule,
    PagerComponent,
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

            <mat-form-field appearance="outline" class="notes">
              <mat-label>Anything in particular?</mat-label>
              <textarea
                matInput
                rows="2"
                [attr.maxlength]="notesMaxLength"
                [value]="notes()"
                (input)="notes.set($any($event.target).value)"
                placeholder="e.g. I want a salmon dish for breakfast"
              ></textarea>
              <mat-hint align="end">{{ notes().length }}/{{ notesMaxLength }}</mat-hint>
            </mat-form-field>

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

                      @if (suggestion.body) {
                        <button
                          mat-button
                          (click)="saveGenerated(suggestion.title, suggestion.body)"
                        >
                          <mat-icon>bookmark_add</mat-icon>
                          Save this recipe
                        </button>
                      }

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

            @if (history().items.length) {
              <h2>Past suggestions</h2>

              <div class="history-list">
                @for (run of history().items; track run.id) {
                  <button
                    type="button"
                    class="history-row"
                    [class.current]="run.id === selectedRunId()"
                    (click)="selectRun(run)"
                  >
                    <span class="grow">
                      <span [class.warn-text]="!run.ok">
                        {{ run.ok ? (run.ai?.summary ?? "Suggestions") : (run.reason ?? "Failed") }}
                      </span>
                      <div class="muted small">
                        {{ run.createdOn | date: "d MMM y, HH:mm" }}
                      </div>
                    </span>
                    <span class="muted small">
                      {{ run.usage.inputTokens }} in / {{ run.usage.outputTokens }} out
                    </span>
                  </button>
                }
              </div>

              <app-pager
                [total]="history().total"
                [limit]="historyLimit"
                [offset]="history().offset"
                (offsetChange)="loadHistory($event)"
              />
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
    .notes {
      width: 100%;
      max-width: 32rem;
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
    .history-list {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .history-row {
      display: flex;
      align-items: center;
      gap: 1rem;
      width: 100%;
      padding: 0.6rem 0.75rem;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      background: none;
      text-align: left;
      cursor: pointer;
      font: inherit;
      color: inherit;
    }
    .history-row.current {
      background: var(--mat-sys-secondary-container);
      border-color: transparent;
    }
  `,
})
export class CookComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly router = inject(Router);

  readonly matches = signal<RecipeMatch[]>([]);
  readonly loading = signal(true);

  readonly ai = signal<AiSuggestionView | null>(null);
  readonly aiLoading = signal(false);
  readonly aiError = signal("");
  readonly notes = signal("");
  readonly notesMaxLength = NOTES_MAX_LENGTH;

  readonly historyLimit = HISTORY_LIMIT;
  readonly history = signal<Paged<AiSuggestionRun>>({
    total: 0,
    limit: HISTORY_LIMIT,
    offset: 0,
    items: [],
  });
  readonly selectedRunId = signal<number | null>(null);

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

    // Shows the most recent run instead of an empty panel on arrival.
    this.loadHistory(0);
  }

  amount(quantity: string, unit: Unit): string {
    return amountWithUnit(quantity, unit);
  }

  label(kind: string): string {
    if (kind === "SAVED_RECIPE") return "your recipe";
    if (kind === "SUBSTITUTION") return "with a swap";
    return "new idea";
  }

  /**
   * Hands a GENERATED suggestion's body to the paste-import review screen, as
   * if it had just come back from parsing pasted text — same review, same
   * edit-before-save trust model, nothing persisted until the cook saves it.
   */
  saveGenerated(title: string, body: GeneratedSuggestionBody): void {
    void this.router.navigate(["/recipes", "import"], {
      state: {
        aiDraft: {
          title,
          servings: body.servings,
          ingredients: body.ingredients,
          steps: body.steps,
          ignored: [],
        },
      },
    });
  }

  askAi(): void {
    this.aiLoading.set(true);
    this.aiError.set("");

    const notes = this.notes().trim();

    this.api.aiSuggestions(notes ? { notes } : {}).subscribe({
      next: (result) => {
        this.ai.set(result);
        this.selectedRunId.set(null);
        this.aiLoading.set(false);
        // The fresh run is now persisted; refresh the list so it shows up
        // (and gets highlighted once it does, as the newest item on page 1).
        this.loadHistory(0);
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

  loadHistory(offset: number): void {
    this.api.aiSuggestionHistory({ limit: this.historyLimit, offset }).subscribe({
      next: (page) => {
        this.history.set(page);
        if (offset === 0 && page.items.length) this.selectRun(page.items[0]);
      },
      error: (error: unknown) =>
        this.notify.error(error, "Could not load past suggestions."),
    });
  }

  selectRun(run: AiSuggestionRun): void {
    this.selectedRunId.set(run.id);
    this.ai.set({ ok: run.ok, reason: run.reason, ai: run.ai, usage: run.usage });
  }
}
