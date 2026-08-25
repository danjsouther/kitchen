import {
  Component,
  inject,
  signal,
} from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatCheckboxModule } from "@angular/material/checkbox";
import { MatChipsModule } from "@angular/material/chips";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatTooltipModule } from "@angular/material/tooltip";
import { SYSTEM_HOUSEHOLD_ID } from "@kitchen/shared-types";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { PagerComponent } from "../shared/pager.component";
import { RecipeShoppingPickerComponent } from "../shopping/recipe-shopping-picker.component";
import { recipeTypeLabel } from "../core/models";
import type { RecipeSummary, ShoppingList } from "../core/models";

const PAGE_LIMIT = 20;

@Component({
  selector: "app-recipe-list",
  imports: [
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatTooltipModule,
    PagerComponent,
    RecipeShoppingPickerComponent,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>Recipes</h1>
        <div class="row">
          <a mat-stroked-button routerLink="/recipes/import">
            <mat-icon>content_paste</mat-icon>
            Paste a recipe
          </a>
          <a mat-flat-button routerLink="/recipes/new">
            <mat-icon>add</mat-icon>
            New recipe
          </a>
        </div>
      </div>

      <mat-form-field appearance="outline" class="search">
        <mat-label>Search</mat-label>
        <input
          matInput
          [value]="query()"
          (input)="onSearch($any($event.target).value)"
          placeholder="Title, description, or an ingredient"
        />
        <mat-icon matSuffix>search</mat-icon>
      </mat-form-field>

      @if (loading()) {
        <mat-progress-bar mode="indeterminate" />
      }

      @if (recipes().length === 0 && !loading()) {
        <div class="empty muted">
          @if (query()) {
            <p>Nothing matches “{{ query() }}”.</p>
          } @else {
            <p>No recipes yet.</p>
            <a mat-flat-button routerLink="/recipes/import"
              >Paste your first one</a
            >
            <a mat-button routerLink="/recipes/new">or write one out</a>
          }
        </div>
      }

      <div class="grid">
        @for (recipe of recipes(); track recipe.id) {
          <mat-card class="card" [routerLink]="['/recipes', recipe.id]">
            <mat-card-content>
              <div class="card-head">
                <mat-checkbox
                  [checked]="selected().has(recipe.id)"
                  (change)="toggle(recipe, $event.checked)"
                  (click)="$event.stopPropagation()"
                  [attr.aria-label]="'Select ' + recipe.title"
                />
                <h2 class="grow">
                  {{ recipe.title }}
                  @if (recipe.householdId === SYSTEM_HOUSEHOLD_ID) {
                    <span class="pill shared" matTooltip="From the shared catalog">Shared</span>
                  }
                </h2>
                <button
                  mat-icon-button
                  [routerLink]="['/recipes', recipe.id]"
                  [queryParams]="{ cook: 1 }"
                  (click)="$event.stopPropagation()"
                  [attr.aria-label]="'Cook ' + recipe.title"
                  matTooltip="Cook this recipe"
                >
                  <mat-icon>restaurant</mat-icon>
                </button>
              </div>
              @if (recipe.description) {
                <p class="muted desc">{{ recipe.description }}</p>
              }
              <div class="meta muted">
                <span>Serves {{ recipe.servings }}</span>
                <span>{{ recipe.ingredientCount }} ingredients</span>
                @if (totalMinutes(recipe); as minutes) {
                  <span>{{ minutes }} min</span>
                }
                @if (recipe.recipeType !== "ANY") {
                  <span>{{ recipeTypeLabel(recipe.recipeType) }}</span>
                }
              </div>
              @if (recipe.tags.length) {
                <mat-chip-set class="chip-row">
                  @for (tag of recipe.tags; track tag.id) {
                    <mat-chip-option [selectable]="false">{{
                      tag.name
                    }}</mat-chip-option>
                  }
                </mat-chip-set>
              }
            </mat-card-content>
          </mat-card>
        }
      </div>

      <app-pager
        [total]="total()"
        [limit]="limit"
        [offset]="offset()"
        (offsetChange)="onPageChange($event)"
      />

      @if (picking(); as pickingRecipes) {
        <app-recipe-shopping-picker
          [recipes]="pickingRecipes"
          (done)="onPicked($event)"
          (cancelled)="picking.set(null)"
        />
      } @else if (selected().size > 0) {
        <div class="selection-bar">
          <span class="grow"
            >{{ selected().size }} recipe{{ selected().size === 1 ? "" : "s" }} selected</span
          >
          <button mat-button (click)="clearSelection()">Clear</button>
          <button mat-flat-button (click)="startPicking()">
            <mat-icon>playlist_add</mat-icon>
            Add to shopping list
          </button>
        </div>
      }
    </div>
  `,
  styles: `
    .search {
      width: min(460px, 100%);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 1rem;
    }
    .card {
      cursor: pointer;
    }
    .card-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 0.5rem;
    }
    .card-head mat-checkbox {
      margin-top: 0.1rem;
    }
    .selection-bar {
      position: sticky;
      bottom: 0;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-top: 1rem;
      padding: 0.6rem 1rem;
      background: var(--mat-sys-surface-container-highest);
      border-radius: 8px;
      box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.1);
    }
    h2 {
      margin: 0 0 0.35rem;
      font-size: 1.1rem;
      font-weight: 500;
    }
    .desc {
      margin: 0 0 0.5rem;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .meta {
      display: flex;
      gap: 0.75rem;
      font-size: 0.85rem;
      flex-wrap: wrap;
    }
    mat-chip-set {
      margin-top: 0.6rem;
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
  `,
})
export class RecipeListComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly router = inject(Router);

  /** Exposed for the template. */
  readonly recipeTypeLabel = recipeTypeLabel;

  /** Exposed for the template's shared-catalog badge. */
  readonly SYSTEM_HOUSEHOLD_ID = SYSTEM_HOUSEHOLD_ID;

  readonly recipes = signal<RecipeSummary[]>([]);
  readonly total = signal(0);
  readonly loading = signal(true);
  readonly limit = PAGE_LIMIT;

  /** A filter, not form data. */
  readonly query = signal("");
  readonly offset = signal(0);
  private searchTimer?: ReturnType<typeof setTimeout>;

  /**
   * Recipes chosen for a shopping list, keyed by id so the picker has each
   * one's title and servings without a second fetch.
   */
  readonly selected = signal<Map<number, RecipeSummary>>(new Map());

  /**
   * A snapshot of the selection taken when the picker opens, not a live view
   * of `selected()`. Passing a fresh array into `[recipes]` on every change
   * detection tick would count as a new input to the picker's `input()` and
   * reset the servings the user is in the middle of adjusting.
   */
  readonly picking = signal<Array<{ id: number; title: string; servings: number }> | null>(null);

  constructor() {
    this.load();
  }

  toggle(recipe: RecipeSummary, checked: boolean): void {
    this.selected.update((current) => {
      const next = new Map(current);
      if (checked) next.set(recipe.id, recipe);
      else next.delete(recipe.id);
      return next;
    });
  }

  clearSelection(): void {
    this.selected.set(new Map());
  }

  startPicking(): void {
    this.picking.set(
      [...this.selected().values()].map((recipe) => ({
        id: recipe.id,
        title: recipe.title,
        servings: recipe.servings,
      })),
    );
  }

  onPicked(list: ShoppingList): void {
    this.picking.set(null);
    this.clearSelection();
    void this.router.navigate(["/shopping", list.id]);
  }

  /** Debounced so typing does not fire a request per keystroke. */
  onSearch(value: string): void {
    // Set explicitly: the input is a one-way [value] binding now, so nothing
    // else writes this back the way [(ngModel)] used to.
    this.query.set(value);
    clearTimeout(this.searchTimer);
    // A new search term makes the previous page meaningless.
    this.offset.set(0);
    this.searchTimer = setTimeout(() => this.load(value, 0), 250);
  }

  onPageChange(offset: number): void {
    this.offset.set(offset);
    this.load(this.query(), offset);
  }

  totalMinutes(recipe: RecipeSummary): number | null {
    const total = (recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0);
    return total > 0 ? total : null;
  }

  private load(q = "", offset = 0): void {
    this.loading.set(true);
    this.api.recipes({ q, limit: this.limit, offset }).subscribe({
      next: (page) => {
        this.recipes.set(page.items);
        this.total.set(page.total);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.notify.error(error, "Could not load recipes.");
      },
    });
  }
}
