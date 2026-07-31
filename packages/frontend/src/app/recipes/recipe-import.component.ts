import {
  Component,
  computed,
  inject,
  signal,
  ChangeDetectionStrategy,
} from "@angular/core";
import {
  FormField,
  applyEach,
  form,
  max,
  maxLength,
  min,
  minLength,
  required,
  validate,
} from "@angular/forms/signals";
import { Router } from "@angular/router";
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
import { IngredientPickerComponent } from "../shared/ingredient-picker.component";
import type { Ingredient, ParseResult, ParsedLine, Unit } from "../core/models";

/**
 * One ingredient line on the review screen, after parse and before save.
 *
 * Amounts and the catalog link are editable here because the parser is a
 * suggestion engine — the plan assumes it is wrong often enough that fixing a
 * line must be faster than typing the recipe from scratch. `rawText` stays as
 * the cook pasted it; it is the left-hand column and the text the save writes
 * back when the line still has no catalog match.
 */
interface DraftLine {
  /**
   * Identity for `@for` tracking, stable across reorders and removals.
   *
   * Tracking by `$index` would be wrong the moment a line can be removed:
   * deleting the second of five renumbers the rest, and Angular would reuse
   * each view for a different row — putting one line's amounts under another
   * line's name. That exact bug has already been paid for once in this repo,
   * on the pantry lot form.
   */
  key: number;
  rawText: string;
  quantity: string;
  /** 0 for "no unit". */
  unitId: number;
  name: string;
  preparation: string;
  optional: boolean;
  /** 0 when unmatched — the line still saves as plain text. */
  ingredientId: number;
  /** Catalog name for the current link, empty when unmatched. */
  matchedName: string;
  /** "For the sauce" — the sub-heading this line sits under, or "". */
  groupLabel: string;
  needsReview: boolean;
  isRange: boolean;
  inferredQuantity: boolean;
  matchKind: ParsedLine["match"]["kind"];
  confidence: number;
}

interface DraftStep {
  key: number;
  text: string;
}

/** Monotonic source of `key`. Never reused, so a removed row cannot alias a new one. */
let nextKey = 1;

function lineFromParsed(line: ParsedLine): DraftLine {
  return {
    key: nextKey++,
    rawText: line.rawText,
    quantity: line.quantity ?? "",
    unitId: line.unitId ?? 0,
    name: line.name,
    preparation: line.preparation ?? "",
    optional: line.optional,
    ingredientId: line.ingredientId ?? 0,
    matchedName: line.match.best?.name ?? "",
    groupLabel: line.groupLabel ?? "",
    needsReview: line.needsReview,
    isRange: line.isRange,
    inferredQuantity: line.inferredQuantity,
    matchKind: line.match.kind,
    confidence: line.match.confidence,
  };
}

/** A line the cook adds by hand, inheriting the group it is being added into. */
function blankLine(groupLabel: string): DraftLine {
  return {
    key: nextKey++,
    rawText: "",
    quantity: "",
    unitId: 0,
    name: "",
    preparation: "",
    optional: false,
    ingredientId: 0,
    matchedName: "",
    groupLabel,
    needsReview: false,
    isRange: false,
    inferredQuantity: false,
    matchKind: "NONE",
    confidence: 0,
  };
}

@Component({
  selector: "app-recipe-import",
  imports: [
    FormField,
    IngredientPickerComponent,
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
        <h1>Paste a recipe</h1>
      </div>

      @if (!parsed()) {
        <p class="muted">
          Paste the whole thing — title, ingredients and method. Nothing is
          saved until you have looked over what it made of it.
        </p>

        <mat-form-field appearance="outline" class="full">
          <mat-label>Recipe text</mat-label>
          <textarea
            matInput
            rows="16"
            [formField]="pasteForm.text"
          ></textarea>
          @if (firstError(pasteForm.text()); as message) {
            <mat-error>{{ message }}</mat-error>
          }
        </mat-form-field>

        <button
          mat-flat-button
          (click)="parse()"
          [disabled]="busy() || pasteForm().invalid()"
        >
          <mat-icon>auto_fix_high</mat-icon>
          Read it
        </button>
      }

      @if (busy()) {
        <mat-progress-bar mode="indeterminate" />
      }

      @if (parsed(); as result) {
        <mat-card class="summary">
          <mat-card-content class="row">
            <span class="grow">
              Found {{ draftModel().ingredients.length }} ingredients and
              {{ draftModel().steps.length }} steps.
              @if (reviewCount(); as count) {
                <strong class="warn-text">
                  {{ count }} need{{ count === 1 ? "s" : "" }} a look.
                </strong>
              } @else {
                <span class="ok-text">Everything matched cleanly.</span>
              }
            </span>
            <button mat-button (click)="startOver()">Start over</button>
          </mat-card-content>
        </mat-card>

        <div class="row fields">
          <mat-form-field appearance="outline" class="grow">
            <mat-label>Title</mat-label>
            <input matInput [formField]="draftForm.title" />
            @if (firstError(draftForm.title()); as message) {
              <mat-error>{{ message }}</mat-error>
            }
          </mat-form-field>
          <mat-form-field appearance="outline" class="servings">
            <mat-label>Serves</mat-label>
            <input
              matInput
              type="number"
              [formField]="draftForm.servings"
            />
            @if (firstError(draftForm.servings()); as message) {
              <mat-error>{{ message }}</mat-error>
            }
          </mat-form-field>
        </div>

        <h2>Ingredients</h2>
        <p class="muted small">
          The original text is on the left and what the app made of it on the
          right. Correct anything it got wrong before saving.
        </p>

        @for (row of draftForm.ingredients; track draftModel().ingredients[$index].key) {
          <!--
            The sub-heading the parser found ("For the sauce"), shown whenever
            it changes. Recipes read in groups, and without this the grouping is
            invisible on the one screen where it could be checked before saving.
          -->
          @if (groupHeadingAt($index); as heading) {
            <h3 class="group">{{ heading }}</h3>
          }

          <mat-card
            class="line"
            [class.review]="draftModel().ingredients[$index].needsReview"
          >
            <mat-card-content class="line-grid">
              <div class="raw">
                @if (draftModel().ingredients[$index].rawText; as raw) {
                  <code>{{ raw }}</code>
                } @else {
                  <span class="muted small">added by hand</span>
                }
                @if (draftModel().ingredients[$index].isRange) {
                  <div class="hint warn-text">
                    <mat-icon class="tiny">info</mat-icon>
                    a range — took the lower amount
                  </div>
                }
                @if (draftModel().ingredients[$index].inferredQuantity) {
                  <div class="hint warn-text">
                    <mat-icon class="tiny">info</mat-icon>
                    no number given — read as one
                  </div>
                }
                <div class="hint muted">
                  <span [matTooltip]="matchHelp($index)">
                    @if (draftModel().ingredients[$index].matchedName; as matched) {
                      {{ matched }} · {{ matchLabel($index) }}
                    } @else {
                      {{ matchLabel($index) }}
                    }
                  </span>
                </div>
              </div>

              <div class="parsed">
                <div class="edit-grid">
                  <app-ingredient-picker
                    class="who"
                    label="Ingredient"
                    [allowCreate]="true"
                    [initialText]="draftModel().ingredients[$index].name"
                    (picked)="onPicked($index, $event)"
                    (createRequested)="onCreate($index, $event)"
                    (textChanged)="onTyped($index, $event)"
                  />

                  <mat-form-field appearance="outline" class="qty">
                    <mat-label>Amount</mat-label>
                    <input
                      matInput
                      inputmode="decimal"
                      [formField]="row.quantity"
                    />
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
                  </mat-form-field>

                  <label class="optional">
                    <input type="checkbox" [formField]="row.optional" />
                    Optional
                  </label>

                  <button
                    mat-icon-button
                    type="button"
                    class="drop"
                    [attr.aria-label]="'Remove ' + lineLabel($index)"
                    [matTooltip]="'Remove ' + lineLabel($index)"
                    (click)="removeLine($index)"
                  >
                    <mat-icon>close</mat-icon>
                  </button>
                </div>
                @if (firstError(row.name()); as message) {
                  <p class="warn-text small" role="alert">{{ message }}</p>
                }
              </div>
            </mat-card-content>
          </mat-card>
        }

        <button mat-stroked-button type="button" (click)="addLine()">
          <mat-icon>add</mat-icon>
          Add an ingredient
        </button>

        <h2>Method</h2>
        @for (step of draftForm.steps; track draftModel().steps[$index].key) {
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
              class="drop"
              [attr.aria-label]="'Remove step ' + ($index + 1)"
              [matTooltip]="'Remove step ' + ($index + 1)"
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

        @if (result.ignored.length) {
          <p class="muted small">Set aside: {{ result.ignored.join(" · ") }}</p>
        }

        <div class="row actions">
          <button mat-flat-button (click)="save()" [disabled]="busy()">
            <mat-icon>save</mat-icon>
            Save recipe
          </button>
          @if (unresolvedCount(); as count) {
            <span class="muted small">
              {{ count }} line{{ count === 1 ? "" : "s" }} will save as plain
              text.
            </span>
          }
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .full {
      width: 100%;
    }
    .fields {
      align-items: flex-start;
    }
    .servings {
      width: 8rem;
    }
    h2 {
      font-size: 1.1rem;
      font-weight: 500;
      margin: 1.5rem 0 0.25rem;
    }
    .small {
      font-size: 0.85rem;
    }
    .summary {
      margin-bottom: 1rem;
      background: var(--mat-sys-surface-container-high);
    }
    .line {
      margin-bottom: 0.5rem;
    }
    .line.review {
      border-left: 3px solid var(--mat-sys-error);
    }
    .line-grid {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) 2fr;
      gap: 1rem;
      align-items: start;
      padding-bottom: 0.75rem;
    }
    @media (max-width: 720px) {
      .line-grid {
        grid-template-columns: 1fr;
        gap: 0.35rem;
      }
    }
    code {
      font-size: 0.85rem;
      color: var(--mat-sys-on-surface-variant);
      word-break: break-word;
    }
    .hint {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.75rem;
      margin-top: 0.2rem;
    }
    .tiny {
      font-size: 0.9rem;
      width: 0.9rem;
      height: 0.9rem;
    }
    /* Picker · amount · unit · preparation · optional · remove. */
    .edit-grid {
      display: grid;
      grid-template-columns: minmax(10rem, 2fr) 5.5rem 7rem minmax(8rem, 1fr) auto auto;
      gap: 0 0.5rem;
      align-items: start;
    }
    @media (max-width: 900px) {
      .edit-grid {
        grid-template-columns: 1fr 1fr;
      }
      .who,
      .prep {
        grid-column: 1 / -1;
      }
      /* Amount and unit pair up on their own row rather than being orphaned
         against the checkbox and the remove button. */
      .qty,
      .unit {
        grid-column: span 1;
      }
      .optional {
        padding-top: 0;
      }
    }
    .drop {
      margin-top: 0.5rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .group {
      font-size: 0.95rem;
      font-weight: 500;
      margin: 1rem 0 0.35rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .optional {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.85rem;
      color: var(--mat-sys-on-surface-variant);
      white-space: nowrap;
      cursor: pointer;
      padding-top: 1rem;
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
      margin-top: 1.5rem;
    }
  `,
})
export class RecipeImportComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  private readonly router = inject(Router);

  readonly parsed = signal<ParseResult | null>(null);
  readonly busy = signal(false);
  readonly units = signal<Unit[]>([]);

  readonly unresolvedCount = computed(
    () =>
      this.draftModel().ingredients.filter((line) => line.ingredientId === 0)
        .length,
  );

  /** Live count — the parse summary is a snapshot and would stay wrong after fixes. */
  readonly reviewCount = computed(
    () =>
      this.draftModel().ingredients.filter((line) => line.needsReview).length,
  );

  /** The pasted blob, before anything has been made of it. */
  private readonly pasteModel = signal({ text: "" });
  readonly pasteForm = form(this.pasteModel, (path) => {
    required(path.text, { message: "Paste a recipe first." });
    minLength(path.text, 20, {
      message: "That looks too short to be a recipe.",
    });
  });

  /**
   * Title, servings, lines and steps — all editable after the parse.
   *
   * Starts empty; `parse()` replaces the whole model and then `reset()`s so the
   * form does not open already showing errors on fields nobody has touched.
   */
  readonly draftModel = signal<{
    title: string;
    servings: number;
    ingredients: DraftLine[];
    steps: DraftStep[];
  }>({
    title: "",
    servings: 4,
    ingredients: [],
    steps: [],
  });

  readonly draftForm = form(this.draftModel, (path) => {
    required(path.title, { message: "A title is required." });
    min(path.servings, 1, { message: "At least one serving." });
    max(path.servings, 100, { message: "That is a lot of servings." });

    applyEach(path.ingredients, (row) => {
      required(row.name, { message: "Name this ingredient, or remove the line." });
      validate(row.quantity, ({ value }) => {
        const raw = value().trim();
        if (raw === "") return undefined;
        if (!/^\d*\.?\d+$/.test(raw)) {
          return {
            kind: "notANumber",
            message: "Use digits, for example 2 or 0.5.",
          };
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
  }

  /** The first message worth showing, once the user has actually been there. */
  firstError(state: {
    touched: () => boolean;
    errors: () => readonly { message?: string }[];
  }): string | undefined {
    if (!state.touched()) return undefined;
    return state.errors().find((e) => e.message)?.message;
  }

  parse(): void {
    // Gate on validity here rather than in a <form>: this submits from a
    // button, so there is no submit event for FormRoot to intercept.
    this.pasteForm().markAsTouched();
    if (this.pasteForm().invalid()) return;

    this.busy.set(true);
    this.api.parseRecipe(this.pasteModel().text).subscribe({
      next: (result) => {
        this.parsed.set(result);
        this.draftModel.set({
          title: result.title ?? "",
          servings: result.servings ?? 4,
          ingredients: result.ingredients.map(lineFromParsed),
          steps: result.steps.map((step) => ({ key: nextKey++, text: step.text })),
        });
        // Clears touched/dirty so the review does not open already in error.
        this.draftForm().reset();
        this.busy.set(false);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not read that.");
      },
    });
  }

  startOver(): void {
    this.parsed.set(null);
    this.draftModel.set({
      title: "",
      servings: 4,
      ingredients: [],
      steps: [],
    });
    this.draftForm().reset();
  }

  onPicked(index: number, item: Ingredient): void {
    this.updateRow(index, (row) => ({
      ...row,
      ingredientId: item.id,
      name: item.name,
      matchedName: item.name,
      needsReview: false,
      matchKind: "EXACT",
      confidence: 1,
      unitId:
        row.unitId === 0 && item.defaultUnitId ? item.defaultUnitId : row.unitId,
    }));
  }

  /**
   * Typing after a pick drops the catalog link.
   *
   * Keeping it would save a free-typed name pointing at a different catalog
   * row, which is worse than saving no link at all. The same-name guard covers
   * the autocomplete echo that can still reach here if Material fires (input)
   * before the picker has applied the selection into its own text signal.
   */
  onTyped(index: number, text: string): void {
    this.updateRow(index, (row) => {
      if (row.ingredientId !== 0 && text.trim() === row.name.trim()) {
        return row;
      }
      return {
        ...row,
        name: text,
        ingredientId: 0,
        matchedName: "",
        needsReview: true,
        matchKind: "NONE",
        confidence: 0,
      };
    });
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
          matchedName: created.name,
          needsReview: false,
          matchKind: "EXACT",
          confidence: 1,
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

  /**
   * The sub-heading to print above this line, or "" for none.
   *
   * Only where the group changes, so a run of lines under "For the sauce" gets
   * one heading rather than one each.
   */
  groupHeadingAt(index: number): string {
    const lines = this.draftModel().ingredients;
    const current = lines[index]?.groupLabel ?? "";
    if (!current) return "";
    return current === (lines[index - 1]?.groupLabel ?? "") ? "" : current;
  }

  /** Names a line for the remove button's label, falling back to its position. */
  lineLabel(index: number): string {
    const line = this.draftModel().ingredients[index];
    const name = line?.name.trim() || line?.rawText.trim();
    return name || `line ${index + 1}`;
  }

  /**
   * Adds a blank line at the end, inheriting the last line's group.
   *
   * Inheriting matters: appending to a recipe that has "For the sauce" and
   * "For the pasta" otherwise drops the new line into no group at all, which
   * reads as a third unnamed section on the saved recipe.
   */
  addLine(): void {
    this.draftModel.update((m) => ({
      ...m,
      ingredients: [
        ...m.ingredients,
        blankLine(m.ingredients.at(-1)?.groupLabel ?? ""),
      ],
    }));
  }

  removeLine(index: number): void {
    this.draftModel.update((m) => ({
      ...m,
      ingredients: m.ingredients.filter((_, i) => i !== index),
    }));
  }

  addStep(): void {
    this.draftModel.update((m) => ({
      ...m,
      steps: [...m.steps, { key: nextKey++, text: "" }],
    }));
  }

  removeStep(index: number): void {
    this.draftModel.update((m) => ({
      ...m,
      steps: m.steps.filter((_, i) => i !== index),
    }));
  }

  private updateRow(
    index: number,
    change: (row: DraftLine) => DraftLine,
  ): void {
    this.draftModel.update((m) => ({
      ...m,
      ingredients: m.ingredients.map((row, i) =>
        i === index ? change(row) : row,
      ),
    }));
  }

  matchLabel(index: number): string {
    const line = this.draftModel().ingredients[index];
    if (!line) return "";
    const labels: Record<string, string> = {
      EXACT: "exact match",
      ALIAS: "matched an alias",
      SINGULAR: "matched the singular",
      FUZZY: `looks similar (${Math.round(line.confidence * 100)}%)`,
      NONE: "no catalog match — will save as plain text",
    };
    return labels[line.matchKind] ?? line.matchKind;
  }

  matchHelp(index: number): string {
    const line = this.draftModel().ingredients[index];
    if (!line) return "";
    return line.matchKind === "FUZZY"
      ? "Matched by spelling similarity rather than exactly, so it is worth a glance."
      : "Matched against the ingredient catalog.";
  }

  /**
   * Sends back the same shape the create endpoint takes.
   *
   * Every line keeps its original text, so even the ones that never matched a
   * catalog ingredient are preserved exactly as pasted. A line added by hand
   * has no pasted text, so its name stands in — `rawText` is required by the
   * API and is what the recipe falls back to displaying when a match is later
   * found to be wrong.
   *
   * `groupLabel` is carried through untouched. It is the parser's reading of
   * "For the sauce", and dropping it here would silently flatten a grouped
   * recipe into one undifferentiated list on save.
   */
  save(): void {
    // Gate on validity here rather than in a <form>: this submits from a
    // button, so there is no submit event for FormRoot to intercept.
    this.draftForm().markAsTouched();
    if (this.draftForm().invalid()) return;

    this.busy.set(true);

    const draft = this.draftModel();
    const payload = {
      title: draft.title.trim() || "Untitled recipe",
      servings: Number(draft.servings) || 4,
      ingredients: draft.ingredients.map((line) => ({
        ...(line.ingredientId ? { ingredientId: line.ingredientId } : {}),
        rawText: line.rawText.trim() || line.name.trim(),
        ...(line.quantity.trim() ? { quantity: line.quantity.trim() } : {}),
        ...(line.unitId ? { unitId: line.unitId } : {}),
        ...(line.preparation.trim()
          ? { preparation: line.preparation.trim() }
          : {}),
        ...(line.groupLabel.trim() ? { groupLabel: line.groupLabel.trim() } : {}),
        optional: line.optional,
      })),
      steps: draft.steps.map((step) => ({ text: step.text.trim() })),
    };

    this.api.createRecipe(payload).subscribe({
      next: (recipe) => {
        this.notify.success(`Saved “${recipe.title}”.`);
        void this.router.navigate(["/recipes", recipe.id]);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not save that recipe.");
      },
    });
  }
}
