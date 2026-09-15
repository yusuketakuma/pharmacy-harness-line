const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when `value` is a real calendar date in `YYYY-MM-DD` form.
 * Never throws: inputs that match the shape but are not real dates
 * (e.g. `2024-13-45`) return false.
 */
export function isIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
