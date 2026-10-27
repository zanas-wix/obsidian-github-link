import { describe, expect, it } from "@jest/globals";
import { buildPullDetailQuery, parsePullDetail, type PullDetailResponse } from "./pull-detail";

const ref = { org: "wix-private", repo: "ricos", number: 7 };
const author = { login: "zanas-wix", avatarUrl: "a.png" };

const response: PullDetailResponse = {
	repository: {
		pullRequest: {
			id: "PR_kwDOabc123",
			title: "Add pages",
			url: "https://github.com/wix-private/ricos/pull/7",
			body: "Body",
			state: "OPEN",
			isDraft: false,
			merged: false,
			createdAt: "2026-10-01T10:00:00Z",
			updatedAt: "2026-10-03T10:00:00Z",
			author,
			baseRefName: "main",
			headRefName: "feat/pages",
			headRefOid: "f3f673bc36762a49ee083bb067f2e2878828a569",
			additions: 10,
			deletions: 2,
			changedFiles: 2,
			reviewDecision: "CHANGES_REQUESTED",
			mergeable: "CONFLICTING",
			mergeStateStatus: "DIRTY",
			labels: { nodes: [{ name: "bug", color: "ff0000" }] },
			reviewRequests: {
				nodes: [{ requestedReviewer: { login: "bob" } }, { requestedReviewer: { name: "core-team" } }],
			},
			latestReviews: { nodes: [{ author, state: "CHANGES_REQUESTED", submittedAt: "2026-10-02T10:00:00Z" }] },
			comments: { nodes: [{ author, body: "late", createdAt: "2026-10-03T09:00:00Z", url: "c1" }] },
			reviews: {
				nodes: [
					{ author, state: "COMMENTED", body: "", submittedAt: "2026-10-02T09:00:00Z", url: "r0" },
					{ author, state: "CHANGES_REQUESTED", body: "Please fix", submittedAt: "2026-10-02T10:00:00Z", url: "r1" },
				],
			},
			reviewThreads: {
				nodes: [
					{
						isResolved: false,
						isOutdated: false,
						path: "src/a.ts",
						line: 12,
						comments: {
							nodes: [{ author, body: "nit", createdAt: "2026-10-02T09:30:00Z", url: "t1", diffHunk: "@@ -1 +1 @@" }],
						},
					},
					{ isResolved: true, isOutdated: true, path: "src/b.ts", line: null, comments: { nodes: [] } },
				],
			},
			files: { nodes: [{ path: "src/a.ts", additions: 8, deletions: 1 }] },
			commits: {
				nodes: [
					{
						commit: {
							statusCheckRollup: {
								contexts: {
									nodes: [
										{
											__typename: "CheckRun",
											name: "lint",
											status: "COMPLETED",
											conclusion: "SUCCESS",
											detailsUrl: "u1",
										},
										{
											__typename: "CheckRun",
											name: "build",
											status: "COMPLETED",
											conclusion: "FAILURE",
											detailsUrl: "u2",
										},
										{ __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null, detailsUrl: null },
										{
											__typename: "CheckRun",
											name: "docs",
											status: "COMPLETED",
											conclusion: "SKIPPED",
											detailsUrl: null,
										},
										{ __typename: "StatusContext", context: "legacy", state: "PENDING", targetUrl: null },
									],
								},
							},
						},
					},
				],
			},
		},
	},
};

describe("parsePullDetail", () => {
	const detail = parsePullDetail(ref, response)!;

	it("maps state, review decision and merge state", () => {
		expect(detail).toMatchObject({
			state: "open",
			review: "changes-requested",
			mergeable: "conflicting",
			mergeState: "DIRTY",
			baseRef: "main",
			headRef: "feat/pages",
			headSha: "f3f673bc36762a49ee083bb067f2e2878828a569",
			requestedReviewers: ["bob", "core-team"],
		});
	});

	it("orders the timeline by time, keeps threads, and drops empty review wrappers and empty threads", () => {
		expect(detail.timeline.map((item) => item.kind)).toEqual(["thread", "review", "comment"]);
		expect(detail.unresolvedThreads).toBe(1);
	});

	it("puts failing checks first, then running, then passing", () => {
		expect(detail.checks.map((check) => `${check.name}:${check.state}`)).toEqual([
			"build:failure",
			"e2e:pending",
			"legacy:pending",
			"lint:success",
			"docs:neutral",
		]);
	});

	it("is null for a pull request GitHub did not return", () => {
		expect(parsePullDetail(ref, { repository: { pullRequest: null } })).toBeNull();
	});

	it("rejects references that could break out of the query", () => {
		expect(() => buildPullDetailQuery({ org: 'x") { y', repo: "r", number: 1 })).toThrow();
	});
});
