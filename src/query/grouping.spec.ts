import { describe, expect, it } from "@jest/globals";
import type { PullStatus } from "../github/pull-status";
import { IssueStatus } from "../github/response";
import { groupRows, readinessGroup, type GroupContext } from "./grouping";

interface Row {
	id: number;
	repo?: string;
	status?: IssueStatus;
	author?: string;
	updated?: string;
	pull?: PullStatus;
}

const NOW = Date.UTC(2026, 9, 22, 12);
const hoursAgo = (hours: number) => new Date(NOW - hours * 3600 * 1000).toISOString();
const ctx: GroupContext<Row> = {
	repo: (row) => row.repo ?? null,
	status: (row) => row.status ?? IssueStatus.Open,
	author: (row) => row.author ?? null,
	updatedAt: (row) => row.updated,
	pullStatus: (row) => row.pull,
	now: NOW,
};
const ids = (groups: { label: string; rows: Row[] }[]) => groups.map((g) => [g.label, g.rows.map((r) => r.id)]);
const pull = (overrides: Partial<PullStatus> = {}): PullStatus => ({
	state: "open",
	draft: false,
	review: "approved",
	merge: "mergeable",
	ci: { state: "success", passed: 1, total: 1 },
	...overrides,
});

describe("groupRows", () => {
	it("returns one unlabelled group when not grouping", () => {
		expect(ids(groupRows([{ id: 1 }, { id: 2 }], "none", ctx))).toEqual([["", [1, 2]]]);
	});

	it("groups by repo in order of first appearance, keeping row order and linking the heading", () => {
		const groups = groupRows(
			[{ id: 1, repo: "o/b" }, { id: 2, repo: "o/a" }, { id: 3, repo: "o/b" }, { id: 4 }],
			"repo",
			ctx,
		);
		expect(ids(groups)).toEqual([
			["o/b", [1, 3]],
			["o/a", [2]],
			["Unknown repository", [4]],
		]);
		expect(groups[0].href).toBe("https://github.com/o/b");
		expect(groups[2].href).toBeUndefined();
	});

	it("groups by status in the fixed order open, draft, merged, closed, skipping empty ones", () => {
		const rows: Row[] = [
			{ id: 1, status: IssueStatus.Closed },
			{ id: 2, status: IssueStatus.Open },
			{ id: 3, status: IssueStatus.Done },
			{ id: 4, status: IssueStatus.Open },
		];
		expect(ids(groupRows(rows, "status", ctx))).toEqual([
			["Open", [2, 4]],
			["Merged", [3]],
			["Closed", [1]],
		]);
	});

	it("groups by author in order of first appearance", () => {
		const rows: Row[] = [
			{ id: 1, author: "bob" },
			{ id: 2, author: "alice" },
			{ id: 3, author: "bob" },
		];
		expect(ids(groupRows(rows, "author", ctx))).toEqual([
			["bob", [1, 3]],
			["alice", [2]],
		]);
	});

	it("groups by age buckets, newest first, with missing or invalid dates as Older", () => {
		const rows: Row[] = [
			{ id: 1, updated: hoursAgo(24 * 60) },
			{ id: 2, updated: hoursAgo(2) },
			{ id: 3, updated: hoursAgo(24 * 3) },
			{ id: 4, updated: hoursAgo(24 * 10) },
			{ id: 5 },
			{ id: 6, updated: "nonsense" },
		];
		expect(ids(groupRows(rows, "updated", ctx))).toEqual([
			["Today", [2]],
			["This week", [3]],
			["This month", [4]],
			["Older", [1, 5, 6]],
		]);
	});

	it("groups by merge readiness, most actionable first, and shows 'Checking…' until statuses arrive", () => {
		const rows: Row[] = [
			{ id: 1 },
			{ id: 2, pull: pull({ review: "review-required" }) },
			{ id: 3, pull: pull() },
			{ id: 4, pull: pull({ draft: true }) },
			{ id: 5, pull: pull({ state: "merged" }) },
		];
		expect(ids(groupRows(rows, "readiness", ctx))).toEqual([
			["Ready to merge", [3]],
			["Needs review", [2]],
			["Draft", [4]],
			["Merged / closed", [5]],
			["Checking…", [1]],
		]);
	});
});

describe("readinessGroup", () => {
	it("names the most blocking reason first", () => {
		expect(readinessGroup(pull({ merge: "conflicting", ci: { state: "failure", passed: 0, total: 1 } }))).toBe(
			"Conflicts",
		);
		expect(readinessGroup(pull({ ci: { state: "failure", passed: 0, total: 1 }, review: "changes-requested" }))).toBe(
			"CI failing",
		);
		expect(readinessGroup(pull({ review: "changes-requested" }))).toBe("Changes requested");
		expect(readinessGroup(pull({ ci: { state: "pending", passed: 0, total: 1 }, review: "review-required" }))).toBe(
			"CI running",
		);
	});

	it("treats a merge state GitHub has not computed yet as still checking", () => {
		expect(readinessGroup(pull({ merge: "unknown" }))).toBe("Checking…");
	});
});
