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
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatSelectModule } from "@angular/material/select";
import { MatTooltipModule } from "@angular/material/tooltip";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { amountWithUnit, trimQuantity, unitLabel } from "../shared/format";
import type {
  CookPin,
  CookReport,
  PantryLot,
  PlannedMeal,
  Unit,
  UnmeasuredLot,
} from "../core/models";

/** Why a recipe line was left out of the deduction entirely. */
const SKIP_REASON: Record<string, string> = {
  OPTIONAL: "optional — not deducted",
  UNRESOLVED: "not matched to an ingredient",
  NO_QUANTITY: "no amount given",
  NO_UNIT: "no unit given",
};

/** Why a lot could not be measured against what the recipe asked for. */
const UNUSABLE_REASON: Record<string, string> = {
  NO_DENSITY: "no density recorded",
  NO_PIECE_WEIGHT: "no item weight recorded",
  NO_INGREDIENT: "nothing to convert through",
  INVALID_UNIT: "the unit is unusable",
};

/**
 * Shows what cooking a meal would take out of the pantry, and lets the cook
 * change their mind about *which jar* before it happens.
 *
 * Cooking used to fire straight off a menu item, which meant the whole report —
 * what came from where, what was short, what could not be measured — was
 * thrown away into a one-line snackbar after the fact. Deduction is not
 * reversible in the user's head, so it is worth a look first.
 *
 * The preview comes from the same code path as the real cook, so what is on
 * screen is what will happen; every change of jar re-asks the server rather
 * than guessing at the new split locally.
 */
@Component({
  selector: "app-cook-confirm",
  imports: [
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  template: `
    <mat-card class="form">
      <mat-card-content>
        <h2>Cook {{ meal().recipe?.title }}</h2>

        @if (report(); as preview) {
          <p class="muted small">
            {{ preview.servings }} serving{{ preview.servings === 1 ? "" : "s" }}
            @if (preview.servings !== preview.scaledFrom) {
              · scaled from {{ preview.scaledFrom }}
            }
          </p>
        }

        @if (loading()) {
          <mat-progress-bar mode="indeterminate" />
        }

        @if (error()) {
          <p class="warn-text small" role="alert">{{ error() }}</p>
        }

        @if (report(); as preview) {
          @for (line of lines(); track line.ingredientId) {
            <div class="line">
              <div class="row">
                <span class="grow">{{ line.rawText }}</span>
                <span class="amount">
                  {{ amount(line.took, line.unit) }}
                  <span class="muted">of {{ amount(line.needed, line.unit) }}</span>
                </span>
                @if (line.short) {
                  <span class="pill missing">
                    {{ amount(line.short, line.unit) }} short
                  </span>
                } @else if (line.over) {
                  <!-- Not an error. Cooks use more than the recipe says. -->
                  <span class="pill over">{{ amount(line.over, line.unit) }} over</span>
                }
              </div>

              <!--
                Every lot, always — including the ones the plan did not touch,
                because "I actually used some of that jar too" is exactly the
                correction this screen exists to allow.
              -->
              @for (lot of lotsFor(line.ingredientId); track lot.id) {
                <div class="draw" [class.untouched]="!drawFor(line.ingredientId, lot.id)">
                  <input
                    class="draw-input"
                    inputmode="decimal"
                    [attr.aria-label]="'Amount used from ' + lotLabel(lot)"
                    [value]="drawFor(line.ingredientId, lot.id)"
                    (input)="onDraw(line.ingredientId, lot.id, $event)"
                    (blur)="commit()"
                    (keydown.enter)="commit()"
                  />
                  <span class="draw-unit muted">{{ lotUnit(lot) }}</span>
                  <span class="grow small">
                    {{ lotLabel(lot) }}
                    @if (unmeasuredIn(line, lot.id)) {
                      <!--
                        Deducted on the cook's word, but not countable towards
                        the need above. Not "left alone", and not zero.
                      -->
                      <span
                        class="pill unknown"
                        [matTooltip]="
                          'This will come out of the pantry as you have said, but it cannot be measured against what the recipe asks for, so it does not count towards the total.'
                        "
                      >
                        counted as unknown
                      </span>
                    }
                  </span>
                </div>
              }

              <!--
                Untouched lots the app could not measure. Distinct from the
                pill above: nothing is being taken from these at all.
              -->
              @for (lot of line.unusableLots; track lot.lotId) {
                <div class="small unusable">
                  <span
                    class="pill unknown"
                    [matTooltip]="
                      'This lot is on the shelf but cannot be compared with what the recipe asks for. It was left untouched.'
                    "
                  >
                    {{ lotName(lot.lotId) }} — could not check
                    <span class="muted">({{ reason(lot.reason) }})</span>
                  </span>
                </div>
              }

              <div class="small muted line-foot">
                @if (line.explicit) {
                  <span>Your amounts.</span>
                  <button mat-button type="button" class="reset" (click)="reset(line.ingredientId)">
                    Let the app choose
                  </button>
                } @else {
                  <span>Soonest expiry first — type over any amount to change it.</span>
                }
              </div>
            </div>
          }

          @if (preview.skipped.length) {
            <div class="line">
              <p class="small muted skip-head">Left alone:</p>
              @for (line of preview.skipped; track line.lineId) {
                <div class="small muted">
                  {{ line.rawText }} — {{ skipReason(line.reason) }}
                </div>
              }
            </div>
          }

          @if (!lines().length) {
            <p class="muted small">
              Nothing on this recipe can be deducted — no line has both an
              ingredient and an amount.
            </p>
          }
        }

        <div class="actions">
          <button
            mat-flat-button
            type="button"
            [disabled]="busy() || loading() || !report()"
            (click)="confirm()"
          >
            <mat-icon>restaurant</mat-icon>
            Cook it
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
    .line {
      padding: .5rem 0;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }
    .line:first-of-type { border-top: none; }
    .amount { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .unusable { margin: .1rem 0 .35rem; }
    .draw {
      display: flex;
      align-items: center;
      gap: .5rem;
      padding: .15rem 0;
    }
    .draw-input {
      width: 5rem;
      padding: .25rem .4rem;
      font: inherit;
      font-variant-numeric: tabular-nums;
      text-align: right;
      color: inherit;
      background: var(--mat-sys-surface);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 4px;
    }
    .draw-input:focus {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -1px;
    }
    /* Dimmed, not hidden: a lot you are taking nothing from is still a lot you
       might have used, and it has to stay reachable. */
    .draw.untouched { opacity: .65; }
    .draw-unit { min-width: 2.5rem; }
    .line-foot {
      display: flex;
      align-items: center;
      gap: .35rem;
      margin-top: .25rem;
    }
    .reset { --mat-button-text-container-height: 1.75rem; font-size: .8rem; }
    .skip-head { margin: 0 0 .15rem; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: .3rem;
      padding: .1rem .5rem;
      border-radius: 999px;
      font-size: .85rem;
    }
    .pill.missing {
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    .pill.unknown { border: 1px dashed var(--mat-sys-outline); }
    /* Neutral, not a warning: using more than the recipe says is normal. */
    .pill.over {
      background: var(--mat-sys-surface-variant);
      color: var(--mat-sys-on-surface-variant);
    }
    .actions { display: flex; gap: .5rem; align-items: center; margin-top: .75rem; }
  `,
})
export class CookConfirmComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  /**
   * Used from TypeScript rather than the template — the expiry date is part of
   * an option's single-line label, not a standalone binding. Takes the app's
   * locale so a date here reads the same as one rendered by `| date`.
   */
  private readonly dates = new DatePipe(inject(LOCALE_ID));

  readonly meal = input.required<PlannedMeal>();

  readonly cooked = output<CookReport>();
  readonly cancelled = output<void>();

  readonly report = signal<CookReport | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal("");

  /**
   * What the cook has typed, per ingredient, per lot — the amounts as strings.
   *
   * An ingredient present here is one the cook has taken over: from that point
   * every lot's amount is theirs, including the ones they left as proposed.
   * Absent, the line is still auto-allocated and the inputs show what the
   * server last planned.
   *
   * Strings all the way through. These are Decimals server-side and parsing
   * them here to add up a total is exactly how 0.33 cups rots.
   */
  private readonly drafts = signal<Record<number, Record<number, string>>>({});

  /** Every lot of every ingredient on this recipe, for the pickers and labels. */
  private readonly lots = signal<PantryLot[]>([]);

  private readonly lotById = computed(
    () => new Map(this.lots().map((lot) => [lot.id, lot])),
  );

  /**
   * The unit catalog, purely for labels.
   *
   * The report's units are `UnitDef`s — what the conversion engine needs, which
   * is id, kind and factor and deliberately not `abbrev` or `plural`. Rendering
   * those directly gave "250 grams" beside a lot picker saying "250 g" in the
   * same panel, so the id is looked up here for display instead.
   */
  private readonly unitById = signal(new Map<number, Unit>());

  /**
   * One row per ingredient, whether it was covered, short, or both.
   *
   * The server reports `deducted` and `shortfalls` as separate lists — right for
   * a machine, wrong on screen, where it rendered the same ingredient twice and
   * read as two. A shortfall belongs to the line it fell short of.
   */
  readonly lines = computed(() => {
    const preview = this.report();
    if (!preview) return [];

    const shortByIngredient = new Map(
      preview.shortfalls.map((short) => [short.ingredientId, short]),
    );

    const rows = preview.deducted.map((line) => {
      const short = shortByIngredient.get(line.ingredientId);
      shortByIngredient.delete(line.ingredientId);
      return {
        ingredientId: line.ingredientId,
        rawText: line.rawText,
        took: line.took,
        needed: line.needed,
        over: line.over,
        unit: line.unit,
        explicit: line.explicit,
        fromLots: line.fromLots,
        // Blank rather than "0 short" when only an unusable lot was reported.
        short: short && Number(short.short) > 0 ? short.short : "",
        unusableLots: short?.unusableLots ?? [],
        unmeasuredLots: short?.unmeasuredLots ?? [],
      };
    });

    // A shortfall with no matching withdrawal should still be seen.
    for (const short of shortByIngredient.values()) {
      rows.push({
        ingredientId: short.ingredientId,
        rawText: short.rawText,
        took: short.got,
        needed: short.wanted,
        over: "",
        unit: short.unit,
        explicit: false,
        fromLots: [],
        short: Number(short.short) > 0 ? short.short : "",
        unusableLots: short.unusableLots,
        unmeasuredLots: short.unmeasuredLots,
      });
    }

    return rows;
  });

  constructor() {
    // Keyed on the meal id rather than run once: the parent may swap one meal
    // for another without destroying this component, and a stale preview would
    // then invite the user to confirm a cook of the wrong recipe.
    let loadedFor: number | null = null;
    effect(() => {
      const meal = this.meal();
      if (meal.id === loadedFor) return;
      loadedFor = meal.id;
      this.drafts.set({});
      this.lots.set([]);
      this.load();
    });

    this.api.units().subscribe({
      next: (units) => this.unitById.set(new Map(units.map((u) => [u.id, u]))),
      error: () => undefined,
    });
  }

  /** Re-asks the server for the split, so the preview is never a local guess. */
  private load(): void {
    this.loading.set(true);
    this.error.set("");

    this.api.previewCookMeal(this.meal().id, { pins: this.pinList() }).subscribe({
      next: (preview) => {
        this.loading.set(false);
        this.report.set(preview);
        this.loadLots(preview);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.error.set(this.message(error));
      },
    });
  }

  /**
   * Loads the lots behind the pickers, once per set of ingredients.
   *
   * Skipped on later previews: the ingredient list does not change when a pin
   * does, and refetching would flicker every picker on every choice.
   */
  private loadLots(preview: CookReport): void {
    if (this.lots().length) return;

    const ids = [
      ...new Set([
        ...preview.deducted.map((line) => line.ingredientId),
        ...preview.shortfalls.map((line) => line.ingredientId),
      ]),
    ];
    if (!ids.length) return;

    for (const ingredientId of ids) {
      // Already ordered expiry-then-id by the API — the same order the
      // deduction itself uses, so the list reads top-down as "next up".
      this.api.pantry({ ingredientId, limit: 100 }).subscribe({
        next: (page) => this.lots.update((all) => [...all, ...page.items]),
        error: () => undefined,
      });
    }
  }

  lotsFor(ingredientId: number): PantryLot[] {
    return this.lots().filter((lot) => lot.ingredient.id === ingredientId);
  }

  /**
   * What the input shows: the cook's own figure once they have taken the line
   * over, otherwise whatever the server last planned to take from that lot.
   *
   * Untouched lots read as "" rather than "0" — a blank box invites a number,
   * where a column of zeroes reads as a form to fill in.
   */
  drawFor(ingredientId: number, lotId: number): string {
    const mine = this.drafts()[ingredientId];
    if (mine) return mine[lotId] ?? "";

    const line = this.lines().find((row) => row.ingredientId === ingredientId);
    const planned = line?.fromLots.find((draw) => draw.lotId === lotId);
    return planned ? trimQuantity(planned.took, 3) : "";
  }

  /**
   * Takes the line over on the first keystroke.
   *
   * The whole proposed split is copied into the draft, not just the box being
   * typed in: the other amounts were the app's suggestion, and once the cook is
   * stating what happened those figures become theirs to keep or change. Losing
   * them instead would silently zero every lot they did not touch.
   */
  onDraw(ingredientId: number, lotId: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;

    this.drafts.update((current) => {
      const existing = current[ingredientId] ?? this.plannedDraws(ingredientId);
      return { ...current, [ingredientId]: { ...existing, [lotId]: value } };
    });
  }

  /** Hands the line back to auto-allocation. */
  reset(ingredientId: number): void {
    this.drafts.update((current) => {
      const next = { ...current };
      delete next[ingredientId];
      return next;
    });
    this.load();
  }

  /**
   * Re-asks the server on blur, not per keystroke.
   *
   * A quantity is entered, not typed at — previewing mid-number would show a
   * split for "1" on the way to "150". Same reason the shopping list commits
   * its quantities on blur.
   */
  commit(): void {
    this.load();
  }

  private plannedDraws(ingredientId: number): Record<number, string> {
    const line = this.lines().find((row) => row.ingredientId === ingredientId);
    const seeded: Record<number, string> = {};
    for (const draw of line?.fromLots ?? []) {
      seeded[draw.lotId] = trimQuantity(draw.took, 3);
    }
    return seeded;
  }

  /** Was this lot deducted but left uncountable? */
  unmeasuredIn(line: { unmeasuredLots: UnmeasuredLot[] }, lotId: number): boolean {
    return line.unmeasuredLots.some((entry) => entry.lotId === lotId);
  }

  /**
   * The draws to send. Blank and zero boxes are dropped rather than sent as
   * zero — the server treats them the same, but a request that says only what
   * was used is easier to read in a log than one listing every empty jar.
   */
  private pinList(): CookPin[] {
    return Object.entries(this.drafts()).map(([ingredientId, byLot]) => ({
      ingredientId: Number(ingredientId),
      draws: Object.entries(byLot)
        .filter(([, quantity]) => quantity.trim() !== "" && Number(quantity) > 0)
        .map(([lotId, quantity]) => ({ lotId: Number(lotId), quantity: quantity.trim() })),
    }));
  }

  confirm(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set("");

    this.api.cookMeal(this.meal().id, { pins: this.pinList() }).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.cooked.emit(result);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.error.set(this.message(error));
      },
    });
  }

  lotLabel(lot: PantryLot): string {
    const parts = [amountWithUnit(lot.quantity, lot.unit)];
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

  /** The unit an amount typed against this lot is measured in. */
  lotUnit(lot: PantryLot): string {
    return unitLabel(lot.unit, lot.quantity);
  }

  /** A lot named well enough to recognise on the shelf, even once it is gone. */
  lotName(lotId: number): string {
    const lot = this.lotById().get(lotId);
    if (!lot) return `lot ${lotId}`;
    const label = lot.brand ?? lot.product?.brands ?? lot.location.name;
    return `${label} (${unitLabel(lot.unit, lot.quantity)})`;
  }

  /** Rendered through the catalog unit so "250 g" does not read "250 grams". */
  amount(quantity: string, unit: { id: number; name: string }): string {
    return amountWithUnit(quantity, this.unitById().get(unit.id) ?? unit);
  }

  round(quantity: string): string {
    return trimQuantity(quantity, 3);
  }

  skipReason(reason: string): string {
    return SKIP_REASON[reason] ?? reason.toLowerCase().replace(/_/g, " ");
  }

  reason(reason: string): string {
    return UNUSABLE_REASON[reason] ?? reason.toLowerCase().replace(/_/g, " ");
  }

  /** Surfaces the server's own message — a stale pin explains itself there. */
  private message(error: unknown): string {
    const body = (error as { error?: { message?: string | string[] } }).error;
    const message = body?.message;
    if (Array.isArray(message)) return message.join(" ");
    if (typeof message === "string") return message;
    return "Could not work out what that would take.";
  }
}
