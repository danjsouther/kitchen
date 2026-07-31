import { Component,
  effect,
  inject,
  input,
  linkedSignal,
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
import { firstValueFrom } from "rxjs";
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
import type {
  Ingredient,
  IngredientCategory,
  IngredientWrite,
  Unit,
} from "../core/models";

/**
 * Catalog admin: the screen that turns "not countable" into a number.
 *
 * Everything else in the app leans on the physical data edited here. Without a
 * density the app cannot add 200 ml of yogurt to 150 g of yogurt; without a
 * piece weight it cannot tell whether three onions covers a recipe asking for
 * 400 g. Until this screen existed those gaps were visible but unfixable, which
 * is why it is worth more than it looks.
 *
 * Seeded ingredients are shared by every household and are not editable in
 * place. Editing one forks a private copy first (POST /ingredients/:id/customize)
 * so one household cannot redefine "flour" for everybody.
 */
@Component({
  selector: "app-ingredients",
  imports: [
    FormField,
    FormRoot,
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
        <div>
          <h1>Ingredients</h1>
          <div class="muted small">
            Densities and item weights live here. They are what let the app compare a
            recipe's cups with the pantry's grams.
          </div>
        </div>
      </div>

      <mat-card class="finder">
        <mat-card-content>
          <div class="row">
            <mat-form-field appearance="outline" class="grow">
              <mat-label>Search the catalog</mat-label>
              <input
                matInput
                [value]="query()"
                (input)="query.set($any($event.target).value)"
                placeholder="flour, yogurt, onion…"
                autocomplete="off"
              />
              <mat-icon matSuffix>search</mat-icon>
            </mat-form-field>

            <mat-form-field appearance="outline" class="cat">
              <mat-label>Category</mat-label>
              <mat-select
                [value]="categoryId()"
                (valueChange)="categoryId.set($event)"
              >
                <mat-option [value]="null">Any</mat-option>
                @for (category of categories(); track category.id) {
                  <mat-option [value]="category.id">{{ category.name }}</mat-option>
                }
              </mat-select>
            </mat-form-field>

            <button mat-stroked-button (click)="startCreate()">
              <mat-icon>add</mat-icon>
              New
            </button>
          </div>

          @if (loading()) {
            <mat-progress-bar mode="indeterminate" />
          }
        </mat-card-content>
      </mat-card>

      @if (creating()) {
        <mat-card class="editor">
          <mat-card-content>
            <h2>New ingredient</h2>
            <mat-form-field appearance="outline" class="full">
              <mat-label>Name</mat-label>
              <input
                matInput
                [value]="draftName()"
                (input)="draftName.set($any($event.target).value)"
              />
            </mat-form-field>
            <div class="actions">
              <button mat-flat-button (click)="create()" [disabled]="!draftName().trim() || busy()">
                Create
              </button>
              <button mat-button (click)="creating.set(false)">Cancel</button>
            </div>
          </mat-card-content>
        </mat-card>
      }

      @if (!loading() && results().length === 0 && query().length >= 2) {
        <p class="empty muted">Nothing matched “{{ query() }}”.</p>
      }

      @for (item of results(); track item.id) {
        <mat-card class="item">
          <mat-card-content>
            <div class="row head" (click)="toggle(item)">
              <div class="grow">
                <strong>{{ item.name }}</strong>
                @if (item.householdId === null) {
                  <span
                    class="pill shared"
                    matTooltip="From the shared catalog. Editing it makes a private copy for your household first."
                    >shared</span
                  >
                } @else {
                  <span class="pill own">yours</span>
                }
                <div class="muted small facts">{{ summarise(item) }}</div>
              </div>
              <mat-icon>{{ editingId() === item.id ? "expand_less" : "expand_more" }}</mat-icon>
            </div>

            @if (editingId() === item.id) {
              <div class="editor-body">
                @if (item.householdId === null) {
                  <p class="notice small">
                    <mat-icon class="tiny">info</mat-icon>
                    Saving will create your household's own copy of this ingredient. The
                    shared one is left alone.
                  </p>
                }

                <form [formRoot]="editForm" (submit)="save($event, item)">
                  <div class="grid">
                    <mat-form-field appearance="outline">
                      <mat-label>Name</mat-label>
                      <input matInput [formField]="editForm.name" />
                      @if (firstError(editForm.name()); as message) {
                        <mat-error>{{ message }}</mat-error>
                      }
                    </mat-form-field>

                    <mat-form-field appearance="outline">
                      <mat-label>Category</mat-label>
                      <mat-select [formField]="editForm.categoryId">
                        @for (category of categories(); track category.id) {
                          <mat-option [value]="category.id">{{ category.name }}</mat-option>
                        }
                      </mat-select>
                    </mat-form-field>

                    <mat-form-field appearance="outline">
                      <mat-label>Usual unit</mat-label>
                      <mat-select [formField]="editForm.defaultUnitId">
                        @for (unit of units(); track unit.id) {
                          <mat-option [value]="unit.id">{{ unit.name }}</mat-option>
                        }
                      </mat-select>
                    </mat-form-field>

                    <mat-form-field appearance="outline">
                      <mat-label>Density (g per ml)</mat-label>
                      <input matInput [formField]="editForm.gramsPerMl" inputmode="decimal" />
                      @if (firstError(editForm.gramsPerMl()); as message) {
                        <mat-error>{{ message }}</mat-error>
                      } @else {
                        <mat-hint>
                          Lets cups and grams be compared. Water is 1; empty
                          means unknown.
                        </mat-hint>
                      }
                    </mat-form-field>

                    <mat-form-field appearance="outline">
                      <mat-label>Weight of one (g)</mat-label>
                      <input matInput [formField]="editForm.gramsPerPiece" inputmode="decimal" />
                      @if (firstError(editForm.gramsPerPiece()); as message) {
                        <mat-error>{{ message }}</mat-error>
                      } @else {
                        <mat-hint>
                          One egg ≈ 50, one onion ≈ 150; empty means unknown.
                        </mat-hint>
                      }
                    </mat-form-field>

                    <mat-form-field appearance="outline">
                      <mat-label>Keeps for (days)</mat-label>
                      <input matInput type="number" [formField]="editForm.shelfLifeDays" />
                      @if (firstError(editForm.shelfLifeDays()); as message) {
                        <mat-error>{{ message }}</mat-error>
                      } @else {
                        <mat-hint>Suggests an expiry when stocking.</mat-hint>
                      }
                    </mat-form-field>
                  </div>

                  <mat-form-field appearance="outline" class="full">
                    <mat-label>Note</mat-label>
                    <input matInput [formField]="editForm.note" />
                  </mat-form-field>

                  <div class="actions">
                    <button mat-flat-button type="submit" [disabled]="busy()">
                      <mat-icon>save</mat-icon>
                      {{ item.householdId === null ? "Save a private copy" : "Save" }}
                    </button>
                    <button mat-button type="button" (click)="editingId.set(null)">Cancel</button>
                  </div>
                </form>
              </div>
            }
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  styles: `
    h1 { margin: 0; font-size: 1.4rem; }
    h2 { font-size: 1rem; font-weight: 500; margin: 0 0 .5rem; }
    .small { font-size: .85rem; }
    .finder { margin-bottom: 1rem; }
    .cat { min-width: 10rem; }
    .item { margin-bottom: .4rem; }
    .head { cursor: pointer; align-items: flex-start; }
    .facts { margin-top: .15rem; }
    .editor-body { margin-top: .75rem; }
    .editor { margin-bottom: 1rem; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
      gap: .5rem 1rem;
    }
    .full { width: 100%; }
    .actions { display: flex; gap: .5rem; margin-top: .5rem; }
    .pill {
      margin-left: .5rem;
      padding: .1rem .5rem;
      border-radius: 999px;
      font-size: .75rem;
      vertical-align: middle;
    }
    .pill.shared { background: var(--mat-sys-surface-container-highest); }
    .pill.own { background: var(--mat-sys-tertiary-container); }
    .notice {
      display: flex;
      gap: .4rem;
      align-items: center;
      background: var(--mat-sys-surface-container-high);
      padding: .5rem .75rem;
      border-radius: .5rem;
      margin: 0 0 .75rem;
    }
    .tiny { font-size: 1rem; width: 1rem; height: 1rem; }
  `,
})
export class IngredientsComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  readonly results = signal<Ingredient[]>([]);
  readonly categories = signal<IngredientCategory[]>([]);
  readonly units = signal<Unit[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly editingId = signal<number | null>(null);
  readonly creating = signal(false);

  /**
   * Bound from the `?q=` query parameter by withComponentInputBinding().
   *
   * This is how the pantry's "Fix" link arrives: it carries the name of the
   * ingredient whose missing density caused a balance to read "not countable",
   * so the user lands on the row they need rather than an empty search box.
   */
  readonly q = input("");

  /**
   * The search box, seeded from ?q= but freely editable afterwards.
   *
   * linkedSignal rather than a one-time copy: the router reuses this component
   * across navigations within the same route, so arriving at ?q=flour from
   * ?q=yogurt would otherwise leave the old term in the box.
   *
   * The ?? "" is load-bearing. When the parameter is absent the router binds
   * the input as undefined, which overrides input()'s own default — so without
   * it `query` is undefined and every later .trim() throws.
   */
  readonly query = linkedSignal(() => this.q() ?? "");

  /** Filters, not form data — plain signals rather than a form. */
  readonly categoryId = signal<number | null>(null);
  readonly draftName = signal("");

  /**
   * The editor model. Every physical value is a string, matching how it crosses
   * the wire: these are Decimals server-side, and parsing them to numbers here
   * to satisfy a number input is exactly how a density like 0.53 rots.
   *
   * Empty string means "not set", never null — Signal Forms needs a non-null
   * initial value, and an empty field is dropped rather than sent on save.
   */
  private readonly editModel = signal({
    name: "",
    categoryId: 0,
    defaultUnitId: 0,
    gramsPerMl: "",
    gramsPerPiece: "",
    shelfLifeDays: "",
    note: "",
  });

  readonly editForm = form(this.editModel, (path) => {
    required(path.name, { message: "A name is required." });

    // Optional, but if given it must be a positive number. A density of 0 or a
    // stray letter would not fail loudly later — it would quietly make every
    // conversion for this ingredient wrong.
    validate(path.gramsPerMl, ({ value }) => decimalRule(value(), "Density"));
    validate(path.gramsPerPiece, ({ value }) => decimalRule(value(), "Weight"));

    validate(path.shelfLifeDays, ({ value }) => {
      const raw = value().trim();
      if (raw === "") return undefined;
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        return { kind: "notWholeDays", message: "Whole days, 1 or more." };
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

  private searchToken = 0;

  constructor() {
    this.api.categories().subscribe({ next: (c) => this.categories.set(c) });
    this.api.units().subscribe({ next: (u) => this.units.set(u) });

    // Re-runs whenever the search term changes, including when an inbound ?q=
    // resets it. Reading a signal and firing a request is a genuine side
    // effect, which is what effect() is for — it is not deriving state.
    effect(() => {
      this.query();
      this.search();
    });
  }

  /** A one-line description of what the app does and does not know about this. */
  summarise(item: Ingredient): string {
    const known: string[] = [];
    const missing: string[] = [];

    if (item.gramsPerMl) known.push(`${item.gramsPerMl} g/ml`);
    else missing.push("no density");

    if (item.gramsPerPiece) known.push(`${item.gramsPerPiece} g each`);
    else missing.push("no item weight");

    if (item.shelfLifeDays) known.push(`keeps ${item.shelfLifeDays} days`);

    // Missing data is named rather than left blank: a blank row reads as "fine",
    // and the whole point of this screen is to show what still needs filling in.
    return [...known, ...missing].join(" · ");
  }

  search(): void {
    const token = ++this.searchToken;
    this.loading.set(true);
    const q = this.query().trim();

    this.api.searchIngredients(q, 40, this.categoryId() ?? undefined).subscribe({
      next: (items) => {
        // Ignore a response that a later search has already superseded.
        if (token !== this.searchToken) return;
        this.results.set(items);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        if (token !== this.searchToken) return;
        this.loading.set(false);
        this.notify.error(error, "Could not search the catalog.");
      },
    });
  }

  toggle(item: Ingredient): void {
    if (this.editingId() === item.id) {
      this.editingId.set(null);
      return;
    }
    // Seed the form from the row. Numbers stay strings so a density is never
    // routed through a float on its way back to a Decimal column.
    this.editModel.set({
      name: item.name,
      categoryId: item.categoryId ?? 0,
      defaultUnitId: item.defaultUnitId ?? 0,
      gramsPerMl: item.gramsPerMl ?? "",
      gramsPerPiece: item.gramsPerPiece ?? "",
      shelfLifeDays: item.shelfLifeDays === null ? "" : String(item.shelfLifeDays),
      note: item.note ?? "",
    });
    // Clears touched/dirty with the value, so a freshly opened editor does not
    // open already showing errors from the last one.
    this.editForm().reset();
    this.editingId.set(item.id);
  }

  startCreate(): void {
    this.draftName.set(this.query().trim());
    this.creating.set(true);
  }

  create(): void {
    const name = this.draftName().trim();
    if (!name) return;
    this.busy.set(true);

    this.api.createIngredient({ name }).subscribe({
      next: (created) => {
        this.busy.set(false);
        this.creating.set(false);
        this.notify.success(`Added ${created.name}. Fill in its density next.`);
        this.query.set(created.name);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not create that ingredient.");
      },
    });
  }

  save(event: Event, item: Ingredient): void {
    event.preventDefault();
    if (this.busy()) return;
    this.editForm().markAsTouched();
    if (this.editForm().invalid()) return;

    this.busy.set(true);

    // A shared ingredient is forked first: the PATCH must land on a row this
    // household owns, or the tenancy layer will (correctly) refuse it.
    const target =
      item.householdId === null
        ? this.api.customizeIngredient(item.id)
        : this.api.ingredient(item.id);

    target.subscribe({
      next: (owned) => this.applyUpdate(owned.id, item.householdId === null),
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not prepare that ingredient for editing.");
      },
    });
  }

  private applyUpdate(id: number, forked: boolean): void {
    this.api.updateIngredient(id, this.clean()).subscribe({
      next: (saved) => {
        this.busy.set(false);
        this.editingId.set(null);
        this.notify.success(
          forked ? `Saved your household's copy of ${saved.name}.` : `Saved ${saved.name}.`,
        );
        this.search();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not save that ingredient.");
      },
    });
  }

  /**
   * The whole form as a payload, with emptied fields sent as **null**.
   *
   * Null rather than omitted, because this is a full editor: the fields on
   * screen are the ingredient's whole physical description, so a box the user
   * emptied is a statement — "this has no density" — and omitting it would
   * quietly mean "leave the old one", which is how a wrong density used to
   * become permanent.
   *
   * An empty string would not do: the API validates a supplied density with
   * IsNumberString and would reject it. Null is the value that carries the
   * meaning, and the API reads it as such.
   */
  private clean(): IngredientWrite {
    const form = this.editModel();

    return {
      name: form.name.trim(),
      // 0 is the "nothing chosen" sentinel the selects use, since Signal Forms
      // will not hold a null; it maps back to null on the way out.
      categoryId: form.categoryId ? Number(form.categoryId) : null,
      defaultUnitId: form.defaultUnitId ? Number(form.defaultUnitId) : null,
      gramsPerMl: form.gramsPerMl.trim() || null,
      gramsPerPiece: form.gramsPerPiece.trim() || null,
      shelfLifeDays: form.shelfLifeDays.trim()
        ? Number(form.shelfLifeDays.trim())
        : null,
      note: form.note.trim() || null,
    };
  }
}

/**
 * An optional positive decimal, validated as a string.
 *
 * Shared by density and item weight because they fail the same way: a blank is
 * fine and means "unknown", but a zero or a stray letter would be accepted
 * silently and then quietly poison every conversion for that ingredient.
 */
function decimalRule(
  raw: string,
  label: string,
): { kind: string; message: string } | undefined {
  const value = raw.trim();
  if (value === "") return undefined;
  if (!/^\d*\.?\d+$/.test(value)) {
    return { kind: "notANumber", message: `${label} must be a number.` };
  }
  if (Number(value) <= 0) {
    return { kind: "notPositive", message: `${label} must be more than zero.` };
  }
  return undefined;
}
