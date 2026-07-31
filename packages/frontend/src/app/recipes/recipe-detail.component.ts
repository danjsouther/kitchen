import {
  Component,
  inject,
  input,
  signal,
} from "@angular/core";
import { RouterLink } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatChipsModule } from "@angular/material/chips";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatTooltipModule } from "@angular/material/tooltip";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { amountWithUnit, trimQuantity } from "../shared/format";
import type { Recipe, RecipeIngredient } from "../core/models";

@Component({
  selector: "app-recipe-detail",
  imports: [
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatIconModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }

    @if (recipe(); as r) {
      <div class="page">
        <div class="page-header">
          <div>
            <h1>{{ r.title }}</h1>
            @if (r.description) {
              <p class="muted">{{ r.description }}</p>
            }
          </div>
          <a mat-stroked-button [routerLink]="['/recipes', r.id, 'edit']">
            <mat-icon>edit</mat-icon>
            Edit
          </a>
        </div>

        <div class="chip-row meta muted">
          @if (r.prepMinutes) {
            <span
              ><mat-icon class="tiny">schedule</mat-icon>
              {{ r.prepMinutes }} min prep</span
            >
          }
          @if (r.cookMinutes) {
            <span
              ><mat-icon class="tiny">local_fire_department</mat-icon>
              {{ r.cookMinutes }} min cook</span
            >
          }
          @for (tag of r.tags; track tag.id) {
            <span class="tag">{{ tag.name }}</span>
          }
        </div>

        <mat-card class="scaler">
          <mat-card-content class="row">
            <span class="grow">
              <strong>Serves {{ servings() }}</strong>
              @if (servings() !== baseServings()) {
                <span class="muted"> · written for {{ baseServings() }}</span>
              }
            </span>
            <button
              mat-icon-button
              (click)="setServings(servings() - 1)"
              [disabled]="servings() <= 1"
              aria-label="Fewer servings"
            >
              <mat-icon>remove</mat-icon>
            </button>
            <button
              mat-icon-button
              (click)="setServings(servings() + 1)"
              aria-label="More servings"
            >
              <mat-icon>add</mat-icon>
            </button>
            @if (servings() !== baseServings()) {
              <button mat-button (click)="setServings(baseServings())">
                Reset
              </button>
            }
          </mat-card-content>
        </mat-card>

        <div class="columns">
          <section>
            <h2>Ingredients</h2>
            @for (group of groups(); track group.label) {
              @if (group.label) {
                <h3 class="muted">{{ group.label }}</h3>
              }
              <ul class="ingredients">
                @for (line of group.lines; track line.id) {
                  <li [class.optional]="line.optional">
                    <!--
                      Not always shown. On an unmatched line the text beside it
                      is the whole raw line, amount included, so printing one
                      here as well gives "2 2 cups dried beans". showsAmount()
                      is what decides; see it for the scaling case.
                    -->
                    @if (showsAmount(line)) {
                      <span class="amount">{{ display(line) }}</span>
                    }
                    <!--
                      prettier-ignore, and do not reflow this by hand either: a
                      line break between the name and the comma becomes a space
                      in the rendered text, giving "onion , finely chopped". The
                      Angular v22 migration reformatted this file and reintroduced
                      exactly that bug, which is why the pragma is here now.

                      The preparation is appended only alongside a catalog name.
                      rawText is the whole line as written — "2 cups of flour,
                      sifted" — so adding it there gives ", sifted, sifted".
                    -->
                    <!-- prettier-ignore -->
                    <span
                      >{{ lineName(line)
                      }}@if (line.ingredient && line.preparation) {<span class="muted">, {{ line.preparation }}</span>}@if (line.optional) {<span class="muted"> (optional)</span>}
                      @if (!line.ingredient) {
                        <mat-icon
                          class="tiny muted"
                          matTooltip="Not linked to a catalog ingredient, so it takes no part in pantry maths."
                          >link_off</mat-icon
                        >
                      }
                    </span>
                  </li>
                }
              </ul>
            }
          </section>

          <section>
            <h2>Method</h2>
            <ol class="steps">
              @for (step of r.steps; track step.id) {
                <li>{{ step.text }}</li>
              }
            </ol>
            @if (r.notes) {
              <h3>Notes</h3>
              <p class="muted">{{ r.notes }}</p>
            }
          </section>
        </div>
      </div>
    }
  `,
  styles: `
    h1 {
      margin: 0;
      font-size: 1.6rem;
    }
    h2 {
      font-size: 1.1rem;
      font-weight: 500;
      margin: 1.25rem 0 0.5rem;
    }
    h3 {
      font-size: 0.95rem;
      font-weight: 500;
      margin: 0.75rem 0 0.25rem;
    }
    .meta {
      align-items: center;
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }
    .meta span {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
    }
    .tag {
      padding: 0.15rem 0.6rem;
      border-radius: 999px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }
    .tiny {
      font-size: 1rem;
      width: 1rem;
      height: 1rem;
    }
    .scaler {
      margin-bottom: 1rem;
    }
    .columns {
      display: grid;
      grid-template-columns: minmax(240px, 1fr) 2fr;
      gap: 2rem;
    }
    @media (max-width: 760px) {
      .columns {
        grid-template-columns: 1fr;
        gap: 0.5rem;
      }
    }
    .ingredients {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .ingredients li {
      display: grid;
      grid-template-columns: 6.5rem 1fr;
      gap: 0.5rem;
      padding: 0.3rem 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .ingredients li.optional {
      opacity: 0.75;
    }
    .amount {
      font-variant-numeric: tabular-nums;
      font-weight: 500;
    }
    .steps {
      padding-left: 1.2rem;
    }
    .steps li {
      margin-bottom: 0.75rem;
      line-height: 1.5;
    }
  `,
})
export class RecipeDetailComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  /** Bound from the route by `withComponentInputBinding`. */
  readonly id = input.required<string>();

  readonly recipe = signal<Recipe | null>(null);
  readonly loading = signal(true);
  readonly servings = signal(0);
  readonly baseServings = signal(0);

  constructor() {
    queueMicrotask(() => this.load());
  }

  /**
   * Rescaling asks the server rather than multiplying here.
   *
   * The backend scales from the recipe's stored values every time, so going 4 → 6
   * → 5 gives exactly what going straight to 5 would. Doing the arithmetic in the
   * browser would compound rounding across each adjustment.
   */
  setServings(value: number): void {
    if (value < 1) return;
    this.servings.set(value);

    const recipeId = Number(this.id());
    const request =
      value === this.baseServings()
        ? this.api.recipe(recipeId)
        : this.api.recipeScaled(recipeId, value);

    request.subscribe({
      next: (recipe) => this.recipe.set(recipe),
      error: (error: unknown) =>
        this.notify.error(error, "Could not rescale the recipe."),
    });
  }

  /** The scaled amount when one is present, otherwise the recipe's own. */
  display(line: RecipeIngredient): string {
    if (line.scaled) return line.scaled.display;
    if (line.quantity === null) return "";

    return amountWithUnit(line.quantity, line.unit);
  }

  /**
   * The text that follows the amount.
   *
   * A matched line has a catalog name to use. An unmatched one has only
   * `rawText`, which is the *whole* line — amount included — so the amount is
   * taken back off where it can be identified, leaving "dried kidney beans"
   * rather than "2 cups dried kidney beans" beside a separate "2 cups".
   */
  lineName(line: RecipeIngredient): string {
    return line.ingredient?.name ?? this.withoutLeadingAmount(line);
  }

  /**
   * Whether to print an amount of its own beside the text.
   *
   * A matched line always does. An unmatched line does only when its raw text
   * no longer carries one — otherwise the amount appears twice, which is the
   * bug this exists to stop.
   *
   * The exception is a scaled view. There the number on screen is the whole
   * point of scaling, so when the raw amount could not be identified and
   * removed, the scaled figure is printed anyway: showing it beside a stale one
   * is confusing, but silently showing only the unscaled text is wrong, and
   * this app prefers a visible oddity to a quiet lie.
   */
  showsAmount(line: RecipeIngredient): boolean {
    if (!this.display(line)) return false;
    if (line.ingredient) return true;

    return this.withoutLeadingAmount(line) !== line.rawText.trim() || line.scaled != null;
  }

  /**
   * `rawText` with its own leading amount removed, when that amount is
   * recognisable.
   *
   * Several spellings are tried because the parser keeps the source wording:
   * "2 tsp salt", "2 teaspoons salt" and "2 teaspoon salt" all reduce to the
   * same quantity and unit, and only one of them is what `amountWithUnit`
   * renders. Anything unrecognised is left exactly as written — a wrong guess
   * here would silently delete part of an ingredient's name.
   */
  private withoutLeadingAmount(line: RecipeIngredient): string {
    const raw = line.rawText.trim();
    if (line.quantity === null) return raw;

    const amount = trimQuantity(line.quantity, 3);
    const unit = line.unit;
    const candidates = unit
      ? [
          amountWithUnit(line.quantity, unit),
          `${amount} ${unit.abbrev ?? ""}`,
          `${amount} ${unit.plural}`,
          `${amount} ${unit.name}`,
        ]
      : [amount];

    for (const candidate of candidates) {
      const prefix = candidate.trim();
      if (!prefix || !raw.toLowerCase().startsWith(prefix.toLowerCase())) continue;

      // Whole words only: "2" must not be shaved off "200 g", and "2 cup" must
      // not be shaved off "2 cupfuls".
      const rest = raw.slice(prefix.length);
      if (rest !== "" && !/^[\s,.]/.test(rest)) continue;

      const trimmed = rest.replace(/^[\s,.]+/, "");
      // Never leave the line nameless — "2 cups" on its own is all the text
      // there is, and an empty name would render a bare amount.
      if (trimmed) return trimmed;
    }

    return raw;
  }

  /** Lines under their "For the sauce" headings, in order. */
  groups(): Array<{ label: string | null; lines: RecipeIngredient[] }> {
    const recipe = this.recipe();
    if (!recipe) return [];

    const groups: Array<{ label: string | null; lines: RecipeIngredient[] }> =
      [];
    for (const line of recipe.ingredients) {
      const label = line.groupLabel ?? null;
      const last = groups.at(-1);
      if (last && last.label === label) last.lines.push(line);
      else groups.push({ label, lines: [line] });
    }
    return groups;
  }

  private load(): void {
    this.api.recipe(Number(this.id())).subscribe({
      next: (recipe) => {
        this.recipe.set(recipe);
        this.servings.set(recipe.servings);
        this.baseServings.set(recipe.servings);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.notify.error(error, "Could not load that recipe.");
      },
    });
  }
}
