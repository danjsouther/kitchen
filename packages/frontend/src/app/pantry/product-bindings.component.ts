import { Component,
  inject,
  signal,
} from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { BarcodeScanComponent } from "../shared/barcode-scan.component";
import { IngredientPickerComponent } from "../shared/ingredient-picker.component";
import { PagerComponent } from "../shared/pager.component";
import { ProductPickerComponent } from "../shared/product-picker.component";
import type {
  BarcodeLookup,
  Ingredient,
  Product,
  ProductBindingRow,
} from "../core/models";

const PAGE_LIMIT = 20;

/**
 * This household's category overrides for products.
 *
 * Products are a shared, import-owned Open Food Facts mirror. The default
 * category for a barcode is live ranked consensus across households. What
 * belongs here is only an optional override — pin a different category, or
 * clear it to follow the crowd again.
 */
@Component({
  selector: "app-product-bindings",
  imports: [
    BarcodeScanComponent,
    IngredientPickerComponent,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    PagerComponent,
    ProductPickerComponent,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>Product categories</h1>
        <span class="grow"></span>
      </div>

      <p class="muted">
        Products come from Open Food Facts and are the same for everyone. By
        default a barcode uses the most common category across households. Your
        overrides below pin a different category for this household only.
      </p>

      <mat-card class="adder">
        <mat-card-content>
          <app-barcode-scan
            label="Look up a product"
            hint="Scan or type a code to see the usual category, or set an override."
            (scanned)="onScanned($event)"
          />

          <app-product-picker
            label="Or find by name"
            (picked)="onProductPicked($event)"
          />

          @if (lookingUp()) {
            <mat-progress-bar mode="indeterminate" />
          }

          @if (scan(); as result) {
            @if (result.product; as product) {
              <div class="row">
                <strong class="grow">{{ product.name }}</strong>
                <span class="muted small">{{ product.barcode }}</span>
              </div>
              @if (result.source === 'override' && result.effectiveIngredient; as ingredient) {
                <p class="small">
                  Your override: <strong>{{ ingredient.name }}</strong>. Pick
                  another below to change it, or clear to follow the usual
                  category.
                </p>
                <button
                  mat-stroked-button
                  type="button"
                  [disabled]="busy()"
                  (click)="clearOverride(result.barcode)"
                >
                  Use usual category
                </button>
              } @else if (result.source === 'consensus' && result.effectiveIngredient; as ingredient) {
                <p class="small">
                  Usually <strong>{{ ingredient.name }}</strong>
                  @if (result.consensus[0]; as top) {
                    ({{ top.householdCount }} household{{ top.householdCount === 1 ? "" : "s" }})
                  }
                  . Pick below only if you want a different category for this
                  household.
                </p>
              } @else {
                <p class="small">No category yet — pick one below to set an override.</p>
              }
              <app-ingredient-picker
                label="Override category"
                (picked)="setOverride(result.barcode, $event)"
              />
            } @else {
              <p class="muted small">
                Barcode {{ result.barcode }} is not in the catalog, so there is
                nothing to categorize. It may not be in Open Food Facts, or the
                mirror may need its monthly refresh.
              </p>
            }
          }
        </mat-card-content>
      </mat-card>

      @if (loading()) {
        <mat-progress-bar mode="indeterminate" />
      }

      <mat-form-field appearance="outline" class="search">
        <mat-label>Search overrides</mat-label>
        <input
          matInput
          [value]="overridesQuery()"
          (input)="onOverridesSearch($any($event.target).value)"
          placeholder="Product, brand, or ingredient"
        />
        <mat-icon matSuffix>search</mat-icon>
      </mat-form-field>

      @if (!loading() && overrides().length === 0) {
        <p class="empty muted">
          @if (overridesQuery()) {
            Nothing matches “{{ overridesQuery() }}”.
          } @else {
            No overrides yet. Most barcodes simply follow the usual category —
            only pin one when you disagree.
          }
        </p>
      }

      @for (row of overrides(); track row.id) {
        <mat-card>
          <mat-card-content class="row">
            @if (row.product.imageSmallUrl) {
              <img [src]="row.product.imageSmallUrl" [alt]="row.product.name" />
            }
            <span class="grow">
              <strong>{{ row.product.name }}</strong>
              @if (row.product.brands) {
                <span class="muted"> · {{ row.product.brands }}</span>
              }
              <div class="muted small">{{ row.productId }}</div>
            </span>

            <span class="ingredient">
              <mat-icon class="tiny">arrow_forward</mat-icon>
              {{ row.ingredient.name }}
            </span>

            <button
              mat-button
              class="warn-text"
              [disabled]="busy()"
              (click)="clearListed(row)"
            >
              <mat-icon>restart_alt</mat-icon>
              Clear
            </button>
          </mat-card-content>
        </mat-card>
      }

      <app-pager
        [total]="total()"
        [limit]="limit"
        [offset]="offset()"
        (offsetChange)="onPageChange($event)"
      />
    </div>
  `,
  styles: `
    .adder { margin-bottom: 1rem; }
    .small { font-size: .85rem; }
    .tiny { font-size: 1rem; width: 1rem; height: 1rem; vertical-align: middle; }
    .row { display: flex; gap: .75rem; align-items: center; }
    img { width: 2.5rem; height: 2.5rem; object-fit: contain; }
    .ingredient { white-space: nowrap; }
    mat-card { margin-bottom: .5rem; }
    .search { width: min(400px, 100%); margin-bottom: .5rem; }
  `,
})
export class ProductBindingsComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  readonly overrides = signal<ProductBindingRow[]>([]);
  readonly total = signal(0);
  readonly limit = PAGE_LIMIT;
  readonly loading = signal(true);
  readonly busy = signal(false);

  /** A filter, not form data. */
  readonly overridesQuery = signal("");
  readonly offset = signal(0);
  private searchTimer?: ReturnType<typeof setTimeout>;

  readonly scan = signal<BarcodeLookup | null>(null);
  readonly lookingUp = signal(false);

  constructor() {
    this.load();
  }

  onOverridesSearch(value: string): void {
    this.overridesQuery.set(value);
    this.offset.set(0);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load(), 250);
  }

  onPageChange(offset: number): void {
    this.offset.set(offset);
    this.load();
  }

  onProductPicked(product: Product): void {
    this.onScanned(product.barcode);
  }

  onScanned(code: string): void {
    this.lookingUp.set(true);
    this.api.lookupBarcode(code).subscribe({
      next: (result) => {
        this.lookingUp.set(false);
        this.scan.set(result);
      },
      error: (error: unknown) => {
        this.lookingUp.set(false);
        this.scan.set(null);
        this.notify.error(error, "Could not look that barcode up.");
      },
    });
  }

  setOverride(barcode: string, item: Ingredient): void {
    if (this.busy()) return;
    this.busy.set(true);

    this.api.bindProduct(barcode, item.id).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.scan.set(result);
        this.notify.success(`Override set to ${item.name}.`);
        this.offset.set(0);
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not set that override.");
      },
    });
  }

  clearOverride(barcode: string): void {
    if (this.busy()) return;
    this.busy.set(true);

    this.api.unbindProduct(barcode).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.scan.set(result);
        this.notify.success(
          result.effectiveIngredient
            ? `Using usual category: ${result.effectiveIngredient.name}.`
            : "Override cleared.",
        );
        this.offset.set(0);
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not clear that override.");
      },
    });
  }

  /**
   * Removes the override only.
   *
   * Lots already stocked keep their `productId` — they really did come from
   * that pack, and rewriting history because a category was corrected later
   * would be a different claim from the one the ledger recorded.
   */
  clearListed(row: ProductBindingRow): void {
    if (this.busy()) return;
    this.busy.set(true);

    this.api.unbindProduct(row.productId).subscribe({
      next: () => {
        this.busy.set(false);
        this.notify.success(`Cleared override for ${row.product.name}.`);
        this.scan.set(null);
        this.offset.set(0);
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not clear that override.");
      },
    });
  }

  private load(): void {
    this.loading.set(true);
    this.api
      .productBindings({ q: this.overridesQuery(), limit: this.limit, offset: this.offset() })
      .subscribe({
        next: (page) => {
          this.overrides.set(page.items);
          this.total.set(page.total);
          this.loading.set(false);
        },
        error: (error: unknown) => {
          this.loading.set(false);
          this.notify.error(error, "Could not load your category overrides.");
        },
      });
  }
}
