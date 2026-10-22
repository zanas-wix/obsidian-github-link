import type { PullDetail } from "../github/pull-detail";

export type Tone = "success" | "danger" | "attention" | "neutral";

export interface ReadinessItem {
	tone: Tone;
	label: string;
}

export interface Readiness {
	items: ReadinessItem[];
	/** Items that stand in the way of merging: danger and attention */
	blockers: number;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * A merge checklist built only from what is on the PR: draft, reviews, checks, conflicts, base, threads.
 */
export function getReadiness(pull: PullDetail): Readiness {
	if (pull.state !== "open") {
		return { items: [{ tone: "neutral", label: pull.state === "merged" ? "Merged" : "Closed" }], blockers: 0 };
	}

	const failing = pull.checks.filter((check) => check.state === "failure").length;
	const running = pull.checks.filter((check) => check.state === "pending").length;

	const items: ReadinessItem[] = [
		pull.draft
			? { tone: "danger", label: "Draft: mark as ready for review" }
			: { tone: "success", label: "Ready for review" },
		pull.review === "approved"
			? { tone: "success", label: "Approved" }
			: pull.review === "changes-requested"
				? { tone: "danger", label: "Changes requested" }
				: pull.review === "review-required"
					? { tone: "attention", label: "Review required" }
					: { tone: "neutral", label: "No review required" },
		failing > 0
			? { tone: "danger", label: `${plural(failing, "check")} failing` }
			: running > 0
				? { tone: "attention", label: `${plural(running, "check")} running` }
				: pull.checks.length === 0
					? { tone: "neutral", label: "No checks" }
					: { tone: "success", label: `All ${plural(pull.checks.length, "check")} passed` },
		pull.mergeable === "conflicting"
			? { tone: "danger", label: "Merge conflicts" }
			: pull.mergeable === "mergeable"
				? { tone: "success", label: "No conflicts" }
				: { tone: "attention", label: "Conflicts not computed yet" },
		pull.mergeState === "BEHIND"
			? { tone: "attention", label: `Behind ${pull.baseRef}` }
			: { tone: "success", label: `Up to date with ${pull.baseRef}` },
		pull.unresolvedThreads > 0
			? { tone: "attention", label: `${plural(pull.unresolvedThreads, "unresolved conversation")}` }
			: { tone: "success", label: "No unresolved conversations" },
	];

	return { items, blockers: items.filter((item) => item.tone === "danger" || item.tone === "attention").length };
}
