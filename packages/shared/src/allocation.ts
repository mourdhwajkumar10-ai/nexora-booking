/**
 * Best-fit table allocation (PRD §Best-Fit Table Allocation Strategy).
 * Candidates: not BLOCKED, no overlapping active booking, min <= P <= max.
 * Sort by seat differential D = max_capacity - P ascending (ties: table_number).
 * If allowUpsize is false, only tables with the smallest achievable max_capacity are returned.
 */
export interface AllocatableTable {
  id: string;
  tableNumber: string;
  minCapacity: number;
  maxCapacity: number;
}

export function bestFitOrder<T extends AllocatableTable>(tables: T[], partySize: number, allowUpsize = true): T[] {
  const fits = tables
    .filter((t) => t.minCapacity <= partySize && partySize <= t.maxCapacity)
    .sort(
      (a, b) =>
        a.maxCapacity - partySize - (b.maxCapacity - partySize) ||
        a.tableNumber.localeCompare(b.tableNumber, undefined, { numeric: true }),
    );
  if (allowUpsize || fits.length === 0) return fits;
  const best = fits[0].maxCapacity;
  return fits.filter((t) => t.maxCapacity === best);
}
