import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
} from "@angular/core";
import {
  FormField,
  FormRoot,
  form,
  minLength,
  required,
  submit,
} from "@angular/forms/signals";
import { firstValueFrom } from "rxjs";
import { RouterLink } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatListModule } from "@angular/material/list";

import { ApiService } from "../core/api.service";
import { AuthService } from "../core/auth.service";
import { NotifyService } from "../core/notify.service";
import type { StorageLocation, Store } from "../core/models";

@Component({
  selector: "app-settings",
  imports: [
    FormField,
    FormRoot,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatListModule,
  ],
  template: `
    <div class="page">
      <div class="page-header">
        <h1>Settings</h1>
      </div>

      <div class="cards">
        <mat-card>
          <mat-card-content>
            <h2>Where things are kept</h2>
            <p class="muted small">
              Fridge, freezer, larder — wherever the pantry lives.
            </p>

            <mat-list>
              @for (location of locations(); track location.id) {
                <mat-list-item>
                  <span matListItemTitle>{{ location.name }}</span>
                  <span matListItemLine class="muted">
                    {{ location._count?.items ?? 0 }} items
                  </span>
                </mat-list-item>
              }
            </mat-list>

            <form [formRoot]="locationForm" (submit)="addLocation($event)" class="row">
              <mat-form-field appearance="outline" class="grow">
                <mat-label>Add a place</mat-label>
                <input matInput [formField]="locationForm.name" />
                @if (firstError(locationForm.name()); as message) {
                  <mat-error>{{ message }}</mat-error>
                }
              </mat-form-field>
              <button mat-stroked-button type="submit">Add</button>
            </form>
          </mat-card-content>
        </mat-card>

        <mat-card>
          <mat-card-content>
            <h2>Where you shop</h2>
            <p class="muted small">
              A store can carry its own aisle order, so a generated list reads
              in the order you actually walk.
            </p>

            <mat-list>
              @for (store of stores(); track store.id) {
                <mat-list-item>
                  <span matListItemTitle>{{ store.name }}</span>
                  <span matListItemLine class="muted">
                    @if (store.aisles.length) {
                      {{ store.aisles.length }} aisles ordered
                    } @else {
                      follows the catalog's own order
                    }
                  </span>
                  <a
                    matListItemMeta
                    mat-icon-button
                    [routerLink]="['/settings/stores', store.id]"
                    [attr.aria-label]="'Order the aisles at ' + store.name"
                  >
                    <mat-icon>reorder</mat-icon>
                  </a>
                </mat-list-item>
              }
            </mat-list>

            <form [formRoot]="storeForm" (submit)="addStore($event)" class="row">
              <mat-form-field appearance="outline" class="grow">
                <mat-label>Add a store</mat-label>
                <input matInput [formField]="storeForm.name" />
                @if (firstError(storeForm.name()); as message) {
                  <mat-error>{{ message }}</mat-error>
                }
              </mat-form-field>
              <button mat-stroked-button type="submit">Add</button>
            </form>
          </mat-card-content>
        </mat-card>

        <mat-card>
          <mat-card-content>
            <h2>Suggestions from Claude</h2>
            <p class="muted small">
              The “Ideas” tab is bring-your-own-key: your household supplies an
              Anthropic API key and pays for its own usage.
            </p>
            @if (auth.isAdmin()) {
              <a mat-stroked-button routerLink="/settings/ai">
                <mat-icon>key</mat-icon>
                Manage the API key
              </a>
            } @else {
              <p class="muted small">
                Only a household administrator can change this.
              </p>
            }
          </mat-card-content>
        </mat-card>

        <mat-card>
          <mat-card-content>
            <h2>You</h2>
            @if (auth.user(); as user) {
              <p>
                <strong>{{ user.displayName }}</strong
                ><br />
                <span class="muted"
                  >{{ user.email }} · {{ user.role.toLowerCase() }}</span
                >
              </p>
            }
            <button mat-stroked-button (click)="auth.logout()">
              <mat-icon>logout</mat-icon>
              Sign out
            </button>
          </mat-card-content>
        </mat-card>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: `
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1rem;
      align-items: start;
    }
    h2 {
      font-size: 1.05rem;
      font-weight: 500;
      margin: 0 0 0.25rem;
    }
    .small {
      font-size: 0.85rem;
    }
    mat-list {
      margin-bottom: 0.5rem;
    }
  `,
})
export class SettingsComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);
  readonly auth = inject(AuthService);

  readonly locations = signal<StorageLocation[]>([]);
  readonly stores = signal<Store[]>([]);

  // Two independent single-field forms rather than one: they submit to
  // different endpoints and either can be filled without the other.
  private readonly locationModel = signal({ name: "" });
  readonly locationForm = form(this.locationModel, (path) => {
    required(path.name, { message: "Give the place a name." });
    minLength(path.name, 2, { message: "A little longer, please." });
  });

  private readonly storeModel = signal({ name: "" });
  readonly storeForm = form(this.storeModel, (path) => {
    required(path.name, { message: "Give the store a name." });
    minLength(path.name, 2, { message: "A little longer, please." });
  });

  /** The first message worth showing, once the user has actually been there. */
  firstError(state: {
    touched: () => boolean;
    errors: () => readonly { message?: string }[];
  }): string | undefined {
    if (!state.touched()) return undefined;
    return state.errors().find((e) => e.message)?.message;
  }

  constructor() {
    this.loadLocations();
    this.loadStores();
  }

  addLocation(event: Event): void {
    event.preventDefault();
    this.locationForm().markAsTouched();

    void submit(this.locationForm, async () => {
      try {
        await firstValueFrom(this.api.createLocation(this.locationModel().name.trim()));
        // reset() clears the value and the touched/dirty flags together, so the
        // field does not come back already showing "required".
        this.locationForm().reset();
        this.loadLocations();
      } catch (error: unknown) {
        this.notify.error(error, "Could not add that.");
      }
    });
  }

  addStore(event: Event): void {
    event.preventDefault();
    this.storeForm().markAsTouched();

    void submit(this.storeForm, async () => {
      try {
        await firstValueFrom(this.api.createStore(this.storeModel().name.trim()));
        this.storeForm().reset();
        this.loadStores();
      } catch (error: unknown) {
        this.notify.error(error, "Could not add that store.");
      }
    });
  }

  private loadLocations(): void {
    this.api
      .locations()
      .subscribe({ next: (list) => this.locations.set(list) });
  }

  private loadStores(): void {
    this.api.stores().subscribe({ next: (list) => this.stores.set(list) });
  }
}
