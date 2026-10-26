import type { IssueListResponse, IssueSearchResponse, PullListResponse } from "../github/response";
import type { GroupBy } from "./grouping";

export type TableResult = IssueSearchResponse["items"] | IssueListResponse | PullListResponse;

export enum OutputType {
	Table = "table",
	Cards = "cards",
}

export enum QueryType {
	PullRequest = "pull-request",
	Issue = "issue",
	Repo = "repo",
}

export interface BaseParams {
	refresh?: boolean;
}

/**
 * Not all fields are supported by all query types
 */
export interface QueryParams {
	outputType: OutputType;
	queryType: QueryType;
	columns: string[];

	/**
	 * Custom query. This will override most other options.
	 */
	query?: string;

	/**
	 * Pagination page size
	 */
	per_page?: number;

	/**
	 * Pagination page number
	 */
	page?: number;

	/**
	 * Repository name
	 */
	repo?: string;

	/**
	 * Organization or user name
	 */
	org?: string;
	milestone?: string;
	state?: "open" | "closed" | "all";
	assignee?: "none" | "*" | string;
	creator?: string;
	mentioned?: string;
	labels?: string | string[];

	/**
	 * "comments" - Issues only
	 * "popularity", "long-running" - Pull requests only
	 * "reactions" and "interactions" - Search only
	 */
	sort?:
		| "created"
		| "updated"
		| "comments"
		| "popularity"
		| "long-running"
		| "reactions"
		| "reactions-+1"
		| "reactions--1"
		| "reactions-smile"
		| "reactions-thinking_face"
		| "reactions-heart"
		| "reactions-tada"
		| "interactions";

	/**
	 * Sort direction, for most queries
	 */
	direction?: "asc" | "desc";
	/**
	 * Sort direction, for search queries
	 */
	order?: "asc" | "desc";
	since?: string;

	/**
	 * Issue filter type
	 */
	filter?: "assigned" | "created" | "mentioned" | "subscribed" | "repos" | "all";

	/**
	 * Pull request branch
	 */
	head?: string;

	/**
	 * Pull request target
	 */
	base?: string;

	/**
	 * Pull requests only: group PRs that are stacked on each other (a PR targeting another PR's
	 * branch) together, bottom of the stack first. Adds a "stack" column by default.
	 */
	stack?: boolean;

	/**
	 * Cards output only: how cards are grouped to start with. The switch above the list can change it:
	 * none, repo, status, author, updated or readiness.
	 */
	groupBy?: GroupBy;

	/**
	 * Pull requests with review/ci/merge columns: re-check their status every this many seconds
	 * (minimum 30). Off when not set.
	 */
	statusRefresh?: number;

	/**
	 * Pull requests only: watch every open pull request in the results and send desktop notifications
	 * (CI green, approved, ready to merge). Individual pull requests can be muted from the side pane.
	 */
	notify?: boolean;
}
