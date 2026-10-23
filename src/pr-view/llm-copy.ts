import type { PullDetail, TimelineItem } from "../github/pull-detail";

const REVIEW_LABEL = {
	approved: "approved",
	"changes-requested": "requested changes",
	commented: "commented",
	dismissed: "dismissed review",
	pending: "pending review",
} as const;

/**
 * A timeline item as plain text to paste into an LLM so it can act on it: what PR it is about, where
 * in the code (for review threads: file, line and the diff hunk), and the words, in order.
 */
export function formatForLlm(pull: PullDetail, item: TimelineItem): string {
	const subject = `PR #${pull.ref.number} in ${pull.ref.org}/${pull.ref.repo} ("${pull.title}", ${pull.headRef} into ${pull.baseRef})`;

	if (item.kind === "thread") {
		const lines = [
			`Address this review feedback on ${subject}.`,
			"",
			`File: ${item.path}${item.line ? `:${item.line}` : ""}`,
		];
		if (item.outdated) {
			lines.push("(This thread is outdated: the code it refers to has since changed.)");
		}
		if (item.diffHunk) {
			lines.push("", "Code under discussion:", "```diff", item.diffHunk, "```");
		}
		lines.push("", "Conversation:");
		for (const comment of item.comments) {
			lines.push(`@${comment.author.login}: ${comment.body.trim()}`, "");
		}
		return lines.join("\n").trimEnd();
	}

	const how = item.kind === "review" ? `left a review (${REVIEW_LABEL[item.state]})` : "commented";
	return [`Address this feedback on ${subject}.`, "", `@${item.author.login} ${how}:`, "", item.body.trim()].join("\n");
}
