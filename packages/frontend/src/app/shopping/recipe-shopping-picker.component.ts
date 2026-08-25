import {
  Component,
  effect,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
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
  RecipeServings,
  ShoppingList,
  ShoppingListSummary,
  Store,
  Unit,
} from "../core/models";

/** The recipes offered to the picker, with the servings to default each one to. */
export interface RecipePick {
  id: number;
  title: string;
  servings: number;
}

/**
 * Sets servings per selected recipe, then previews and either creates a new
 * shopping list from them or adds them onto an already-open one.
 *
 * Follows `app-cook-confirm`'s shape: an inline component toggled by the
 * caller, not a dialog and not a route of its own. The preview reuses the
 * same generation endpoint `app-shopping`'s date-range flow uses — recipes
 * are just a second way to describe demand, so the server does not need a
 * separate preview path for it.
 */
@Component({
  selector: "app-recipe-shopping-picker",
  imports: [
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
    <mat-card class="form">
      <mat-card-content>
        <h2>
          Add {{ recipes().length }} recipe{{ recipes().length === 1 ? "" : "s" }}
          to a shopping list
        </h2>

        <div class="recipe-rows">
          @for (recipe of recipes(); track recipe.id) {
            <div class="recipe-row">
              <span class="grow">{{ recipe.title }}</span>
              <button
                mat-icon-button
                (click)="setServings(recipe.id, servingsFor(recipe) - 1)"
                [disabled]="servingsFor(recipe) <= 1"
                [attr.aria-label]="'Fewer servings of ' + recipe.title"
              >
                <mat-icon>remove</mat-icon>
              </button>
              <span class="servings">{{ servingsFor(recipe) }} serving{{ servingsFor(recipe) === 1 ? "" : "s" }}</span>
              <button
                mat-icon-button
                (click)="setServings(recipe.id, servingsFor(recipe) + 1)"
                [attr.aria-label]="'More servings of ' + recipe.title"
              >
                <mat-icon>add</mat-icon>
              </button>
            </div>
          }
        </div>

        <div class="row destination">
          <mat-form-field appearance="outline">
            <mat-label>Add to</mat-label>
            <mat-select [value]="destinationValue()" (valueChange)="onDestinationChange($event)">
              <mat-option value="new">A new list</mat-option>
              @for (list of activeLists(); track list.id) {
                <mat-option [value]="list.id">{{ list.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>

          @if (destination() === 'new') {
            <mat-form-field appearance="outline">
              <mat-label>Name (optional)</mat-label>
              <input
                matInput
                [value]="newListName()"
                (input)="newListName.set($any($event.target).value)"
              />
            </mat-form-field>
            <mat-form-field appearance="outline" class="store">
              <mat-label>Store</mat-label>
              <mat-select [value]="storeId() ?? 0" (valueChange)="onStoreChange($event)">
                <mat-option [value]="0">Any</mat-option>
                @for (store of stores(); track store.id) {
                  <mat-option [value]="store.id">{{ store.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          }

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
              Nothing to buy — the pantry and your open lists already cover this.
            </p>
          } @else {
            <ul class="preview">
              @for (item of p.items; track item.ingredientId + "-" + item.unit.id) {
                <li>
                  <span class="amount">{{ amount(item.quantity, item.unit) }}</span>
                  <span class="grow">
                    {{ item.ingredientName }}
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
                    @if (item.alreadyOnLists === null) {
                      <mat-icon
                        class="tiny warn-text"
                        matTooltip="Another open list holds some of this but it could not be counted in these units, so nothing was deducted."
                        >help_outline</mat-icon
                      >
                    }
                  </span>
                  @if (item.estimatedPrice) {
                    <span class="muted price">~{{ item.estimatedPrice }}</span>
                  }
                </li>
              }
            </ul>
          }
        }

        <div class="actions">
          <button
            mat-flat-button
            type="button"
            [disabled]="busy() || !proposal()"
            (click)="save()"
          >
            <mat-icon>playlist_add</mat-icon>
            {{ destination() === "new" ? "Create list" : "Add to list" }}
          </button>
          <button mat-button type="button" (click)="cancelled.emit()">Cancel</button>
        </div>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    h2 {
      font-size: 1rem;
      font-weight: 500;
      margin: 0 0 0.5rem;
    }
    .form {
      margin-bottom: 1rem;
    }
    .recipe-rows {
      margin-bottom: 0.75rem;
    }
    .recipe-row {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.3rem 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .servings {
      min-width: 7rem;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    .destination {
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 0.6rem;
      margin-bottom: 0.5rem;
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
    .actions {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-top: 0.75rem;
    }
  `,
})
export class RecipeShoppingPickerComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  readonly recipes = input.required<RecipePick[]>();

  /** Emits the list that was created or added to, so the caller can navigate there. */
  readonly done = output<ShoppingList>();
  readonly cancelled = output<void>();

  readonly servingsById = signal<Map<number, number>>(new Map());
  readonly destination = signal<"new" | number>("new");
  readonly newListName = signal("");
  readonly storeId = signal<number | null>(null);
  readonly activeLists = signal<ShoppingListSummary[]>([]);
  readonly stores = signal<Store[]>([]);
  readonly proposal = signal<Proposal | null>(null);
  readonly busy = signal(false);

  constructor() {
    // Re-seeds servings whenever the caller hands over a different selection —
    // the picker is created fresh each time, but this keeps it correct even if
    // the input ever changes under an existing instance.
    effect(() => {
      const map = new Map<number, number>();
      for (const recipe of this.recipes()) map.set(recipe.id, recipe.servings);
      this.servingsById.set(map);
    });

    this.api.shoppingLists({ status: "ACTIVE", limit: 100 }).subscribe({
      next: (page) => this.activeLists.set(page.items),
      error: () => undefined,
    });
    this.api.stores().subscribe({
      next: (stores) => this.stores.set(stores),
      error: () => undefined,
    });
  }

  /** Template needs a single primitive for `mat-select`'s value binding. */
  destinationValue(): string | number {
    return this.destination();
  }

  servingsFor(recipe: RecipePick): number {
    return this.servingsById().get(recipe.id) ?? recipe.servings;
  }

  setServings(recipeId: number, value: number): void {
    if (value < 1) return;
    this.servingsById.update((current) => new Map(current).set(recipeId, value));
    this.proposal.set(null);
  }

  onDestinationChange(value: string | number): void {
    this.destination.set(value === "new" ? "new" : Number(value));
    this.proposal.set(null);
  }

  onStoreChange(value: number): void {
    this.storeId.set(value || null);
    this.proposal.set(null);
  }

  amount(quantity: string, unit: Unit | null): string {
    return amountWithUnit(quantity, unit);
  }

  preview(): void {
    this.busy.set(true);
    this.api
      .generateList({ recipes: this.selections(), storeId: this.previewStoreId() })
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
    const destination = this.destination();
    const request =
      destination === "new"
        ? this.api.createList({
            recipes: this.selections(),
            name: this.newListName().trim() || undefined,
            storeId: this.storeId() ?? undefined,
          })
        : this.api.addRecipesToList(destination, this.selections());

    request.subscribe({
      next: (list) => {
        this.busy.set(false);
        this.done.emit(list);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not save that list.");
      },
    });
  }

  private selections(): RecipeServings[] {
    return this.recipes().map((recipe) => ({
      recipeId: recipe.id,
      servings: this.servingsFor(recipe),
    }));
  }

  /** The store to sort the preview by: the chosen one for a new list, or the destination list's own. */
  private previewStoreId(): number | undefined {
    const destination = this.destination();
    if (destination === "new") return this.storeId() ?? undefined;
    return this.activeLists().find((list) => list.id === destination)?.store?.id;
  }
}
