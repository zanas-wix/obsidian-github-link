import { describe, expect, it } from "@jest/globals";
import {
	buildPullStatusQuery,
	isReadyToMerge,
	POLL_DELAY_MS,
	pollDelayMs,
	pollTier,
	parsePullStatuses,
	pullKey,
	type PullStatus,
} from "./pull-status";

const refs = [
	{ org: "wix-private", repo: "ricos", number: 1 },
	{ org: "wix-private", repo: "ricos", number: 2 },
	{ org: "wix-private", repo: "gone", number: 3 },
];

describe("buildPullStatusQuery", () => {
	it("aliases every pull request", () => {
		const query = buildPullStatusQuery(refs);
		expect(query).toContain('p0: repository(owner: "wix-private", name: "ricos")');
		expect(query).toContain("pullRequest(number: 2)");
		expect(query).toContain('p2: repository(owner: "wix-private", name: "gone")');
	});

	it("rejects names that could break out of the query", () => {
		expect(() => buildPullStatusQuery([{ org: 'a") { x', repo: "r", number: 1 }])).toThrow();
		expect(() => buildPullStatusQuery([{ org: "o", repo: "r", number: 1.5 }])).toThrow();
	});
});

describe("parsePullStatuses", () => {
	const data = {
		p0: {
			pullRequest: {
				reviewDecision: "APPROVED",
				mergeable: "MERGEABLE",
				commits: {
					nodes: [
						{
							commit: {
								statusCheckRollup: {
									state: "FAILURE",
									contexts: {
										nodes: [
											{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
											{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
											{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
											{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
											{ __typename: "StatusContext", state: "SUCCESS" },
										],
									},
								},
							},
						},
					],
				},
			},
		},
		p1: {
			pullRequest: {
				reviewDecision: null,
				mergeable: "CONFLICTING",
				commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
			},
		},
		p2: null,
	};

	it("counts passing checks and maps review, merge and CI state", () => {
		const statuses = parsePullStatuses(refs, data);

		expect(statuses.get(pullKey(refs[0]))).toEqual({
			state: "open",
			draft: false,
			review: "approved",
			merge: "mergeable",
			ci: { state: "failure", passed: 3, total: 5 },
		});
		expect(statuses.get(pullKey(refs[1]))).toEqual({
			state: "open",
			draft: false,
			review: null,
			merge: "conflicting",
			ci: { state: null, passed: 0, total: 0 },
		});
	});

	it("omits pull requests GitHub did not return", () => {
		expect(parsePullStatuses(refs, data).has(pullKey(refs[2]))).toBe(false);
	});
});

describe("isReadyToMerge", () => {
	const ready: PullStatus = {
		state: "open",
		draft: false,
		review: "approved",
		merge: "mergeable",
		ci: { state: "success", passed: 3, total: 3 },
	};

	it("is ready when approved, green and conflict-free", () => {
		expect(isReadyToMerge(ready)).toBe(true);
		expect(isReadyToMerge({ ...ready, review: null, ci: { state: null, passed: 0, total: 0 } })).toBe(true);
	});

	it("is not ready while anything is outstanding", () => {
		for (const blocked of [
			{ draft: true },
			{ state: "merged" },
			{ review: "review-required" },
			{ review: "changes-requested" },
			{ merge: "conflicting" },
			{ merge: "unknown" },
			{ ci: { state: "pending", passed: 1, total: 3 } },
			{ ci: { state: "failure", passed: 2, total: 3 } },
		]) {
			expect(isReadyToMerge({ ...ready, ...blocked } as PullStatus)).toBe(false);
		}
	});
});

describe("poll tiers", () => {
	const base: PullStatus = {
		state: "open",
		draft: false,
		review: "review-required",
		merge: "mergeable",
		ci: { state: "success", passed: 1, total: 1 },
	};

	it("watches closely while CI runs or the merge state is being computed", () => {
		expect(pollTier({ ...base, ci: { state: "pending", passed: 0, total: 1 } })).toBe("active");
		expect(pollTier({ ...base, merge: "unknown" })).toBe("active");
	});

	it("waits normally for a human, and backs off while the PR is stuck", () => {
		expect(pollTier(base)).toBe("waiting");
		expect(pollTier({ ...base, draft: true })).toBe("idle");
		expect(pollTier({ ...base, review: "changes-requested" })).toBe("idle");
		expect(pollTier({ ...base, ci: { state: "failure", passed: 0, total: 1 } })).toBe("idle");
	});

	it("does not poll fast just because mergeable stays unknown on a stuck PR", () => {
		expect(pollTier({ ...base, merge: "unknown", draft: true })).toBe("idle");
		expect(pollTier({ ...base, merge: "unknown", ci: { state: "failure", passed: 0, total: 1 } })).toBe("idle");
	});

	it("is paced by the most urgent PR", () => {
		const running = { ...base, ci: { state: "pending" as const, passed: 0, total: 1 } };
		expect(pollDelayMs([{ ...base, draft: true }, running])).toBe(POLL_DELAY_MS.active);
		expect(pollDelayMs([{ ...base, draft: true }])).toBe(POLL_DELAY_MS.idle);
		expect(pollDelayMs([])).toBe(POLL_DELAY_MS.waiting);
	});
});
