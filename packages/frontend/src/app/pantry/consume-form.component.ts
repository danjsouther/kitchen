import { Component, computed, inject, input, linkedSignal, output, signal } from "@angular/core";
import {
  FormField,
  FormRoot,
  form,
  min,
  required,
  submit,
  validate,
} from "@angular/forms/signals";
import { firstValueFrom } from "rxjs";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatSelectModule } from "@angular/material/select";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { amountWithUnit, trimQuantity, unitLabel } from "../shared/format";
import type { ConsumeResult, PantryLot, Unit } from "../core/models";

/**
 * Takes some of *one* lot out of the pantry.
 *
 * The ordinary deduction paths draw across every lot of an ingredient,
 * soonest-expiry-first, which is the right default and the wrong answer when
 * you are standing there holding a particular jar. Here the lot is already in
 * hand, so the pin is implicit and not something the user has to express.
 *
 * Discarding a whole lot is a different action and already exists on the edit
 * form; this is the partial case.
 */
@Component({
  selector: "app-consume-form",
  imports: [
    FormField,
    FormRoot,
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
        <h2>Use some of this</h2>

        <p class="muted small">
          {{ lot().ingredient.name }}
          @if (lot().brand) {
            · {{ lot().brand }}
          }
          — {{ onHand() }} on hand
          @if (lot().product; as product) {
            · {{ product.barcode }}
          }
        </p>

        <form [formRoot]="consumeForm" (submit)="save($event)">
          <div class="grid">
            <mat-form-field appearance="outline">
              <mat-label>How much</mat-label>
              <input matInput [formField]="consumeForm.quantity" inputmode="decimal" />
              @if (firstError(consumeForm.quantity()); as message) {
                <mat-error>{{ message }}</mat-error>
              }
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Unit</mat-label>
              <mat-select [formField]="consumeForm.unitId">
                @for (unit of units(); track unit.id) {
                  <mat-option [value]="unit.id">{{ unit.name }}</mat-option>
                }
              </mat-select>
              @if (firstError(consumeForm.unitId()); as message) {
                <mat-error>{{ message }}</mat-error>
              }
              <mat-hint>Anything convertible — grams out of a litre is fine.</mat-hint>
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Note</mat-label>
              <input matInput [formField]="consumeForm.note" />
            </mat-form-field>
          </div>

          @if (error()) {
            <p class="warn-text small" role="alert">{{ error() }}</p>
          }

          <div class="actions">
            <button mat-flat-button type="submit" [disabled]="busy()">
              <mat-icon>remove_circle_outline</mat-icon>
              Use it
            </button>
            <button mat-button type="button" (click)="cancelled.emit()">Cancel</button>
          </div>
        </form>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    h2 { font-size: 1rem; font-weight: 500; margin: 0 0 .25rem; }
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
export class ConsumeFormComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  readonly lot = input.required<PantryLot>();
  readonly units = input.required<Unit[]>();

  readonly saved = output<void>();
  readonly cancelled = output<void>();

  readonly busy = signal(false);
  readonly error = signal("");

  readonly onHand = computed(() => amountWithUnit(this.lot().quantity, this.lot().unit));

  /**
   * linkedSignal on the model object, keyed off the lot — the parent list keeps
   * this component alive when you move from one lot's "use some" straight to
   * another's, so a constructor-seeded signal would leave the first lot's
   * numbers under the second lot's name.
   *
   * Defaults to the lot's own unit, which is nearly always what gets typed:
   * you are looking at "400 g" and taking some of those grams.
   */
  readonly model = linkedSignal<
    PantryLot,
    { quantity: string; unitId: number; note: string }
  >({
    source: () => this.lot(),
    computation: (lot) => ({ quantity: "", unitId: lot.unit.id, note: "" }),
  });

  readonly consumeForm = form(this.model, (path) => {
    required(path.quantity, { message: "How much is required." });

    // Validated as a string, never parsed: the quantity is a Decimal server-side
    // and crosses the wire as one, and routing it through a JavaScript number is
    // how 0.33 cups rots.
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
  });

  /** The first message worth showing, once the user has actually been there. */
  firstError(state: {
    touched: () => boolean;
    errors: () => readonly { message?: string }[];
  }): string | undefined {
    if (!state.touched()) return undefined;
    return state.errors().find((e) => e.message)?.message;
  }

  save(event: Event): void {
    // Native submit, not ngSubmit — that is an NgForm output and Signal Forms
    // replaces NgForm entirely.
    event.preventDefault();
    if (this.busy()) return;
    this.error.set("");

    // submit() runs the action only when valid but marks nothing on the way, so
    // a blank submit would otherwise sit there saying nothing.
    this.consumeForm().markAsTouched();

    void submit(this.consumeForm, async () => {
      this.busy.set(true);
      const value = this.model();
      const lot = this.lot();

      try {
        const result = await firstValueFrom(
          this.api.consume({
            ingredientId: lot.ingredient.id,
            quantity: value.quantity.trim(),
            unitId: value.unitId,
            lotId: lot.id,
            note: value.note.trim() || undefined,
          }),
        );
        this.busy.set(false);
        this.notify.success(this.outcome(result));
        this.saved.emit();
      } catch (error: unknown) {
        this.busy.set(false);
        this.error.set(this.message(error));
      }
    });
  }

  /**
   * What actually happened, which is not always what was asked for.
   *
   * A lot that holds less than the amount typed gives what it has and reports
   * the gap; a lot the maths cannot reach is named rather than counted as zero.
   * Both are worth a sentence — silently succeeding would leave the user
   * believing a deduction landed that did not.
   */
  private outcome(result: ConsumeResult): string {
    const unit = unitLabel(result.unit, result.applied);
    const took = `Used ${trimQuantity(result.applied, 3)}${unit ? ` ${unit}` : ""}`;

    if (result.unusable.length) {
      return `${took}. That lot could not be measured against the unit you used — it was left alone.`;
    }
    if (Number(result.shortfall) > 0) {
      const short = trimQuantity(result.shortfall, 3);
      return `${took} — ${short}${unit ? ` ${unit}` : ""} short of what you asked for.`;
    }
    return `${took}.`;
  }

  /** Surfaces the server's own message rather than a generic one. */
  private message(error: unknown): string {
    const body = (error as { error?: { message?: string | string[] } }).error;
    const message = body?.message;
    if (Array.isArray(message)) return message.join(" ");
    if (typeof message === "string") return message;
    return "Could not use that. Check the amount and try again.";
  }
}
