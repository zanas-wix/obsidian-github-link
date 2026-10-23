import { describe, expect, it } from "@jest/globals";
import { formatCountdown } from "./countdown";

describe("formatCountdown", () => {
	it("rounds up so a countdown never shows 0s before it is due", () => {
		expect(formatCountdown(12_001)).toBe("13s");
		expect(formatCountdown(1)).toBe("1s");
	});

	it("shows minutes with padded seconds, and 'now' once due", () => {
		expect(formatCountdown(65_000)).toBe("1m 05s");
		expect(formatCountdown(180_000)).toBe("3m 00s");
		expect(formatCountdown(0)).toBe("now");
		expect(formatCountdown(-500)).toBe("now");
	});
});
