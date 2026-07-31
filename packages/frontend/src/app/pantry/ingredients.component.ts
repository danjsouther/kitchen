import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
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
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [
    FormsModule,
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
                [(ngModel)]="query"
                (ngModelChange)="search()"
                name="q"
                placeholder="flour, yogurt, onion…"
                autocomplete="off"
              />
              <mat-icon matSuffix>search</mat-icon>
            </mat-form-field>

            <mat-form-field appearance="outline" class="cat">
              <mat-label>Category</mat-label>
              <mat-select [(ngModel)]="categoryId" (ngModelChange)="search()" name="cat">
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
              <input matInput [(ngModel)]="draftName" name="new-name" />
            </mat-form-field>
            <div class="actions">
              <button mat-flat-button (click)="create()" [disabled]="!draftName.trim() || busy()">
                Create
              </button>
              <button mat-button (click)="creating.set(false)">Cancel</button>
            </div>
          </mat-card-content>
        </mat-card>
      }

      @if (!loading() && results().length === 0 && query.length >= 2) {
        <p class="empty muted">Nothing matched “{{ query }}”.</p>
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

                <div class="grid">
                  <mat-form-field appearance="outline">
                    <mat-label>Name</mat-label>
                    <input matInput [(ngModel)]="form.name" name="name" />
                  </mat-form-field>

                  <mat-form-field appearance="outline">
                    <mat-label>Category</mat-label>
                    <mat-select [(ngModel)]="form.categoryId" name="categoryId">
                      @for (category of categories(); track category.id) {
                        <mat-option [value]="category.id">{{ category.name }}</mat-option>
                      }
                    </mat-select>
                  </mat-form-field>

                  <mat-form-field appearance="outline">
                    <mat-label>Usual unit</mat-label>
                    <mat-select [(ngModel)]="form.defaultUnitId" name="defaultUnitId">
                      @for (unit of units(); track unit.id) {
                        <mat-option [value]="unit.id">{{ unit.name }}</mat-option>
                      }
                    </mat-select>
                  </mat-form-field>

                  <mat-form-field appearance="outline">
                    <mat-label>Density (g per ml)</mat-label>
                    <input matInput [(ngModel)]="form.gramsPerMl" name="gramsPerMl" inputmode="decimal" />
                    <mat-hint>Lets cups and grams be compared. Water is 1.</mat-hint>
                  </mat-form-field>

                  <mat-form-field appearance="outline">
                    <mat-label>Weight of one (g)</mat-label>
                    <input matInput [(ngModel)]="form.gramsPerPiece" name="gramsPerPiece" inputmode="decimal" />
                    <mat-hint>One egg ≈ 50, one onion ≈ 150.</mat-hint>
                  </mat-form-field>

                  <mat-form-field appearance="outline">
                    <mat-label>Keeps for (days)</mat-label>
                    <input matInput type="number" min="1" [(ngModel)]="form.shelfLifeDays" name="shelfLifeDays" />
                    <mat-hint>Suggests an expiry when stocking.</mat-hint>
                  </mat-form-field>
                </div>

                <mat-form-field appearance="outline" class="full">
                  <mat-label>Note</mat-label>
                  <input matInput [(ngModel)]="form.note" name="note" />
                </mat-form-field>

                <div class="actions">
                  <button mat-flat-button (click)="save(item)" [disabled]="busy()">
                    <mat-icon>save</mat-icon>
                    {{ item.householdId === null ? "Save a private copy" : "Save" }}
                  </button>
                  <button mat-button (click)="editingId.set(null)">Cancel</button>
                </div>
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

  query = "";
  categoryId: number | null = null;
  draftName = "";

  form: IngredientWrite = {};

  private searchToken = 0;

  constructor() {
    this.api.categories().subscribe({ next: (c) => this.categories.set(c) });
    this.api.units().subscribe({ next: (u) => this.units.set(u) });

    // After inputs are bound, so an inbound ?q= is honoured on first load.
    //
    // The ?? "" is load-bearing: when the query parameter is absent the router
    // binds the input as undefined, which overrides input()'s own default and
    // leaves `query` undefined for every later .trim().
    queueMicrotask(() => {
      this.query = this.q() ?? "";
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
    const q = (this.query ?? "").trim();

    this.api.searchIngredients(q, 40, this.categoryId ?? undefined).subscribe({
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
    this.form = {
      name: item.name,
      categoryId: item.categoryId ?? undefined,
      defaultUnitId: item.defaultUnitId ?? undefined,
      gramsPerMl: item.gramsPerMl ?? undefined,
      gramsPerPiece: item.gramsPerPiece ?? undefined,
      shelfLifeDays: item.shelfLifeDays ?? undefined,
      note: item.note ?? undefined,
    };
    this.editingId.set(item.id);
  }

  startCreate(): void {
    this.draftName = this.query.trim();
    this.creating.set(true);
  }

  create(): void {
    const name = this.draftName.trim();
    if (!name) return;
    this.busy.set(true);

    this.api.createIngredient({ name }).subscribe({
      next: (created) => {
        this.busy.set(false);
        this.creating.set(false);
        this.notify.success(`Added ${created.name}. Fill in its density next.`);
        this.query = created.name;
        this.search();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not create that ingredient.");
      },
    });
  }

  save(item: Ingredient): void {
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
   * Drops empty fields rather than sending them.
   *
   * An empty string would fail the backend's IsNumberString check, and sending
   * a blank density is not how you clear one anyway — the API treats an absent
   * field as "leave alone".
   */
  private clean(): IngredientWrite {
    const out: IngredientWrite = {};
    const form = this.form;

    if (form.name?.trim()) out.name = form.name.trim();
    if (form.categoryId) out.categoryId = Number(form.categoryId);
    if (form.defaultUnitId) out.defaultUnitId = Number(form.defaultUnitId);
    if (String(form.gramsPerMl ?? "").trim()) out.gramsPerMl = String(form.gramsPerMl).trim();
    if (String(form.gramsPerPiece ?? "").trim()) {
      out.gramsPerPiece = String(form.gramsPerPiece).trim();
    }
    if (form.shelfLifeDays) out.shelfLifeDays = Number(form.shelfLifeDays);
    if (form.note?.trim()) out.note = form.note.trim();

    return out;
  }
}
