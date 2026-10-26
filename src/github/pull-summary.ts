import type { TableResult } from "../query/types";
import { pullKey, validatePullRef, type PullRef } from "./pull-status";

/**
 * Pull requests fetched by reference, as the rows a list shows. Used for PRs that a query block lists
 * explicitly but its search did not return; they must behave exactly like search results, so the
 * GraphQL answer is adapted to the shape of a search result (plus `base` and `head`, which spare the
 * stack grouping an extra request per PR).
 */

export function buildPullSummaryQuery(refs: PullRef[]): string {
	const fields = refs.map((ref, i) => {
		validatePullRef(ref);
		return `p${i}: repository(owner: "${ref.org}", name: "${ref.repo}") {
	nameWithOwner
	pullRequest(number: ${ref.number}) {
		number title url state isDraft merged mergedAt closedAt createdAt updatedAt baseRefName headRefName
		author { login avatarUrl url }
		labels(first: 20) { nodes { name color } }
		headRepository { nameWithOwner }
	}
}`;
	});
	return `query {\n${fields.join("\n")}\n}`;
}

interface RawSummary {
	nameWithOwner: string;
	pullRequest?: {
		number: number;
		title: string;
		url: string;
		state: string;
		isDraft: boolean;
		merged: boolean;
		mergedAt: string | null;
		closedAt: string | null;
		createdAt: string;
		updatedAt: string;
		baseRefName: string;
		headRefName: string;
		author?: { login: string; avatarUrl: string; url: string } | null;
		labels?: { nodes?: { name: string; color: string }[] };
		headRepository?: { nameWithOwner: string } | null;
	} | null;
}

export interface PullSummaries {
	rows: Map<string, TableResult[number]>;
	/** Keys of references GitHub did not return (no such PR, or no access) */
	missing: PullRef[];
}

export function parsePullSummaries(refs: PullRef[], data: Record<string, RawSummary | null>): PullSummaries {
	const rows = new Map<string, TableResult[number]>();
	const missing: PullRef[] = [];
	refs.forEach((ref, i) => {
		const repository = data[`p${i}`];
		const pull = repository?.pullRequest;
		if (!repository || !pull) {
			missing.push(ref);
			return;
		}
		const author = pull.author;
		const row = {
			number: pull.number,
			title: pull.title,
			html_url: pull.url,
			repository_url: `https://api.github.com/repos/${repository.nameWithOwner}`,
			state: pull.state === "OPEN" ? "open" : "closed",
			state_reason: null,
			draft: pull.isDraft,
			created_at: pull.createdAt,
			updated_at: pull.updatedAt,
			closed_at: pull.closedAt,
			user: author ? { login: author.login, avatar_url: author.avatarUrl, html_url: author.url } : null,
			assignee: null,
			labels: pull.labels?.nodes ?? [],
			pull_request: { merged_at: pull.merged ? pull.mergedAt ?? pull.closedAt : null, html_url: pull.url },
			base: { ref: pull.baseRefName, repo: { full_name: repository.nameWithOwner } },
			head: {
				ref: pull.headRefName,
				repo: pull.headRepository ? { full_name: pull.headRepository.nameWithOwner } : null,
			},
		};
		// The row carries the fields of both a search result and a pull list item that the list reads;
		// it is not every field of either, which is why this one cast stands in for the full type
		rows.set(pullKey(ref), row as unknown as TableResult[number]);
	});
	return { rows, missing };
}
