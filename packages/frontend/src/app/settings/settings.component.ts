import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
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
    FormsModule,
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

            <div class="row">
              <mat-form-field appearance="outline" class="grow">
                <mat-label>Add a place</mat-label>
                <input matInput [(ngModel)]="newLocation" name="location" />
              </mat-form-field>
              <button
                mat-stroked-button
                (click)="addLocation()"
                [disabled]="!newLocation.trim()"
              >
                Add
              </button>
            </div>
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
                    {{ store.aisles.length }} aisles ordered
                  </span>
                </mat-list-item>
              }
            </mat-list>

            <div class="row">
              <mat-form-field appearance="outline" class="grow">
                <mat-label>Add a store</mat-label>
                <input matInput [(ngModel)]="newStore" name="store" />
              </mat-form-field>
              <button
                mat-stroked-button
                (click)="addStore()"
                [disabled]="!newStore.trim()"
              >
                Add
              </button>
            </div>
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

  newLocation = "";
  newStore = "";

  constructor() {
    this.loadLocations();
    this.loadStores();
  }

  addLocation(): void {
    this.api.createLocation(this.newLocation.trim()).subscribe({
      next: () => {
        this.newLocation = "";
        this.loadLocations();
      },
      error: (error: unknown) =>
        this.notify.error(error, "Could not add that."),
    });
  }

  addStore(): void {
    this.api.createStore(this.newStore.trim()).subscribe({
      next: () => {
        this.newStore = "";
        this.loadStores();
      },
      error: (error: unknown) =>
        this.notify.error(error, "Could not add that store."),
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
