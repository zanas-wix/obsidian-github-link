import { describe, expect, it } from "@jest/globals";
import { buildPullStatusQuery, parsePullStatuses, pullKey } from "./pull-status";

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
			review: "approved",
			merge: "mergeable",
			ci: { state: "failure", passed: 3, total: 5 },
		});
		expect(statuses.get(pullKey(refs[1]))).toEqual({
			review: null,
			merge: "conflicting",
			ci: { state: null, passed: 0, total: 0 },
		});
	});

	it("omits pull requests GitHub did not return", () => {
		expect(parsePullStatuses(refs, data).has(pullKey(refs[2]))).toBe(false);
	});
});
