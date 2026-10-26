import { describe, expect, it } from "@jest/globals";
import { parseGroups, parsePrRef } from "./pr-ref";

describe("parsePrRef", () => {
	it("reads org/repo#number and pull request URLs, with or without a trailing path", () => {
		const ref = { org: "wix-private", repo: "ricos", number: 10779 };
		expect(parsePrRef(" wix-private/ricos#10779 ")).toEqual(ref);
		expect(parsePrRef("https://github.com/wix-private/ricos/pull/10779")).toEqual(ref);
		expect(parsePrRef("https://github.com/wix-private/ricos/pull/10779/files#diff-1")).toEqual(ref);
	});

	it("rejects everything else", () => {
		for (const bad of ["#123", "ricos#123", "o/r#x", "o/r", "https://github.com/o/r/issues/5", "o/r#1; drop", ""]) {
			expect(parsePrRef(bad)).toBeNull();
		}
	});
});

describe("parseGroups", () => {
	it("reads named groups of references, keeping their order", () => {
		expect(
			parseGroups([
				{ name: "Pages", prs: ["o/r#2", "https://github.com/o/r/pull/1"] },
				{ name: " Blog ", prs: [] },
			]),
		).toEqual([
			{
				name: "Pages",
				refs: [
					{ org: "o", repo: "r", number: 2 },
					{ org: "o", repo: "r", number: 1 },
				],
			},
			{ name: "Blog", refs: [] },
		]);
	});

	it("fails loudly, naming what is wrong", () => {
		expect(() => parseGroups({})).toThrow("list");
		expect(() => parseGroups([{ prs: [] }])).toThrow("Group 1");
		expect(() => parseGroups([{ name: "A" }])).toThrow('Group "A" needs a `prs` list');
		expect(() => parseGroups([{ name: "A", prs: ["nope"] }])).toThrow('Group "A": "nope" is not a pull request');
		expect(() => parseGroups([{ name: "A", prs: [42] }])).toThrow('"42" is not a pull request');
	});
});
