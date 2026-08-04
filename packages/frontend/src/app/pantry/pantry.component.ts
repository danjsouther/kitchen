import {
  Component,
  inject,
  signal,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import { RouterLink } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatTabsModule } from "@angular/material/tabs";
import { MatTooltipModule } from "@angular/material/tooltip";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { trimQuantity, unitLabel } from "../shared/format";
import { PagerComponent } from "../shared/pager.component";
import { ConsumeFormComponent } from "./consume-form.component";
import { ConsumeIngredientComponent } from "./consume-ingredient.component";
import { PantryItemFormComponent } from "./pantry-item-form.component";
import { ScanQueueComponent } from "./scan-queue.component";
import type { Balance, PantryLot, StorageLocation, Unit } from "../core/models";

const PAGE_LIMIT = 20;
/** Mirrors the backend's `EXPIRY_SOON_DAYS` (`pantry.service.ts`) — kept in
 * sync by hand since nothing shares constants across the API boundary. */
const EXPIRY_SOON_DAYS = 7;

@Component({
  selector: "app-pantry",
  imports: [
    DatePipe,
    RouterLink,
    ConsumeFormComponent,
    ConsumeIngredientComponent,
    PagerComponent,
    PantryItemFormComponent,
    ScanQueueComponent,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatTabsModule,
    MatTooltipModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>Pantry</h1>
        <span class="grow"></span>
        @if (expiringCount(); as count) {
          <span class="warn-text row">
            <mat-icon>schedule</mat-icon>
            {{ count }} item{{ count === 1 ? "" : "s" }} needs using
          </span>
        }
        <a mat-stroked-button routerLink="/pantry/ingredients">
          <mat-icon>science</mat-icon>
          Ingredients
        </a>
        <a mat-stroked-button routerLink="/pantry/barcodes">
          <mat-icon>category</mat-icon>
          Categories
        </a>
        <button mat-stroked-button (click)="startScanQueue()">
          <mat-icon>qr_code_scanner</mat-icon>
          Scan multiple
        </button>
        <button mat-flat-button (click)="startAdd()">
          <mat-icon>add</mat-icon>
          Add
        </button>
      </div>

      @if (loading()) {
        <mat-progress-bar mode="indeterminate" />
      }

      @if (
        pendingScanCount() > 0 && !scanningQueue() && !adding() && !editing()
      ) {
        <mat-card class="resume-banner">
          <mat-card-content class="row">
            <mat-icon>qr_code_scanner</mat-icon>
            <span class="grow">
              {{ pendingScanCount() }} scanned item{{
                pendingScanCount() === 1 ? "" : "s"
              }}
              waiting to be stocked.
            </span>
            <button mat-stroked-button (click)="resumeScanQueue()">Finish stocking</button>
          </mat-card-content>
        </mat-card>
      }

      @if (adding() || editing()) {
        <app-pantry-item-form
          [lot]="editing()"
          [units]="units()"
          [locations]="locations()"
          (saved)="onSaved()"
          (cancelled)="closeForm()"
        />
      }

      @if (consuming(); as lot) {
        <app-consume-form
          [lot]="lot"
          [units]="units()"
          (saved)="onSaved()"
          (cancelled)="closeForm()"
        />
      }

      @if (consumingIngredient(); as balance) {
        <app-consume-ingredient
          [balance]="balance"
          (saved)="onSaved()"
          (cancelled)="closeForm()"
        />
      }

      @if (scanningQueue()) {
        <app-scan-queue
          [units]="units()"
          [locations]="locations()"
          [startInStocking]="resumeInStocking()"
          (saved)="onScanQueueSaved()"
          (cancelled)="closeScanQueue()"
        />
      }

      <mat-tab-group>
        <mat-tab label="What is on hand">
          <div class="tab-body">
            <mat-form-field appearance="outline" class="search">
              <mat-label>Search</mat-label>
              <input
                matInput
                [value]="balancesQuery()"
                (input)="onBalancesSearch($any($event.target).value)"
                placeholder="Ingredient name"
              />
              <mat-icon matSuffix>search</mat-icon>
            </mat-form-field>

            @if (balances().length === 0 && !loading()) {
              <p class="empty muted">
                @if (balancesQuery()) {
                  Nothing matches “{{ balancesQuery() }}”.
                } @else {
                  The pantry is empty.
                }
              </p>
            }
            @for (balance of balances(); track balance.ingredientId) {
              <mat-card>
                <mat-card-content>
                  <div class="row">
                    <strong class="grow">{{ balance.ingredient.name }}</strong>
                    @if (balance.total !== null && balance.unit) {
                      <span class="amount">
                        {{ round(balance.total) }} {{ unitLabel(balance) }}
                      </span>
                    } @else {
                      <!--
                        Deliberately not "0". The app could not add this up, which
                        is a different claim from having none of it.
                      -->
                      <span class="muted">not countable</span>
                    }
                  </div>
                  <div class="row muted small">
                    <span class="grow">
                      across {{ balance.lotCount }} lot{{
                        balance.lotCount === 1 ? "" : "s"
                      }}
                    </span>
                    @if (balance.lotCount > 0) {
                      <button
                        mat-button
                        class="use-across"
                        (click)="startConsumeIngredient(balance)"
                      >
                        <mat-icon>remove_circle_outline</mat-icon>
                        Use some
                      </button>
                    }
                  </div>

                  @for (bad of balance.unconvertible; track bad.lotId) {
                    <div class="warn-text small row">
                      <mat-icon class="tiny">help_outline</mat-icon>
                      <span class="grow">
                        {{ bad.quantity }} {{ bad.unit.name }} could not be
                        combined
                        <span
                          class="muted"
                          [matTooltip]="reasonHelp(bad.reason)"
                        >
                          ({{ reasonLabel(bad.reason) }})
                        </span>
                      </span>
                      <!--
                        The reason is only worth naming if it can be acted on.
                        This is the missing datum and the screen that supplies it,
                        one click apart.
                      -->
                      <a
                        class="fix"
                        routerLink="/pantry/ingredients"
                        [queryParams]="{ q: balance.ingredient.name }"
                        >Fix</a
                      >
                    </div>
                  }
                </mat-card-content>
              </mat-card>
            }

            <app-pager
              [total]="balancesTotal()"
              [limit]="limit"
              [offset]="balancesOffset()"
              (offsetChange)="onBalancesPageChange($event)"
            />
          </div>
        </mat-tab>

        <mat-tab label="Every lot">
          <div class="tab-body">
            <mat-form-field appearance="outline" class="search">
              <mat-label>Search</mat-label>
              <input
                matInput
                [value]="lotsQuery()"
                (input)="onLotsSearch($any($event.target).value)"
                placeholder="Ingredient name or brand"
              />
              <mat-icon matSuffix>search</mat-icon>
            </mat-form-field>

            @if (lots().length === 0 && !loading()) {
              <p class="empty muted">
                @if (lotsQuery()) {
                  Nothing matches “{{ lotsQuery() }}”.
                } @else {
                  Nothing stored yet.
                }
              </p>
            }
            @for (lot of lots(); track lot.id) {
              <mat-card
                class="lot"
                [class.expired]="lot.expiry === 'expired'"
                (click)="startEdit(lot)"
              >
                <mat-card-content>
                  <div class="row">
                    <span class="grow">
                      <strong>{{ lot.ingredient.name }}</strong>
                      @if (lot.brand) {
                        <span class="muted"> · {{ lot.brand }}</span>
                      }
                    </span>
                    <span class="amount">
                      {{ round(lot.quantity) }} {{ lotUnit(lot) }}
                    </span>
                    <!--
                      Inside a card whose whole body opens the editor, so the
                      click must be stopped from reaching it.
                    -->
                    <button
                      mat-icon-button
                      class="use-some"
                      matTooltip="Use some of this lot"
                      aria-label="Use some of this lot"
                      (click)="startConsume(lot, $event)"
                    >
                      <mat-icon>remove_circle_outline</mat-icon>
                    </button>
                  </div>
                  <div class="row small muted">
                    <span>{{ lot.location.name }}</span>
                    @if (lot.product; as product) {
                      <span class="row" [matTooltip]="product.name">
                        <mat-icon class="tiny">barcode_reader</mat-icon>
                        {{ product.barcode }}
                      </span>
                    }
                    @if (lot.expiresOn) {
                      <span [class]="expiryClass(lot)">
                        {{ expiryWord(lot) }}
                        {{ lot.expiresOn | date: "d MMM y" }}
                      </span>
                    }
                  </div>
                </mat-card-content>
              </mat-card>
            }

            <app-pager
              [total]="lotsTotal()"
              [limit]="limit"
              [offset]="lotsOffset()"
              (offsetChange)="onLotsPageChange($event)"
            />
          </div>
        </mat-tab>
      </mat-tab-group>
    </div>
  `,
  styles: `
    .resume-banner {
      margin-bottom: 1rem;
      border-left: 3px solid var(--mat-sys-primary);
    }
    .tab-body {
      padding-top: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }
    .search {
      width: min(460px, 100%);
    }
    .amount {
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .small {
      font-size: 0.85rem;
    }
    .tiny {
      font-size: 1rem;
      width: 1rem;
      height: 1rem;
    }
    .lot {
      cursor: pointer;
    }
    .use-some {
      --mdc-icon-button-state-layer-size: 2rem;
      margin: -.35rem -.5rem -.35rem .25rem;
    }
    .use-across {
      --mat-button-text-container-height: 1.75rem;
      font-size: .8rem;
      margin: -.25rem -.5rem -.25rem 0;
    }
    .fix {
      font-size: 0.8rem;
      white-space: nowrap;
    }
    mat-card.expired {
      border-left: 3px solid var(--mat-sys-error);
    }
    mat-card-content {
      padding-bottom: 0.75rem;
    }
  `,
})
export class PantryComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  readonly lots = signal<PantryLot[]>([]);
  readonly lotsTotal = signal(0);
  readonly balances = signal<Balance[]>([]);
  readonly balancesTotal = signal(0);
  readonly loading = signal(true);
  readonly limit = PAGE_LIMIT;

  /** Filters, not form data — one search + page per tab. */
  readonly lotsQuery = signal("");
  readonly lotsOffset = signal(0);
  readonly balancesQuery = signal("");
  readonly balancesOffset = signal(0);
  private lotsSearchTimer?: ReturnType<typeof setTimeout>;
  private balancesSearchTimer?: ReturnType<typeof setTimeout>;

  readonly units = signal<Unit[]>([]);
  readonly locations = signal<StorageLocation[]>([]);
  readonly adding = signal(false);
  readonly editing = signal<PantryLot | null>(null);
  /** The lot being partly used up, if any — a different action from editing it. */
  readonly consuming = signal<PantryLot | null>(null);
  /** The ingredient being used across several of its lots at once. */
  readonly consumingIngredient = signal<Balance | null>(null);
  readonly scanningQueue = signal(false);
  readonly resumeInStocking = signal(false);
  /** Count only — the queue's own contents are loaded by app-scan-queue itself. */
  readonly pendingScanCount = signal(0);

  /**
   * A whole-pantry count, not a page-scoped one — `lots()` only holds the
   * current page, so this reads `.total` from a `limit: 1` call rather than
   * summing over whatever page happens to be loaded.
   */
  readonly expiringCount = signal(0);

  constructor() {
    this.loadLots();
    this.loadBalances();
    this.loadExpiringCount();
    this.api.units().subscribe({ next: (units) => this.units.set(units) });
    this.api.locations().subscribe({
      next: (locations) => {
        this.locations.set(locations);
        // Adding a lot needs somewhere to put it. Rather than let the form open
        // with an empty, unfixable "Where" select, say what is missing.
        if (locations.length === 0) {
          this.notify.error(
            null,
            'No storage locations yet — add one in Settings before stocking the pantry.',
          );
        }
      },
    });
    this.api.scanQueue().subscribe({
      next: (entries) => this.pendingScanCount.set(entries.length),
      error: () => undefined,
    });
  }

  startAdd(): void {
    this.editing.set(null);
    this.consuming.set(null);
    this.adding.set(true);
  }

  startEdit(lot: PantryLot): void {
    this.adding.set(false);
    this.consuming.set(null);
    this.editing.set(lot);
  }

  /**
   * Opens the partial-use form for one lot.
   *
   * Stops the click reaching the card, whose whole body opens the editor —
   * without this, using some of a lot would open two forms at once.
   */
  startConsume(lot: PantryLot, event: Event): void {
    event.stopPropagation();
    this.adding.set(false);
    this.editing.set(null);
    this.consumingIngredient.set(null);
    this.consuming.set(lot);
  }

  /** Uses several lots of one ingredient at once, with an amount for each. */
  startConsumeIngredient(balance: Balance): void {
    this.adding.set(false);
    this.editing.set(null);
    this.consuming.set(null);
    this.consumingIngredient.set(balance);
  }

  closeForm(): void {
    this.adding.set(false);
    this.editing.set(null);
    this.consuming.set(null);
    this.consumingIngredient.set(null);
  }

  startScanQueue(): void {
    this.resumeInStocking.set(false);
    this.scanningQueue.set(true);
  }

  resumeScanQueue(): void {
    this.resumeInStocking.set(true);
    this.scanningQueue.set(true);
  }

  closeScanQueue(): void {
    this.scanningQueue.set(false);
    // Whatever state the queue was left in (cleared, partially stocked, or
    // untouched) — the banner needs to reflect it, not the count from before
    // this session opened.
    this.api.scanQueue().subscribe({
      next: (entries) => this.pendingScanCount.set(entries.length),
      error: () => undefined,
    });
  }

  onScanQueueSaved(): void {
    this.closeScanQueue();
    this.reloadAll();
  }

  onSaved(): void {
    this.closeForm();
    this.reloadAll();
  }

  onLotsSearch(value: string): void {
    this.lotsQuery.set(value);
    this.lotsOffset.set(0);
    clearTimeout(this.lotsSearchTimer);
    this.lotsSearchTimer = setTimeout(() => this.loadLots(), 250);
  }

  onLotsPageChange(offset: number): void {
    this.lotsOffset.set(offset);
    this.loadLots();
  }

  onBalancesSearch(value: string): void {
    this.balancesQuery.set(value);
    this.balancesOffset.set(0);
    clearTimeout(this.balancesSearchTimer);
    this.balancesSearchTimer = setTimeout(() => this.loadBalances(), 250);
  }

  onBalancesPageChange(offset: number): void {
    this.balancesOffset.set(offset);
    this.loadBalances();
  }

  round(value: string): string {
    return trimQuantity(value);
  }

  unitLabel(balance: Balance): string {
    return unitLabel(balance.unit, balance.total ?? "0");
  }

  lotUnit(lot: PantryLot): string {
    return unitLabel(lot.unit, lot.quantity);
  }

  expiryClass(lot: PantryLot): string {
    return lot.expiry === "expired" || lot.expiry === "soon"
      ? "warn-text"
      : "muted";
  }

  expiryWord(lot: PantryLot): string {
    return lot.expiry === "expired" ? "expired" : "use by";
  }

  reasonLabel(reason: string): string {
    if (reason === "NO_DENSITY") return "no density";
    if (reason === "NO_PIECE_WEIGHT") return "no item weight";
    return "unknown";
  }

  /** The point of naming the reason is that the user can act on it. */
  reasonHelp(reason: string): string {
    if (reason === "NO_DENSITY") {
      return "To combine a volume with a weight, the app needs to know what a millilitre of this weighs. Add a density to the ingredient and this will fold in.";
    }
    if (reason === "NO_PIECE_WEIGHT") {
      return "To combine a count with a weight, the app needs to know what one of these weighs. Add an item weight to the ingredient.";
    }
    return "These units cannot be reconciled.";
  }

  private reloadAll(): void {
    this.loadLots();
    this.loadBalances();
    this.loadExpiringCount();
  }

  private loadLots(): void {
    this.loading.set(true);
    this.api
      .pantry({ q: this.lotsQuery(), limit: this.limit, offset: this.lotsOffset() })
      .subscribe({
        next: (page) => {
          this.lots.set(page.items);
          this.lotsTotal.set(page.total);
          this.loading.set(false);
        },
        error: (error: unknown) => {
          this.loading.set(false);
          this.notify.error(error, "Could not load the pantry.");
        },
      });
  }

  private loadBalances(): void {
    this.api
      .balances({ q: this.balancesQuery(), limit: this.limit, offset: this.balancesOffset() })
      .subscribe({
        next: (page) => {
          this.balances.set(page.items);
          this.balancesTotal.set(page.total);
        },
        error: (error: unknown) =>
          this.notify.error(error, "Could not load balances."),
      });
  }

  /** A single row's worth of a filtered `pantry()` call, read only for `.total`. */
  private loadExpiringCount(): void {
    this.api
      .pantry({ expiringWithinDays: EXPIRY_SOON_DAYS, limit: 1 })
      .subscribe({
        next: (page) => this.expiringCount.set(page.total),
        error: () => undefined,
      });
  }
}
