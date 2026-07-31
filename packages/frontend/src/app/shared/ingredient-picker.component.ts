import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatAutocompleteModule } from "@angular/material/autocomplete";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { Subject, debounceTime, distinctUntilChanged, switchMap } from "rxjs";

import { ApiService } from "../core/api.service";
import type { Ingredient } from "../core/models";

/**
 * Finds an ingredient in the catalog, with the option to create one inline.
 *
 * Shared because both the pantry and the catalog admin need it, and the last
 * time two screens grew their own version of a shared helper here they drifted
 * apart and disagreed on screen.
 *
 * The search is debounced and switchMapped: typing "tomato" fires a request per
 * keystroke otherwise, and without switchMap a slow early response can land
 * after a fast later one and repopulate the list with results for a prefix the
 * user has already moved past.
 */
@Component({
  selector: "app-ingredient-picker",
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [
    FormsModule,
    MatAutocompleteModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
  ],
  template: `
    <mat-form-field appearance="outline" class="full">
      <mat-label>{{ label() }}</mat-label>
      <input
        matInput
        [(ngModel)]="text"
        [name]="'ingredient-' + label()"
        [matAutocomplete]="auto"
        (ngModelChange)="onType($event)"
        [placeholder]="placeholder()"
        autocomplete="off"
      />
      <mat-icon matSuffix>search</mat-icon>

      <!--
        displayWith is required, not cosmetic: option values are Ingredient
        objects, so without it Material writes the object itself back into the
        model and the field reads "[object Object]" — and every later
        this.text.trim() throws.
      -->
      <mat-autocomplete
        #auto="matAutocomplete"
        [displayWith]="displayName"
        (optionSelected)="onPick($event.option.value)"
      >
        @for (item of results(); track item.id) {
          <mat-option [value]="item">
            {{ item.name }}
            @if (item.householdId !== null) {
              <span class="muted small">· yours</span>
            }
          </mat-option>
        }

        <!--
          Offered only when nothing matched exactly. A catalog that quietly
          accumulates "tomatos" alongside "tomato" makes every later conversion
          and pantry match worse, so creating is a deliberate act rather than
          the first thing on the list.
        -->
        @if (allowCreate() && canCreate()) {
          <mat-option [value]="CREATE">
            <mat-icon class="tiny">add</mat-icon>
            Create “{{ typedText() }}”
          </mat-option>
        }
      </mat-autocomplete>
    </mat-form-field>

    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
  `,
  styles: `
    .full { width: 100%; }
    .small { font-size: .8rem; }
    .tiny { font-size: 1rem; width: 1rem; height: 1rem; vertical-align: middle; }
  `,
})
export class IngredientPickerComponent {
  private readonly api = inject(ApiService);

  readonly label = input("Ingredient");
  readonly placeholder = input("Start typing…");
  readonly allowCreate = input(false);

  readonly picked = output<Ingredient>();
  /** Emitted when the user asks for an ingredient that does not exist yet. */
  readonly createRequested = output<string>();

  /** Sentinel for the "create this" row, so it is distinguishable from a real hit. */
  readonly CREATE = "__create__" as const;

  readonly results = signal<Ingredient[]>([]);
  readonly loading = signal(false);

  text = "";

  private readonly typed = new Subject<string>();

  constructor() {
    this.typed
      .pipe(
        debounceTime(200),
        distinctUntilChanged(),
        switchMap((q) => {
          this.loading.set(true);
          return this.api.searchIngredients(q, 15);
        }),
      )
      .subscribe({
        next: (items) => {
          this.results.set(items);
          this.loading.set(false);
        },
        error: () => {
          this.results.set([]);
          this.loading.set(false);
        },
      });
  }

  /**
   * Coerces whatever ngModel is currently holding into a string.
   *
   * The model is not always a string. Material's autocomplete writes the
   * selected *option value* back through ngModel, so on selection this becomes
   * an Ingredient object — and every `.trim()` in this component would throw.
   * Both the reader and the change handler go through here for that reason.
   */
  private asText(value: unknown): string {
    if (typeof value === "string") return value;
    if (value == null) return "";
    return (value as Ingredient).name ?? "";
  }

  /** What is in the box right now, whatever ngModel currently holds. */
  typedText(): string {
    return this.asText(this.text);
  }

  /** True when what was typed is not already an exact catalog name. */
  canCreate(): boolean {
    const typed = this.typedText().trim().toLowerCase();
    if (typed.length < 2) return false;
    return !this.results().some((item) => item.name.toLowerCase() === typed);
  }

  onType(value: unknown): void {
    // Typed as unknown deliberately: ngModelChange fires with an Ingredient
    // object on selection, not just with the string the user typed.
    const query = this.asText(value).trim();
    if (query.length < 2) {
      this.results.set([]);
      return;
    }
    this.typed.next(query);
  }

  onPick(value: Ingredient | typeof this.CREATE): void {
    if (value === this.CREATE) {
      const name = this.typedText().trim();
      // Leave the typed name in the box: the parent is about to create it, and
      // blanking the field here would make the screen look like nothing happened.
      this.createRequested.emit(name);
      return;
    }
    this.text = value.name;
    this.picked.emit(value);
  }

  /** Lets a parent show the chosen name after a pick, or clear it after saving. */
  setText(value: string): void {
    this.text = value;
  }

  /**
   * Must tolerate null: Material calls displayWith with the model's initial
   * value, which is empty before anything is picked. It is also called as a
   * bare function reference, so it cannot rely on `this`.
   */
  displayName(item: Ingredient | string | null | undefined): string {
    if (item == null) return "";
    return typeof item === "string" ? item : item.name;
  }
}
