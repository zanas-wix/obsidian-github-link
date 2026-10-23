import { describe, expect, it } from "@jest/globals";
import { getSearchResultPRStatus, IssueStatus } from "../github/response";
import { applyPullState } from "./pull-state";

const open = () => ({ state: "open", closed_at: null, draft: false, pull_request: { merged_at: null } });
const status = (row: object) => getSearchResultPRStatus(row as Parameters<typeof getSearchResultPRStatus>[0]);

describe("applyPullState", () => {
	it("turns an open row into a merged one", () => {
		const row = open();
		expect(applyPullState(row, "merged", false)).toBe(true);
		expect(status(row)).toBe(IssueStatus.Done);
	});

	it("closes and reopens, and tracks draft only while open", () => {
		const row = open();
		expect(applyPullState(row, "closed", false)).toBe(true);
		expect(status(row)).toBe(IssueStatus.Closed);
		expect(applyPullState(row, "open", true)).toBe(true);
		expect(status(row)).toBe(IssueStatus.Draft);
		expect(applyPullState(row, "open", false)).toBe(true);
		expect(status(row)).toBe(IssueStatus.Open);
	});

	it("reports no change when the state is the same, so nothing is redrawn", () => {
		expect(applyPullState(open(), "open", false)).toBe(false);
	});

	it("handles rows without a pull_request object, as repo lists have", () => {
		const row = { state: "open", closed_at: null, draft: false };
		expect(applyPullState(row, "merged", false)).toBe(true);
		expect(status(row)).toBe(IssueStatus.Done);
	});
});
