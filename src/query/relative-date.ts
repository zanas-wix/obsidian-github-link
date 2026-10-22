/**
 * GitHub search only takes absolute dates (`updated:>2026-09-22`). Let queries say `updated:>-30d`
 * instead: a `-N` followed by h, d, w, m (30 days) or y (365 days) right after a qualifier is
 * replaced by the date that long ago, so a note keeps meaning "the last 30 days".
 */

const UNIT_MS = {
	h: 3600e3,
	d: 24 * 3600e3,
	w: 7 * 24 * 3600e3,
	m: 30 * 24 * 3600e3,
	y: 365 * 24 * 3600e3,
};

const RELATIVE_DATE = /(\b[a-z]+:(?:[<>]=?)?)-(\d+)([hdwmy])\b/gi;

export function resolveRelativeDates(query: string, now: number = Date.now()): string {
	return query.replace(RELATIVE_DATE, (_match, prefix: string, amount: string, unit: string) => {
		const date = new Date(now - parseInt(amount, 10) * UNIT_MS[unit.toLowerCase() as keyof typeof UNIT_MS]);
		return `${prefix}${date.toISOString().slice(0, 10)}`;
	});
}
