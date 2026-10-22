/**
 * A PR stack is a chain of PRs where each PR targets the head branch of the PR below it.
 * Stacks are derived purely from branch names, within the set of PRs given.
 */

export interface PullBranches {
	/** Full name (`org/repo`) of the repository the PR targets */
	repo: string;
	/** Branch the PR merges into */
	base: string;
	/** Full name (`org/repo`) of the repository the PR branch lives in (differs from `repo` for forks) */
	headRepo: string;
	/** Branch the PR merges from */
	head: string;
}

export interface StackPosition {
	/** 1-based position within the stack, bottom (closest to the trunk) first */
	position: number;
	/** Number of PRs in the stack */
	size: number;
	/** Distance from the bottom of the stack, 0 for the bottom PR */
	depth: number;
}

export interface StackedResult<T> {
	/** Items regrouped so each stack is contiguous and ordered bottom to top */
	ordered: T[];
	/** Position of every item that is part of a stack of 2 or more PRs */
	positions: Map<T, StackPosition>;
}

/**
 * Group items into stacks. Stacks keep the place of their earliest item in the input; items
 * without a stack stay where they were. `getBranches` returns null for items that cannot be stacked.
 */
export function groupIntoStacks<T>(items: T[], getBranches: (item: T) => PullBranches | null): StackedResult<T> {
	const branches = items.map(getBranches);

	// Index PRs by the branch they provide, so a PR can find the PR it is stacked on
	const byHead = new Map<string, number[]>();
	branches.forEach((b, i) => {
		if (!b) return;
		const key = branchKey(b.headRepo, b.head);
		byHead.set(key, [...(byHead.get(key) ?? []), i]);
	});

	const parent = new Array<number>(items.length).fill(-1);
	const children = items.map(() => [] as number[]);
	branches.forEach((b, i) => {
		if (!b) return;
		const candidates = byHead.get(branchKey(b.repo, b.base))?.filter((c) => c !== i);
		if (candidates?.length) {
			parent[i] = candidates[0];
			children[candidates[0]].push(i);
		}
	});

	// Walk each stack from its root. Items never reached are part of a cycle and stay on their own.
	const visited = new Set<number>();
	const stacks: number[][] = [];
	const walk = (index: number, stack: number[]) => {
		if (visited.has(index)) return;
		visited.add(index);
		stack.push(index);
		children[index].forEach((child) => walk(child, stack));
	};
	items.forEach((_, i) => {
		if (parent[i] === -1) {
			const stack: number[] = [];
			walk(i, stack);
			stacks.push(stack);
		}
	});
	items.forEach((_, i) => {
		if (!visited.has(i)) stacks.push([i]);
	});

	stacks.sort((a, b) => Math.min(...a) - Math.min(...b));

	const ordered: T[] = [];
	const positions = new Map<T, StackPosition>();
	for (const stack of stacks) {
		stack.forEach((index, n) => {
			ordered.push(items[index]);
			if (stack.length > 1) {
				positions.set(items[index], { position: n + 1, size: stack.length, depth: depthOf(index, parent) });
			}
		});
	}
	return { ordered, positions };
}

function branchKey(repo: string, branch: string): string {
	return `${repo.toLowerCase()}:${branch}`;
}

function depthOf(index: number, parent: number[]): number {
	let depth = 0;
	for (let p = parent[index]; p !== -1 && depth <= parent.length; p = parent[p]) depth++;
	return depth;
}

/**
 * Stack position of table rows, filled in by the query when stack grouping is on.
 * Keyed by row so column renderers, which only receive the row, can look it up.
 */
export const rowStackPositions = new WeakMap<object, StackPosition>();
