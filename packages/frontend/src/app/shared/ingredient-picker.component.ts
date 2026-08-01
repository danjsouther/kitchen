import { Component,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from "@angular/core";
import { MatAutocompleteModule } from "@angular/material/autocomplete";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { Subject, debounceTime, distinctUntilChanged, switchMap } from "rxjs";
import { SYSTEM_HOUSEHOLD_ID } from "@kitchen/shared-types";

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
  imports: [
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
        [value]="text()"
        [matAutocomplete]="auto"
        (input)="onType($any($event.target).value)"
        [placeholder]="placeholder()"
        autocomplete="off"
      />
      <mat-icon matSuffix>search</mat-icon>

      <!--
        No ngModel: the input is bound to a string signal, so nothing can put an
        Ingredient where this component expects text. Two separate crashes came
        from that when it was an ngModel field — every .trim() in here was
        really operating on an object.
        displayWith is still needed, and is not the same thing. On selection
        Material writes into the input element itself, and with no displayWith
        it writes the option value — which put a literal "[object Object]" on
        screen whenever the typed text already matched the chosen name exactly,
        because then the [value] binding did not change and never overwrote it.
      -->
      <mat-autocomplete
        #auto="matAutocomplete"
        [displayWith]="display"
        (optionSelected)="onPick($event.option.value)"
      >
        @for (item of results(); track item.id) {
          <mat-option [value]="item">
            {{ item.name }}
            @if (item.householdId !== SYSTEM_HOUSEHOLD_ID) {
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
            Create “{{ text() }}”
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
  /**
   * What the box should show when the parent already knows the name.
   *
   * Needed by the recipe form, where a row is one of a list: removing a row in
   * the middle hands this component to a different row, and a plain signal
   * would leave the previous row's text sitting above the new row's amount.
   */
  readonly initialText = input("");

  readonly picked = output<Ingredient>();
  /** Emitted when the user asks for an ingredient that does not exist yet. */
  readonly createRequested = output<string>();
  /** Every keystroke, so a parent can keep a free-typed name that never matched. */
  readonly textChanged = output<string>();

  /** Sentinel for the "create this" row, so it is distinguishable from a real hit. */
  readonly CREATE = "__create__" as const;

  /** Exposed for the template's "· yours" badge. */
  readonly SYSTEM_HOUSEHOLD_ID = SYSTEM_HOUSEHOLD_ID;

  /** What is in the box. Always a string — never an Ingredient. */
  readonly text = linkedSignal(() => this.initialText());

  readonly results = signal<Ingredient[]>([]);
  readonly loading = signal(false);

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
   * What Material should put in the box for a selected option.
   *
   * An arrow property so `this` survives being handed to the trigger. It is
   * called with null on a cleared selection and with the create sentinel — both
   * of which threw here before, hence the explicit cases rather than
   * `value.name`.
   */
  readonly display = (value: Ingredient | string | null): string => {
    if (!value) return "";
    if (typeof value === "string") {
      return value === this.CREATE ? this.text() : value;
    }
    return value.name;
  };

  /** True when what was typed is not already an exact catalog name. */
  canCreate(): boolean {
    const typed = this.text().trim().toLowerCase();
    if (typed.length < 2) return false;
    return !this.results().some((item) => item.name.toLowerCase() === typed);
  }

  onType(value: string): void {
    // Selecting an option sets `text` in onPick, then Material writes the same
    // string into the input and fires (input). Emitting textChanged for that
    // echo would make the parent drop the catalog link we just established.
    if (value === this.text()) return;

    this.text.set(value);
    this.textChanged.emit(value);
    const query = value.trim();
    if (query.length < 2) {
      this.results.set([]);
      return;
    }
    this.typed.next(query);
  }

  onPick(value: Ingredient | typeof this.CREATE): void {
    if (value === this.CREATE) {
      const name = this.text().trim();
      // Leave the typed name in the box: the parent is about to create it, and
      // blanking the field here would make the screen look like nothing happened.
      this.createRequested.emit(name);
      return;
    }
    this.text.set(value.name);
    this.picked.emit(value);
  }
}
