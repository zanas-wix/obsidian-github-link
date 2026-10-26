import { isReadyToMerge, type PullStatus } from "../github/pull-status";
import { IssueStatus } from "../github/response";

export type GroupBy = "none" | "repo" | "status" | "author" | "updated" | "readiness" | "custom";

export const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
	{ value: "none", label: "No grouping" },
	{ value: "repo", label: "By repo" },
	{ value: "status", label: "By status" },
	{ value: "author", label: "By author" },
	{ value: "updated", label: "By last update" },
	{ value: "readiness", label: "By merge readiness" },
	{ value: "custom", label: "Custom groups" },
];

/** The label of rows no custom group lists */
export const OTHER_GROUP = "Other";

export interface Group<T> {
	key: string;
	label: string;
	/** Where the heading links to, when it names something with a page of its own */
	href?: string;
	rows: T[];
}

/** How to read each grouping criterion off a row; injected so the grouping rules stay independent of GitHub's response shapes */
export interface GroupContext<T> {
	repo: (row: T) => string | null;
	status: (row: T) => IssueStatus;
	author: (row: T) => string | null;
	updatedAt: (row: T) => string | null | undefined;
	/** Review, CI and merge state; undefined until the lazy status load has finished */
	pullStatus: (row: T) => PullStatus | undefined;
	now: number;
	/** For "custom": the group a row is listed in and its position there; null when no group lists it */
	custom?: (row: T) => { group: string; index: number } | null;
	/** For "custom": the group names in the order the block defines them */
	customGroups?: string[];
	/** For "custom": rows with the same non-null id are a stack and stay together, in their given order */
	stackRun?: (row: T) => number | null;
}

const DAY_MS = 24 * 3600 * 1000;

const STATUS_GROUPS: Record<IssueStatus, { label: string; rank: number }> = {
	[IssueStatus.Open]: { label: "Open", rank: 0 },
	[IssueStatus.Draft]: { label: "Draft", rank: 1 },
	[IssueStatus.Done]: { label: "Merged", rank: 2 },
	[IssueStatus.Closed]: { label: "Closed", rank: 3 },
};

const UPDATED_GROUPS = ["Today", "This week", "This month", "Older"];

/** Most actionable first: what can be merged now, then what is waiting on something, then what is not live */
const READINESS_GROUPS = [
	"Ready to merge",
	"Needs review",
	"CI running",
	"CI failing",
	"Changes requested",
	"Conflicts",
	"Draft",
	"Merged / closed",
	"Checking…",
];

export function readinessGroup(status: PullStatus | undefined): string {
	if (!status) return "Checking…";
	if (status.state !== "open") return "Merged / closed";
	if (status.draft) return "Draft";
	if (isReadyToMerge(status)) return "Ready to merge";
	if (status.merge === "conflicting") return "Conflicts";
	if (status.ci.state === "failure") return "CI failing";
	if (status.review === "changes-requested") return "Changes requested";
	if (status.ci.state === "pending") return "CI running";
	if (status.review === "review-required") return "Needs review";
	// Mergeable state still being computed by GitHub
	return "Checking…";
}

function updatedGroup(updatedAt: string | null | undefined, now: number): string {
	const time = updatedAt ? new Date(updatedAt).valueOf() : NaN;
	const age = now - time;
	if (isNaN(age)) return "Older";
	if (age < DAY_MS) return "Today";
	if (age < 7 * DAY_MS) return "This week";
	if (age < 30 * DAY_MS) return "This month";
	return "Older";
}

/**
 * Split rows into groups. Rows keep their order inside a group, so a PR stack stays together.
 * Groups with a natural order (status, readiness, age) come in that order and only when non-empty;
 * repos and authors come in the order they first appear.
 */
export function groupRows<T>(rows: T[], by: GroupBy, ctx: GroupContext<T>): Group<T>[] {
	if (by === "none") {
		return [{ key: "", label: "", rows: [...rows] }];
	}

	const groups = new Map<string, Group<T>>();
	const add = (key: string, label: string, row: T, href?: string) => {
		const group = groups.get(key) ?? { key, label, href, rows: [] };
		group.rows.push(row);
		groups.set(key, group);
	};

	for (const row of rows) {
		switch (by) {
			case "repo": {
				const repo = ctx.repo(row) ?? "";
				add(repo, repo || "Unknown repository", row, repo ? `https://github.com/${repo}` : undefined);
				break;
			}
			case "status": {
				const status = STATUS_GROUPS[ctx.status(row)];
				add(status.label, status.label, row);
				break;
			}
			case "author": {
				const author = ctx.author(row) ?? "Unknown author";
				add(author, author, row);
				break;
			}
			case "updated": {
				const label = updatedGroup(ctx.updatedAt(row), ctx.now);
				add(label, label, row);
				break;
			}
			case "readiness": {
				const label = readinessGroup(ctx.pullStatus(row));
				add(label, label, row);
				break;
			}
			case "custom": {
				const listed = ctx.custom?.(row);
				add(listed?.group ?? OTHER_GROUP, listed?.group ?? OTHER_GROUP, row);
				break;
			}
		}
	}

	const result = [...groups.values()];
	if (by === "custom") {
		const names = [...(ctx.customGroups ?? []), OTHER_GROUP];
		for (const group of result) {
			group.rows = orderAsListed(group.rows, ctx);
		}
		return result.sort((a, b) => names.indexOf(a.label) - names.indexOf(b.label));
	}
	const order =
		by === "status"
			? Object.values(STATUS_GROUPS)
					.sort((a, b) => a.rank - b.rank)
					.map((g) => g.label)
			: by === "updated"
				? UPDATED_GROUPS
				: by === "readiness"
					? READINESS_GROUPS
					: null;
	return order ? result.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label)) : result;
}

/**
 * Rows in the order the block lists them. A stack stays together, in its own order, at the place of
 * its earliest listed member, so listing a stack top-first does not tear it apart. Rows nobody lists
 * keep their given order after the listed ones.
 */
function orderAsListed<T>(rows: T[], ctx: GroupContext<T>): T[] {
	const units: { key: number; rows: T[] }[] = [];
	const runs = new Map<number, { key: number; rows: T[] }>();
	for (const row of rows) {
		const index = ctx.custom?.(row)?.index ?? Number.MAX_SAFE_INTEGER;
		const run = ctx.stackRun?.(row) ?? null;
		const existing = run === null ? undefined : runs.get(run);
		if (existing) {
			existing.rows.push(row);
			existing.key = Math.min(existing.key, index);
			continue;
		}
		const unit = { key: index, rows: [row] };
		units.push(unit);
		if (run !== null) {
			runs.set(run, unit);
		}
	}
	return units.sort((a, b) => a.key - b.key).flatMap((unit) => unit.rows);
}
