import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatTabsModule } from "@angular/material/tabs";
import { MatTooltipModule } from "@angular/material/tooltip";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { trimQuantity, unitLabel } from "../shared/format";
import type { Balance, PantryLot } from "../core/models";

@Component({
  selector: "app-pantry",
  imports: [
    DatePipe,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
    MatTabsModule,
    MatTooltipModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>Pantry</h1>
        @if (expiringCount(); as count) {
          <span class="warn-text row">
            <mat-icon>schedule</mat-icon>
            {{ count }} item{{ count === 1 ? "" : "s" }} needs using
          </span>
        }
      </div>

      @if (loading()) {
        <mat-progress-bar mode="indeterminate" />
      }

      <mat-tab-group>
        <mat-tab label="What is on hand">
          <div class="tab-body">
            @if (balances().length === 0 && !loading()) {
              <p class="empty muted">The pantry is empty.</p>
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
                  <div class="muted small">
                    across {{ balance.lotCount }} lot{{
                      balance.lotCount === 1 ? "" : "s"
                    }}
                  </div>

                  @for (bad of balance.unconvertible; track bad.lotId) {
                    <div class="warn-text small row">
                      <mat-icon class="tiny">help_outline</mat-icon>
                      <span>
                        {{ bad.quantity }} {{ bad.unit.name }} could not be
                        combined
                        <span
                          class="muted"
                          [matTooltip]="reasonHelp(bad.reason)"
                        >
                          ({{ reasonLabel(bad.reason) }})
                        </span>
                      </span>
                    </div>
                  }
                </mat-card-content>
              </mat-card>
            }
          </div>
        </mat-tab>

        <mat-tab label="Every lot">
          <div class="tab-body">
            @if (lots().length === 0 && !loading()) {
              <p class="empty muted">Nothing stored yet.</p>
            }
            @for (lot of lots(); track lot.id) {
              <mat-card [class.expired]="lot.expiry === 'expired'">
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
                  </div>
                  <div class="row small muted">
                    <span>{{ lot.location.name }}</span>
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
          </div>
        </mat-tab>
      </mat-tab-group>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .tab-body {
      padding-top: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
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
  readonly balances = signal<Balance[]>([]);
  readonly loading = signal(true);

  readonly expiringCount = computed(
    () =>
      this.lots().filter(
        (lot) => lot.expiry === "expired" || lot.expiry === "soon",
      ).length,
  );

  constructor() {
    this.load();
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

  private load(): void {
    this.loading.set(true);

    this.api.pantry().subscribe({
      next: (lots) => this.lots.set(lots),
      error: (error: unknown) =>
        this.notify.error(error, "Could not load the pantry."),
    });

    this.api.balances().subscribe({
      next: (balances) => {
        this.balances.set(balances);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.notify.error(error, "Could not load balances.");
      },
    });
  }
}
