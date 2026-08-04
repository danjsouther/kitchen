import {
  Component,
  inject,
  signal,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import {
  FormField,
  form,
  validate,
  required,
  submit,
} from "@angular/forms/signals";
import { firstValueFrom } from "rxjs";
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
import { PagerComponent } from "../shared/pager.component";
import type {
  Proposal,
  ShoppingListSummary,
  Store,
  Unit,
} from "../core/models";

const PAGE_LIMIT = 20;

@Component({
  selector: "app-shopping",
  imports: [
    DatePipe,
    FormField,
      RouterLink,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
    PagerComponent,
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
              <input matInput type="date" [formField]="rangeForm.from" />
              @if (firstError(rangeForm.from()); as message) {
                <mat-error>{{ message }}</mat-error>
              }
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>To</mat-label>
              <input matInput type="date" [formField]="rangeForm.to" />
              <!--
                Without this the backwards-range rule blocks generation with
                nothing on screen: the button simply does nothing.
              -->
              @if (firstError(rangeForm.to()); as message) {
                <mat-error>{{ message }}</mat-error>
              }
            </mat-form-field>
            <mat-form-field appearance="outline" class="store">
              <mat-label>Store</mat-label>
              <mat-select [formField]="rangeForm.storeId">
                <mat-option [value]="0">Any</mat-option>
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

      <div class="row list-filters">
        <mat-form-field appearance="outline" class="search">
          <mat-label>Search</mat-label>
          <input
            matInput
            [value]="listQuery()"
            (input)="onListSearch($any($event.target).value)"
            placeholder="List name"
          />
          <mat-icon matSuffix>search</mat-icon>
        </mat-form-field>

        <mat-form-field appearance="outline" class="status-filter">
          <mat-label>Status</mat-label>
          <mat-select [value]="listStatus()" (valueChange)="onListStatusChange($event)">
            <mat-option value="">Any</mat-option>
            <mat-option value="ACTIVE">Active</mat-option>
            <mat-option value="COMPLETED">Completed</mat-option>
            <mat-option value="ARCHIVED">Archived</mat-option>
          </mat-select>
        </mat-form-field>
      </div>

      @if (lists().length === 0) {
        <p class="empty muted">
          @if (listQuery()) {
            Nothing matches “{{ listQuery() }}”.
          } @else {
            No lists yet.
          }
        </p>
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
            @if (list.status !== "ARCHIVED") {
              <button
                mat-icon-button
                class="warn-text"
                [disabled]="listBusy()"
                (click)="deleteList(list, $event)"
                [attr.aria-label]="'Delete ' + list.name"
              >
                <mat-icon>delete_outline</mat-icon>
              </button>
            }
          </mat-card-content>
        </mat-card>
      }

      <app-pager
        [total]="listTotal()"
        [limit]="listLimit"
        [offset]="listOffset()"
        (offsetChange)="onListPageChange($event)"
      />
    </div>
  `,
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
    .list-filters {
      align-items: flex-start;
      gap: 0.75rem;
      margin-bottom: 0.5rem;
    }
    .search {
      width: min(360px, 100%);
    }
    .status-filter {
      min-width: 9rem;
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
  readonly listTotal = signal(0);
  readonly listLimit = PAGE_LIMIT;
  /** Filters, not form data. */
  readonly listQuery = signal("");
  readonly listStatus = signal("");
  readonly listOffset = signal(0);
  private listSearchTimer?: ReturnType<typeof setTimeout>;

  readonly stores = signal<Store[]>([]);
  readonly proposal = signal<Proposal | null>(null);
  readonly busy = signal(false);
  readonly listBusy = signal(false);

  /**
   * The date range and store that drive list generation.
   *
   * storeId is 0 for "any store" rather than null: Signal Forms wants a
   * non-null initial value, and 0 doubles as the sentinel the template binds
   * its "Any" option to.
   */
  private readonly rangeModel = signal({
    from: isoDate(new Date()),
    to: isoDate(addDays(new Date(), 6)),
    storeId: 0,
  });

  readonly rangeForm = form(this.rangeModel, (path) => {
    required(path.from, { message: "Pick a start date." });
    required(path.to, { message: "Pick an end date." });

    // A backwards range silently produces an empty list, which reads as "you
    // need nothing" rather than "these dates are the wrong way round".
    validate(path.to, ({ value, valueOf }) => {
      const from = valueOf(path.from);
      if (!from || !value()) return undefined;
      if (value() < from) {
        return { kind: "backwards", message: "The end date is before the start." };
      }
      return undefined;
    });
  });

  /** The first message worth showing, once the user has actually been there. */
  firstError(state: {
    touched: () => boolean;
    errors: () => readonly { message?: string }[];
  }): string | undefined {
    if (!state.touched()) return undefined;
    return state.errors().find((e) => e.message)?.message;
  }


  constructor() {
    this.loadLists();
    this.api.stores().subscribe({ next: (stores) => this.stores.set(stores) });
  }

  amount(quantity: string, unit: Unit | null): string {
    return amountWithUnit(quantity, unit);
  }

  onListSearch(value: string): void {
    this.listQuery.set(value);
    this.listOffset.set(0);
    clearTimeout(this.listSearchTimer);
    this.listSearchTimer = setTimeout(() => this.loadLists(), 250);
  }

  onListStatusChange(value: string): void {
    this.listStatus.set(value);
    this.listOffset.set(0);
    this.loadLists();
  }

  onListPageChange(offset: number): void {
    this.listOffset.set(offset);
    this.loadLists();
  }

  /** Archives rather than truly deletes — the list stays visible under the Archived filter. */
  deleteList(list: ShoppingListSummary, event: Event): void {
    event.stopPropagation();
    this.listBusy.set(true);
    this.api.archiveList(list.id).subscribe({
      next: () => {
        this.listBusy.set(false);
        this.loadLists();
      },
      error: (error: unknown) => {
        this.listBusy.set(false);
        this.notify.error(error, "Could not delete that list.");
      },
    });
  }

  private loadLists(): void {
    this.api
      .shoppingLists({
        status: this.listStatus() || undefined,
        q: this.listQuery(),
        limit: this.listLimit,
        offset: this.listOffset(),
      })
      .subscribe({
        next: (page) => {
          this.lists.set(page.items);
          this.listTotal.set(page.total);
        },
        error: (error: unknown) =>
          this.notify.error(error, "Could not load your lists."),
      });
  }

  /** Previews without saving — a generated list is a guess about a week ahead. */
  preview(): void {
    // Gate on validity here rather than in a <form>: this submits from a
    // button, so there is no submit event for FormRoot to intercept.
    this.rangeForm().markAsTouched();
    if (this.rangeForm().invalid()) return;

    this.busy.set(true);
    this.api
      .generateList({
        from: this.rangeModel().from,
        to: this.rangeModel().to,
        storeId: this.rangeModel().storeId || undefined,
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
    // Gate on validity here rather than in a <form>: this submits from a
    // button, so there is no submit event for FormRoot to intercept.
    this.rangeForm().markAsTouched();
    if (this.rangeForm().invalid()) return;

    this.busy.set(true);
    this.api
      .createList({
        from: this.rangeModel().from,
        to: this.rangeModel().to,
        storeId: this.rangeModel().storeId || undefined,
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
