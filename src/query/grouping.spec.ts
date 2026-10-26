import { describe, expect, it } from "@jest/globals";
import type { PullStatus } from "../github/pull-status";
import { IssueStatus } from "../github/response";
import { groupCustom, groupNested, groupRows, isGroupBy, readinessGroup, type GroupContext } from "./grouping";

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
	additions: 0,
	deletions: 0,
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

describe("custom groups", () => {
	interface R extends Row {
		listed?: [string, number];
		run?: number;
	}
	const custom: GroupContext<R> = {
		...ctx,
		custom: (row) => (row.listed ? { group: row.listed[0], index: row.listed[1] } : null),
		customGroups: ["Pages", "Blog"],
		stackRun: (row) => row.run ?? null,
	};

	it("shows groups in the order the block defines them, with unlisted rows last under Other", () => {
		const rows: R[] = [{ id: 1, listed: ["Blog", 0] }, { id: 2 }, { id: 3, listed: ["Pages", 0] }];
		expect(ids(groupCustom(rows, custom))).toEqual([
			["Pages", [3]],
			["Blog", [1]],
			["Other", [2]],
		]);
	});

	it("keeps rows in the order they are listed, not the order the search returned them", () => {
		const rows: R[] = [
			{ id: 1, listed: ["Pages", 2] },
			{ id: 2, listed: ["Pages", 0] },
			{ id: 3, listed: ["Pages", 1] },
		];
		expect(ids(groupCustom(rows, custom))).toEqual([["Pages", [2, 3, 1]]]);
	});

	it("keeps a stack together in its own order at its earliest listed member", () => {
		// 10, 11, 12 are one stack (bottom first) listed top-first; 20 is listed between them
		const rows: R[] = [
			{ id: 10, run: 1, listed: ["Pages", 3] },
			{ id: 11, run: 1, listed: ["Pages", 1] },
			{ id: 12, run: 1, listed: ["Pages", 0] },
			{ id: 20, listed: ["Pages", 2] },
			{ id: 30, listed: ["Pages", 4] },
		];
		expect(ids(groupCustom(rows, custom))).toEqual([["Pages", [10, 11, 12, 20, 30]]]);
	});

	it("shows no empty groups", () => {
		expect(ids(groupCustom([{ id: 1, listed: ["Blog", 0] } as R], custom))).toEqual([["Blog", [1]]]);
	});

	describe("nested", () => {
		const rows: R[] = [
			{ id: 1, repo: "o/a", listed: ["Pages", 0] },
			{ id: 2, repo: "o/b", listed: ["Pages", 1] },
			{ id: 3, repo: "o/a", listed: ["Pages", 2] },
			{ id: 4, repo: "o/b", listed: ["Blog", 0] },
			{ id: 5, repo: "o/a" },
		];

		it("splits each custom group by the chosen grouping, keeping the listed order inside", () => {
			const groups = groupNested(rows, "repo", custom);
			expect(groups.map((g) => g.label)).toEqual(["Pages", "Blog", "Other"]);
			expect(groups.map((g) => ids(g.children ?? []))).toEqual([
				[
					["o/a", [1, 3]],
					["o/b", [2]],
				],
				[["o/b", [4]]],
				[["o/a", [5]]],
			]);
			expect(groups[0].rows.map((r) => r.id)).toEqual([1, 2, 3]);
		});

		it("leaves custom groups unsplit when not sub-grouping", () => {
			const groups = groupNested(rows, "none", custom);
			expect(groups.map((g) => g.children)).toEqual([undefined, undefined, undefined]);
		});

		it("is plain single-level grouping when the block defines no custom groups", () => {
			const plain = { ...custom, customGroups: [] };
			expect(ids(groupNested(rows, "repo", plain))).toEqual([
				["o/a", [1, 3, 5]],
				["o/b", [2, 4]],
			]);
		});
	});
});

describe("isGroupBy", () => {
	it("accepts the known groupings only", () => {
		expect(isGroupBy("repo")).toBe(true);
		expect(isGroupBy("custom")).toBe(false);
		expect(isGroupBy("typo")).toBe(false);
		expect(isGroupBy(undefined)).toBe(false);
	});
});
