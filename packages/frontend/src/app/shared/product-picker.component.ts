import { Component,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { MatAutocompleteModule } from "@angular/material/autocomplete";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { of, Subject, debounceTime, distinctUntilChanged, switchMap } from "rxjs";

import { ApiService } from "../core/api.service";
import type { Product } from "../core/models";

/**
 * Finds a pack in the Open Food Facts mirror by name or brand.
 *
 * Barcode scan is the fast path when the pack is in hand; this is for when it
 * is not — a half-torn label, a remembered brand, a pack whose digits you never
 * bothered to scan. There is no "create product" row: products are written only
 * by `npm run off:import`, and a household-private duplicate of a barcode would
 * defeat the only thing a barcode is good for.
 *
 * Same search shape as the ingredient picker: plain signal text (not a form),
 * debounced and switchMapped so a slow early response cannot overwrite a later
 * one, and `displayWith` so Material does not write `[object Object]` into the
 * input on an exact-name pick.
 */
@Component({
  selector: "app-product-picker",
  imports: [
    MatAutocompleteModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
  ],
  template: `
    <mat-form-field appearance="outline" class="full">
      <mat-label>{{ label() }}</mat-label>
      <input
        matInput
        [value]="text()"
        [matAutocomplete]="auto"
        (input)="onType($any($event.target).value)"
        [placeholder]="placeholder()"
        autocomplete="off"
      />
      <mat-icon matSuffix>search</mat-icon>

      <mat-autocomplete
        #auto="matAutocomplete"
        [displayWith]="display"
        (optionSelected)="onPick($event.option.value)"
      >
        @for (item of results(); track item.barcode) {
          <mat-option [value]="item" class="product-option">
            @if (item.imageSmallUrl) {
              <img [src]="item.imageSmallUrl" [alt]="" class="thumb" />
            } @else {
              <span class="thumb placeholder" aria-hidden="true"></span>
            }
            <span class="meta">
              <span class="name">{{ item.name }}</span>
              <span class="muted small">
                @if (item.brands) {
                  {{ item.brands }} ·
                }
                {{ item.quantityRaw || "size unknown" }}
              </span>
            </span>
          </mat-option>
        }

        @if (showEmpty()) {
          <mat-option disabled>
            Nothing in the catalog matches. It may not be in Open Food Facts, or
            the mirror may need its monthly refresh.
          </mat-option>
        }
      </mat-autocomplete>
    </mat-form-field>

    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
  `,
  styles: `
    .full { width: 100%; }
    .small { font-size: .8rem; }
    .muted { color: color-mix(in srgb, currentColor 60%, transparent); }
    .product-option {
      min-height: 3rem;
      line-height: 1.2;
      height: auto;
      padding-top: .4rem;
      padding-bottom: .4rem;
    }
    .product-option ::ng-deep .mdc-list-item__primary-text {
      display: flex;
      align-items: center;
      gap: .6rem;
      white-space: normal;
    }
    .thumb {
      width: 2rem;
      height: 2rem;
      object-fit: contain;
      flex: 0 0 auto;
      border-radius: 2px;
    }
    .thumb.placeholder {
      display: inline-block;
      background: color-mix(in srgb, currentColor 8%, transparent);
    }
    .meta {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .name {
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `,
})
export class ProductPickerComponent {
  private readonly api = inject(ApiService);

  readonly label = input("Or find by name");
  readonly placeholder = input("Name or brand…");

  readonly picked = output<Product>();

  /** What is in the box. Always a string — never a Product. */
  readonly text = signal("");
  readonly results = signal<Product[]>([]);
  readonly loading = signal(false);
  /** True once a query has returned with nothing — ordinary, not an error. */
  readonly searchedEmpty = signal(false);

  private readonly typed = new Subject<string>();

  constructor() {
    this.typed
      .pipe(
        debounceTime(200),
        distinctUntilChanged(),
        switchMap((q) => {
          if (q.length < 2) {
            this.loading.set(false);
            return of([] as Product[]);
          }
          this.loading.set(true);
          return this.api.searchProducts(q, 15);
        }),
      )
      .subscribe({
        next: (items) => {
          this.results.set(items);
          this.searchedEmpty.set(items.length === 0 && this.text().trim().length >= 2);
          this.loading.set(false);
        },
        error: () => {
          this.results.set([]);
          this.searchedEmpty.set(false);
          this.loading.set(false);
        },
      });
  }

  showEmpty(): boolean {
    return this.searchedEmpty() && this.results().length === 0 && !this.loading();
  }

  /**
   * What Material should put in the box for a selected option.
   *
   * An arrow property so `this` survives being handed to the trigger. Called
   * with null on a cleared selection — do not assume `value.name`.
   */
  readonly display = (value: Product | string | null): string => {
    if (!value) return "";
    if (typeof value === "string") return value;
    return value.name;
  };

  onType(value: string): void {
    // Selecting an option sets `text` in onPick, then Material writes the same
    // string into the input and fires (input). Skip that echo.
    if (value === this.text()) return;

    this.text.set(value);
    const query = value.trim();
    if (query.length < 2) {
      this.results.set([]);
      this.searchedEmpty.set(false);
      return;
    }
    this.typed.next(query);
  }

  onPick(value: Product): void {
    this.text.set(value.name);
    this.results.set([]);
    this.searchedEmpty.set(false);
    this.picked.emit(value);
  }
}
