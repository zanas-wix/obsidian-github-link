import { describe, expect, it } from "@jest/globals";
import { expandOrQuery } from "./or-query";

describe("expandOrQuery", () => {
	it("leaves queries without OR untouched", () => {
		expect(expandOrQuery('is:pr  label:"a b"')).toEqual(['is:pr  label:"a b"']);
	});

	it("distributes the surrounding terms over a parenthesised OR", () => {
		expect(expandOrQuery("is:pr (author:me OR assignee:me) is:open")).toEqual([
			"is:pr author:me is:open",
			"is:pr assignee:me is:open",
		]);
	});

	it("gives AND higher precedence than OR when there are no parentheses", () => {
		expect(expandOrQuery("is:pr author:me OR assignee:me")).toEqual(["is:pr author:me", "assignee:me"]);
	});

	it("expands several groups and nested groups", () => {
		expect(expandOrQuery("(a OR b) (c OR (d e))")).toEqual(["a c", "a d e", "b c", "b d e"]);
	});

	it("keeps quoted text together and ignores OR inside quotes", () => {
		expect(expandOrQuery('label:"x OR y" OR author:me')).toEqual(['label:"x OR y"', "author:me"]);
	});

	it("rejects unbalanced parentheses and runaway expansions", () => {
		expect(() => expandOrQuery("(a OR b")).toThrow();
		expect(() => expandOrQuery("a OR b)")).toThrow();
		const wide = Array.from({ length: 5 }, () => "(a OR b OR c)").join(" ");
		expect(() => expandOrQuery(wide)).toThrow();
	});
});

describe("expandOrQuery keyword case", () => {
	it("accepts lowercase or", () => {
		expect(expandOrQuery("is:pr author:me state:open or is:pr assignee:me state:open")).toEqual([
			"is:pr author:me state:open",
			"is:pr assignee:me state:open",
		]);
	});
});
