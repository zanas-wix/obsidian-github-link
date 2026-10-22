import { describe, expect, it } from "@jest/globals";
import { groupIntoStacks, type PullBranches } from "./stack";

interface PR {
	n: number;
	base: string;
	head: string;
	repo?: string;
}

function branches(pr: PR): PullBranches {
	const repo = pr.repo ?? "org/repo";
	return { repo, base: pr.base, headRepo: repo, head: pr.head };
}

describe("groupIntoStacks", () => {
	it("orders a stack bottom to top and pulls it together at its earliest member", () => {
		const prs: PR[] = [
			{ n: 1, base: "feat-b", head: "feat-c" }, // top of stack
			{ n: 2, base: "main", head: "solo" },
			{ n: 3, base: "main", head: "feat-a" }, // bottom of stack
			{ n: 4, base: "feat-a", head: "feat-b" }, // middle
		];

		const { ordered, positions } = groupIntoStacks(prs, branches);

		expect(ordered.map((p) => p.n)).toEqual([3, 4, 1, 2]);
		expect(ordered.slice(0, 3).map((p) => positions.get(p))).toEqual([
			{ position: 1, size: 3, depth: 0 },
			{ position: 2, size: 3, depth: 1 },
			{ position: 3, size: 3, depth: 2 },
		]);
		expect(positions.has(prs[1])).toBe(false);
	});

	it("does not stack PRs with the same branch names in different repositories", () => {
		const prs: PR[] = [
			{ n: 1, base: "main", head: "feat-a", repo: "org/one" },
			{ n: 2, base: "feat-a", head: "feat-b", repo: "org/two" },
		];

		const { ordered, positions } = groupIntoStacks(prs, branches);

		expect(ordered.map((p) => p.n)).toEqual([1, 2]);
		expect(positions.size).toBe(0);
	});

	it("keeps PRs that cannot be stacked and survives branch cycles", () => {
		const prs: PR[] = [
			{ n: 1, base: "b", head: "a" },
			{ n: 2, base: "a", head: "b" },
			{ n: 3, base: "main", head: "x" },
		];

		const { ordered } = groupIntoStacks(prs, (p) => (p.n === 3 ? null : branches(p)));

		expect(ordered.map((p) => p.n).sort()).toEqual([1, 2, 3]);
	});

	it("keeps siblings of a forked stack together, in input order", () => {
		const prs: PR[] = [
			{ n: 1, base: "base", head: "left" },
			{ n: 2, base: "main", head: "base" },
			{ n: 3, base: "base", head: "right" },
		];

		const { ordered, positions } = groupIntoStacks(prs, branches);

		expect(ordered.map((p) => p.n)).toEqual([2, 1, 3]);
		expect(positions.get(prs[2])).toEqual({ position: 3, size: 3, depth: 1 });
	});
});
