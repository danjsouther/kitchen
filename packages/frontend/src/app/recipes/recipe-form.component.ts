import { Component,
  computed,
  inject,
  input,
  signal,
} from "@angular/core";
import {
  FormField,
  FormRoot,
  applyEach,
  form,
  max,
  maxLength,
  min,
  required,
  submit,
  validate,
} from "@angular/forms/signals";
import { Router, RouterLink } from "@angular/router";
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
import { IngredientPickerComponent } from "../shared/ingredient-picker.component";
import { amountWithUnit, withoutLeadingAmount } from "../shared/format";
import type { Ingredient, RecipeWrite, Unit } from "../core/models";

/** One ingredient line as the form holds it, before it becomes a payload. */
interface IngredientRow {
  /** 0 when nothing in the catalog was chosen — the line still saves as text. */
  ingredientId: number;
  name: string;
  quantity: string;
  /** 0 for "no unit": "2 eggs", "salt to taste". */
  unitId: number;
  preparation: string;
  optional: boolean;
  /**
   * The line exactly as it is already stored, empty on a new row.
   *
   * On the paste path this is the cook's original wording and the only record
   * of what was meant, so an edit must not casually rewrite it.
   */
  rawText: string;
  /** The name as seeded, so "the cook renamed this" is a fact, not a guess. */
  seedName: string;
  /**
   * The amount as seeded, for the same reason as `seedName`.
   *
   * An unmatched line carries its amount only inside `rawText`, so a changed
   * quantity or unit has to be recomposed into the wording or it never reaches
   * the screen. See `lineText`.
   */
  seedQuantity: string;
  seedUnitId: number;
}

interface StepRow {
  text: string;
}

function blankIngredient(): IngredientRow {
  return {
    ingredientId: 0,
    name: "",
    quantity: "",
    unitId: 0,
    preparation: "",
    optional: false,
    rawText: "",
    seedName: "",
    seedQuantity: "",
    seedUnitId: 0,
  };
}

/**
 * Writes a recipe by hand, for the ones that never existed as text to paste —
 * a family card, something worked out at the stove — and edits one already
 * saved, at `/recipes/:id/edit`.
 *
 * One component for both because they are the same form over the same payload:
 * `PATCH` replaces ingredients, steps and tags wholesale, exactly as `POST`
 * writes them, so the only real differences are where the model starts and
 * which method the save calls.
 *
 * The catalog link per line is optional on purpose. An unmatched line keeps its
 * text and simply sits out of pantry maths, which is the same contract the
 * paste-and-parse screen honours; forcing every line into the catalog would
 * either block the save or quietly fill the catalog with one-offs.
 */
@Component({
  selector: "app-recipe-form",
  imports: [
    FormField,
    FormRoot,
    IngredientPickerComponent,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>{{ editing() ? "Edit recipe" : "New recipe" }}</h1>
        @if (!editing()) {
          <a mat-stroked-button routerLink="/recipes/import">
            <mat-icon>content_paste</mat-icon>
            Paste one instead
          </a>
        }
      </div>

      @if (loading()) {
        <mat-progress-bar mode="indeterminate" />
      }

      <form [formRoot]="recipeForm" (submit)="save($event)">
        <mat-card>
          <mat-card-content>
            <mat-form-field appearance="outline" class="full">
              <mat-label>Title</mat-label>
              <input matInput [formField]="recipeForm.title" />
              @if (firstError(recipeForm.title()); as message) {
                <mat-error>{{ message }}</mat-error>
              }
            </mat-form-field>

            <mat-form-field appearance="outline" class="full">
              <mat-label>Description</mat-label>
              <textarea
                matInput
                rows="2"
                [formField]="recipeForm.description"
              ></textarea>
            </mat-form-field>

            <div class="grid">
              <mat-form-field appearance="outline">
                <mat-label>Serves</mat-label>
                <input matInput type="number" [formField]="recipeForm.servings" />
                <mat-hint>Everything scales from this.</mat-hint>
                @if (firstError(recipeForm.servings()); as message) {
                  <mat-error>{{ message }}</mat-error>
                }
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Prep (minutes)</mat-label>
                <input
                  matInput
                  type="number"
                  [formField]="recipeForm.prepMinutes"
                />
                @if (firstError(recipeForm.prepMinutes()); as message) {
                  <mat-error>{{ message }}</mat-error>
                }
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Cook (minutes)</mat-label>
                <input
                  matInput
                  type="number"
                  [formField]="recipeForm.cookMinutes"
                />
                @if (firstError(recipeForm.cookMinutes()); as message) {
                  <mat-error>{{ message }}</mat-error>
                }
              </mat-form-field>
            </div>
          </mat-card-content>
        </mat-card>

        <h2>Ingredients</h2>
        <p class="muted small">
          Pick from the catalog where you can — a matched line is what lets the
          pantry, the shopping list and “what can I cook” count it. A line that
          matches nothing still saves, it just does not take part in that.
        </p>
        <!--
          The rule that at least one line is needed lives on the array, which is
          not a form field and so has no <mat-error> of its own. Without this it
          would refuse to save with nothing on screen.
        -->
        @if (firstError(recipeForm.ingredients()); as message) {
          <p class="warn-text small" role="alert">{{ message }}</p>
        }

        @for (row of recipeForm.ingredients; track $index) {
          <mat-card class="line">
            <mat-card-content class="line-grid">
              <app-ingredient-picker
                class="who"
                label="Ingredient"
                [allowCreate]="true"
                [initialText]="rows()[$index].name"
                (picked)="onPicked($index, $event)"
                (createRequested)="onCreate($index, $event)"
                (textChanged)="onTyped($index, $event)"
              />

              <mat-form-field appearance="outline" class="qty">
                <mat-label>Amount</mat-label>
                <input matInput inputmode="decimal" [formField]="row.quantity" />
                @if (firstError(row.quantity()); as message) {
                  <mat-error>{{ message }}</mat-error>
                }
              </mat-form-field>

              <mat-form-field appearance="outline" class="unit">
                <mat-label>Unit</mat-label>
                <mat-select [formField]="row.unitId">
                  <mat-option [value]="0">none</mat-option>
                  @for (unit of units(); track unit.id) {
                    <mat-option [value]="unit.id">{{ unit.name }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>

              <mat-form-field appearance="outline" class="prep">
                <mat-label>Preparation</mat-label>
                <input matInput [formField]="row.preparation" />
                <mat-hint>finely chopped, at room temperature</mat-hint>
              </mat-form-field>

              <div class="row-actions">
                <!--
                  A native checkbox, not <mat-checkbox>: it compiles either way,
                  but Signal Forms rejects the Material one at runtime with
                  NG01914 — [formField] needs a real form control host.
                -->
                <label class="optional">
                  <input type="checkbox" [formField]="row.optional" />
                  Optional
                </label>
                <button
                  mat-icon-button
                  type="button"
                  aria-label="Remove this ingredient"
                  (click)="removeIngredient($index)"
                >
                  <mat-icon>close</mat-icon>
                </button>
              </div>

              @if (firstError(row.name()); as message) {
                <p class="warn-text small picker-error" role="alert">
                  {{ message }}
                </p>
              }
            </mat-card-content>
          </mat-card>
        }

        <button mat-stroked-button type="button" (click)="addIngredient()">
          <mat-icon>add</mat-icon>
          Add an ingredient
        </button>

        <h2>Method</h2>
        @for (step of recipeForm.steps; track $index) {
          <div class="step">
            <span class="step-number">{{ $index + 1 }}</span>
            <mat-form-field appearance="outline" class="grow">
              <mat-label>Step {{ $index + 1 }}</mat-label>
              <textarea matInput rows="2" [formField]="step.text"></textarea>
              @if (firstError(step.text()); as message) {
                <mat-error>{{ message }}</mat-error>
              }
            </mat-form-field>
            <button
              mat-icon-button
              type="button"
              aria-label="Remove this step"
              (click)="removeStep($index)"
            >
              <mat-icon>close</mat-icon>
            </button>
          </div>
        }

        <button mat-stroked-button type="button" (click)="addStep()">
          <mat-icon>add</mat-icon>
          Add a step
        </button>

        <h2>Where it came from</h2>
        <mat-card>
          <mat-card-content>
            <div class="grid">
              <mat-form-field appearance="outline">
                <mat-label>Source note</mat-label>
                <input matInput [formField]="recipeForm.sourceNote" />
                <mat-hint>Grandma's card, Bittman p.212</mat-hint>
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Link</mat-label>
                <input matInput [formField]="recipeForm.sourceUrl" />
                @if (firstError(recipeForm.sourceUrl()); as message) {
                  <mat-error>{{ message }}</mat-error>
                }
              </mat-form-field>

              <mat-form-field appearance="outline">
                <mat-label>Tags</mat-label>
                <input matInput [formField]="recipeForm.tags" />
                <mat-hint>Comma separated: weeknight, vegetarian</mat-hint>
              </mat-form-field>
            </div>

            <mat-form-field appearance="outline" class="full">
              <mat-label>Notes</mat-label>
              <textarea matInput rows="3" [formField]="recipeForm.notes"></textarea>
            </mat-form-field>
          </mat-card-content>
        </mat-card>

        @if (error()) {
          <p class="warn-text" role="alert">{{ error() }}</p>
        }

        <div class="actions">
          <button mat-flat-button type="submit" [disabled]="busy() || loading()">
            <mat-icon>save</mat-icon>
            {{ editing() ? "Save changes" : "Save recipe" }}
          </button>
          @if (editing()) {
            <a mat-button [routerLink]="['/recipes', id()]">Cancel</a>
          } @else {
            <a mat-button routerLink="/recipes">Cancel</a>
          }
        </div>
      </form>
    </div>
  `,
  styles: `
    h2 {
      font-size: 1.1rem;
      font-weight: 500;
      margin: 1.5rem 0 0.25rem;
    }
    .small {
      font-size: 0.85rem;
    }
    .full {
      width: 100%;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
      gap: 0.25rem 1rem;
    }
    .line {
      margin-bottom: 0.5rem;
    }
    .line-grid {
      display: grid;
      grid-template-columns: minmax(12rem, 2fr) 6rem 8rem minmax(10rem, 1fr) auto;
      gap: 0 0.75rem;
      align-items: start;
      padding-bottom: 0.25rem;
    }
    @media (max-width: 900px) {
      .line-grid {
        grid-template-columns: 1fr 1fr;
      }
      .who,
      .prep {
        grid-column: 1 / -1;
      }
    }
    .row-actions {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding-top: 1rem;
    }
    .optional {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.85rem;
      color: var(--mat-sys-on-surface-variant);
      white-space: nowrap;
      cursor: pointer;
    }
    .picker-error {
      grid-column: 1 / -1;
      margin: -0.5rem 0 0.5rem;
    }
    .step {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
    }
    .step-number {
      padding-top: 1.15rem;
      min-width: 1.2rem;
      text-align: right;
      color: var(--mat-sys-on-surface-variant);
    }
    .grow {
      flex: 1;
    }
    .actions {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-top: 1.5rem;
    }
  `,
})
export class RecipeFormComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly router = inject(Router);

  /**
   * The recipe being edited, bound from the route by `withComponentInputBinding`.
   *
   * Typed as possibly undefined, and read through `?? ""`, because that is what
   * actually arrives on `/recipes/new`: a route with no `:id` binds the input to
   * `undefined` rather than leaving the declared default in place. A default of
   * `""` here compiles, types as `string`, and then threw on `.trim()` — which
   * rendered the new-recipe screen blank with only a console error to show for
   * it.
   */
  readonly id = input<string | undefined>(undefined);
  readonly editing = computed(() => (this.id() ?? "").trim() !== "");

  readonly units = signal<Unit[]>([]);
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly error = signal("");

  /**
   * Ids are 0 rather than null where nothing is chosen, and every text field
   * starts as "" — Signal Forms requires non-null initial values throughout.
   */
  private readonly model = signal({
    title: "",
    description: "",
    servings: 4,
    prepMinutes: 0,
    cookMinutes: 0,
    sourceNote: "",
    sourceUrl: "",
    notes: "",
    tags: "",
    ingredients: [blankIngredient()] as IngredientRow[],
    steps: [{ text: "" }] as StepRow[],
  });

  /** The ingredient rows as values, for the pickers' text. */
  readonly rows = computed(() => this.model().ingredients);

  readonly recipeForm = form(this.model, (path) => {
    required(path.title, { message: "A title is required." });
    maxLength(path.title, 200, { message: "That title is too long." });
    maxLength(path.description, 2000, { message: "That description is too long." });

    min(path.servings, 1, { message: "It has to serve at least one." });
    max(path.servings, 1000, { message: "That is more than the API will take." });
    min(path.prepMinutes, 0, { message: "Minutes cannot be negative." });
    min(path.cookMinutes, 0, { message: "Minutes cannot be negative." });

    // The API validates this with IsUrl and rejects the whole save, so catch it
    // here where it can be pointed at the field that caused it.
    validate(path.sourceUrl, ({ value }) => {
      const raw = value().trim();
      if (raw === "") return undefined;
      if (!/^https?:\/\/\S+$/i.test(raw)) {
        return { kind: "notAUrl", message: "Start it with http:// or https://" };
      }
      return undefined;
    });

    // A recipe with no ingredients cannot be cooked, shopped for or matched
    // against the pantry, so it is not worth saving.
    validate(path.ingredients, ({ value }) => {
      if (value().length === 0) {
        return { kind: "empty", message: "Add at least one ingredient." };
      }
      return undefined;
    });

    applyEach(path.ingredients, (row) => {
      required(row.name, { message: "Name this ingredient." });
      maxLength(row.name, 200, { message: "That name is too long." });
      maxLength(row.preparation, 200, { message: "That is too long." });

      // Quantities are Decimals server-side and cross the wire as strings, so
      // this checks the string rather than parsing it to a number.
      //
      // Empty is allowed here, unlike in the pantry: "salt and pepper to taste"
      // is a real ingredient line with no amount at all.
      validate(row.quantity, ({ value }) => {
        const raw = value().trim();
        if (raw === "") return undefined;
        if (!/^\d*\.?\d+$/.test(raw)) {
          return { kind: "notANumber", message: "Use digits, for example 2 or 0.5." };
        }
        if (Number(raw) <= 0) {
          return { kind: "notPositive", message: "Must be more than zero." };
        }
        return undefined;
      });
    });

    applyEach(path.steps, (step) => {
      required(step.text, { message: "Write the step or remove it." });
      maxLength(step.text, 4000, { message: "That step is too long." });
    });
  });

  constructor() {
    this.api.units().subscribe({
      next: (units) => this.units.set(units),
      error: (error: unknown) =>
        this.notify.error(error, "Could not load the units."),
    });

    // Deferred a tick: route inputs are not bound while the constructor runs,
    // and reading `id()` here throws NG0950 with nothing to show for it at
    // build time.
    queueMicrotask(() => {
      if (this.editing()) this.load(Number(this.id()));
    });
  }

  /**
   * Fills the form from the saved recipe.
   *
   * `set` on the model rather than a `linkedSignal`: the router builds a fresh
   * component per recipe, so there is no input swapping underneath a live form
   * here — unlike the pantry and planner forms, which the parent keeps alive.
   */
  private load(id: number): void {
    this.loading.set(true);

    this.api.recipe(id).subscribe({
      next: (recipe) => {
        this.model.set({
          title: recipe.title,
          description: recipe.description ?? "",
          servings: recipe.servings,
          prepMinutes: recipe.prepMinutes ?? 0,
          cookMinutes: recipe.cookMinutes ?? 0,
          sourceNote: recipe.sourceNote ?? "",
          sourceUrl: recipe.sourceUrl ?? "",
          notes: recipe.notes ?? "",
          tags: recipe.tags.map((tag) => tag.name).join(", "),
          ingredients: recipe.ingredients.map((line) => {
            // A line that never matched the catalog has no name of its own —
            // rawText is the only text it carries, so that is what the cook
            // sees and can correct. Its leading amount comes off first: the
            // amount already has fields of its own right beside it, and leaving
            // it in the name too means an edit to either one contradicts the
            // other. "200 g flour" with the unit changed to milligrams saved as
            // "200 mg 200 g flour" while the screen went on reading "200 g".
            const name =
              line.ingredient?.name ??
              withoutLeadingAmount(line.rawText, line.quantity, line.unit);
            return {
              ingredientId: line.ingredient?.id ?? 0,
              name,
              quantity: line.quantity ?? "",
              unitId: line.unit?.id ?? 0,
              preparation: line.preparation ?? "",
              optional: line.optional,
              rawText: line.rawText,
              seedName: name,
              seedQuantity: line.quantity ?? "",
              seedUnitId: line.unit?.id ?? 0,
            };
          }),
          steps: recipe.steps.map((step) => ({ text: step.text })),
        });

        // Clears touched and dirty along with the value, so an edit screen does
        // not open already showing errors on fields nobody has been near.
        this.recipeForm().reset();
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.notify.error(error, "Could not load that recipe.");
      },
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

  addIngredient(): void {
    this.model.update((m) => ({
      ...m,
      ingredients: [...m.ingredients, blankIngredient()],
    }));
  }

  removeIngredient(index: number): void {
    this.model.update((m) => ({
      ...m,
      ingredients: m.ingredients.filter((_, i) => i !== index),
    }));
  }

  addStep(): void {
    this.model.update((m) => ({ ...m, steps: [...m.steps, { text: "" }] }));
  }

  removeStep(index: number): void {
    this.model.update((m) => ({
      ...m,
      steps: m.steps.filter((_, i) => i !== index),
    }));
  }

  onPicked(index: number, item: Ingredient): void {
    this.updateRow(index, (row) => ({
      ...row,
      ingredientId: item.id,
      name: item.name,
      // A default the cook can override, rather than an empty select.
      unitId: row.unitId === 0 && item.defaultUnitId ? item.defaultUnitId : row.unitId,
    }));
  }

  /**
   * Typing after a pick drops the catalog link.
   *
   * Keeping it would save "plain flour" pointing at the row for butter, which
   * is worse than saving no link at all: the pantry and the shopping list would
   * both act on it.
   */
  onTyped(index: number, text: string): void {
    this.updateRow(index, (row) => ({ ...row, name: text, ingredientId: 0 }));
  }

  onCreate(index: number, name: string): void {
    this.busy.set(true);
    this.api.createIngredient({ name }).subscribe({
      next: (created) => {
        this.busy.set(false);
        this.updateRow(index, (row) => ({
          ...row,
          ingredientId: created.id,
          name: created.name,
        }));
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

  private updateRow(
    index: number,
    change: (row: IngredientRow) => IngredientRow,
  ): void {
    this.model.update((m) => ({
      ...m,
      ingredients: m.ingredients.map((row, i) => (i === index ? change(row) : row)),
    }));
  }

  save(event: Event): void {
    // Native submit, not ngSubmit — that is an NgForm output and Signal Forms
    // replaces NgForm entirely.
    event.preventDefault();
    if (this.busy()) return;
    this.error.set("");

    // submit() runs the action only when valid but marks nothing on the way, so
    // without this a blank submit would sit there saying nothing.
    this.recipeForm().markAsTouched();

    void submit(this.recipeForm, async () => {
      this.busy.set(true);
      const value = this.model();

      const body: RecipeWrite = {
        title: value.title.trim(),
        servings: Number(value.servings) || 1,
        ingredients: value.ingredients.map((row) => ({
          ...(row.ingredientId ? { ingredientId: row.ingredientId } : {}),
          rawText: this.lineText(row),
          ...(row.quantity.trim() ? { quantity: row.quantity.trim() } : {}),
          ...(row.unitId ? { unitId: row.unitId } : {}),
          ...(row.preparation.trim()
            ? { preparation: row.preparation.trim() }
            : {}),
          optional: row.optional,
        })),
        steps: value.steps.map((step) => ({ text: step.text.trim() })),
      };

      const tags = value.tags
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);

      if (this.editing()) {
        // Sent whether or not they hold anything, because on a PATCH an absent
        // field means "leave alone" — omitting the empty ones is what would
        // make a description or a wrong link impossible to take away. The API
        // reads "" and 0 as "clear it".
        body.description = value.description.trim();
        body.sourceNote = value.sourceNote.trim();
        body.sourceUrl = value.sourceUrl.trim();
        body.notes = value.notes.trim();
        body.prepMinutes = Number(value.prepMinutes) || 0;
        body.cookMinutes = Number(value.cookMinutes) || 0;
        body.tags = tags.map((name) => ({ name }));
      } else {
        if (value.description.trim()) body.description = value.description.trim();
        if (Number(value.prepMinutes) > 0) body.prepMinutes = Number(value.prepMinutes);
        if (Number(value.cookMinutes) > 0) body.cookMinutes = Number(value.cookMinutes);
        if (value.sourceNote.trim()) body.sourceNote = value.sourceNote.trim();
        if (value.sourceUrl.trim()) body.sourceUrl = value.sourceUrl.trim();
        if (value.notes.trim()) body.notes = value.notes.trim();
        if (tags.length) body.tags = tags.map((name) => ({ name }));
      }

      try {
        const recipe = await firstValueFrom(
          this.editing()
            ? this.api.updateRecipe(Number(this.id()), body)
            : this.api.createRecipe(body),
        );
        this.notify.success(`Saved “${recipe.title}”.`);
        void this.router.navigate(["/recipes", recipe.id]);
      } catch (error: unknown) {
        this.busy.set(false);
        this.error.set(this.message(error));
      }
    });
  }

  /**
   * The line to store: the text already on record, unless the cook changed
   * what that text says.
   *
   * `rawText` is kept verbatim while it still describes the line, because on
   * the paste path it is the cook's own wording and the only record of what was
   * meant. It stops describing the line the moment the name, the quantity or
   * the unit is edited, and then it has to be recomposed.
   *
   * The amount matters here even though it has columns of its own, because an
   * *unmatched* line has no catalog name: the recipe screen prints its
   * `rawText` in place of a separate amount, so a line left saying "200 g
   * flour" goes on saying that however often the unit is changed underneath it.
   * That is the bug this replaced — the edit saved, and nothing on screen moved.
   *
   * Recomposing does not print the amount twice. The recipe screen strips a
   * leading amount it can recognise before printing the rest, and it builds the
   * candidates it strips with the same `amountWithUnit` used below, so a
   * recomposed line is the case it recognises best. A *stale* one is what
   * defeats it.
   */
  private lineText(row: IngredientRow): string {
    const renamed = row.name.trim() !== row.seedName.trim();
    const reamounted =
      row.quantity.trim() !== row.seedQuantity.trim() ||
      row.unitId !== row.seedUnitId;
    return row.rawText && !renamed && !reamounted
      ? row.rawText
      : this.rawText(row);
  }

  /**
   * The line as a cook would have written it.
   *
   * `rawText` is required by the API and kept verbatim forever, because on the
   * paste-and-parse path it is the original text and the only record of what
   * was actually meant. Typed by hand there is no original, so this composes
   * the one the fields describe rather than storing an empty string.
   */
  private rawText(row: IngredientRow): string {
    const unit = this.units().find((u) => u.id === row.unitId) ?? null;
    const amount = row.quantity.trim()
      ? amountWithUnit(row.quantity.trim(), unit)
      : "";
    const head = [amount, row.name.trim()].filter(Boolean).join(" ");
    const line = row.preparation.trim()
      ? `${head}, ${row.preparation.trim()}`
      : head;
    return line || row.name.trim() || "ingredient";
  }

  /** Surfaces the server's validation message rather than a generic one. */
  private message(error: unknown): string {
    const body = (error as { error?: { message?: string | string[] } }).error;
    const message = body?.message;
    if (Array.isArray(message)) return message.join(" ");
    if (typeof message === "string") return message;
    return "Could not save that recipe. Check the fields and try again.";
  }
}
