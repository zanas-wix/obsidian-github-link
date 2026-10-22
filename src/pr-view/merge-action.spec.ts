import { describe, expect, it } from "@jest/globals";
import type { PullDetail } from "../github/pull-detail";
import { getDraftAction, getMergeAction } from "./merge-action";

const ready = {
	state: "open",
	draft: false,
	review: "approved",
	mergeable: "mergeable",
	squashAllowed: true,
	autoMerge: null,
	canEnableAutoMerge: true,
	canDisableAutoMerge: false,
	checks: [{ name: "a", state: "success", url: null }],
} as unknown as PullDetail;

describe("getMergeAction", () => {
	it("offers squash & merge when approved, green and conflict-free", () => {
		expect(getMergeAction(ready)).toEqual({ kind: "merge" });
	});

	it("also merges when no review is required", () => {
		expect(getMergeAction({ ...ready, review: null })).toEqual({ kind: "merge" });
	});

	it("offers auto-merge instead while something still blocks the merge", () => {
		for (const blocked of [
			{ review: "review-required" },
			{ review: "changes-requested" },
			{ mergeable: "conflicting" },
			{ draft: true },
			{ checks: [{ name: "a", state: "pending", url: null }] },
			{ checks: [{ name: "a", state: "failure", url: null }] },
		]) {
			expect(getMergeAction({ ...ready, ...blocked } as unknown as PullDetail)).toEqual({
				kind: "enable-auto-merge",
			});
		}
	});

	it("only offers turning auto-merge off while it is on", () => {
		const enabled = { ...ready, autoMerge: { method: "SQUASH", enabledBy: "me" }, canDisableAutoMerge: true };
		expect(getMergeAction(enabled)).toEqual({ kind: "disable-auto-merge" });
		expect(getMergeAction({ ...enabled, canDisableAutoMerge: false })).toEqual({ kind: "none" });
	});

	it("offers nothing when GitHub does not allow it, or the PR is not open", () => {
		expect(getMergeAction({ ...ready, review: "review-required", canEnableAutoMerge: false })).toEqual({
			kind: "none",
		});
		expect(getMergeAction({ ...ready, squashAllowed: false, canEnableAutoMerge: false })).toEqual({ kind: "none" });
		expect(getMergeAction({ ...ready, state: "merged" } as unknown as PullDetail)).toEqual({ kind: "none" });
	});
});

describe("getDraftAction", () => {
	it("marks a draft ready and turns a ready pull request back into a draft", () => {
		expect(getDraftAction({ ...ready, draft: true, canUpdate: true } as unknown as PullDetail)).toBe("ready");
		expect(getDraftAction({ ...ready, draft: false, canUpdate: true } as unknown as PullDetail)).toBe("draft");
	});

	it("offers nothing without edit rights or once the pull request is closed", () => {
		expect(getDraftAction({ ...ready, canUpdate: false } as unknown as PullDetail)).toBeNull();
		expect(getDraftAction({ ...ready, canUpdate: true, state: "merged" } as unknown as PullDetail)).toBeNull();
	});
});
