import {
  Component,
  computed,
  inject,
  signal,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import { RouterLink } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatMenuModule } from "@angular/material/menu";
import { MatProgressBarModule } from "@angular/material/progress-bar";
import { MatTooltipModule } from "@angular/material/tooltip";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { PlanMealFormComponent } from "./plan-meal-form.component";
import type { PlannedMeal } from "../core/models";

const SLOTS = ["BREAKFAST", "LUNCH", "DINNER", "SNACK"] as const;
type Slot = (typeof SLOTS)[number];

@Component({
  selector: "app-plan",
  imports: [
    DatePipe,
    RouterLink,
    PlanMealFormComponent,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatMenuModule,
    MatProgressBarModule,
    MatTooltipModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>The week</h1>
        <div class="row">
          <button
            mat-icon-button
            (click)="shift(-7)"
            aria-label="Previous week"
          >
            <mat-icon>chevron_left</mat-icon>
          </button>
          <span class="muted range">
            {{ days()[0] | date: "d MMM" }} – {{ days()[6] | date: "d MMM" }}
          </span>
          <button mat-icon-button (click)="shift(7)" aria-label="Next week">
            <mat-icon>chevron_right</mat-icon>
          </button>
          <button mat-button (click)="goToday()">Today</button>
        </div>
        <button mat-flat-button (click)="startAdd()">
          <mat-icon>add</mat-icon>
          Add a meal
        </button>
      </div>

      @if (loading()) {
        <mat-progress-bar mode="indeterminate" />
      }

      @if (adding(); as cell) {
        <app-plan-meal-form
          [date]="cell.date"
          [slot]="cell.slot"
          (saved)="onSaved()"
          (cancelled)="adding.set(null)"
        />
      }

      <div class="scroll-x">
        <div class="grid">
          <div class="corner"></div>
          @for (day of days(); track day.toISOString()) {
            <div class="day-head" [class.today]="isToday(day)">
              <div class="dow">{{ day | date: "EEE" }}</div>
              <div class="dom">{{ day | date: "d" }}</div>
            </div>
          }

          @for (slot of slots; track slot) {
            <div class="slot-head">{{ title(slot) }}</div>
            @for (day of days(); track day.toISOString()) {
              <div class="cell" [class.targeted]="isTarget(day, slot)">
                @for (meal of mealsFor(day, slot); track meal.id) {
                  <div class="meal" [class.cooked]="meal.status === 'COOKED'">
                    @if (meal.recipe) {
                      <a
                        [routerLink]="['/recipes', meal.recipe.id]"
                        class="meal-title"
                      >
                        {{ meal.recipe.title }}
                      </a>
                    } @else {
                      <span class="meal-title muted">{{ meal.note }}</span>
                    }
                    <div class="meal-foot">
                      <span class="muted">{{ meal.servings }}</span>
                      <button
                        mat-icon-button
                        class="tiny-btn"
                        [matMenuTriggerFor]="menu"
                        aria-label="Meal actions"
                      >
                        <mat-icon class="tiny">more_vert</mat-icon>
                      </button>
                      <mat-menu #menu="matMenu">
                        @if (meal.recipe && meal.status !== "COOKED") {
                          <button mat-menu-item (click)="cook(meal)">
                            <mat-icon>restaurant</mat-icon>
                            <span>Cook and deduct</span>
                          </button>
                        }
                        @if (lastSession(meal); as session) {
                          <button mat-menu-item (click)="undo(session)">
                            <mat-icon>undo</mat-icon>
                            <span>Undo the cook</span>
                          </button>
                        }
                        <button mat-menu-item (click)="remove(meal)">
                          <mat-icon>delete</mat-icon>
                          <span>Remove</span>
                        </button>
                      </mat-menu>
                    </div>
                  </div>
                }

                <!--
                  Dimmed rather than hidden-until-hover: a control that only
                  exists on hover is a control a touch screen cannot find.
                -->
                <button
                  mat-icon-button
                  class="tiny-btn add-btn"
                  (click)="startAdd(day, slot)"
                  [attr.aria-label]="addLabel(day, slot)"
                >
                  <mat-icon class="tiny">add</mat-icon>
                </button>
              </div>
            }
          }
        </div>
      </div>

      <p class="muted small">
        Cooking a meal deducts its ingredients from the pantry, soonest-expiry
        first, and can be undone.
      </p>
    </div>
  `,
  styles: `
    .range {
      min-width: 8.5rem;
      text-align: center;
    }
    .grid {
      display: grid;
      grid-template-columns: 5.5rem repeat(7, minmax(8rem, 1fr));
      gap: 1px;
      background: var(--mat-sys-outline-variant);
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      overflow: hidden;
      min-width: 62rem;
    }
    .corner,
    .day-head,
    .slot-head,
    .cell {
      background: var(--mat-sys-surface);
      padding: 0.5rem;
    }
    .day-head {
      text-align: center;
    }
    .day-head.today {
      background: var(--mat-sys-secondary-container);
    }
    .dow {
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--mat-sys-on-surface-variant);
    }
    .dom {
      font-size: 1.1rem;
    }
    .slot-head {
      font-size: 0.8rem;
      text-transform: uppercase;
      color: var(--mat-sys-on-surface-variant);
      display: flex;
      align-items: center;
    }
    .cell {
      min-height: 4.5rem;
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
    }
    .meal {
      background: var(--mat-sys-surface-container-high);
      border-radius: 6px;
      padding: 0.3rem 0.4rem;
      font-size: 0.85rem;
    }
    .meal.cooked {
      opacity: 0.55;
    }
    .meal.cooked .meal-title {
      text-decoration: line-through;
    }
    .meal-title {
      display: block;
      color: inherit;
      text-decoration: none;
      line-height: 1.25;
    }
    a.meal-title:hover {
      text-decoration: underline;
    }
    .meal-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.75rem;
    }
    .tiny {
      font-size: 1rem;
      width: 1rem;
      height: 1rem;
    }
    .tiny-btn {
      width: 1.5rem;
      height: 1.5rem;
      padding: 0;
    }
    .cell.targeted {
      background: var(--mat-sys-secondary-container);
    }
    .add-btn {
      align-self: flex-start;
      opacity: 0.35;
      margin-top: auto;
    }
    .cell:hover .add-btn,
    .add-btn:focus-visible {
      opacity: 1;
    }
    .small {
      font-size: 0.85rem;
      margin-top: 1rem;
    }
  `,
})
export class PlanComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  readonly slots = SLOTS;
  readonly meals = signal<PlannedMeal[]>([]);
  readonly loading = signal(true);
  readonly weekStart = signal(startOfWeek(new Date()));

  /** The cell the add form is filling, or null when it is closed. */
  readonly adding = signal<{ date: string; slot: Slot } | null>(null);

  readonly days = computed(() => {
    const start = this.weekStart();
    return Array.from({ length: 7 }, (_, offset) => addDays(start, offset));
  });

  constructor() {
    this.load();
  }

  shift(days: number): void {
    this.weekStart.set(addDays(this.weekStart(), days));
    this.load();
  }

  goToday(): void {
    this.weekStart.set(startOfWeek(new Date()));
    this.load();
  }

  isToday(day: Date): boolean {
    return isoDate(day) === isoDate(new Date());
  }

  title(slot: Slot): string {
    return slot.charAt(0) + slot.slice(1).toLowerCase();
  }

  /**
   * Opens the add form on a cell.
   *
   * With no cell — the header button — it aims at tonight's dinner if this week
   * contains today, and otherwise at the first day shown, so the form never
   * opens on a date that is not on screen.
   */
  startAdd(day?: Date, slot: Slot = "DINNER"): void {
    const days = this.days();
    const fallback = days.find((d) => this.isToday(d)) ?? days[0];
    this.adding.set({ date: isoDate(day ?? fallback), slot });
  }

  isTarget(day: Date, slot: Slot): boolean {
    const cell = this.adding();
    return cell !== null && cell.date === isoDate(day) && cell.slot === slot;
  }

  addLabel(day: Date, slot: Slot): string {
    return `Add a meal to ${this.title(slot).toLowerCase()} on ${isoDate(day)}`;
  }

  onSaved(): void {
    this.adding.set(null);
    this.load();
  }

  mealsFor(day: Date, slot: Slot): PlannedMeal[] {
    const iso = isoDate(day);
    return this.meals().filter(
      (meal) => meal.date.slice(0, 10) === iso && meal.slot === slot,
    );
  }

  /** The session that could still be undone, if there is one. */
  lastSession(meal: PlannedMeal): number | null {
    const open = meal.cookSessions.find(
      (session) => session.reversedOn === null,
    );
    return open?.id ?? null;
  }

  cook(meal: PlannedMeal): void {
    this.api.cookMeal(meal.id).subscribe({
      next: (report) => {
        const short = report.shortfalls.length;
        // A shortfall is reported rather than treated as a failure: the pantry
        // gave what it had, and the gap is something the cook needs to know.
        this.notify.success(
          short
            ? `Cooked. ${short} ingredient${short === 1 ? " was" : "s were"} short — check the pantry.`
            : "Cooked, and the pantry has been updated.",
        );
        this.load();
      },
      error: (error: unknown) =>
        this.notify.error(error, "Could not cook that meal."),
    });
  }

  undo(sessionId: number): void {
    this.api.undoCook(sessionId).subscribe({
      next: () => {
        this.notify.success("Put back.");
        this.load();
      },
      error: (error: unknown) =>
        this.notify.error(error, "Could not undo that."),
    });
  }

  remove(meal: PlannedMeal): void {
    this.api.removePlannedMeal(meal.id).subscribe({
      next: () => this.load(),
      error: (error: unknown) =>
        this.notify.error(error, "Could not remove that."),
    });
  }

  private load(): void {
    this.loading.set(true);
    const days = this.days();

    this.api.planner(isoDate(days[0]), isoDate(days[6])).subscribe({
      next: (meals) => {
        this.meals.set(meals);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.notify.error(error, "Could not load the plan.");
      },
    });
  }
}

/** Weeks start on Monday. */
function startOfWeek(date: Date): Date {
  const result = new Date(date);
  const offset = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - offset);
  result.setHours(0, 0, 0, 0);
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Formats from local parts, not `toISOString()`.
 *
 * A date built at local midnight converts to the previous day in UTC anywhere
 * behind it, which would ask the server for the wrong week.
 */
function isoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
