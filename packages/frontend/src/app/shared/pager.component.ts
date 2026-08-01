import { Component, computed, input, output } from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";

/** Sentinel page number standing in for an ellipsis in the windowed list. */
const GAP = -1;

/**
 * Page-number controls for a `Paged<T>` response: prev/next plus a windowed
 * set of page buttons with ellipses for a long run.
 *
 * Deliberately not `MatPaginator` — that widget is prev/next plus a page-size
 * picker and an "X-Y of Z" label, not numbered page buttons, which is what
 * every list in this app was asked to have.
 */
@Component({
  selector: "app-pager",
  imports: [MatButtonModule, MatIconModule],
  template: `
    @if (totalPages() > 1) {
      <div class="pager">
        <button
          mat-icon-button
          type="button"
          [disabled]="page() === 1"
          (click)="go(page() - 1)"
          aria-label="Previous page"
        >
          <mat-icon>chevron_left</mat-icon>
        </button>

        @for (p of pageNumbers(); track $index) {
          @if (p === gap) {
            <span class="ellipsis">…</span>
          } @else {
            <button
              mat-stroked-button
              type="button"
              class="page"
              [class.current]="p === page()"
              (click)="go(p)"
            >
              {{ p }}
            </button>
          }
        }

        <button
          mat-icon-button
          type="button"
          [disabled]="page() === totalPages()"
          (click)="go(page() + 1)"
          aria-label="Next page"
        >
          <mat-icon>chevron_right</mat-icon>
        </button>
      </div>
    }
  `,
  styles: `
    .pager {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      margin: 1rem 0;
      flex-wrap: wrap;
    }
    .page {
      min-width: 2.5rem;
      padding: 0 0.5rem;
    }
    .page.current {
      background: var(--mat-sys-secondary-container);
    }
    .ellipsis {
      padding: 0 0.25rem;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class PagerComponent {
  readonly total = input.required<number>();
  readonly limit = input.required<number>();
  readonly offset = input.required<number>();
  readonly offsetChange = output<number>();

  readonly gap = GAP;

  readonly page = computed(() => Math.floor(this.offset() / this.limit()) + 1);
  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.total() / this.limit())),
  );

  /** First, last, and a window around the current page; gaps become ellipses. */
  readonly pageNumbers = computed<number[]>(() => {
    const total = this.totalPages();
    const current = this.page();
    const wanted = new Set<number>([1, total, current - 1, current, current + 1]);

    const numbers = [...wanted]
      .filter((p) => p >= 1 && p <= total)
      .sort((a, b) => a - b);

    const withGaps: number[] = [];
    for (const [index, p] of numbers.entries()) {
      if (index > 0 && p - numbers[index - 1] > 1) withGaps.push(GAP);
      withGaps.push(p);
    }
    return withGaps;
  });

  go(page: number): void {
    if (page < 1 || page > this.totalPages() || page === this.page()) return;
    this.offsetChange.emit((page - 1) * this.limit());
  }
}
