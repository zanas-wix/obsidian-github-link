import { describe, expect, it } from "@jest/globals";
import { getPaneSelection, onPaneSelection, setPaneSelection } from "./selection";

describe("pane selection", () => {
	it("tells subscribed owners about changes only", () => {
		const owner = { seen: [] as (string | null)[] };
		onPaneSelection(owner, (self, key) => self.seen.push(key));

		setPaneSelection("a/b#1");
		setPaneSelection("a/b#1");
		setPaneSelection("a/b#2");

		expect(owner.seen).toEqual(["a/b#1", "a/b#2"]);
		expect(getPaneSelection()).toBe("a/b#2");
	});
});
