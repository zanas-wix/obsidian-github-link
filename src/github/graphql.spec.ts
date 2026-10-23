import { describe, expect, it } from "@jest/globals";
import { unwrapGraphql } from "./graphql";

describe("unwrapGraphql", () => {
	const refused = {
		data: { enablePullRequestAutoMerge: null },
		errors: [{ message: "Auto-merge is not supported for stacked pull requests." }],
	};

	it("fails a mutation GitHub refused, with GitHub's reason, even though data is present", () => {
		expect(() => unwrapGraphql(refused, true)).toThrow("Auto-merge is not supported for stacked pull requests.");
	});

	it("keeps partial data for a query", () => {
		expect(unwrapGraphql(refused, false)).toEqual({ enablePullRequestAutoMerge: null });
	});

	it("fails when there is no data at all, and passes clean responses", () => {
		expect(() => unwrapGraphql({ errors: [{ message: "bad" }] }, false)).toThrow("bad");
		expect(() => unwrapGraphql({}, false)).toThrow();
		expect(unwrapGraphql({ data: { ok: 1 } }, true)).toEqual({ ok: 1 });
	});
});
