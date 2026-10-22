import { describe, expect, it } from "@jest/globals";
import { resolveRelativeDates } from "./relative-date";

const now = Date.UTC(2026, 9, 22, 12);

describe("resolveRelativeDates", () => {
	it("replaces relative offsets after date qualifiers and comparison operators", () => {
		expect(resolveRelativeDates("is:pr updated:>-30d created:>=-2w closed:-1y", now)).toBe(
			"is:pr updated:>2026-09-22 created:>=2026-10-08 closed:2025-10-22",
		);
	});

	it("leaves absolute dates, ranges and other negations alone", () => {
		const query = "updated:>2026-01-01 created:2026-01-01..2026-02-01 -label:bug -author:x";
		expect(resolveRelativeDates(query, now)).toBe(query);
	});
});
