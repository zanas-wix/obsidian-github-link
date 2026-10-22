import type { PullDetail } from "../github/pull-detail";

export type MergeAction =
	| { kind: "merge" }
	| { kind: "enable-auto-merge" }
	| { kind: "disable-auto-merge" }
	| { kind: "none" };

/**
 * The one action offered for an open pull request:
 * - auto-merge is on: switch it off
 * - approved (or no review needed), no failing or running check, no conflicts, not a draft: squash & merge now
 * - otherwise: switch auto-merge on, when GitHub allows it for this PR
 */
export function getMergeAction(pull: PullDetail): MergeAction {
	if (pull.state !== "open") {
		return { kind: "none" };
	}
	if (pull.autoMerge) {
		return pull.canDisableAutoMerge ? { kind: "disable-auto-merge" } : { kind: "none" };
	}

	const checksGreen = pull.checks.every((check) => check.state === "success" || check.state === "neutral");
	const approved = pull.review === "approved" || pull.review === null;
	if (!pull.draft && approved && checksGreen && pull.mergeable === "mergeable" && pull.squashAllowed) {
		return { kind: "merge" };
	}
	return pull.canEnableAutoMerge ? { kind: "enable-auto-merge" } : { kind: "none" };
}
