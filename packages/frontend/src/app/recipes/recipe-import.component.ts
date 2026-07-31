import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatSelectModule } from "@angular/material/select";
import { MatTooltipModule } from "@angular/material/tooltip";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import type { ParseResult, ParsedLine } from "../core/models";

@Component({
  selector: "app-recipe-import",
  imports: [
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>Paste a recipe</h1>
      </div>

      @if (!parsed()) {
        <p class="muted">
          Paste the whole thing — title, ingredients and method. Nothing is
          saved until you have looked over what it made of it.
        </p>

        <mat-form-field appearance="outline" class="full">
          <mat-label>Recipe text</mat-label>
          <textarea
            matInput
            rows="16"
            [(ngModel)]="text"
            name="text"
          ></textarea>
        </mat-form-field>

        <button
          mat-flat-button
          (click)="parse()"
          [disabled]="busy() || !text.trim()"
        >
          <mat-icon>auto_fix_high</mat-icon>
          Read it
        </button>
      }

      @if (busy()) {
        <mat-progress-bar mode="indeterminate" />
      }

      @if (parsed(); as result) {
        <mat-card class="summary">
          <mat-card-content class="row">
            <span class="grow">
              Found {{ result.summary.total }} ingredients and
              {{ result.steps.length }} steps.
              @if (result.summary.needsReview) {
                <strong class="warn-text">
                  {{ result.summary.needsReview }} need a look.
                </strong>
              } @else {
                <span class="ok-text">Everything matched cleanly.</span>
              }
            </span>
            <button mat-button (click)="startOver()">Start over</button>
          </mat-card-content>
        </mat-card>

        <div class="row fields">
          <mat-form-field appearance="outline" class="grow">
            <mat-label>Title</mat-label>
            <input matInput [(ngModel)]="title" name="title" />
          </mat-form-field>
          <mat-form-field appearance="outline" class="servings">
            <mat-label>Serves</mat-label>
            <input
              matInput
              type="number"
              min="1"
              [(ngModel)]="servings"
              name="servings"
            />
          </mat-form-field>
        </div>

        <h2>Ingredients</h2>
        <p class="muted small">
          The original text is on the left and what the app made of it on the
          right. Correct anything it got wrong before saving.
        </p>

        @for (line of lines(); track $index) {
          <mat-card class="line" [class.review]="line.needsReview">
            <mat-card-content class="line-grid">
              <div class="raw">
                <code>{{ line.rawText }}</code>
                @if (line.isRange) {
                  <div class="hint warn-text">
                    <mat-icon class="tiny">info</mat-icon>
                    a range — took the lower amount
                  </div>
                }
                @if (line.inferredQuantity) {
                  <div class="hint warn-text">
                    <mat-icon class="tiny">info</mat-icon>
                    no number given — read as one
                  </div>
                }
              </div>

              <div class="parsed">
                <div class="row">
                  <span class="amount">{{ line.quantity ?? "—" }}</span>
                  <span class="muted">{{ line.unitToken ?? "no unit" }}</span>
                  <span class="grow">{{ line.name }}</span>
                </div>
                <div class="row match">
                  @if (line.match.best) {
                    <span
                      class="pill"
                      [class.fuzzy]="line.match.kind === 'FUZZY'"
                    >
                      {{ line.match.best.name }}
                    </span>
                    <span class="muted small" [matTooltip]="matchHelp(line)">
                      {{ matchLabel(line) }}
                    </span>
                  } @else {
                    <span class="muted small">
                      no catalog match — it will save as plain text
                    </span>
                  }
                  @if (line.match.alternatives.length) {
                    <mat-form-field appearance="outline" class="alt">
                      <mat-label>Use instead</mat-label>
                      <mat-select
                        [value]="line.ingredientId"
                        (valueChange)="pick(line, $event)"
                      >
                        @if (line.match.best) {
                          <mat-option [value]="line.match.best.ingredientId">
                            {{ line.match.best.name }}
                          </mat-option>
                        }
                        @for (
                          alt of line.match.alternatives;
                          track alt.ingredientId
                        ) {
                          <mat-option [value]="alt.ingredientId">{{
                            alt.name
                          }}</mat-option>
                        }
                        <mat-option [value]="null">Leave unmatched</mat-option>
                      </mat-select>
                    </mat-form-field>
                  }
                </div>
              </div>
            </mat-card-content>
          </mat-card>
        }

        <h2>Method</h2>
        <ol class="steps">
          @for (step of result.steps; track $index) {
            <li>{{ step.text }}</li>
          }
        </ol>

        @if (result.ignored.length) {
          <p class="muted small">Set aside: {{ result.ignored.join(" · ") }}</p>
        }

        <div class="row actions">
          <button mat-flat-button (click)="save()" [disabled]="busy()">
            <mat-icon>save</mat-icon>
            Save recipe
          </button>
          @if (unresolvedCount(); as count) {
            <span class="muted small">
              {{ count }} line{{ count === 1 ? "" : "s" }} will save as plain
              text.
            </span>
          }
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .full {
      width: 100%;
    }
    .fields {
      align-items: flex-start;
    }
    .servings {
      width: 8rem;
    }
    h2 {
      font-size: 1.1rem;
      font-weight: 500;
      margin: 1.5rem 0 0.25rem;
    }
    .small {
      font-size: 0.85rem;
    }
    .summary {
      margin-bottom: 1rem;
      background: var(--mat-sys-surface-container-high);
    }
    .line {
      margin-bottom: 0.5rem;
    }
    .line.review {
      border-left: 3px solid var(--mat-sys-error);
    }
    .line-grid {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) 2fr;
      gap: 1rem;
      align-items: start;
      padding-bottom: 0.75rem;
    }
    @media (max-width: 720px) {
      .line-grid {
        grid-template-columns: 1fr;
        gap: 0.35rem;
      }
    }
    code {
      font-size: 0.85rem;
      color: var(--mat-sys-on-surface-variant);
      word-break: break-word;
    }
    .hint {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.75rem;
      margin-top: 0.2rem;
    }
    .tiny {
      font-size: 0.9rem;
      width: 0.9rem;
      height: 0.9rem;
    }
    .amount {
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }
    .match {
      margin-top: 0.35rem;
    }
    .pill {
      padding: 0.15rem 0.6rem;
      border-radius: 999px;
      background: var(--mat-sys-tertiary-container);
      color: var(--mat-sys-on-tertiary-container);
      font-size: 0.85rem;
    }
    .pill.fuzzy {
      background: var(--mat-sys-surface-container-highest);
      border: 1px dashed var(--mat-sys-outline);
    }
    .alt {
      width: 12rem;
    }
    .alt ::ng-deep .mat-mdc-form-field-subscript-wrapper {
      display: none;
    }
    .steps {
      padding-left: 1.2rem;
    }
    .steps li {
      margin-bottom: 0.5rem;
    }
    .actions {
      margin-top: 1.5rem;
    }
  `,
})
export class RecipeImportComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly router = inject(Router);

  readonly parsed = signal<ParseResult | null>(null);
  readonly lines = signal<ParsedLine[]>([]);
  readonly busy = signal(false);

  readonly unresolvedCount = computed(
    () => this.lines().filter((line) => line.ingredientId === null).length,
  );

  text = "";
  title = "";
  servings = 4;

  parse(): void {
    this.busy.set(true);
    this.api.parseRecipe(this.text).subscribe({
      next: (result) => {
        this.parsed.set(result);
        this.lines.set(result.ingredients);
        this.title = result.title ?? "";
        this.servings = result.servings ?? 4;
        this.busy.set(false);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not read that.");
      },
    });
  }

  startOver(): void {
    this.parsed.set(null);
    this.lines.set([]);
  }

  /** Accepts a correction from the picker. */
  pick(line: ParsedLine, ingredientId: number | null): void {
    this.lines.update((lines) =>
      lines.map((candidate) =>
        candidate === line
          ? { ...candidate, ingredientId, needsReview: false }
          : candidate,
      ),
    );
  }

  matchLabel(line: ParsedLine): string {
    const labels: Record<string, string> = {
      EXACT: "exact match",
      ALIAS: "matched an alias",
      SINGULAR: "matched the singular",
      FUZZY: `looks similar (${Math.round(line.match.confidence * 100)}%)`,
      NONE: "no match",
    };
    return labels[line.match.kind] ?? line.match.kind;
  }

  matchHelp(line: ParsedLine): string {
    return line.match.kind === "FUZZY"
      ? "Matched by spelling similarity rather than exactly, so it is worth a glance."
      : "Matched against the ingredient catalog.";
  }

  /**
   * Sends back the same shape the create endpoint takes.
   *
   * Every line keeps its original text, so even the ones that never matched a
   * catalog ingredient are preserved exactly as pasted.
   */
  save(): void {
    this.busy.set(true);

    const payload = {
      title: this.title.trim() || "Untitled recipe",
      servings: Number(this.servings) || 4,
      ingredients: this.lines().map((line) => ({
        ...(line.ingredientId !== null
          ? { ingredientId: line.ingredientId }
          : {}),
        rawText: line.rawText,
        ...(line.quantity !== null ? { quantity: line.quantity } : {}),
        ...(line.unitId !== null ? { unitId: line.unitId } : {}),
        ...(line.preparation ? { preparation: line.preparation } : {}),
        ...(line.groupLabel ? { groupLabel: line.groupLabel } : {}),
        optional: line.optional,
      })),
      steps: this.parsed()?.steps ?? [],
    };

    this.api.createRecipe(payload).subscribe({
      next: (recipe) => {
        this.notify.success(`Saved “${recipe.title}”.`);
        void this.router.navigate(["/recipes", recipe.id]);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not save that recipe.");
      },
    });
  }
}
