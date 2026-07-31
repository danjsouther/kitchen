import {
  Component,
  inject,
  input,
  signal,
  ChangeDetectionStrategy,
} from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatCheckboxModule } from "@angular/material/checkbox";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatSelectModule } from "@angular/material/select";
import { MatTooltipModule } from "@angular/material/tooltip";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { amountWithUnit } from "../shared/format";
import type {
  ShoppingList,
  ShoppingListItem,
  StorageLocation,
  Unit,
} from "../core/models";

@Component({
  selector: "app-shopping-list",
  imports: [
    MatButtonModule,
    MatCardModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }

    @if (list(); as l) {
      <div class="page">
        <div class="page-header">
          <div>
            <h1>{{ l.name }}</h1>
            <div class="muted small">
              @if (l.store) {
                {{ l.store.name }} ·
              }
              {{ l.totals.checkedItems }} of {{ l.totals.totalItems }} in the
              basket
            </div>
          </div>

          <mat-card class="running">
            <mat-card-content>
              <div class="total">{{ l.totals.projected }}</div>
              <div class="muted small">
                projected
                @if (l.totals.unpricedItems) {
                  <!-- Said out loud: a total is not complete if part of the list has no price. -->
                  · {{ l.totals.unpricedItems }} without a price
                }
              </div>
            </mat-card-content>
          </mat-card>
        </div>

        @if (l.status !== "ACTIVE") {
          <mat-card class="notice">
            <mat-card-content>
              This list is {{ l.status.toLowerCase() }} and can no longer be
              changed.
            </mat-card-content>
          </mat-card>
        }

        @for (item of l.items; track item.id) {
          <mat-card class="item" [class.done]="item.checkedOn">
            <mat-card-content class="item-grid">
              <mat-checkbox
                [checked]="!!item.checkedOn"
                [disabled]="l.status !== 'ACTIVE'"
                (change)="toggle(item, $event.checked)"
                [attr.aria-label]="'Got ' + name(item)"
              />

              <div class="what">
                <span class="name">{{ name(item) }}</span>
                @if (item.quantity && item.unit) {
                  <span class="muted">{{
                    amount(item.quantity, item.unit)
                  }}</span>
                }
                @if (item.brand) {
                  <span class="muted">· {{ item.brand }}</span>
                }
                @if (item.unconvertible) {
                  <mat-icon
                    class="tiny warn-text"
                    matTooltip="Listed separately because it could not be combined with the rest of this ingredient."
                    >call_split</mat-icon
                  >
                }
              </div>

              <mat-form-field appearance="outline" class="price">
                <mat-label>Paid</mat-label>
                <input
                  matInput
                  type="number"
                  step="0.01"
                  min="0"
                  [disabled]="l.status !== 'ACTIVE'"
                  [value]="item.actualPrice"
                  (input)="priceDraft.set(item.id, $any($event.target).value)"
                  (blur)="savePrice(item)"
                  [placeholder]="item.estimatedPrice ?? ''"
                />
              </mat-form-field>
            </mat-card-content>
          </mat-card>
        }

        @if (l.status === "ACTIVE") {
          <mat-card class="receive">
            <mat-card-content>
              <h2>Put the shopping away</h2>
              <p class="muted small">
                Ticked items become pantry stock, and what you paid becomes
                price history that prefills the next list.
              </p>
              <div class="row">
                <mat-form-field appearance="outline">
                  <mat-label>Where it goes</mat-label>
                  <mat-select
                    [value]="locationId()"
                    (valueChange)="locationId.set($event)"
                  >
                    @for (location of locations(); track location.id) {
                      <mat-option [value]="location.id">{{
                        location.name
                      }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
                <button
                  mat-flat-button
                  (click)="receive()"
                  [disabled]="
                    !locationId || l.totals.checkedItems === 0 || busy()
                  "
                >
                  <mat-icon>inventory_2</mat-icon>
                  Receive {{ l.totals.checkedItems }} item{{
                    l.totals.checkedItems === 1 ? "" : "s"
                  }}
                </button>
              </div>
            </mat-card-content>
          </mat-card>
        }
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    h1 {
      margin: 0;
      font-size: 1.4rem;
    }
    h2 {
      font-size: 1rem;
      font-weight: 500;
      margin: 0 0 0.25rem;
    }
    .small {
      font-size: 0.85rem;
    }
    .running {
      min-width: 9rem;
      text-align: right;
    }
    .total {
      font-size: 1.6rem;
      font-variant-numeric: tabular-nums;
    }
    .item {
      margin-bottom: 0.4rem;
    }
    .item.done .name {
      text-decoration: line-through;
      opacity: 0.6;
    }
    .item-grid {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      padding-bottom: 0.5rem;
    }
    .what {
      flex: 1 1 auto;
      display: flex;
      gap: 0.4rem;
      align-items: center;
      flex-wrap: wrap;
    }
    .name {
      font-weight: 500;
    }
    .price {
      width: 7rem;
    }
    .price ::ng-deep .mat-mdc-form-field-subscript-wrapper {
      display: none;
    }
    .tiny {
      font-size: 1rem;
      width: 1rem;
      height: 1rem;
    }
    .receive {
      margin-top: 1.5rem;
    }
    .notice {
      background: var(--mat-sys-surface-container-high);
      margin-bottom: 1rem;
    }
  `,
})
export class ShoppingListComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  readonly id = input.required<string>();

  readonly list = signal<ShoppingList | null>(null);
  readonly locations = signal<StorageLocation[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);

  /** Prices typed but not yet committed, keyed by item. */
  readonly priceDraft = new Map<number, string>();

  /** Where received stock goes. A one-off action control, not form data. */
  readonly locationId = signal<number | null>(null);

  constructor() {
    queueMicrotask(() => {
      this.load();
      this.api.locations().subscribe({
        next: (locations) => {
          this.locations.set(locations);
          this.locationId.set(locations[0]?.id ?? null);
        },
      });
    });
  }

  name(item: ShoppingListItem): string {
    return item.ingredient?.name ?? item.rawName ?? "Item";
  }

  amount(quantity: string, unit: Unit | null): string {
    return amountWithUnit(quantity, unit);
  }

  toggle(item: ShoppingListItem, checked: boolean): void {
    this.patch(item.id, { checked });
  }

  /** Commits on blur rather than per keystroke — a price is entered, not typed at. */
  savePrice(item: ShoppingListItem): void {
    const draft = this.priceDraft.get(item.id);
    if (draft === undefined || draft === item.actualPrice) return;
    this.priceDraft.delete(item.id);
    this.patch(item.id, {
      actualPrice: draft === "" ? undefined : String(draft),
    });
  }

  receive(): void {
    if (!this.locationId()) return;
    this.busy.set(true);

    this.api.receiveList(Number(this.id()), this.locationId()!).subscribe({
      next: (result) => {
        this.busy.set(false);
        const skipped = result.skipped.length;
        this.notify.success(
          `Stocked ${result.stocked.length} item${result.stocked.length === 1 ? "" : "s"}` +
            (skipped ? `, ${skipped} could not be stocked` : "") +
            ".",
        );
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not receive that list.");
      },
    });
  }

  private patch(itemId: number, body: Record<string, unknown>): void {
    this.api.updateListItem(Number(this.id()), itemId, body).subscribe({
      next: (list) => this.list.set(list),
      error: (error: unknown) =>
        this.notify.error(error, "Could not update that item."),
    });
  }

  private load(): void {
    this.api.shoppingList(Number(this.id())).subscribe({
      next: (list) => {
        this.list.set(list);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.notify.error(error, "Could not load that list.");
      },
    });
  }
}
