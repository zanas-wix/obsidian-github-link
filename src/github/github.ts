import { RequestError, mapObject } from "../util";

import type { GithubAccount } from "../settings";
import { PluginSettings } from "../plugin";
import { getGhTokenSync } from "./gh-token";
import { issueListSortFromQuery, pullListSortFromQuery, searchSortFromQuery } from "../query/sort";
import type { QueryParams } from "../query/types";
import { buildPullDetailQuery, parsePullDetail, type PullDetail, type PullDetailResponse } from "./pull-detail";
import { buildAutoMergeMutation, buildDraftMutation, buildMergeMutation } from "./pull-actions";
import { buildPullStatusQuery, parsePullStatuses, pullKey, type PullRef, type PullStatus } from "./pull-status";
import { GitHubApi } from "./api";
import type {
	CheckRunListResponse,
	IssueListParams,
	IssueListResponse,
	IssueResponse,
	IssueSearchParams,
	IssueSearchResponse,
	IssueTimelineResponse,
	MaybePaginated,
	PullListParams,
	PullListResponse,
	PullResponse,
	TimelineCrossReferencedEvent,
} from "./response";

// TODO: Refactor this whole file into a class for better use in dataview queries, etc

const tokenMatchRegex = /repo:(.+)\//;
const api = new GitHubApi();

/**
 * Everything the pull request pane shows, in one request. Never cached: the pane is a live view.
 */
export async function getPullDetail(ref: PullRef): Promise<PullDetail> {
	const data = await api.graphql<PullDetailResponse>(buildPullDetailQuery(ref), getToken(ref.org));
	const detail = parsePullDetail(ref, data);
	if (!detail) {
		throw new Error(`Pull request ${pullKey(ref)} was not found, or you have no access to it.`);
	}
	return detail;
}

/**
 * Squash and merge. The cached review/CI status of the PR is dropped, so lists show its new state.
 */
export async function squashMergePullRequest(ref: PullRef, nodeId: string): Promise<void> {
	await api.graphql(buildMergeMutation(nodeId), getToken(ref.org));
	pullStatusCache.delete(pullKey(ref));
}

export async function setPullAutoMerge(ref: PullRef, nodeId: string, enable: boolean): Promise<void> {
	await api.graphql(buildAutoMergeMutation(nodeId, enable), getToken(ref.org));
	pullStatusCache.delete(pullKey(ref));
}

/**
 * `draft: true` converts to a draft, `false` marks the pull request ready for review.
 */
export async function setPullDraft(ref: PullRef, nodeId: string, draft: boolean): Promise<void> {
	await api.graphql(buildDraftMutation(nodeId, draft), getToken(ref.org));
	pullStatusCache.delete(pullKey(ref));
}

const PULL_STATUS_BATCH_SIZE = 25;

/** Latest status per pull request, shared by every query block so the same PR is never fetched twice at once */
const pullStatusCache = new Map<string, { status: PullStatus; fetchedAt: number }>();

/**
 * Review, merge and CI state for pull requests, batched into as few GraphQL requests as possible
 * (25 PRs per request). Statuses fetched less than `maxAgeMs` ago are reused instead of requested again.
 * Pull requests GitHub does not return (no access, deleted) are missing from the result.
 */
export async function getPullStatuses(refs: PullRef[], maxAgeMs = 0): Promise<Map<string, PullStatus>> {
	const result = new Map<string, PullStatus>();
	const stale = new Map<string, PullRef>();
	const now = Date.now();
	for (const ref of refs) {
		const key = pullKey(ref);
		const cached = pullStatusCache.get(key);
		if (cached && now - cached.fetchedAt < maxAgeMs) {
			result.set(key, cached.status);
		} else {
			stale.set(key, ref);
		}
	}

	const byOrg = new Map<string, PullRef[]>();
	for (const ref of stale.values()) {
		byOrg.set(ref.org, [...(byOrg.get(ref.org) ?? []), ref]);
	}
	for (const [org, orgRefs] of byOrg) {
		for (let i = 0; i < orgRefs.length; i += PULL_STATUS_BATCH_SIZE) {
			const batch = orgRefs.slice(i, i + PULL_STATUS_BATCH_SIZE);
			const data = await api.graphql<Parameters<typeof parsePullStatuses>[1]>(
				buildPullStatusQuery(batch),
				getToken(org),
			);
			for (const [key, status] of parsePullStatuses(batch, data)) {
				pullStatusCache.set(key, { status, fetchedAt: Date.now() });
				result.set(key, status);
			}
		}
	}
	return result;
}

function getAccount(org?: string): GithubAccount | undefined {
	const account =
		PluginSettings.accounts.find((acc) => acc.orgs.some((savedOrg) => savedOrg === org)) ??
		PluginSettings.accounts.find((acc) => acc.id === PluginSettings.defaultAccount);
	return account;
}

function getToken(org?: string, query?: string): string | undefined {
	let _org = org;

	// Try and parse org from the query
	if (!org && query) {
		const match = tokenMatchRegex.exec(query);
		if (match?.[0] !== null) {
			_org = match?.[1];
		}
	}

	const account = getAccount(_org);
	if (account?.token) return account.token;
	if (PluginSettings.useGhCli) return getGhTokenSync() ?? undefined;
	return undefined;
}

export function getIssue(org: string, repo: string, issue: number, skipCache = false): Promise<IssueResponse> {
	return api.getIssue(org, repo, issue, getToken(org), skipCache);
}

export function getMyIssues(
	params: QueryParams,
	org?: string,
	skipCache = false,
): Promise<MaybePaginated<IssueListResponse>> {
	const account = getAccount(org);
	if (!account?.token) {
		return Promise.resolve({ meta: {}, response: [] });
	}

	return api.listIssuesForToken(toIssueListParams(params), account.token, skipCache);
}

export function getIssuesForRepo(
	params: QueryParams,
	org: string,
	repo: string,
	skipCache = false,
): Promise<MaybePaginated<IssueListResponse>> {
	return api.listIssuesForRepo(org, repo, toIssueListParams(params), getToken(org), skipCache);
}

export function getIssuesForOrganization(
	params: QueryParams,
	org: string,
	skipCache = false,
): Promise<MaybePaginated<IssueListResponse>> {
	const listParams = mapObject<QueryParams, IssueListParams>(
		params,
		{
			assignee: true,
			creator: true,
			direction: true,
			labels: (params) => {
				if (Array.isArray(params.labels)) {
					return params.labels.join(",");
				}
				return params.labels;
			},
			mentioned: true,
			page: true,
			per_page: true,
			since: true,
			sort: (params) => issueListSortFromQuery(params),
			state: true,
			filter: true,
		},
		true,
		true,
	);

	setPageSize(listParams);

	return api.listIssuesForOrganization(org, listParams, getToken(org), skipCache);
}

export function getPullRequest(
	org: string,
	repo: string,
	pullRequest: number,
	skipCache = false,
): Promise<PullResponse> {
	return api.getPullRequest(org, repo, pullRequest, getToken(org), skipCache);
}

export function getPullRequestsForRepo(
	params: QueryParams,
	org: string,
	repo: string,
	skipCache = false,
): Promise<MaybePaginated<PullListResponse>> {
	const listParams = mapObject<QueryParams, PullListParams>(
		params,
		{
			direction: true,
			page: true,
			per_page: true,
			sort: (params) => pullListSortFromQuery(params),
			state: true,
		},
		true,
		true,
	);

	setPageSize(listParams);
	return api.listPullRequestsForRepo(org, repo, listParams, getToken(org), skipCache);
}

export function listCheckRunsForRef(
	org: string,
	repo: string,
	ref: string,
	skipCache = false,
): Promise<CheckRunListResponse> {
	return api.listCheckRunsForRef(org, repo, ref, getToken(org), skipCache);
}

export async function searchIssues(
	params: QueryParams,
	query: string,
	org?: string,
	skipCache = false,
): Promise<MaybePaginated<IssueSearchResponse>> {
	const searchParams = mapObject<QueryParams, IssueSearchParams>(
		params,
		{
			q: () => query,
			sort: (params) => searchSortFromQuery(params),
			order: (params) => params.order,
			page: (params) => params.page,
			per_page: (params) => params.per_page,
		},
		true,
		true,
	);

	setPageSize(searchParams);
	return api.searchIssues(searchParams, getToken(org, query), skipCache);
}

// TODO: This is in the wrong place and should be at the API level to be properly cached
export async function getPRForIssue(timelineUrl: string, org?: string): Promise<string | null> {
	let result: IssueTimelineResponse | null = null;
	try {
		const { response } = await api.queueRequest({ url: timelineUrl }, getToken(org));
		result = response.json as IssueTimelineResponse;
	} catch (err) {
		// 404 means there's no timeline for this, we can ignore the error
		if (err instanceof RequestError && err.status === 404) {
			return null;
		} else {
			throw err;
		}
	}
	if (!result) {
		return null;
	}

	// TODO: Figure out a better/more reliable way to do this.
	const crossRefEvent = result.find((_evt) => {
		const evt = _evt as Partial<TimelineCrossReferencedEvent>;
		return evt.event === "cross-referenced" && evt.source?.issue?.pull_request?.html_url;
	}) as TimelineCrossReferencedEvent | undefined;
	return crossRefEvent?.source.issue?.pull_request?.html_url ?? null;
}

function setPageSize(params: { per_page?: number }): void {
	params.per_page = params.per_page ?? PluginSettings.defaultPageSize;
}

function toIssueListParams(queryParams: QueryParams): IssueListParams {
	const listParams = mapObject<QueryParams, IssueListParams>(
		queryParams,
		{
			assignee: true,
			creator: true,
			direction: true,
			labels: (params) => {
				if (Array.isArray(params.labels)) {
					return params.labels.join(",");
				}
				return params.labels;
			},
			mentioned: true,
			page: true,
			per_page: true,
			since: true,
			sort: (params) => issueListSortFromQuery(params),
			state: true,
		},
		true,
		true,
	);
	setPageSize(listParams);
	return listParams;
}
