import { describe, expect, it } from "@jest/globals";
import { getSearchResultPRStatus, IssueStatus } from "./response";
import { buildPullSummaryQuery, parsePullSummaries } from "./pull-summary";
import { pullKey } from "./pull-status";

const refs = [
	{ org: "o", repo: "r", number: 1 },
	{ org: "o", repo: "r", number: 2 },
	{ org: "o", repo: "gone", number: 3 },
];
const pull = (overrides = {}) => ({
	number: 1,
	title: "T",
	url: "https://github.com/o/r/pull/1",
	state: "OPEN",
	isDraft: false,
	merged: false,
	mergedAt: null,
	closedAt: null,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-02T00:00:00Z",
	baseRefName: "main",
	headRefName: "feat",
	author: { login: "me", avatarUrl: "a.png", url: "https://github.com/me" },
	labels: { nodes: [{ name: "bug", color: "f00" }] },
	headRepository: { nameWithOwner: "o/r" },
	...overrides,
});

describe("pull summaries", () => {
	it("asks for every reference by alias and rejects names that could break out of the query", () => {
		expect(buildPullSummaryQuery(refs)).toContain('p2: repository(owner: "o", name: "gone")');
		expect(() => buildPullSummaryQuery([{ org: 'x") {', repo: "r", number: 1 }])).toThrow();
	});

	const { rows, missing } = parsePullSummaries(refs, {
		p0: { nameWithOwner: "o/r", pullRequest: pull() },
		p1: {
			nameWithOwner: "o/r",
			pullRequest: pull({ number: 2, merged: true, state: "MERGED", mergedAt: "2026-01-03T00:00:00Z" }),
		},
		p2: null,
	});

	it("adapts a pull request to the row a list reads, repository, author, labels and branches included", () => {
		expect(rows.get(pullKey(refs[0]))).toMatchObject({
			number: 1,
			html_url: "https://github.com/o/r/pull/1",
			repository_url: "https://api.github.com/repos/o/r",
			user: { login: "me", avatar_url: "a.png" },
			labels: [{ name: "bug", color: "f00" }],
			base: { ref: "main", repo: { full_name: "o/r" } },
			head: { ref: "feat", repo: { full_name: "o/r" } },
		});
	});

	it("gives the row the same status icon a search result would", () => {
		const status = (key: string) =>
			getSearchResultPRStatus(rows.get(key) as Parameters<typeof getSearchResultPRStatus>[0]);
		expect(status(pullKey(refs[0]))).toBe(IssueStatus.Open);
		expect(status(pullKey(refs[1]))).toBe(IssueStatus.Done);
	});

	it("reports references GitHub did not return", () => {
		expect(missing).toEqual([refs[2]]);
	});
});
