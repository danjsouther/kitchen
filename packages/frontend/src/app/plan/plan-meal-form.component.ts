import {
  ChangeDetectionStrategy,
  Component,
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
  max,
  min,
  required,
  submit,
  validate,
} from "@angular/forms/signals";
import { firstValueFrom, Subject, debounceTime, distinctUntilChanged, switchMap } from "rxjs";
import { MatAutocompleteModule } from "@angular/material/autocomplete";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatSelectModule } from "@angular/material/select";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import type { PlannedMeal, PlannedMealWrite, RecipeSummary } from "../core/models";

const SLOTS: ReadonlyArray<PlannedMeal["slot"]> = [
  "BREAKFAST",
  "LUNCH",
  "DINNER",
  "SNACK",
];

/**
 * Puts a meal on the calendar.
 *
 * A planned meal is either a recipe or a bare note: "leftovers" and "dinner out"
 * are as much a plan for Thursday as a recipe is, and the grid has to hold both.
 * Only the recipe kind can be cooked and deducted, and only the recipe kind
 * reaches shopping-list generation — which is why the note is offered as an
 * alternative rather than as a free-text ingredient list.
 */
@Component({
  selector: "app-plan-meal-form",
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [
    FormField,
    FormRoot,
    MatAutocompleteModule,
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
        <h2>Add a meal</h2>

        <!--
          Not part of the form: this is a search box, and the last time a
          Material autocomplete was given a form field to write into it wrote
          the option *object* over a string. The picked id lands in the model
          through onPick instead.
        -->
        <mat-form-field appearance="outline" class="full">
          <mat-label>Which recipe</mat-label>
          <input
            matInput
            [value]="text()"
            [matAutocomplete]="auto"
            (input)="onType($any($event.target).value)"
            placeholder="Start typing a title…"
            autocomplete="off"
          />
          <mat-icon matSuffix>search</mat-icon>
          <!--
            displayWith is not optional here. Selecting an option makes Material
            write into the input element directly, and without it that write is
            the raw value — "[object Object]" on screen the moment the typed
            text already matched the chosen title.
          -->
          <mat-autocomplete
            #auto="matAutocomplete"
            [displayWith]="display"
            (optionSelected)="onPick($event.option.value)"
          >
            @for (recipe of results(); track recipe.id) {
              <mat-option [value]="recipe">
                {{ recipe.title }}
                <span class="muted small">· serves {{ recipe.servings }}</span>
              </mat-option>
            }
          </mat-autocomplete>
        </mat-form-field>

        <form [formRoot]="mealForm" (submit)="save($event)">
          <div class="grid">
            <mat-form-field appearance="outline">
              <mat-label>Day</mat-label>
              <input matInput type="date" [formField]="mealForm.date" />
              @if (firstError(mealForm.date()); as message) {
                <mat-error>{{ message }}</mat-error>
              }
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Meal</mat-label>
              <mat-select [formField]="mealForm.slot">
                @for (slot of slots; track slot) {
                  <mat-option [value]="slot">{{ title(slot) }}</mat-option>
                }
              </mat-select>
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>Servings</mat-label>
              <input matInput type="number" inputmode="numeric" [formField]="mealForm.servings" />
              <mat-hint>
                @if (recipeTitle()) {
                  Cooking scales the recipe to this.
                }
              </mat-hint>
              @if (firstError(mealForm.servings()); as message) {
                <mat-error>{{ message }}</mat-error>
              }
            </mat-form-field>

            <mat-form-field appearance="outline">
              <mat-label>{{ recipeTitle() ? "A note" : "…or just say what it is" }}</mat-label>
              <input matInput [formField]="mealForm.note" placeholder="Leftovers" />
              @if (firstError(mealForm.note()); as message) {
                <mat-error>{{ message }}</mat-error>
              }
            </mat-form-field>
          </div>

          @if (recipeTitle(); as chosen) {
            <p class="row small chosen">
              <mat-icon class="tiny">menu_book</mat-icon>
              <span class="grow">{{ chosen }}</span>
              <button mat-button type="button" (click)="clearRecipe()">Not that one</button>
            </p>
          }

          @if (error()) {
            <p class="warn-text small" role="alert">{{ error() }}</p>
          }

          <div class="actions">
            <button mat-flat-button type="submit" [disabled]="busy()">
              <mat-icon>add</mat-icon>
              Add it
            </button>
            <button mat-button type="button" (click)="cancelled.emit()">Cancel</button>
          </div>
        </form>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    h2 { font-size: 1rem; font-weight: 500; margin: 0 0 .5rem; }
    .small { font-size: .85rem; }
    .full { width: 100%; }
    .form { margin-bottom: 1rem; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
      gap: .25rem 1rem;
    }
    .chosen { margin: 0 0 .5rem; }
    .tiny { font-size: 1rem; width: 1rem; height: 1rem; }
    .actions { display: flex; gap: .5rem; align-items: center; margin-top: .5rem; }
  `,
})
export class PlanMealFormComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  /** The cell that was clicked: `YYYY-MM-DD` and a slot, both still editable. */
  readonly date = input.required<string>();
  readonly slot = input.required<PlannedMeal["slot"]>();

  readonly saved = output<void>();
  readonly cancelled = output<void>();

  readonly slots = SLOTS;
  readonly busy = signal(false);
  readonly error = signal("");
  readonly results = signal<RecipeSummary[]>([]);

  /** What is in the search box. Always a string — never a RecipeSummary. */
  readonly text = signal("");

  private readonly typed = new Subject<string>();

  /**
   * Everything the user has entered, reseeded whenever a different cell is
   * clicked.
   *
   * linkedSignal rather than a constructor-seeded signal for the reason the
   * pantry form uses one: the parent keeps this component alive and only swaps
   * the inputs, so one-time seeding would leave Tuesday's date under Thursday's
   * heading and file the meal on the wrong day.
   *
   * `recipeId` is 0 when nothing is chosen, since Signal Forms rejects null and
   * a real id is always positive.
   */
  private readonly source = () => ({ date: this.date(), slot: this.slot() });

  readonly model = linkedSignal<
    { date: string; slot: PlannedMeal["slot"] },
    {
      date: string;
      slot: PlannedMeal["slot"];
      recipeId: number;
      servings: number;
      note: string;
    }
  >({
    source: this.source,
    computation: (cell) => ({
      date: cell.date,
      slot: cell.slot,
      recipeId: 0,
      servings: 1,
      note: "",
    }),
  });

  /**
   * The chosen recipe's title, kept beside the model rather than in it: it is
   * display only, and a model field bound to no control has no way to show an
   * error. Keyed on the same source so it clears with everything else.
   */
  readonly recipeTitle = linkedSignal<{ date: string; slot: PlannedMeal["slot"] }, string>({
    source: this.source,
    computation: () => "",
  });

  readonly mealForm = form(this.model, (path) => {
    required(path.date, { message: "Pick a day." });
    min(path.servings, 1, { message: "At least one serving." });
    max(path.servings, 1000, { message: "That is a banquet — 1000 is the most." });

    // The API refuses an entry that names neither, so the rule is stated here
    // too and rendered on the note field, which is the one the user can act on.
    validate(path.note, ({ value, valueOf }) => {
      if (valueOf(path.recipeId) > 0) return undefined;
      if (value().trim() !== "") return undefined;
      return {
        kind: "empty",
        message: "Pick a recipe, or write what the meal is.",
      };
    });
  });

  constructor() {
    this.typed
      .pipe(
        // Debounced and switchMapped for the same reason the ingredient picker
        // is: a request per keystroke, and a slow early response landing after a
        // fast later one and repopulating the list with stale titles.
        debounceTime(200),
        distinctUntilChanged(),
        switchMap((q) => this.api.recipes({ q, limit: 10 })),
      )
      .subscribe({
        next: (page) => this.results.set(page.items),
        error: () => this.results.set([]),
      });
  }

  title(slot: PlannedMeal["slot"]): string {
    return slot.charAt(0) + slot.slice(1).toLowerCase();
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
   * What Material should put in the box for a selected option. An arrow property
   * so `this` survives being handed to the trigger, and null-tolerant because it
   * is called with null on a cleared selection.
   */
  readonly display = (value: RecipeSummary | null): string => value?.title ?? "";

  onType(value: string): void {
    this.text.set(value);
    const query = value.trim();
    if (query.length < 2) {
      this.results.set([]);
      return;
    }
    this.typed.next(query);
  }

  onPick(recipe: RecipeSummary): void {
    this.text.set(recipe.title);
    this.recipeTitle.set(recipe.title);
    this.model.update((m) => ({
      ...m,
      recipeId: recipe.id,
      // The recipe's own count, so the common case — cooking it as written —
      // needs no decision. Overriding it here is what scales the cook later.
      servings: recipe.servings,
    }));
    this.error.set("");
  }

  clearRecipe(): void {
    this.text.set("");
    this.recipeTitle.set("");
    this.results.set([]);
    this.model.update((m) => ({ ...m, recipeId: 0 }));
  }

  save(event: Event): void {
    // Native submit, not ngSubmit — that is an NgForm output, and Signal Forms
    // replaces NgForm entirely.
    event.preventDefault();
    if (this.busy()) return;
    this.error.set("");

    // submit() runs the action only when valid but marks nothing on the way, so
    // without this a blank submit would sit there saying nothing.
    this.mealForm().markAsTouched();

    void submit(this.mealForm, async () => {
      this.busy.set(true);
      const value = this.model();

      const body: PlannedMealWrite = {
        date: value.date,
        slot: value.slot,
        servings: value.servings,
      };
      if (value.recipeId > 0) body.recipeId = value.recipeId;
      if (value.note.trim()) body.note = value.note.trim();

      try {
        await firstValueFrom(this.api.addPlannedMeal(body));
        this.busy.set(false);
        this.notify.success("On the plan.");
        this.saved.emit();
      } catch (error: unknown) {
        this.busy.set(false);
        this.error.set(this.message(error));
      }
    });
  }

  /** Surfaces the server's own message — "that recipe is archived" is worth reading. */
  private message(error: unknown): string {
    const body = (error as { error?: { message?: string | string[] } }).error;
    const message = body?.message;
    if (Array.isArray(message)) return message.join(" ");
    if (typeof message === "string") return message;
    return "Could not add that to the plan.";
  }
}
