import type { PullRef } from "../github/pull-status";
import type { TableResult } from "./types";

/**
 * "org/repo" of a list row, whichever API it came from: search results and issue lists carry the
 * repository URL, pull list items and PRs fetched by reference carry their base repository.
 */
export function rowRepoFullName(row: TableResult[number]): string | null {
	if ("repository_url" in row) {
		return /\/repos\/([^/]+\/[^/]+)$/.exec(row.repository_url)?.[1] ?? null;
	}
	return "base" in row ? row.base.repo.full_name : null;
}

export function rowPullRef(row: TableResult[number]): PullRef | null {
	const [org, repo] = rowRepoFullName(row)?.split("/") ?? [];
	return org && repo ? { org, repo, number: row.number } : null;
}
