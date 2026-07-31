import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatSelectModule } from "@angular/material/select";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { IngredientPickerComponent } from "../shared/ingredient-picker.component";
import type {
  Ingredient,
  PantryItemWrite,
  PantryLot,
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
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [
    FormsModule,
    IngredientPickerComponent,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <mat-card class="form">
      <mat-card-content>
        <h2>{{ lot() ? "Edit this lot" : "Add to the pantry" }}</h2>

        @if (lot(); as existing) {
          <p class="muted small">{{ existing.ingredient.name }}</p>
        } @else {
          <app-ingredient-picker
            label="What is it"
            [allowCreate]="true"
            (picked)="onPicked($event)"
            (createRequested)="onCreate($event)"
          />
        }

        <!--
          [ngModel] + (ngModelChange) rather than the [(ngModel)] shorthand:
          these are signals, and the banana-in-a-box form would try to assign to
          the signal reference itself instead of calling .set().
        -->
        <div class="grid">
          <mat-form-field appearance="outline">
            <mat-label>How much</mat-label>
            <input
              matInput
              [ngModel]="quantity()"
              (ngModelChange)="quantity.set($event)"
              name="quantity"
              inputmode="decimal"
            />
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Unit</mat-label>
            <mat-select [ngModel]="unitId()" (ngModelChange)="unitId.set($event)" name="unitId">
              @for (unit of units(); track unit.id) {
                <mat-option [value]="unit.id">{{ unit.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Where</mat-label>
            <mat-select
              [ngModel]="locationId()"
              (ngModelChange)="locationId.set($event)"
              name="locationId"
            >
              @for (location of locations(); track location.id) {
                <mat-option [value]="location.id">{{ location.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Brand</mat-label>
            <input matInput [ngModel]="brand()" (ngModelChange)="brand.set($event)" name="brand" />
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Use by</mat-label>
            <input
              matInput
              type="date"
              [ngModel]="expiresOn()"
              (ngModelChange)="expiresOn.set($event)"
              name="expiresOn"
            />
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
          <button mat-flat-button (click)="save()" [disabled]="busy() || !ready()">
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
  `,
})
export class PantryItemFormComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  /** Present when editing; absent when adding. */
  readonly lot = input<PantryLot | null>(null);
  readonly units = input.required<Unit[]>();
  readonly locations = input.required<StorageLocation[]>();

  readonly saved = output<void>();
  readonly cancelled = output<void>();

  readonly busy = signal(false);
  readonly error = signal("");

  /**
   * Form state derived from the `lot` input, but still freely editable.
   *
   * linkedSignal rather than one-time seeding in the constructor. The parent
   * keeps this component alive when you click from one lot straight to another
   * — only the input changes — so constructor seeding ran once and the fields
   * kept showing the *previous* lot's values under the new lot's name. Saving
   * then wrote those numbers onto the wrong lot.
   *
   * linkedSignal recomputes when its source changes, which is precisely the
   * behaviour that was missing, while staying writable so typing still works.
   */
  readonly ingredientId = linkedSignal<number | null>(() => this.lot()?.ingredient.id ?? null);
  readonly quantity = linkedSignal(() => this.lot()?.quantity ?? "");
  readonly unitId = linkedSignal<number | null>(() => this.lot()?.unit.id ?? null);
  readonly brand = linkedSignal(() => this.lot()?.brand ?? "");
  readonly expiresOn = linkedSignal(() => this.lot()?.expiresOn?.slice(0, 10) ?? "");

  /**
   * Uses the source/computation form so a location the user picked by hand is
   * preserved when the locations list itself reloads, rather than snapping back
   * to the first entry.
   */
  readonly locationId = linkedSignal<
    { lot: PantryLot | null; locations: StorageLocation[] },
    number | null
  >({
    source: () => ({ lot: this.lot(), locations: this.locations() }),
    computation: (source, previous) => {
      if (source.lot) return source.lot.location.id;
      const chosen = previous?.value ?? null;
      if (chosen !== null && source.locations.some((l) => l.id === chosen)) return chosen;
      return source.locations[0]?.id ?? null;
    },
  });

  ready(): boolean {
    const hasIngredient = this.lot() !== null || this.ingredientId() !== null;
    return (
      hasIngredient &&
      this.quantity().trim() !== "" &&
      this.unitId() !== null &&
      this.locationId() !== null
    );
  }

  onPicked(item: Ingredient): void {
    this.ingredientId.set(item.id);
    // A sensible default the user can override, rather than an empty select.
    if (item.defaultUnitId && this.unitId() === null) this.unitId.set(item.defaultUnitId);
    this.error.set("");
  }

  onCreate(name: string): void {
    this.busy.set(true);
    this.api.createIngredient({ name }).subscribe({
      next: (created) => {
        this.busy.set(false);
        this.ingredientId.set(created.id);
        this.notify.success(
          `Added ${created.name} to the catalog. It has no density yet, so it may not combine with other units.`,
        );
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not create that ingredient.");
      },
    });
  }

  save(): void {
    if (!this.ready()) return;
    this.busy.set(true);
    this.error.set("");

    const existing = this.lot();
    const body: PantryItemWrite = {
      quantity: this.quantity().trim(),
      unitId: Number(this.unitId()),
      locationId: Number(this.locationId()),
    };
    if (this.brand().trim()) body.brand = this.brand().trim();

    // An empty date means "leave it to the shelf life" when adding, but means
    // "clear it" when editing — hence null rather than simply omitting.
    const expires = this.expiresOn();
    if (expires) body.expiresOn = new Date(expires).toISOString();
    else if (existing) body.expiresOn = null;

    const request = existing
      ? this.api.updatePantryItem(existing.id, body)
      : this.api.addPantryItem({ ...body, ingredientId: Number(this.ingredientId()) });

    request.subscribe({
      next: () => {
        this.busy.set(false);
        this.notify.success(existing ? "Updated." : "Added to the pantry.");
        this.saved.emit();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.error.set(this.message(error));
      },
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
