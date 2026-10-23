import { describe, expect, it, jest } from "@jest/globals";
import { setCopyTarget } from "./copy-link";

function copy(): { setData: jest.Mock; event: Event } {
	const setData = jest.fn();
	const event = new Event("copy", { cancelable: true, bubbles: true });
	Object.defineProperty(event, "clipboardData", { value: { setData } });
	document.dispatchEvent(event);
	return { setData, event };
}

describe("copy link of the selected card", () => {
	const host = document.createElement("div");
	const outside = document.createElement("div");
	document.body.append(host, outside);

	it("replaces the copy with the PR link", () => {
		setCopyTarget(host, () => "https://github.com/o/r/pull/7");
		const { setData, event } = copy();

		expect(setData).toHaveBeenCalledWith("text/plain", "https://github.com/o/r/pull/7");
		expect(event.defaultPrevented).toBe(true);
	});

	it("leaves copying alone once the user clicks elsewhere", () => {
		setCopyTarget(host, () => "https://github.com/o/r/pull/7");
		outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		const { setData, event } = copy();

		expect(setData).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("leaves copying alone when nothing is selected in the list, or the list is gone", () => {
		setCopyTarget(host, () => null);
		expect(copy().setData).not.toHaveBeenCalled();

		const detached = document.createElement("div");
		setCopyTarget(detached, () => "https://x");
		expect(copy().setData).not.toHaveBeenCalled();
	});
});
