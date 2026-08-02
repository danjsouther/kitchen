import {
  Component,
  inject,
  input,
  signal,
} from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatChipsModule } from "@angular/material/chips";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatTooltipModule } from "@angular/material/tooltip";
import { SYSTEM_HOUSEHOLD_ID } from "@kitchen/shared-types";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { amountWithUnit, withoutLeadingAmount } from "../shared/format";
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
            <h1>
              {{ r.title }}
              @if (r.householdId === SYSTEM_HOUSEHOLD_ID) {
                <span class="pill shared" matTooltip="From the shared catalog">Shared</span>
              }
            </h1>
            @if (r.description) {
              <p class="muted">{{ r.description }}</p>
            }
          </div>
          <div class="row">
            @if (r.householdId === SYSTEM_HOUSEHOLD_ID) {
              <button mat-stroked-button [disabled]="busy()" (click)="copy(r.id)">
                <mat-icon>content_copy</mat-icon>
                Copy to my recipes
              </button>
            } @else {
              <button mat-stroked-button [disabled]="busy()" (click)="publish(r.id)">
                <mat-icon>share</mat-icon>
                Share with every household
              </button>
              <a mat-stroked-button [routerLink]="['/recipes', r.id, 'edit']">
                <mat-icon>edit</mat-icon>
                Edit
              </a>
            }
          </div>
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
    .row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    .pill {
      margin-left: 0.5rem;
      padding: 0.1rem 0.5rem;
      border-radius: 999px;
      font-size: 0.75rem;
      vertical-align: middle;
    }
    .pill.shared {
      background: var(--mat-sys-surface-container-highest);
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
  private readonly router = inject(Router);

  /** Exposed for the template's shared-catalog checks. */
  readonly SYSTEM_HOUSEHOLD_ID = SYSTEM_HOUSEHOLD_ID;

  /** Bound from the route by `withComponentInputBinding`. */
  readonly id = input.required<string>();

  readonly recipe = signal<Recipe | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly servings = signal(0);
  readonly baseServings = signal(0);

  constructor() {
    queueMicrotask(() => this.load());
  }

  /** Publishes a copy of this household's recipe into the shared catalog. */
  publish(id: number): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.api.publishRecipe(id).subscribe({
      next: () => {
        this.busy.set(false);
        this.notify.success("Published — every household can now see and copy this.");
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not publish that recipe.");
      },
    });
  }

  /**
   * Forks a shared-catalog recipe into a household-owned copy, then opens the
   * copy for editing — this is the entry point for editing a global recipe,
   * so it reads naturally as "make it mine before you touch it."
   */
  copy(id: number): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.api.copyRecipe(id).subscribe({
      next: (copy) => {
        this.busy.set(false);
        this.notify.success(`Copied “${copy.title}” to your recipes.`);
        void this.router.navigate(["/recipes", copy.id, "edit"]);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not copy that recipe.");
      },
    });
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

  /** `rawText` with its own leading amount removed, where one can be found. */
  private withoutLeadingAmount(line: RecipeIngredient): string {
    return withoutLeadingAmount(line.rawText, line.quantity, line.unit);
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
