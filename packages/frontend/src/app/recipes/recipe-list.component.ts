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
import { MatSelectModule } from "@angular/material/select";
import { MatTooltipModule } from "@angular/material/tooltip";
import { SYSTEM_HOUSEHOLD_ID } from "@kitchen/shared-types";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { PagerComponent } from "../shared/pager.component";
import { RecipeShoppingPickerComponent } from "../shopping/recipe-shopping-picker.component";
import { RECIPE_TYPE_OPTIONS, recipeTypeLabel } from "../core/models";
import type { RecipeSummary, RecipeType, ShoppingList, Tag } from "../core/models";

/** 'all' applies no scope filter server-side; 'shared' is the public catalog. */
type ScopeFilter = "all" | "mine" | "shared";

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
    MatSelectModule,
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

      <div class="filters">
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

        <mat-form-field appearance="outline" class="meal-type">
          <mat-label>Meal type</mat-label>
          <mat-select multiple [value]="selectedMealTypes()" (valueChange)="onMealTypesChange($event)">
            @for (option of recipeTypeOptions; track option.value) {
              <mat-option [value]="option.value">{{ option.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline" class="scope">
          <mat-label>Visibility</mat-label>
          <mat-select [value]="scope()" (valueChange)="onScopeChange($event)">
            <mat-option value="all">All</mat-option>
            <mat-option value="shared">Public (shared catalog)</mat-option>
            <mat-option value="mine">Private (my household)</mat-option>
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline" class="tags">
          <mat-label>Tags</mat-label>
          <mat-select multiple [value]="selectedTags()" (valueChange)="onTagsChange($event)">
            @for (tag of availableTags(); track tag.id) {
              <mat-option [value]="tag.slug">{{ tag.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </div>

      @if (loading()) {
        <mat-progress-bar mode="indeterminate" />
      }

      @if (recipes().length === 0 && !loading()) {
        <div class="empty muted">
          @if (hasActiveFilter()) {
            <p>Nothing matches those filters.</p>
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
              </div>
              @if (mealTypesToShow(recipe).length || recipe.tags.length) {
                <mat-chip-set class="chip-row">
                  @for (type of mealTypesToShow(recipe); track type) {
                    <mat-chip-option class="meal-chip" [selectable]="false">{{
                      recipeTypeLabel(type)
                    }}</mat-chip-option>
                  }
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
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin-bottom: 0.5rem;
    }
    .search {
      width: min(460px, 100%);
    }
    .meal-type,
    .scope {
      width: min(200px, 100%);
    }
    .tags {
      width: min(260px, 100%);
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
    /*
     * Distinguishes the meal-type badge from ordinary tag chips beside it.
     * The --mat-chip-* prefix (not --mdc-chip-*) is what Angular Material 22's
     * chip actually reads for an unselected chip's fill — confirmed by
     * inspecting the compiled chips.mjs, since a wrong prefix here fails
     * silently: the chip still renders, just transparent as if unstyled.
     */
    .meal-chip {
      --mat-chip-elevated-container-color: var(--mat-sys-tertiary-container);
      --mat-chip-label-text-color: var(--mat-sys-on-tertiary-container);
      font-weight: 500;
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

  /**
   * Exposed for the template's meal-type select. Excludes ANY: that value
   * already means "no restriction" on the recipe itself, so filtering *for*
   * it would just be a second, redundant way to say "all meal types".
   */
  readonly recipeTypeOptions = RECIPE_TYPE_OPTIONS.filter((option) => option.value !== "ANY");

  readonly recipes = signal<RecipeSummary[]>([]);
  readonly total = signal(0);
  readonly loading = signal(true);
  readonly limit = PAGE_LIMIT;

  /** Filters, not form data — plain signals rather than a form. */
  readonly query = signal("");
  readonly selectedMealTypes = signal<RecipeType[]>([]);
  readonly scope = signal<ScopeFilter>("all");
  readonly selectedTags = signal<string[]>([]);
  readonly availableTags = signal<Tag[]>([]);
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
    this.api.recipeTags().subscribe({ next: (tags) => this.availableTags.set(tags) });
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

  /** Selects re-filter immediately — no debounce, unlike the search box. */
  onMealTypesChange(value: RecipeType[]): void {
    this.selectedMealTypes.set(value);
    this.offset.set(0);
    this.load(this.query(), 0);
  }

  onScopeChange(value: ScopeFilter): void {
    this.scope.set(value);
    this.offset.set(0);
    this.load(this.query(), 0);
  }

  onTagsChange(value: string[]): void {
    this.selectedTags.set(value);
    this.offset.set(0);
    this.load(this.query(), 0);
  }

  hasActiveFilter(): boolean {
    return (
      this.query() !== "" ||
      this.selectedMealTypes().length > 0 ||
      this.scope() !== "all" ||
      this.selectedTags().length > 0
    );
  }

  totalMinutes(recipe: RecipeSummary): number | null {
    const total = (recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0);
    return total > 0 ? total : null;
  }

  /** ANY means "no restriction" — nothing worth badging. */
  mealTypesToShow(recipe: RecipeSummary): RecipeType[] {
    return recipe.recipeType.filter((type) => type !== "ANY");
  }

  private load(q = "", offset = 0): void {
    this.loading.set(true);
    this.api
      .recipes({
        q,
        limit: this.limit,
        offset,
        recipeTypes: this.selectedMealTypes().join(","),
        scope: this.scope(),
        tags: this.selectedTags().join(","),
      })
      .subscribe({
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
