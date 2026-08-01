import { Component,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from "@angular/core";
import {
  FormField,
  FormRoot,
  form,
  min,
  required,
  submit,
  validate,
} from "@angular/forms/signals";
import { UpperCasePipe } from "@angular/common";
import { firstValueFrom } from "rxjs";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatSelectModule } from "@angular/material/select";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { BarcodeScanComponent } from "../shared/barcode-scan.component";
import { IngredientPickerComponent } from "../shared/ingredient-picker.component";
import { ProductPickerComponent } from "../shared/product-picker.component";
import type {
  BarcodeLookup,
  Ingredient,
  PantryItemWrite,
  PantryLot,
  Product,
  ScanQueueEntry,
  StorageLocation,
  Unit,
} from "../core/models";

/**
 * Adds a lot to the pantry, or edits one that is already there.
 *
 * A "lot" is one physical thing: this bag of rice, with its own expiry. Two
 * half-used bags are deliberately two lots rather than one total, which is why
 * this form is per-lot and not per-ingredient.
 */
@Component({
  selector: "app-pantry-item-form",
  imports: [
    UpperCasePipe,
    BarcodeScanComponent,
    FormField,
    FormRoot,
    IngredientPickerComponent,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    ProductPickerComponent,
  ],
  template: `
    <mat-card class="form">
      <mat-card-content>
        <h2>{{ lot() ? "Edit this lot" : "Add to the pantry" }}</h2>

        @if (lot(); as existing) {
          <p class="muted small">{{ existing.ingredient.name }}</p>
          @if (existing.product; as product) {
            <p class="muted small">{{ product.name }} · {{ product.barcode }}</p>
          }
        } @else {
          @if (!prefill()) {
            <app-barcode-scan
              label="Barcode"
              hint="Optional. Scanning fills the rest in."
              (scanned)="onScanned($event)"
            />

            <app-product-picker
              label="Or find by name"
              (picked)="onProductPicked($event)"
            />
          }

          @if (lookingUp()) {
            <mat-progress-bar mode="indeterminate" />
          }

          @if (scan(); as result) {
            @if (result.product; as product) {
              <div class="product">
                @if (product.imageSmallUrl) {
                  <img [src]="product.imageSmallUrl" [alt]="product.name" />
                }
                <div class="grow">
                  <strong>{{ product.name }}</strong>
                  @if (product.brands) {
                    <span class="muted"> · {{ product.brands }}</span>
                  }
                  <div class="muted small">
                    {{ product.quantityRaw || "size unknown" }} · {{ product.barcode }}
                    @if (product.nutriscoreGrade) {
                      <span class="grade">Nutri-Score {{ product.nutriscoreGrade | uppercase }}</span>
                    }
                  </div>

                  @if (result.source === 'override' && result.effectiveIngredient; as ingredient) {
                    <div class="small ok-text category-row">
                      <span>
                        <mat-icon class="tiny">bookmark</mat-icon>
                        Your category: {{ ingredient.name }}
                      </span>
                      <button
                        mat-button
                        type="button"
                        class="clear-override"
                        [disabled]="busy()"
                        (click)="clearOverride()"
                      >
                        Use usual category
                      </button>
                    </div>
                  } @else if (result.source === 'consensus' && result.effectiveIngredient; as ingredient) {
                    <div class="small ok-text">
                      <mat-icon class="tiny">groups</mat-icon>
                      Usually {{ ingredient.name }}
                      @if (result.consensus[0]; as top) {
                        ({{ top.householdCount }} household{{ top.householdCount === 1 ? "" : "s" }})
                      }
                      — change below to override
                    </div>
                  } @else {
                    <!--
                      No override and no consensus yet. Picking a category writes
                      an override (and seeds consensus for others). Never applied
                      automatically from suggestions alone.
                    -->
                    <div class="small">
                      <mat-icon class="tiny">help_outline</mat-icon>
                      No category yet — pick an ingredient below.
                    </div>
                    @if (result.suggestedIngredients.length) {
                      <div class="suggestions">
                        @for (item of result.suggestedIngredients; track item.id) {
                          <button
                            mat-stroked-button
                            type="button"
                            class="chip"
                            (click)="setOverride(item)"
                          >
                            {{ item.name }}
                          </button>
                        }
                      </div>
                    }
                  }
                </div>
              </div>
            } @else {
              <!--
                Not an error. Plenty of store-brand goods are simply not in Open
                Food Facts, and the answer is the manual flow that was always
                there — so this says so plainly and gets out of the way.
              -->
              <p class="muted small">
                Barcode {{ result.barcode }} is not in the catalog. Fill the rest
                in by hand and it will still be saved against the code.
              </p>
            }
          }

          <app-ingredient-picker
            label="Category"
            [allowCreate]="true"
            [initialText]="pickerText()"
            (picked)="onPicked($event)"
            (createRequested)="onCreate($event)"
          />
          <!--
            The picker is not a form control, so ingredientId has no field to
            render its error into. Without this the form is invalid on submit
            with nothing on screen to say why.
          -->
          @if (firstError(itemForm.ingredientId()); as message) {
            <p class="warn-text small picker-error" role="alert">{{ message }}</p>
          }
        }

        <form [formRoot]="itemForm" (submit)="save($event)">
          <div class="grid">
            <mat-form-field appearance="outline">
              <mat-label>How much</mat-label>
              <input matInput [formField]="itemForm.quantity" inputmode="decimal" />
              @if (firstError(itemForm.quantity()); as message) {
                <mat-error>{{ message }}</mat-error>
              }
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Unit</mat-label>
              <mat-select [formField]="itemForm.unitId">
                @for (unit of units(); track unit.id) {
                  <mat-option [value]="unit.id">{{ unit.name }}</mat-option>
                }
              </mat-select>
              @if (firstError(itemForm.unitId()); as message) {
                <mat-error>{{ message }}</mat-error>
              }
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Where</mat-label>
              <mat-select [formField]="itemForm.locationId">
                @for (location of locations(); track location.id) {
                  <mat-option [value]="location.id">{{ location.name }}</mat-option>
                }
              </mat-select>
              @if (firstError(itemForm.locationId()); as message) {
                <mat-error>{{ message }}</mat-error>
              }
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Brand</mat-label>
              <input matInput [formField]="itemForm.brand" />
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Use by</mat-label>
              <input matInput type="date" [formField]="itemForm.expiresOn" />
              <mat-hint>
                @if (!lot()) {
                  Left blank, the ingredient's shelf life suggests one.
                }
              </mat-hint>
            </mat-form-field>
          </div>

        @if (error()) {
          <p class="warn-text small" role="alert">{{ error() }}</p>
        }

        <div class="actions">
          <button mat-flat-button type="submit" [disabled]="busy()">
            <mat-icon>{{ lot() ? "save" : "add" }}</mat-icon>
            {{ lot() ? "Save" : "Add it" }}
          </button>
          <button mat-button (click)="cancelled.emit()">Cancel</button>

          @if (lot(); as existing) {
            <span class="grow"></span>
            <button mat-button class="warn-text" (click)="discard(existing)" [disabled]="busy()">
              <mat-icon>delete_outline</mat-icon>
              Discard
            </button>
            }
          </div>
        </form>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    h2 { font-size: 1rem; font-weight: 500; margin: 0 0 .5rem; }
    .small { font-size: .85rem; }
    .form { margin-bottom: 1rem; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
      gap: .25rem 1rem;
    }
    .actions { display: flex; gap: .5rem; align-items: center; margin-top: .5rem; }
    .picker-error { margin: -.5rem 0 .5rem; }
    .product {
      display: flex;
      gap: .75rem;
      align-items: flex-start;
      padding: .6rem;
      margin-bottom: .75rem;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
    }
    .product img { width: 3.5rem; height: 3.5rem; object-fit: contain; }
    .tiny { font-size: 1rem; width: 1rem; height: 1rem; vertical-align: middle; }
    .grade {
      margin-left: .5rem;
      padding: 0 .35rem;
      border-radius: 4px;
      border: 1px solid var(--mat-sys-outline-variant);
    }
    .suggestions { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .5rem; }
    .chip { --mat-button-outlined-container-height: 1.9rem; font-size: .8rem; }
    .ok-text { color: var(--mat-sys-primary); }
    .category-row {
      display: flex;
      flex-wrap: wrap;
      gap: .25rem .5rem;
      align-items: center;
      justify-content: space-between;
    }
    .clear-override { --mat-button-text-container-height: 1.75rem; font-size: .8rem; }
  `,
})
export class PantryItemFormComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  /** Present when editing; absent when adding. */
  readonly lot = input<PantryLot | null>(null);
  /**
   * A barcode already scanned and looked up elsewhere (the scan queue). When
   * set, the form skips its own scan input and product picker and goes
   * straight to showing this product's card and filling the model from it.
   */
  readonly prefill = input<ScanQueueEntry | null>(null);
  readonly units = input.required<Unit[]>();
  readonly locations = input.required<StorageLocation[]>();

  readonly saved = output<void>();
  readonly cancelled = output<void>();

  readonly busy = signal(false);
  readonly error = signal("");

  /** The last barcode lookup, or null when nothing has been scanned. */
  readonly scan = signal<BarcodeLookup | null>(null);
  readonly lookingUp = signal(false);

  /**
   * What the ingredient picker should show.
   *
   * Set from a binding so a scan visibly fills the field in, and cleared on a
   * new scan. It is an input to the picker rather than a two-way binding: the
   * picker owns its own text after that, so typing over it is not fought.
   */
  readonly pickerText = signal("");

  /**
   * The whole form model, derived from the `lot` input but freely editable.
   *
   * linkedSignal on the *model object*, so Signal Forms gets an ordinary
   * writable signal while the reset-on-input-change behaviour is preserved. The
   * parent keeps this component alive when you click from one lot straight to
   * another — only the input changes — and one-time seeding left the previous
   * lot's numbers under the new lot's name, so saving wrote them to the wrong
   * lot.
   *
   * `previous` keeps a location the user picked by hand when the locations list
   * reloads, instead of snapping back to the first entry.
   *
   * Ids are 0 rather than null when nothing is chosen: Signal Forms requires
   * non-null initial values, so 0 is the "nothing selected" sentinel and the
   * schema rejects it.
   */
  readonly model = linkedSignal<
    { lot: PantryLot | null; locations: StorageLocation[] },
    {
      ingredientId: number;
      quantity: string;
      unitId: number;
      locationId: number;
      brand: string;
      expiresOn: string;
    }
  >({
    source: () => ({ lot: this.lot(), locations: this.locations() }),
    computation: (source, previous) => {
      const lot = source.lot;
      if (lot) {
        return {
          ingredientId: lot.ingredient.id,
          quantity: lot.quantity,
          unitId: lot.unit.id,
          locationId: lot.location.id,
          brand: lot.brand ?? "",
          expiresOn: lot.expiresOn?.slice(0, 10) ?? "",
        };
      }

      const chosen = previous?.value.locationId ?? 0;
      const keepLocation = source.locations.some((l) => l.id === chosen);
      return {
        ingredientId: 0,
        quantity: "",
        unitId: 0,
        locationId: keepLocation ? chosen : (source.locations[0]?.id ?? 0),
        brand: "",
        expiresOn: "",
      };
    },
  });

  readonly itemForm = form(this.model, (path) => {
    required(path.quantity, { message: "How much is required." });

    // A quantity is a Decimal server-side, so it is validated as a string here
    // rather than parsed to a number — the same reason it crosses the wire as
    // one. Rejects "abc", "-5" and "0", all of which the API would refuse.
    validate(path.quantity, ({ value }) => {
      const raw = value().trim();
      if (raw === "") return undefined;
      if (!/^\d*\.?\d+$/.test(raw)) {
        return { kind: "notANumber", message: "Use digits, for example 500 or 1.5." };
      }
      if (Number(raw) <= 0) {
        return { kind: "notPositive", message: "Must be more than zero." };
      }
      return undefined;
    });

    min(path.unitId, 1, { message: "Pick a unit." });
    min(path.locationId, 1, { message: "Pick where it goes." });
    min(path.ingredientId, 1, { message: "Pick an ingredient." });
  });

  constructor() {
    // Seeds the same state a live scan would, once per distinct prefill —
    // guarded on the entry's id rather than running once in the constructor,
    // for the same reason `model` seeds via linkedSignal: the scan-queue
    // flow keeps this component alive across items, only the input changes.
    let seededFor: number | null = null;
    effect(() => {
      const entry = this.prefill();
      if (!entry || entry.id === seededFor) return;
      seededFor = entry.id;
      this.applyLookup(entry);
    });
  }

  /** The first message worth showing, once the user has actually been there. */
  firstError(state: {
    touched: () => boolean;
    errors: () => readonly { message?: string }[];
  }): string | undefined {
    if (!state.touched()) return undefined;
    return state.errors().find((e) => e.message)?.message;
  }

  /**
   * Name/brand search lands on the same path as a scan: the product card and
   * effective category all hang off a barcode lookup.
   */
  onProductPicked(product: Product): void {
    this.onScanned(product.barcode);
  }

  /**
   * Looks a scanned barcode up and fills in whatever it can.
   *
   * Prefills from the effective category (override or consensus). Does not
   * write an override merely by scanning — stocking the consensus default
   * leaves the household on the live crowd ranking.
   */
  onScanned(code: string): void {
    this.lookingUp.set(true);
    this.error.set("");

    this.api.lookupBarcode(code).subscribe({
      next: (result) => {
        this.lookingUp.set(false);
        this.applyLookup(result);
      },
      error: (error: unknown) => {
        this.lookingUp.set(false);
        this.scan.set(null);
        this.notify.error(error, "Could not look that barcode up.");
      },
    });
  }

  /**
   * Fills in whatever a barcode lookup can, whether it came from a live scan
   * or a queue entry looked up earlier.
   *
   * Does not write an override merely by scanning — stocking the consensus
   * default leaves the household on the live crowd ranking.
   */
  private applyLookup(result: BarcodeLookup): void {
    this.scan.set(result);

    if (result.effectiveIngredient) {
      this.applyIngredient(result.effectiveIngredient);
    } else {
      // A new scan supersedes whatever the last one filled in, rather than
      // leaving the previous product's ingredient under the new barcode.
      this.pickerText.set("");
      this.model.update((m) => ({ ...m, ingredientId: 0 }));
    }

    if (result.product?.brands) {
      const brand = result.product.brands.split(",")[0]?.trim() ?? "";
      if (brand) this.model.update((m) => ({ ...m, brand: m.brand || brand }));
    }

    // packQuantity/packUnitId are null together or not at all (see
    // CLAUDE.md), so filling one without the other never happens. Only
    // fills fields the user has not already touched, so a rescan cannot
    // clobber an amount that was typed by hand.
    const product = result.product;
    if (product?.packQuantity && product.packUnitId) {
      this.model.update((m) => ({
        ...m,
        quantity: m.quantity || product.packQuantity!,
        unitId: m.unitId === 0 ? product.packUnitId! : m.unitId,
      }));
    }
  }

  /** Pins a household override for the scanned barcode. */
  setOverride(item: Ingredient): void {
    const barcode = this.scan()?.barcode;
    if (!barcode || this.busy()) return;

    this.busy.set(true);
    this.api.bindProduct(barcode, item.id).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.scan.set(result);
        this.applyIngredient(item);
        this.notify.success(`Category set to ${item.name}.`);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not set that category.");
      },
    });
  }

  /** Clears the override so this household follows consensus again. */
  clearOverride(): void {
    const barcode = this.scan()?.barcode;
    if (!barcode || this.busy()) return;

    this.busy.set(true);
    this.api.unbindProduct(barcode).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.scan.set(result);
        if (result.effectiveIngredient) {
          this.applyIngredient(result.effectiveIngredient);
          this.notify.success(`Using usual category: ${result.effectiveIngredient.name}.`);
        } else {
          this.pickerText.set("");
          this.model.update((m) => ({ ...m, ingredientId: 0 }));
          this.notify.success("Override cleared.");
        }
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not clear that override.");
      },
    });
  }

  /** Fills the ingredient in, and a default unit with it where one is known. */
  private applyIngredient(item: { id: number; name: string; defaultUnitId?: number | null }): void {
    this.pickerText.set(item.name);
    this.model.update((m) => ({
      ...m,
      ingredientId: item.id,
      unitId: m.unitId === 0 && item.defaultUnitId ? item.defaultUnitId : m.unitId,
    }));
  }

  onPicked(item: Ingredient): void {
    this.model.update((m) => ({
      ...m,
      ingredientId: item.id,
      // A sensible default the user can override, rather than an empty select.
      unitId: m.unitId === 0 && item.defaultUnitId ? item.defaultUnitId : m.unitId,
    }));
    this.error.set("");

    // Changing away from the effective category (or picking one when there is
    // none) is an explicit override. Matching the consensus default does not
    // write — stocking under the crowd leaves the household unpinned.
    const scan = this.scan();
    if (!scan?.product) return;
    const effectiveId = scan.effectiveIngredient?.id ?? null;
    if (effectiveId !== item.id) this.setOverride(item);
  }

  onCreate(name: string): void {
    this.busy.set(true);
    this.api.createIngredient({ name }).subscribe({
      next: (created) => {
        this.busy.set(false);
        this.notify.success(
          `Added ${created.name} to the catalog. It has no density yet, so it may not combine with other units.`,
        );
        this.onPicked(created);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not create that ingredient.");
      },
    });
  }

  save(event: Event): void {
    // Native submit, not ngSubmit — that is an NgForm output and Signal Forms
    // replaces NgForm entirely.
    event.preventDefault();
    if (this.busy()) return;
    this.error.set("");

    // Marked touched explicitly: submit() runs the action only when valid but
    // does not mark anything on the way, so a blank submit would otherwise sit
    // there saying nothing.
    this.itemForm().markAsTouched();

    void submit(this.itemForm, async () => {
      this.busy.set(true);
      const value = this.model();
      const existing = this.lot();

      const body: PantryItemWrite = {
        quantity: value.quantity.trim(),
        unitId: value.unitId,
        locationId: value.locationId,
      };
      if (value.brand.trim()) body.brand = value.brand.trim();

      // Attached even when the barcode was not in the mirror — the server
      // rejects an unknown one, so this only ever carries a code that resolved.
      const scanned = this.scan();
      if (!existing && scanned?.product) body.productId = scanned.barcode;

      // An empty date means "leave it to the shelf life" when adding, but means
      // "clear it" when editing — hence null rather than simply omitting.
      if (value.expiresOn) body.expiresOn = new Date(value.expiresOn).toISOString();
      else if (existing) body.expiresOn = null;

      try {
        await firstValueFrom(
          existing
            ? this.api.updatePantryItem(existing.id, body)
            : this.api.addPantryItem({ ...body, ingredientId: value.ingredientId }),
        );
        this.busy.set(false);
        this.notify.success(existing ? "Updated." : "Added to the pantry.");
        this.saved.emit();
      } catch (error: unknown) {
        this.busy.set(false);
        this.error.set(this.message(error));
      }
    });
  }

  discard(existing: PantryLot): void {
    this.busy.set(true);
    this.api.discardPantryItem(existing.id, "Discarded from the pantry screen").subscribe({
      next: () => {
        this.busy.set(false);
        this.notify.success(`Discarded ${existing.ingredient.name}.`);
        this.saved.emit();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not discard that lot.");
      },
    });
  }

  /** Surfaces the server's validation message rather than a generic one. */
  private message(error: unknown): string {
    const body = (error as { error?: { message?: string | string[] } }).error;
    const message = body?.message;
    if (Array.isArray(message)) return message.join(" ");
    if (typeof message === "string") return message;
    return "Could not save that. Check the amounts and try again.";
  }
}
