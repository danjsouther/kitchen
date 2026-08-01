/** Shared shape for every paged list endpoint, so the frontend has one type to read. */
export interface Paged<T> {
  total: number;
  limit: number;
  offset: number;
  items: T[];
}

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 200;

/** Applies the default and cap every paged query DTO already validates >= 1 on. */
export function resolveLimit(
  limit: number | undefined,
  def = DEFAULT_PAGE_LIMIT,
  max = MAX_PAGE_LIMIT,
): number {
  return Math.min(limit ?? def, max);
}

export function paged<T>(items: T[], total: number, limit: number, offset: number): Paged<T> {
  return { total, limit, offset, items };
}
