import { isReadyToMerge, type PullStatus } from "../github/pull-status";
import { IssueStatus } from "../github/response";

export type GroupBy = "none" | "repo" | "status" | "author" | "updated" | "readiness";

export const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
	{ value: "none", label: "No grouping" },
	{ value: "repo", label: "By repo" },
	{ value: "status", label: "By status" },
	{ value: "author", label: "By author" },
	{ value: "updated", label: "By last update" },
	{ value: "readiness", label: "By merge readiness" },
];

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
		}
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
	const result = [...groups.values()];
	return order ? result.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label)) : result;
}
