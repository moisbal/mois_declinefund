export const PAGE_SIZE_OPTIONS = [10, 30, 50] as const;

export type PageSize = typeof PAGE_SIZE_OPTIONS[number];

export function getPageCount(totalItems: number, pageSize: number) {
  if (!Number.isFinite(totalItems) || totalItems <= 0) return 1;
  if (!Number.isFinite(pageSize) || pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(totalItems / pageSize));
}

export function getVisiblePageNumbers(currentPage: number, pageCount: number, maxVisible = 7) {
  const safePageCount = Math.max(1, Math.trunc(pageCount));
  const safeMaxVisible = Math.max(1, Math.trunc(maxVisible));
  const safeCurrentPage = Math.min(Math.max(1, Math.trunc(currentPage)), safePageCount);
  const visibleCount = Math.min(safeMaxVisible, safePageCount);
  const halfWindow = Math.floor(visibleCount / 2);
  const start = Math.max(1, Math.min(
    safeCurrentPage - halfWindow,
    safePageCount - visibleCount + 1,
  ));
  return Array.from({ length: visibleCount }, (_, index) => start + index);
}

export function paginateItems<T>(items: readonly T[], requestedPage: number, pageSize: number) {
  const pageCount = getPageCount(items.length, pageSize);
  const page = Math.min(Math.max(1, Math.trunc(requestedPage)), pageCount);
  const from = (page - 1) * pageSize;
  const to = Math.min(from + pageSize, items.length);
  return {
    items: items.slice(from, to),
    page,
    pageCount,
    firstItemNumber: items.length === 0 ? 0 : from + 1,
    lastItemNumber: to,
  };
}
