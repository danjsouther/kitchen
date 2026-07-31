import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { Router, RouterLink } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
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
  Proposal,
  ShoppingListSummary,
  Store,
  Unit,
} from "../core/models";

@Component({
  selector: "app-shopping",
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>Shopping</h1>
      </div>

      <mat-card class="generator">
        <mat-card-content>
          <h2>Build a list from the plan</h2>
          <p class="muted small">
            Adds up what the planned meals need, takes off what the pantry
            already holds, and tops up anything below its par level.
          </p>

          <div class="row">
            <mat-form-field appearance="outline">
              <mat-label>From</mat-label>
              <input matInput type="date" [(ngModel)]="from" name="from" />
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>To</mat-label>
              <input matInput type="date" [(ngModel)]="to" name="to" />
            </mat-form-field>
            <mat-form-field appearance="outline" class="store">
              <mat-label>Store</mat-label>
              <mat-select [(ngModel)]="storeId" name="store">
                <mat-option [value]="null">Any</mat-option>
                @for (store of stores(); track store.id) {
                  <mat-option [value]="store.id">{{ store.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
            <button mat-stroked-button (click)="preview()" [disabled]="busy()">
              Preview
            </button>
          </div>

          @if (busy()) {
            <mat-progress-bar mode="indeterminate" />
          }

          @if (proposal(); as p) {
            @if (p.items.length === 0) {
              <p class="ok-text">
                Nothing to buy — the pantry already covers
                {{ p.mealCount }} planned meal{{
                  p.mealCount === 1 ? "" : "s"
                }}.
              </p>
            } @else {
              <p class="muted small">
                From {{ p.mealCount }} planned meal{{
                  p.mealCount === 1 ? "" : "s"
                }}:
              </p>
              <ul class="preview">
                @for (
                  item of p.items;
                  track item.ingredientId + "-" + item.unit.id
                ) {
                  <li>
                    <span class="amount">{{
                      amount(item.quantity, item.unit)
                    }}</span>
                    <span class="grow">
                      {{ item.ingredientName }}
                      @if (item.source === "PAR") {
                        <span class="muted">· restock</span>
                      }
                      @if (item.unconvertible) {
                        <mat-icon
                          class="tiny warn-text"
                          matTooltip="This could not be combined with the rest of this ingredient, so it is listed separately."
                          >call_split</mat-icon
                        >
                      }
                      @if (item.onHand === null) {
                        <mat-icon
                          class="tiny warn-text"
                          matTooltip="The pantry holds some of this but it could not be counted in these units, so nothing was deducted. You may end up with a spare."
                          >help_outline</mat-icon
                        >
                      }
                    </span>
                    @if (item.estimatedPrice) {
                      <span class="muted price"
                        >~{{ item.estimatedPrice }}</span
                      >
                    }
                  </li>
                }
              </ul>
              <button mat-flat-button (click)="save()" [disabled]="busy()">
                <mat-icon>playlist_add</mat-icon>
                Save this list
              </button>
            }
          }
        </mat-card-content>
      </mat-card>

      <h2>Your lists</h2>
      @if (lists().length === 0) {
        <p class="empty muted">No lists yet.</p>
      }
      @for (list of lists(); track list.id) {
        <mat-card class="list-row" [routerLink]="['/shopping', list.id]">
          <mat-card-content class="row">
            <span class="grow">
              <strong>{{ list.name }}</strong>
              <div class="muted small">
                {{ list.createdOn | date: "d MMM y" }}
                @if (list.store) {
                  · {{ list.store.name }}
                }
                · {{ list._count.items }} items
              </div>
            </span>
            <span class="status" [class.done]="list.status !== 'ACTIVE'">
              {{ list.status.toLowerCase() }}
            </span>
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    h2 {
      font-size: 1.1rem;
      font-weight: 500;
      margin: 1.25rem 0 0.5rem;
    }
    .small {
      font-size: 0.85rem;
    }
    .generator {
      margin-bottom: 1rem;
    }
    .store {
      min-width: 10rem;
    }
    .preview {
      list-style: none;
      padding: 0;
      margin: 0.5rem 0 1rem;
    }
    .preview li {
      display: flex;
      gap: 0.6rem;
      align-items: center;
      padding: 0.3rem 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .amount {
      min-width: 6rem;
      font-variant-numeric: tabular-nums;
      font-weight: 500;
    }
    .price {
      font-variant-numeric: tabular-nums;
    }
    .tiny {
      font-size: 1rem;
      width: 1rem;
      height: 1rem;
      vertical-align: middle;
    }
    .list-row {
      cursor: pointer;
      margin-bottom: 0.5rem;
    }
    .status {
      padding: 0.15rem 0.6rem;
      border-radius: 999px;
      font-size: 0.8rem;
      background: var(--mat-sys-tertiary-container);
    }
    .status.done {
      background: var(--mat-sys-surface-container-highest);
    }
  `,
})
export class ShoppingComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly router = inject(Router);

  readonly lists = signal<ShoppingListSummary[]>([]);
  readonly stores = signal<Store[]>([]);
  readonly proposal = signal<Proposal | null>(null);
  readonly busy = signal(false);

  from = isoDate(new Date());
  to = isoDate(addDays(new Date(), 6));
  storeId: number | null = null;

  constructor() {
    this.api.shoppingLists().subscribe({
      next: (lists) => this.lists.set(lists),
      error: (error: unknown) =>
        this.notify.error(error, "Could not load your lists."),
    });
    this.api.stores().subscribe({ next: (stores) => this.stores.set(stores) });
  }

  amount(quantity: string, unit: Unit | null): string {
    return amountWithUnit(quantity, unit);
  }

  /** Previews without saving — a generated list is a guess about a week ahead. */
  preview(): void {
    this.busy.set(true);
    this.api
      .generateList({
        from: this.from,
        to: this.to,
        storeId: this.storeId ?? undefined,
      })
      .subscribe({
        next: (proposal) => {
          this.proposal.set(proposal);
          this.busy.set(false);
        },
        error: (error: unknown) => {
          this.busy.set(false);
          this.notify.error(error, "Could not build a list.");
        },
      });
  }

  save(): void {
    this.busy.set(true);
    this.api
      .createList({
        from: this.from,
        to: this.to,
        storeId: this.storeId ?? undefined,
      })
      .subscribe({
        next: (list) => void this.router.navigate(["/shopping", list.id]),
        error: (error: unknown) => {
          this.busy.set(false);
          this.notify.error(error, "Could not save that list.");
        },
      });
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
