import {
  Component,
  LOCALE_ID,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatTooltipModule } from "@angular/material/tooltip";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { amountWithUnit, trimQuantity, unitLabel } from "../shared/format";
import type { Balance, ConsumeResult, ExplicitDraw, PantryLot } from "../core/models";

/** Why a lot could not be measured against the unit being reported in. */
const REASON: Record<string, string> = {
  NO_DENSITY: "no density recorded",
  NO_PIECE_WEIGHT: "no item weight recorded",
  NO_INGREDIENT: "nothing to convert through",
  INVALID_UNIT: "the unit is unusable",
};

/**
 * Records what was actually used of one ingredient, lot by lot.
 *
 * The per-lot "Use some" form handles one jar; this is the case it cannot
 * reach — half a bag from one and a splash from another, in one go, with the
 * amounts the cook actually used rather than a total for the app to divide up.
 *
 * Nothing here is a requirement being met, so there is no "needed" figure and
 * nothing can fall short: it is a statement about what left the shelf.
 */
@Component({
  selector: "app-consume-ingredient",
  imports: [
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  template: `
    <mat-card class="form">
      <mat-card-content>
        <h2>Use some {{ balance().ingredient.name }}</h2>
        <p class="muted small">
          How much came out of each lot. Leave a lot blank to keep it as it is.
        </p>

        @if (loading()) {
          <mat-progress-bar mode="indeterminate" />
        }

        @for (lot of lots(); track lot.id) {
          <div class="draw" [class.untouched]="!draftFor(lot.id)">
            <input
              class="draw-input"
              inputmode="decimal"
              [attr.aria-label]="'Amount used from ' + label(lot)"
              [value]="draftFor(lot.id)"
              (input)="onDraft(lot.id, $event)"
            />
            <span class="draw-unit muted">{{ lotUnit(lot) }}</span>
            <span class="grow small">{{ label(lot) }}</span>
          </div>
        }

        @if (!loading() && !lots().length) {
          <p class="muted small">There are no lots of this to use.</p>
        }

        <input
          class="note"
          placeholder="Note (optional)"
          aria-label="Note"
          [value]="note()"
          (input)="note.set($any($event.target).value)"
        />

        @if (error()) {
          <p class="warn-text small" role="alert">{{ error() }}</p>
        }

        <div class="actions">
          <button
            mat-flat-button
            type="button"
            [disabled]="busy() || !anyDrawn()"
            (click)="save()"
          >
            <mat-icon>remove_circle_outline</mat-icon>
            Use it
          </button>
          <button mat-button type="button" (click)="cancelled.emit()">Cancel</button>
        </div>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    h2 { font-size: 1rem; font-weight: 500; margin: 0 0 .25rem; }
    .small { font-size: .85rem; }
    .form { margin-bottom: 1rem; }
    .draw { display: flex; align-items: center; gap: .5rem; padding: .15rem 0; }
    .draw-input, .note {
      padding: .25rem .4rem;
      font: inherit;
      color: inherit;
      background: var(--mat-sys-surface);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 4px;
    }
    .draw-input {
      width: 5rem;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .draw-input:focus, .note:focus {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -1px;
    }
    /* Dimmed, not hidden: a lot you are taking nothing from is still one you
       might have used, and it has to stay reachable. */
    .draw.untouched { opacity: .65; }
    .draw-unit { min-width: 2.5rem; }
    .note { width: min(28rem, 100%); margin-top: .75rem; }
    .actions { display: flex; gap: .5rem; align-items: center; margin-top: .75rem; }
  `,
})
export class ConsumeIngredientComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly dates = new DatePipe(inject(LOCALE_ID));

  readonly balance = input.required<Balance>();

  readonly saved = output<void>();
  readonly cancelled = output<void>();

  readonly lots = signal<PantryLot[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly note = signal("");

  /**
   * Amounts as typed, keyed by lot. Strings throughout — these are Decimals
   * server-side, and parsing them here to total them up is how 0.33 cups rots.
   *
   * Not a Signal Form: the fields are one per lot and appear only once the lots
   * load, which is the "a set of inputs, not a form" case. The one rule worth
   * enforcing locally is the number format, done below on the string.
   */
  private readonly drafts = signal<Record<number, string>>({});

  readonly anyDrawn = computed(() =>
    Object.values(this.drafts()).some((value) => value.trim() !== ""),
  );

  constructor() {
    // Keyed on the ingredient, not run once: the parent keeps this alive when
    // you move from one balance row straight to another, and stale lots would
    // put one ingredient's jars under another's name.
    let loadedFor: number | null = null;
    effect(() => {
      const ingredientId = this.balance().ingredientId;
      if (ingredientId === loadedFor) return;
      loadedFor = ingredientId;
      this.drafts.set({});
      this.note.set("");
      this.error.set("");
      this.load(ingredientId);
    });
  }

  private load(ingredientId: number): void {
    this.loading.set(true);
    // Already ordered expiry-then-id by the API — the order a deduction would
    // have used, so the list reads top-down as "next up".
    this.api.pantry({ ingredientId, limit: 100 }).subscribe({
      next: (page) => {
        this.loading.set(false);
        this.lots.set(page.items);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.error.set(this.message(error));
      },
    });
  }

  draftFor(lotId: number): string {
    return this.drafts()[lotId] ?? "";
  }

  onDraft(lotId: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.drafts.update((current) => ({ ...current, [lotId]: value }));
  }

  lotUnit(lot: PantryLot): string {
    return unitLabel(lot.unit, lot.quantity);
  }

  label(lot: PantryLot): string {
    const parts = [`${amountWithUnit(lot.quantity, lot.unit)} on hand`];
    if (lot.brand) parts.push(lot.brand);
    else if (lot.product?.brands) parts.push(lot.product.brands);
    parts.push(lot.location.name);
    if (lot.expiresOn) {
      parts.push(
        `${lot.expiry === "expired" ? "expired" : "use by"} ` +
          `${this.dates.transform(lot.expiresOn, "d MMM y")}`,
      );
    }
    return parts.join(" · ");
  }

  save(): void {
    if (this.busy()) return;
    this.error.set("");

    const draws: ExplicitDraw[] = [];
    for (const [lotId, raw] of Object.entries(this.drafts())) {
      const value = raw.trim();
      if (value === "") continue;
      // Validated as a string, never parsed into the value that gets sent.
      if (!/^\d*\.?\d+$/.test(value)) {
        this.error.set("Use digits, for example 500 or 1.5.");
        return;
      }
      if (Number(value) <= 0) continue;
      draws.push({ lotId: Number(lotId), quantity: value });
    }

    if (!draws.length) {
      this.error.set("Put an amount against at least one lot.");
      return;
    }

    this.busy.set(true);
    this.api
      .consume({
        ingredientId: this.balance().ingredientId,
        // No quantity: nothing was required here, so nothing can fall short.
        unitId: this.reportingUnitId(),
        draws,
        note: this.note().trim() || undefined,
      })
      .subscribe({
        next: (result) => {
          this.busy.set(false);
          this.notify.success(this.outcome(result));
          this.saved.emit();
        },
        error: (error: unknown) => {
          this.busy.set(false);
          this.error.set(this.message(error));
        },
      });
  }

  /**
   * The unit the total comes back in.
   *
   * The balance's own unit when there is one; otherwise the first lot's, since
   * a balance that could not be summed has no unit to offer and reporting in
   * *some* real unit beats refusing to report.
   */
  private reportingUnitId(): number {
    return this.balance().unit?.id ?? this.lots()[0].unit.id;
  }

  /**
   * Reports back what was typed, in the units it was typed in.
   *
   * Deliberately *not* `result.applied`, which is a single total in the
   * balance's own unit: flour is balanced in cups here, so entering 30 g and
   * 40 g came back as "used 0.558 cups" — correct arithmetic, and a number the
   * user never asked for and cannot check against the jars in front of them.
   * Nothing was required here, so there is no total worth converting to.
   */
  private outcome(result: ConsumeResult): string {
    const byLot = new Map(this.lots().map((lot) => [lot.id, lot]));
    const parts = result.allocations.map((entry) => {
      const lot = byLot.get(entry.lotId);
      const amount = lot
        ? amountWithUnit(entry.took, lot.unit)
        : trimQuantity(entry.took, 3);
      const name = lot?.brand ?? lot?.product?.brands ?? lot?.location.name;
      return name ? `${amount} from ${name}` : amount;
    });

    if (!parts.length) return "Nothing was taken.";
    const took =
      parts.length <= 2
        ? `Used ${parts.join(" and ")}`
        : `Used ${parts.length} lots' worth`;

    // Named, not swallowed: this stock left the shelf, but it could not be
    // measured against the others, so it is never quietly rolled into a total.
    if (result.unmeasured.length) {
      return `${took}. ${result.unmeasured.length === 1 ? "One lot" : "Some lots"} could not be measured against the rest.`;
    }
    return `${took}.`;
  }

  private message(error: unknown): string {
    const body = (error as { error?: { message?: string | string[] } }).error;
    const message = body?.message;
    if (Array.isArray(message)) return message.join(" ");
    if (typeof message === "string") return message;
    return "Could not record that. Check the amounts and try again.";
  }
}
