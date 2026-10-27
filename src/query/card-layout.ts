/**
 * How crowded a card's right-hand side is. A container query cannot read a number, so the column count
 * becomes one of three bands and each band gets its own width below which a card stacks into two rows
 * (see the `@container` rules in styles.css).
 */
export type CardDensity = "few" | "some" | "many";

/**
 * `sideCells` counts every cell right of the title (number, dates, status pills, stack number, refresh).
 */
export function cardDensity(sideCells: number): CardDensity {
	if (sideCells <= 3) return "few";
	return sideCells <= 5 ? "some" : "many";
}
