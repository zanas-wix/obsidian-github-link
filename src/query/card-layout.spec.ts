import { describe, expect, it } from "@jest/globals";
import { cardDensity } from "./card-layout";

describe("cardDensity", () => {
	it("bands the number of cells right of the title", () => {
		expect([0, 1, 3].map(cardDensity)).toEqual(["few", "few", "few"]);
		expect([4, 5].map(cardDensity)).toEqual(["some", "some"]);
		expect([6, 7, 12].map(cardDensity)).toEqual(["many", "many", "many"]);
	});
});
