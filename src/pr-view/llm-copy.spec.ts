import { describe, expect, it } from "@jest/globals";
import type { PullDetail, TimelineItem } from "../github/pull-detail";
import { formatForLlm } from "./llm-copy";

const pull = {
	ref: { org: "o", repo: "r", number: 7 },
	title: "Add pages",
	headRef: "feat/pages",
	baseRef: "main",
} as PullDetail;
const author = (login: string) => ({ login, avatarUrl: null });
const at = { at: "2026-10-01T00:00:00Z", url: "u" };

describe("formatForLlm", () => {
	it("gives a review thread its file, line, code and whole conversation in order", () => {
		const thread: TimelineItem = {
			kind: "thread",
			resolved: false,
			outdated: false,
			path: "src/a.ts",
			line: 12,
			diffHunk: "@@ -1 +1 @@\n-old\n+new",
			at: at.at,
			comments: [
				{ author: author("alice"), body: "Why not reuse helper?\n", ...at },
				{ author: author("bob"), body: "Good point", ...at },
			],
		};

		expect(formatForLlm(pull, thread)).toBe(
			[
				'Address this review feedback on PR #7 in o/r ("Add pages", feat/pages into main).',
				"",
				"File: src/a.ts:12",
				"",
				"Code under discussion:",
				"```diff",
				"@@ -1 +1 @@",
				"-old",
				"+new",
				"```",
				"",
				"Conversation:",
				"@alice: Why not reuse helper?",
				"",
				"@bob: Good point",
			].join("\n"),
		);
	});

	it("flags an outdated thread and copes with a missing line and hunk", () => {
		const text = formatForLlm(pull, {
			kind: "thread",
			resolved: true,
			outdated: true,
			path: "src/b.ts",
			line: null,
			diffHunk: "",
			at: at.at,
			comments: [{ author: author("alice"), body: "nit", ...at }],
		});

		expect(text).toContain("File: src/b.ts\n");
		expect(text).toContain("outdated");
		expect(text).not.toContain("```diff");
	});

	it("names who said it and what kind of review it was for comments and reviews", () => {
		expect(formatForLlm(pull, { kind: "comment", author: author("alice"), body: "Please add tests", ...at })).toContain(
			"@alice commented:\n\nPlease add tests",
		);
		expect(
			formatForLlm(pull, { kind: "review", state: "changes-requested", author: author("bob"), body: "Fix X", ...at }),
		).toContain("@bob left a review (requested changes):\n\nFix X");
	});
});
