import {
  Component,
  inject,
  signal,
} from "@angular/core";
import { RouterLink } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
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
import type { RecipeSummary } from "../core/models";

const PAGE_LIMIT = 20;

@Component({
  selector: "app-recipe-list",
  imports: [
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatTooltipModule,
    PagerComponent,
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
              <h2>
                {{ recipe.title }}
                @if (recipe.householdId === SYSTEM_HOUSEHOLD_ID) {
                  <span class="pill shared" matTooltip="From the shared catalog">Shared</span>
                }
              </h2>
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

  constructor() {
    this.load();
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
