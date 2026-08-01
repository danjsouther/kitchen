import { Component, computed, inject, input, linkedSignal, output, signal } from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressBarModule } from "@angular/material/progress-bar";

import { ApiService } from "../core/api.service";
import { NotifyService } from "../core/notify.service";
import { BarcodeScanComponent } from "../shared/barcode-scan.component";
import { PantryItemFormComponent } from "./pantry-item-form.component";
import type { ScanQueueEntry, StorageLocation, Unit } from "../core/models";

/**
 * Scan several barcodes in one camera session, then fill in the rest of each
 * lot's details one at a time.
 *
 * The queue lives on the server (`pantry/scan-queue`), not in this
 * component's own state: it has to survive a page refresh, and be there when
 * someone picks the same household up on a different device to finish
 * stocking what was scanned in the kitchen. There is no live sync between two
 * sessions open at once — each load re-fetches, which is what "survives a
 * refresh" actually requires.
 */
@Component({
  selector: "app-scan-queue",
  imports: [
    BarcodeScanComponent,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
    PantryItemFormComponent,
  ],
  template: `
    <mat-card class="queue">
      <mat-card-content>
        @if (phase() === 'scanning') {
          <h2>Scan items</h2>
          <p class="muted small">
            Keep scanning — each barcode is added below. Stop when you're done.
          </p>

          <app-barcode-scan
            label="Barcode"
            hint="Scan one after another."
            [continuous]="true"
            (scanned)="onScanned($event)"
          />

          @if (queue().length === 0) {
            <p class="empty muted">Nothing scanned yet.</p>
          } @else {
            <ul class="rows">
              @for (entry of queue(); track entry.id) {
                <li class="row">
                  @if (entry.product; as product) {
                    @if (product.imageSmallUrl) {
                      <img [src]="product.imageSmallUrl" [alt]="product.name" />
                    }
                    <span class="grow">
                      <strong>{{ product.name }}</strong>
                      @if (product.brands) {
                        <span class="muted"> · {{ product.brands }}</span>
                      }
                    </span>
                  } @else {
                    <span class="grow muted">
                      {{ entry.barcode }} — not in the catalog
                    </span>
                  }
                  <button
                    mat-icon-button
                    type="button"
                    [disabled]="busy()"
                    (click)="removeEntry(entry)"
                    aria-label="Remove from queue"
                  >
                    <mat-icon>close</mat-icon>
                  </button>
                </li>
              }
            </ul>
          }

          @if (busy()) {
            <mat-progress-bar mode="indeterminate" />
          }

          <div class="actions">
            <button
              mat-flat-button
              type="button"
              [disabled]="queue().length === 0"
              (click)="phase.set('stocking')"
            >
              <mat-icon>inventory_2</mat-icon>
              Stock {{ queue().length }} item{{ queue().length === 1 ? "" : "s" }}
            </button>
            <button mat-button type="button" [disabled]="busy()" (click)="cancelAll()">
              Cancel
            </button>
          </div>
        } @else {
          <div class="row">
            <h2 class="grow">Item {{ index() + 1 }} of {{ queue().length }}</h2>
            <button mat-button type="button" (click)="skipCurrent()">
              Skip this item
            </button>
            <button mat-button type="button" (click)="cancelled.emit()">
              Finish later
            </button>
          </div>

          <app-pantry-item-form
            [prefill]="current()"
            [units]="units()"
            [locations]="locations()"
            (saved)="onItemSaved()"
            (cancelled)="skipCurrent()"
          />
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    h2 { font-size: 1rem; font-weight: 500; margin: 0 0 .5rem; }
    .small { font-size: .85rem; }
    .queue { margin-bottom: 1rem; }
    .empty { margin: .5rem 0; }
    .row { display: flex; align-items: center; gap: .5rem; }
    .grow { flex: 1; }
    .rows { list-style: none; margin: .75rem 0; padding: 0; display: flex; flex-direction: column; gap: .4rem; }
    .rows li {
      display: flex;
      align-items: center;
      gap: .5rem;
      padding: .4rem .6rem;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
    }
    .rows img { width: 2.25rem; height: 2.25rem; object-fit: contain; }
    .actions { display: flex; gap: .5rem; align-items: center; margin-top: .75rem; }
  `,
})
export class ScanQueueComponent {
  private readonly api = inject(ApiService);
  private readonly notify = inject(NotifyService);

  readonly units = input.required<Unit[]>();
  readonly locations = input.required<StorageLocation[]>();
  /** Skips straight to the stocking phase — set by the pantry page's "resume" banner. */
  readonly startInStocking = input(false);

  /** Emitted once every queued item has been stocked or skipped. */
  readonly saved = output<void>();
  /** Emitted when the whole session is cancelled from the scanning phase. */
  readonly cancelled = output<void>();

  /** A plain writable signal seeded from `startInStocking`, same shape as
   * `model` in the pantry item form: derived from an input but freely set
   * afterward by "Stock N items" below. */
  readonly phase = linkedSignal<boolean, "scanning" | "stocking">({
    source: () => this.startInStocking(),
    computation: (start) => (start ? "stocking" : "scanning"),
  });
  readonly queue = signal<ScanQueueEntry[]>([]);
  readonly index = signal(0);
  readonly busy = signal(false);

  readonly current = computed(() => this.queue()[this.index()] ?? null);

  constructor() {
    this.api.scanQueue().subscribe({
      next: (entries) => this.queue.set(entries),
      error: (error: unknown) => this.notify.error(error, "Could not load the scan queue."),
    });
  }

  onScanned(barcode: string): void {
    this.busy.set(true);
    this.api.addToScanQueue(barcode).subscribe({
      next: (entry) => {
        this.busy.set(false);
        const already = this.queue().some((e) => e.id === entry.id);
        if (already) {
          // The barcode scanner's own flash/vibrate already confirmed the
          // read; this is the "so now what" half — nothing changed, because
          // it's already here.
          this.notify.success("Already in the queue.");
          return;
        }
        this.queue.update((q) => [...q, entry]);
        this.notify.success(entry.product ? `Added ${entry.product.name}.` : `Added ${entry.barcode}.`);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not look that barcode up.");
      },
    });
  }

  removeEntry(entry: ScanQueueEntry): void {
    this.busy.set(true);
    this.api.removeFromScanQueue(entry.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.queue.update((q) => q.filter((e) => e.id !== entry.id));
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not remove that item.");
      },
    });
  }

  cancelAll(): void {
    this.busy.set(true);
    this.api.clearScanQueue().subscribe({
      next: () => {
        this.busy.set(false);
        this.queue.set([]);
        this.cancelled.emit();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.notify.error(error, "Could not clear the queue.");
      },
    });
  }

  /** A lot was saved for the current entry: dequeue it and move on. */
  onItemSaved(): void {
    const entry = this.current();
    if (!entry) return;
    this.dequeue(entry);
  }

  /** Drops the current entry without stocking it — no lot is created. */
  skipCurrent(): void {
    const entry = this.current();
    if (!entry) return;
    this.dequeue(entry);
  }

  private dequeue(entry: ScanQueueEntry): void {
    this.api.removeFromScanQueue(entry.id).subscribe({
      next: () => {
        const remaining = this.queue().filter((e) => e.id !== entry.id);
        this.queue.set(remaining);
        if (remaining.length === 0) {
          this.saved.emit();
        } else if (this.index() >= remaining.length) {
          this.index.set(remaining.length - 1);
        }
      },
      error: (error: unknown) => this.notify.error(error, "Could not update the queue."),
    });
  }
}
