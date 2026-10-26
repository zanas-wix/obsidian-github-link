import { setIcon } from "obsidian";
import { rowPullStatuses, type PullStatus } from "../../github/pull-status";
import type { ColumnsMap } from "./base";

type Tone = "success" | "danger" | "attention";

const TONE_ICON: Record<Tone, string> = {
	success: "lucide-check",
	danger: "lucide-x",
	attention: "lucide-clock",
};

function pill(el: HTMLElement, tone: Tone, text: string): void {
	const wrapper = el.createSpan({ cls: "github-link-pill" });
	wrapper.dataset.tone = tone;
	setIcon(wrapper.createSpan({ cls: "github-link-pill-icon" }), TONE_ICON[tone]);
	wrapper.createSpan({ text });
}

const REVIEW: Record<NonNullable<PullStatus["review"]>, [Tone, string]> = {
	approved: ["success", "Approved"],
	"changes-requested": ["danger", "Changes requested"],
	"review-required": ["attention", "Review required"],
};

const CI: Record<NonNullable<PullStatus["ci"]["state"]>, Tone> = {
	success: "success",
	failure: "danger",
	pending: "attention",
};

/**
 * Columns backed by `rowPullStatuses`, which the query fills in when one of them is requested.
 * Rows without a status (not loaded, or GitHub did not return the PR) stay empty.
 */
export const PullStatusColumns: ColumnsMap = {
	review: {
		header: "Review",
		cell: (row, el) => {
			const review = rowPullStatuses.get(row)?.review;
			if (review) {
				pill(el, ...REVIEW[review]);
			}
		},
	},
	ci: {
		header: "CI",
		cell: (row, el) => {
			const ci = rowPullStatuses.get(row)?.ci;
			if (ci?.state) {
				pill(el, CI[ci.state], `${ci.passed}/${ci.total}`);
			}
		},
	},
	lines: {
		header: "Lines",
		cell: (row, el) => {
			const status = rowPullStatuses.get(row);
			if (status) {
				el.addClass("github-link-lines");
				el.createSpan({ cls: "github-link-lines-added", text: `+${status.additions}` });
				el.createSpan({ text: "/" });
				el.createSpan({ cls: "github-link-lines-removed", text: `-${status.deletions}` });
			}
		},
	},
	merge: {
		header: "Merge",
		cell: (row, el) => {
			const merge = rowPullStatuses.get(row)?.merge;
			if (merge === "mergeable") {
				pill(el, "success", "Mergeable");
			} else if (merge === "conflicting") {
				pill(el, "danger", "Conflicts");
			}
		},
	},
};
