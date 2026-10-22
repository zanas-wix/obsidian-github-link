import { describe, expect, it } from "@jest/globals";
import type { PullDetail } from "../github/pull-detail";
import { getReadiness } from "./readiness";

const base = {
	state: "open",
	draft: false,
	review: "approved",
	mergeable: "mergeable",
	mergeState: "CLEAN",
	baseRef: "main",
	unresolvedThreads: 0,
	checks: [{ name: "a", state: "success", url: null }],
} as unknown as PullDetail;

describe("getReadiness", () => {
	it("is ready when nothing blocks the merge", () => {
		expect(getReadiness(base).blockers).toBe(0);
	});

	it("counts every blocker, with the worst reason named", () => {
		const readiness = getReadiness({
			...base,
			draft: true,
			review: "changes-requested",
			mergeable: "conflicting",
			mergeState: "BEHIND",
			unresolvedThreads: 2,
			checks: [
				{ name: "a", state: "failure", url: null },
				{ name: "b", state: "pending", url: null },
			],
		});

		expect(readiness.blockers).toBe(6);
		expect(readiness.items.map((item) => item.label)).toEqual([
			"Draft: mark as ready for review",
			"Changes requested",
			"1 check failing",
			"Merge conflicts",
			"Behind main",
			"2 unresolved conversations",
		]);
	});

	it("does not treat running checks as failures", () => {
		const readiness = getReadiness({ ...base, checks: [{ name: "a", state: "pending", url: null }] });
		expect(readiness.items[2]).toEqual({ tone: "attention", label: "1 check running" });
	});

	it("has no blockers for a merged or closed pull request", () => {
		expect(getReadiness({ ...base, state: "merged", draft: true })).toEqual({
			items: [{ tone: "neutral", label: "Merged" }],
			blockers: 0,
		});
	});
});
