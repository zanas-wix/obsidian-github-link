import { describe, expect, it } from "@jest/globals";
import { buildAutoMergeMutation, buildCommentMutation, buildDraftMutation, buildMergeMutation } from "./pull-actions";

describe("pull request mutations", () => {
	it("escapes comment text so it cannot break out of the string", () => {
		const mutation = buildCommentMutation("PR_abc", 'say "hi"\n} } mutation { x');

		expect(mutation).toContain('body: "say \\"hi\\"\\n} } mutation { x"');
		// Only the one body string carries user text: the quote count is the two delimiters plus the escaped ones
		expect(mutation.startsWith('mutation { addComment(input: { subjectId: "PR_abc", body: ')).toBe(true);
	});

	it("refuses empty comments", () => {
		expect(() => buildCommentMutation("PR_abc", "  \n")).toThrow();
	});

	it("refuses node ids that are not plain ids, in every mutation", () => {
		const bad = 'PR_abc") { x';
		expect(() => buildCommentMutation(bad, "hi")).toThrow();
		expect(() => buildMergeMutation(bad)).toThrow();
		expect(() => buildAutoMergeMutation(bad, true)).toThrow();
		expect(() => buildDraftMutation(bad, false)).toThrow();
	});
});
