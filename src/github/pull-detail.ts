/**
 * Everything the pull request pane shows, from one GraphQL request.
 */
import { validatePullRef, type PullRef } from "./pull-status";

export interface Person {
	login: string;
	avatarUrl: string | null;
}

export interface TimelineComment {
	author: Person;
	body: string;
	at: string;
	url: string;
}

export type ReviewState = "approved" | "changes-requested" | "commented" | "dismissed" | "pending";

export type TimelineItem =
	| ({ kind: "comment" } & TimelineComment)
	| ({ kind: "review"; state: ReviewState } & TimelineComment)
	| {
			kind: "thread";
			resolved: boolean;
			outdated: boolean;
			path: string;
			line: number | null;
			diffHunk: string;
			comments: TimelineComment[];
			at: string;
	  };

export type CheckState = "success" | "failure" | "pending" | "neutral";

export interface PullCheck {
	name: string;
	state: CheckState;
	url: string | null;
}

export interface PullDetail {
	ref: PullRef;
	title: string;
	url: string;
	body: string;
	state: "open" | "closed" | "merged";
	draft: boolean;
	author: Person | null;
	createdAt: string;
	updatedAt: string;
	baseRef: string;
	headRef: string;
	additions: number;
	deletions: number;
	review: "approved" | "changes-requested" | "review-required" | null;
	mergeable: "mergeable" | "conflicting" | "unknown";
	/** GitHub's merge state: CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN */
	mergeState: string;
	labels: { name: string; color: string }[];
	requestedReviewers: string[];
	reviewers: { person: Person; state: ReviewState; at: string }[];
	checks: PullCheck[];
	timeline: TimelineItem[];
	unresolvedThreads: number;
	files: { path: string; additions: number; deletions: number }[];
	changedFiles: number;
}

/** Newest comments and reviews are what matter in a long PR, so those lists take `last`, not `first` */
export function buildPullDetailQuery(ref: PullRef): string {
	validatePullRef(ref);
	const author = "author { login avatarUrl }";
	return `query {
	repository(owner: "${ref.org}", name: "${ref.repo}") {
		pullRequest(number: ${ref.number}) {
			title url body state isDraft merged createdAt updatedAt
			${author}
			baseRefName headRefName additions deletions changedFiles
			reviewDecision mergeable mergeStateStatus
			labels(first: 20) { nodes { name color } }
			reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
			latestReviews(first: 30) { nodes { ${author} state submittedAt } }
			comments(last: 50) { nodes { ${author} body createdAt url } }
			reviews(last: 50) { nodes { ${author} state body submittedAt url } }
			reviewThreads(last: 50) { nodes {
				isResolved isOutdated path line
				comments(first: 30) { nodes { ${author} body createdAt url diffHunk } }
			} }
			files(first: 100) { nodes { path additions deletions } }
			commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
				__typename
				... on CheckRun { name status conclusion detailsUrl }
				... on StatusContext { context state targetUrl }
			} } } } } }
		}
	}
}`;
}

interface RawPerson {
	login?: string;
	avatarUrl?: string;
}
interface RawComment {
	author?: RawPerson | null;
	body?: string;
	createdAt?: string;
	submittedAt?: string;
	url?: string;
	state?: string;
	diffHunk?: string;
}
interface RawPull {
	title: string;
	url: string;
	body?: string;
	state: string;
	isDraft: boolean;
	merged: boolean;
	createdAt: string;
	updatedAt: string;
	author?: RawPerson | null;
	baseRefName: string;
	headRefName: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	reviewDecision?: string | null;
	mergeable?: string;
	mergeStateStatus?: string;
	labels?: { nodes?: { name: string; color: string }[] };
	reviewRequests?: { nodes?: { requestedReviewer?: { login?: string; name?: string } | null }[] };
	latestReviews?: { nodes?: RawComment[] };
	comments?: { nodes?: RawComment[] };
	reviews?: { nodes?: RawComment[] };
	reviewThreads?: {
		nodes?: {
			isResolved: boolean;
			isOutdated: boolean;
			path: string;
			line: number | null;
			comments?: { nodes?: RawComment[] };
		}[];
	};
	files?: { nodes?: { path: string; additions: number; deletions: number }[] };
	commits?: {
		nodes?: {
			commit?: {
				statusCheckRollup?: {
					contexts?: {
						nodes?: {
							__typename?: string;
							name?: string;
							status?: string;
							conclusion?: string | null;
							detailsUrl?: string | null;
							context?: string;
							state?: string;
							targetUrl?: string | null;
						}[];
					};
				} | null;
			};
		}[];
	};
}

export type PullDetailResponse = { repository?: { pullRequest?: RawPull | null } | null };

/**
 * Null when GitHub returned no such pull request (deleted, or no access)
 */
export function parsePullDetail(ref: PullRef, data: PullDetailResponse): PullDetail | null {
	const pull = data.repository?.pullRequest;
	if (!pull) {
		return null;
	}

	const person = (raw?: RawPerson | null): Person => ({
		login: raw?.login ?? "ghost",
		avatarUrl: raw?.avatarUrl ?? null,
	});
	const comment = (raw: RawComment): TimelineComment => ({
		author: person(raw.author),
		body: raw.body ?? "",
		at: raw.createdAt ?? raw.submittedAt ?? "",
		url: raw.url ?? pull.url,
	});

	const timeline: TimelineItem[] = [];
	for (const raw of pull.comments?.nodes ?? []) {
		timeline.push({ kind: "comment", ...comment(raw) });
	}
	for (const raw of pull.reviews?.nodes ?? []) {
		const state = toReviewState(raw.state);
		// A bare "commented" review only wraps inline threads, which are listed on their own
		if (raw.body || state !== "commented") {
			timeline.push({ kind: "review", state, ...comment(raw) });
		}
	}
	const threads = pull.reviewThreads?.nodes ?? [];
	for (const thread of threads) {
		const comments = (thread.comments?.nodes ?? []).map(comment);
		if (comments.length > 0) {
			timeline.push({
				kind: "thread",
				resolved: thread.isResolved,
				outdated: thread.isOutdated,
				path: thread.path,
				line: thread.line,
				diffHunk: thread.comments?.nodes?.[0]?.diffHunk ?? "",
				comments,
				at: comments[0].at,
			});
		}
	}
	timeline.sort((a, b) => a.at.localeCompare(b.at));

	return {
		ref,
		title: pull.title,
		url: pull.url,
		body: pull.body ?? "",
		state: pull.merged ? "merged" : pull.state === "CLOSED" ? "closed" : "open",
		draft: pull.isDraft,
		author: pull.author ? person(pull.author) : null,
		createdAt: pull.createdAt,
		updatedAt: pull.updatedAt,
		baseRef: pull.baseRefName,
		headRef: pull.headRefName,
		additions: pull.additions,
		deletions: pull.deletions,
		review:
			pull.reviewDecision === "APPROVED"
				? "approved"
				: pull.reviewDecision === "CHANGES_REQUESTED"
					? "changes-requested"
					: pull.reviewDecision === "REVIEW_REQUIRED"
						? "review-required"
						: null,
		mergeable:
			pull.mergeable === "MERGEABLE" ? "mergeable" : pull.mergeable === "CONFLICTING" ? "conflicting" : "unknown",
		mergeState: pull.mergeStateStatus ?? "UNKNOWN",
		labels: pull.labels?.nodes ?? [],
		requestedReviewers: (pull.reviewRequests?.nodes ?? [])
			.map((request) => request.requestedReviewer?.login ?? request.requestedReviewer?.name)
			.filter((name): name is string => Boolean(name)),
		reviewers: (pull.latestReviews?.nodes ?? []).map((raw) => ({
			person: person(raw.author),
			state: toReviewState(raw.state),
			at: raw.submittedAt ?? "",
		})),
		checks: parseChecks(pull),
		timeline,
		unresolvedThreads: threads.filter((thread) => !thread.isResolved).length,
		files: pull.files?.nodes ?? [],
		changedFiles: pull.changedFiles,
	};
}

function toReviewState(state?: string): ReviewState {
	switch (state) {
		case "APPROVED":
			return "approved";
		case "CHANGES_REQUESTED":
			return "changes-requested";
		case "DISMISSED":
			return "dismissed";
		case "PENDING":
			return "pending";
		default:
			return "commented";
	}
}

function parseChecks(pull: RawPull): PullCheck[] {
	const contexts = pull.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
	const checks = contexts.map((context): PullCheck => {
		if (context.__typename === "StatusContext") {
			return {
				name: context.context ?? "status",
				state: context.state === "SUCCESS" ? "success" : context.state === "PENDING" ? "pending" : "failure",
				url: context.targetUrl ?? null,
			};
		}
		let state: CheckState = "pending";
		if (context.status === "COMPLETED") {
			state = ["SUCCESS"].includes(context.conclusion ?? "")
				? "success"
				: ["NEUTRAL", "SKIPPED"].includes(context.conclusion ?? "")
					? "neutral"
					: "failure";
		}
		return { name: context.name ?? "check", state, url: context.detailsUrl ?? null };
	});
	// What needs attention first: failures, then running checks, then the rest by name
	const rank: Record<CheckState, number> = { failure: 0, pending: 1, success: 2, neutral: 3 };
	return checks.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}
