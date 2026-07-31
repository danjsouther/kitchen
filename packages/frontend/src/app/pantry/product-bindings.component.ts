import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { BarcodeScanComponent } from "../shared/barcode-scan.component";
import { IngredientPickerComponent } from "../shared/ingredient-picker.component";
import type { BarcodeLookup, Ingredient, ProductBindingRow } from "../core/models";

/**
 * What this household means by each barcode it has scanned.
 *
 * The tenancy split this screen exists to make visible: the products themselves
 * are a shared, read-only mirror of Open Food Facts, and none of them can be
 * edited here or anywhere. What belongs to the household — and all that belongs
 * to it — is the line from a barcode to an ingredient. So this screen relinks
 * and unlinks, and never offers to change a product.
 */
@Component({
  selector: "app-product-bindings",
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [
    BarcodeScanComponent,
    IngredientPickerComponent,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>Barcodes</h1>
        <span class="grow"></span>
      </div>

      <p class="muted">
        Products come from Open Food Facts and are shared, read-only, and the
        same for everyone. What is yours is the link from a barcode to one of
        your ingredients — that is what lets a scan know what it is putting in
        the pantry.
      </p>

      <mat-card class="adder">
        <mat-card-content>
          <app-barcode-scan
            label="Link a barcode"
            hint="Scan or type a code to link it, or to see what it is linked to."
            (scanned)="onScanned($event)"
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
              @if (result.binding; as binding) {
                <p class="small">
                  Already linked to <strong>{{ binding.ingredient.name }}</strong
                  >. Pick another below to change it.
                </p>
              }
              <app-ingredient-picker
                label="Link it to"
                (picked)="bind(result.barcode, $event)"
              />
            } @else {
              <p class="muted small">
                Barcode {{ result.barcode }} is not in the catalog, so there is
                nothing to link it to. It may not be in Open Food Facts, or the
                mirror may need its monthly refresh.
              </p>
            }
          }
        </mat-card-content>
      </mat-card>

      @if (loading()) {
        <mat-progress-bar mode="indeterminate" />
      }

      @if (!loading() && bindings().length === 0) {
        <p class="empty muted">
          Nothing linked yet. Scan a barcode when adding to the pantry and it
          will be remembered here.
        </p>
      }

      @for (binding of bindings(); track binding.id) {
        <mat-card>
          <mat-card-content class="row">
            @if (binding.product.imageSmallUrl) {
              <img [src]="binding.product.imageSmallUrl" [alt]="binding.product.name" />
            }
            <span class="grow">
              <strong>{{ binding.product.name }}</strong>
              @if (binding.product.brands) {
                <span class="muted"> · {{ binding.product.brands }}</span>
              }
              <div class="muted small">{{ binding.productId }}</div>
            </span>

            <span class="ingredient">
              <mat-icon class="tiny">arrow_forward</mat-icon>
              {{ binding.ingredient.name }}
            </span>

            <button
              mat-button
              class="warn-text"
              [disabled]="busy()"
              (click)="unbind(binding)"
            >
              <mat-icon>link_off</mat-icon>
              Unlink
            </button>
          </mat-card-content>
        </mat-card>
      }
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
  `,
})
export class ProductBindingsComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  readonly bindings = signal<ProductBindingRow[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);

  readonly scan = signal<BarcodeLookup | null>(null);
  readonly lookingUp = signal(false);

  readonly count = computed(() => this.bindings().length);

  constructor() {
    this.load();
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

  bind(barcode: string, item: Ingredient): void {
    if (this.busy()) return;
    this.busy.set(true);

    this.api.bindProduct(barcode, item.id).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.scan.set(result);
        this.notify.success(`Linked to ${item.name}.`);
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not link that barcode.");
      },
    });
  }

  /**
   * Removes the link only.
   *
   * Lots already stocked keep their `productId` — they really did come from
   * that pack, and rewriting history because a link was corrected later would
   * be a different claim from the one the ledger recorded.
   */
  unbind(binding: ProductBindingRow): void {
    if (this.busy()) return;
    this.busy.set(true);

    this.api.unbindProduct(binding.productId).subscribe({
      next: () => {
        this.busy.set(false);
        this.notify.success(`Unlinked ${binding.product.name}.`);
        this.scan.set(null);
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not unlink that barcode.");
      },
    });
  }

  private load(): void {
    this.loading.set(true);
    this.api.productBindings().subscribe({
      next: (rows) => {
        this.bindings.set(rows);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.notify.error(error, "Could not load your barcode links.");
      },
    });
  }
}
