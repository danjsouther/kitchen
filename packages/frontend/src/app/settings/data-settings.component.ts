import { Component, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";

import { ApiService } from "../core/api.service";
import { NotifyService, describeError } from "../core/notify.service";
import type { ImportSummary } from "../core/models";

/**
 * Whole-household backup/restore. Both actions are admin-only (see
 * `app.routes.ts`'s `adminGuard` on this route) — the export contains every
 * recipe, pantry lot and price record the household has, and import is a
 * large, blast-radius write.
 */
@Component({
  selector: "app-data-settings",
  imports: [RouterLink, MatButtonModule, MatCardModule, MatIconModule, MatProgressBarModule],
  template: `
    <div class="page narrow">
      <div class="page-header">
        <h1>Your data</h1>
      </div>

      @if (busy()) {
        <mat-progress-bar mode="indeterminate" />
      }

      <mat-card>
        <mat-card-content>
          <h2>Download</h2>
          <p class="muted small">
            Everything this household owns — recipes, pantry, planner and
            shopping history, your own ingredient and unit tweaks — as one
            JSON file. Nobody's login and no API key ever leaves this file.
          </p>
          <button mat-stroked-button (click)="exportData()" [disabled]="busy()">
            <mat-icon>download</mat-icon>
            Download my data
          </button>
        </mat-card-content>
      </mat-card>

      <mat-card>
        <mat-card-content>
          <h2>Restore from a file</h2>
          <p class="muted small">
            Only works against an <strong>empty</strong> household — this is
            for restoring after a wipe or a fresh install, not merging into
            one that already has data. If anything in the file collides with
            what's already here (a recipe with the same name, for instance),
            the whole restore is refused and nothing changes.
          </p>
          <p class="muted small">
            The Anthropic API key is never included in a download, so it has
            to be re-entered on
            <a routerLink="/settings/ai">the AI settings page</a> after a
            restore.
          </p>

          <input
            #fileInput
            type="file"
            accept="application/json,.json"
            hidden
            (change)="onFileSelected($event)"
          />
          <button
            mat-stroked-button
            (click)="fileInput.click()"
            [disabled]="busy()"
          >
            <mat-icon>upload</mat-icon>
            Restore from file
          </button>

          @if (error()) {
            <p class="warn-text" role="alert">{{ error() }}</p>
          }

          @if (summary(); as s) {
            <p class="ok-text" role="status">
              Restored {{ s.recipes }} recipe(s), {{ s.pantryItems }} pantry
              lot(s), {{ s.shoppingLists }} shopping list(s) and everything
              else in the file.
            </p>
          }
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: `
    .narrow {
      max-width: 640px;
    }
    .small {
      font-size: 0.85rem;
    }
    mat-card {
      margin-bottom: 1rem;
    }
    h2 {
      font-size: 1.05rem;
      font-weight: 500;
      margin: 0 0 0.25rem;
    }
    button {
      margin-top: 0.5rem;
    }
  `,
})
export class DataSettingsComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  readonly busy = signal(false);
  readonly error = signal("");
  readonly summary = signal<ImportSummary | null>(null);

  exportData(): void {
    this.busy.set(true);
    this.api.exportHouseholdData().subscribe({
      next: (blob) => {
        this.busy.set(false);
        downloadBlob(blob, `kitchen-export-${new Date().toISOString().slice(0, 10)}.json`);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not download your data.");
      },
    });
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // Lets the same file be picked again after a failed attempt.
    if (!file) return;

    this.error.set("");
    this.summary.set(null);
    this.busy.set(true);

    const reader = new FileReader();
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(reader.result as string);
      } catch {
        this.busy.set(false);
        this.error.set("That file is not valid JSON.");
        return;
      }

      this.api.importHouseholdData(parsed).subscribe({
        next: (summary) => {
          this.busy.set(false);
          this.summary.set(summary);
          this.notify.success("Restored.");
        },
        error: (error: unknown) => {
          this.busy.set(false);
          this.error.set(describeError(error, "Could not restore that file."));
        },
      });
    };
    reader.onerror = () => {
      this.busy.set(false);
      this.error.set("Could not read that file.");
    };
    reader.readAsText(file);
  }
}

/** Triggers a browser download for an in-memory blob — no library needed for this. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
