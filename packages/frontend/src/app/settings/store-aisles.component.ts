import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from "@angular/core";
import { RouterLink } from "@angular/router";
import { forkJoin } from "rxjs";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import type { IngredientCategory, Store } from "../core/models";

/**
 * The order this store's aisles are walked, which is the order its generated
 * lists read in.
 *
 * Every category is placed, always — the API stores an aisle order as a set of
 * per-category positions and falls back to the *catalog's* own position for
 * anything a store has not placed. Those two numberings share one scale, so a
 * partial order interleaves the placed and the unplaced: category 11 of your
 * walk lands after "Produce" (10) but before "Bakery" (20). Ordering the whole
 * list means that cannot happen, and it costs nothing since the catalog's
 * categories are a fixed, short list.
 */
@Component({
  selector: "app-store-aisles",
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <div class="row">
          <a mat-icon-button routerLink="/settings" aria-label="Back to settings">
            <mat-icon>arrow_back</mat-icon>
          </a>
          <h1>{{ store()?.name ?? "Aisles" }}</h1>
        </div>
      </div>

      @if (loading()) {
        <mat-progress-bar mode="indeterminate" />
      }

      @if (failed()) {
        <p class="warn-text" role="alert">{{ failed() }}</p>
      }

      @if (!loading() && !failed()) {
        <p class="muted small intro">
          Put these in the order you actually walk the shop. A generated list is
          sorted by this, so it can be ticked off in one pass instead of sending
          you back across the store three times.
        </p>

        <mat-card>
          <mat-card-content>
            <ol class="aisles">
              @for (category of order(); track category.id; let i = $index) {
                <li class="aisle">
                  <span class="position muted">{{ i + 1 }}</span>
                  <span class="name grow">{{ category.name }}</span>
                  <button
                    mat-icon-button
                    (click)="move(i, -1)"
                    [disabled]="i === 0"
                    [attr.aria-label]="'Move ' + category.name + ' earlier'"
                  >
                    <mat-icon>arrow_upward</mat-icon>
                  </button>
                  <button
                    mat-icon-button
                    (click)="move(i, 1)"
                    [disabled]="i === order().length - 1"
                    [attr.aria-label]="'Move ' + category.name + ' later'"
                  >
                    <mat-icon>arrow_downward</mat-icon>
                  </button>
                </li>
              }
            </ol>
          </mat-card-content>
        </mat-card>

        <div class="actions">
          <button mat-flat-button (click)="save()" [disabled]="busy() || !dirty()">
            <mat-icon>save</mat-icon>
            Save the walk
          </button>
          <button mat-button (click)="revert()" [disabled]="busy() || !dirty()">
            Undo the changes
          </button>
          <span class="grow"></span>
          <button mat-button (click)="useCatalogOrder()" [disabled]="busy()">
            Back to the default order
          </button>
        </div>

        @if (dirty()) {
          <p class="muted small">Not saved yet.</p>
        }
      }
    </div>
  `,
  styles: `
    h1 { margin: 0; }
    .small { font-size: .85rem; }
    .intro { max-width: 46rem; }
    .aisles { list-style: none; margin: 0; padding: 0; }
    .aisle {
      display: flex;
      align-items: center;
      gap: .5rem;
      padding: .15rem 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .aisle:last-child { border-bottom: none; }
    .position {
      width: 1.75rem;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .actions {
      display: flex;
      gap: .5rem;
      align-items: center;
      margin-top: 1rem;
      flex-wrap: wrap;
    }
  `,
})
export class StoreAislesComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  /** Bound from the route via `withComponentInputBinding`. */
  readonly id = input.required<string>();

  readonly store = signal<Store | null>(null);
  readonly order = signal<IngredientCategory[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly failed = signal("");

  /** The catalog's own order, kept for the "back to the default" button. */
  private readonly catalog = signal<IngredientCategory[]>([]);
  /** What the server currently holds, so "unsaved" is a fact rather than a guess. */
  private readonly saved = signal<number[]>([]);

  readonly dirty = computed(() => {
    const now = this.order().map((category) => category.id);
    const before = this.saved();
    return now.length !== before.length || now.some((id, i) => id !== before[i]);
  });

  constructor() {
    // Deferred a tick, as the recipe screen does: route inputs are not bound
    // when the constructor runs, and reading `id()` here throws NG0950 — which
    // the build says nothing about, since the input is genuinely declared.
    queueMicrotask(() => this.load());
  }

  move(index: number, by: number): void {
    const next = [...this.order()];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    this.order.set(next);
  }

  revert(): void {
    this.order.set(this.byId(this.saved()));
  }

  useCatalogOrder(): void {
    this.order.set([...this.catalog()]);
  }

  save(): void {
    this.busy.set(true);
    const aisles = this.order().map((category, index) => ({
      categoryId: category.id,
      sortOrder: index,
    }));

    this.api.setStoreAisles(Number(this.id()), aisles).subscribe({
      next: (store) => {
        this.busy.set(false);
        this.store.set(store);
        this.saved.set(this.order().map((category) => category.id));
        this.notify.success("Saved. New lists will read in this order.");
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not save that order.");
      },
    });
  }

  private load(): void {
    this.loading.set(true);
    this.failed.set("");

    // Both, together: the order is seeded from the store's aisles *and* the
    // catalog list, and seeding from whichever landed first would leave the
    // other half of the list missing.
    forkJoin({
      store: this.api.store(Number(this.id())),
      categories: this.api.categories(),
    }).subscribe({
      next: ({ store, categories }) => {
        this.store.set(store);
        this.catalog.set(categories);

        const placed = [...store.aisles]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((aisle) => aisle.categoryId);

        // Anything the store has never placed goes on the end in catalog order,
        // rather than being dropped: the list has to name every category or
        // saving it would silently unplace one.
        const known = new Map(categories.map((category) => [category.id, category]));
        const order = [
          ...placed.map((id) => known.get(id)).filter((c) => c !== undefined),
          ...categories.filter((category) => !placed.includes(category.id)),
        ];

        this.order.set(order);
        this.saved.set(order.map((category) => category.id));
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.failed.set("Could not load that store.");
      },
    });
  }

  private byId(ids: readonly number[]): IngredientCategory[] {
    const known = new Map(this.catalog().map((category) => [category.id, category]));
    return ids.map((id) => known.get(id)).filter((c) => c !== undefined);
  }
}
