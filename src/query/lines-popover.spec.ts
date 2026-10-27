import { beforeAll, describe, expect, it, jest } from "@jest/globals";
import { elementTestSetup } from "../../test/element";

jest.mock("../github/github", () => ({
	getPullFiles: () => Promise.resolve({ truncated: false, files: [{ path: "a.ts", additions: 1, deletions: 1 }] }),
}));
import { attachLinesBreakdown } from "./lines-popover";

const ref = { org: "o", repo: "r", number: 1 };

describe("lines breakdown popover", () => {
	beforeAll(() => {
		elementTestSetup();
		const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
		const create = (parent: HTMLElement, tag: string, info?: { cls?: string; text?: string }) => {
			const element = document.createElement(tag);
			if (info?.cls) element.className = info.cls;
			if (info?.text) element.textContent = info.text;
			parent.appendChild(element);
			return element;
		};
		proto.empty = function (this: HTMLElement) {
			this.innerHTML = "";
		};
		proto.createDiv = function (this: HTMLElement, info?: { cls?: string; text?: string }) {
			return create(this, "div", info);
		};
		proto.createSpan = function (this: HTMLElement, info?: { cls?: string; text?: string }) {
			return create(this, "span", info);
		};
	});

	it("shows one popover however many times the cell was redrawn", async () => {
		jest.useFakeTimers();
		const cell = document.createElement("span");
		document.body.appendChild(cell);
		// Every status refresh empties the cell and renders it again, attaching once more to the same element
		for (let refresh = 0; refresh < 4; refresh++) {
			attachLinesBreakdown(cell, ref);
		}

		cell.dispatchEvent(new MouseEvent("mouseenter"));
		await jest.advanceTimersByTimeAsync(400);

		expect(document.querySelectorAll(".github-link-lines-popover")).toHaveLength(1);

		cell.dispatchEvent(new MouseEvent("mouseleave"));
		expect(document.querySelectorAll(".github-link-lines-popover")).toHaveLength(0);
		jest.useRealTimers();
	});

	it("uses the pull request of the latest redraw", async () => {
		jest.useFakeTimers();
		const cell = document.createElement("span");
		document.body.appendChild(cell);
		attachLinesBreakdown(cell, ref);
		attachLinesBreakdown(cell, { ...ref, number: 2 });

		const github = jest.requireMock<{ getPullFiles: jest.Mock }>("../github/github");
		github.getPullFiles = jest.fn(() => Promise.resolve({ truncated: false, files: [] }));
		cell.dispatchEvent(new MouseEvent("mouseenter"));
		await jest.advanceTimersByTimeAsync(400);

		expect(github.getPullFiles).toHaveBeenCalledTimes(1);
		expect(github.getPullFiles).toHaveBeenCalledWith({ ...ref, number: 2 });
		cell.dispatchEvent(new MouseEvent("mouseleave"));
		jest.useRealTimers();
	});
});
