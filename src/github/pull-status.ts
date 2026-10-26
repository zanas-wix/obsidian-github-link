/** Columns filled from the batched status request (the line counts ride along with CI and review state) */
export const STATUS_COLUMNS = ["ci", "review", "merge", "lines"];

/**
 * Review, merge and CI state of pull requests. The REST API needs several requests per PR for this
 * (pull, reviews, check runs, commit statuses); GraphQL returns it for many PRs in one request.
 */

export interface PullRef {
	org: string;
	repo: string;
	number: number;
}

export interface PullStatus {
	additions: number;
	deletions: number;
	state: "open" | "closed" | "merged";
	draft: boolean;
	/** Combined review state; null when no review is required or requested */
	review: "approved" | "changes-requested" | "review-required" | null;
	merge: "mergeable" | "conflicting" | "unknown";
	/** null state means the PR has no checks at all */
	ci: { state: "success" | "failure" | "pending" | null; passed: number; total: number };
}

const NAME = /^[A-Za-z0-9._-]+$/;

export function pullKey(ref: PullRef): string {
	return `${ref.org}/${ref.repo}#${ref.number}`.toLowerCase();
}

/**
 * Owner and repo names are interpolated into GraphQL documents, so anything that is not a plain
 * GitHub name is rejected.
 */
export function validatePullRef(ref: PullRef): void {
	if (!NAME.test(ref.org) || !NAME.test(ref.repo) || !Number.isInteger(ref.number)) {
		throw new Error(`Invalid pull request reference: ${pullKey(ref)}`);
	}
}

/**
 * One GraphQL document asking for every given PR, aliased `p0`, `p1`, ...
 */
export function buildPullStatusQuery(refs: PullRef[]): string {
	const fields = refs.map((ref, i) => {
		validatePullRef(ref);
		return `p${i}: repository(owner: "${ref.org}", name: "${ref.repo}") {
	pullRequest(number: ${ref.number}) {
		state
		isDraft
		additions
		deletions
		reviewDecision
		mergeable
		commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) {
			nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state } }
		} } } } }
	}
}`;
	});
	return `query {\n${fields.join("\n")}\n}`;
}

interface RawContext {
	__typename?: string;
	status?: string;
	conclusion?: string | null;
	state?: string;
}

interface RawPull {
	additions?: number;
	deletions?: number;
	state?: string;
	isDraft?: boolean;
	reviewDecision?: string | null;
	mergeable?: string;
	commits?: {
		nodes?: { commit?: { statusCheckRollup?: { state?: string; contexts?: { nodes?: RawContext[] } } | null } }[];
	};
}

/**
 * Map a GraphQL response to statuses by ref. PRs missing from the response (no access, deleted) are omitted.
 */
export function parsePullStatuses(
	refs: PullRef[],
	data: Record<string, { pullRequest?: RawPull | null } | null>,
): Map<string, PullStatus> {
	const result = new Map<string, PullStatus>();
	refs.forEach((ref, i) => {
		const pull = data[`p${i}`]?.pullRequest;
		if (pull) {
			result.set(pullKey(ref), toStatus(pull));
		}
	});
	return result;
}

function toStatus(pull: RawPull): PullStatus {
	const rollup = pull.commits?.nodes?.[0]?.commit?.statusCheckRollup;
	const contexts = rollup?.contexts?.nodes ?? [];
	const passed = contexts.filter(isPassing).length;

	let ci: PullStatus["ci"]["state"] = null;
	if (rollup?.state === "SUCCESS") ci = "success";
	else if (rollup?.state === "FAILURE" || rollup?.state === "ERROR") ci = "failure";
	else if (rollup?.state === "PENDING" || rollup?.state === "EXPECTED") ci = "pending";

	return {
		additions: pull.additions ?? 0,
		deletions: pull.deletions ?? 0,
		state: pull.state === "MERGED" ? "merged" : pull.state === "CLOSED" ? "closed" : "open",
		draft: Boolean(pull.isDraft),
		review:
			pull.reviewDecision === "APPROVED"
				? "approved"
				: pull.reviewDecision === "CHANGES_REQUESTED"
					? "changes-requested"
					: pull.reviewDecision === "REVIEW_REQUIRED"
						? "review-required"
						: null,
		merge: pull.mergeable === "MERGEABLE" ? "mergeable" : pull.mergeable === "CONFLICTING" ? "conflicting" : "unknown",
		ci: { state: ci, passed, total: contexts.length },
	};
}

/**
 * What still stands between an open pull request and a merge, in words; empty when nothing does.
 * One authority for "can be merged", so notifications and merge buttons cannot disagree.
 */
export function mergeBlockers(status: PullStatus): string[] {
	const blockers: string[] = [];
	if (status.draft) blockers.push("still a draft");
	if (status.review === "review-required") blockers.push("review required");
	if (status.review === "changes-requested") blockers.push("changes requested");
	if (status.ci.state === "failure") blockers.push("CI failing");
	if (status.ci.state === "pending") blockers.push("CI running");
	if (status.merge === "conflicting") blockers.push("merge conflicts");
	if (status.merge === "unknown") blockers.push("conflicts not checked yet");
	return blockers;
}

/**
 * Whether the pull request can be merged right now: open, not a draft, approved (or no review needed),
 * every check passed (or there are none), and no conflicts.
 */
export function isReadyToMerge(status: PullStatus): boolean {
	return status.state === "open" && mergeBlockers(status).length === 0;
}

/**
 * How closely a pull request needs watching:
 * - active: something is about to change on its own (CI running, merge state being computed)
 * - waiting: ready for a human, e.g. awaiting review
 * - idle: stuck until someone acts (draft, failing CI, changes requested)
 */
export type PollTier = "active" | "waiting" | "idle";

export const POLL_DELAY_MS: Record<PollTier, number> = { active: 20 * 1000, waiting: 60 * 1000, idle: 3 * 60 * 1000 };

export function pollTier(status: Pick<PullStatus, "draft" | "merge" | "review" | "ci">): PollTier {
	if (status.ci.state === "pending") {
		return "active";
	}
	const stuck = status.draft || status.ci.state === "failure" || status.review === "changes-requested";
	// GitHub can leave `mergeable` unknown for a long time on PRs that are stuck anyway
	if (status.merge === "unknown" && !stuck) {
		return "active";
	}
	return stuck ? "idle" : "waiting";
}

/**
 * Wait until the next check of these open pull requests: the shortest of their tiers, so the most
 * urgent one sets the pace. With nothing to go on, the middle tier.
 */
export function pollDelayMs(statuses: Pick<PullStatus, "draft" | "merge" | "review" | "ci">[]): number {
	return statuses.length === 0 ? POLL_DELAY_MS.waiting : Math.min(...statuses.map((s) => POLL_DELAY_MS[pollTier(s)]));
}

/** Skipped and neutral checks do not hold a PR back, so they count as passing */
function isPassing(context: RawContext): boolean {
	if (context.__typename === "StatusContext") {
		return context.state === "SUCCESS";
	}
	return context.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(context.conclusion ?? "");
}

/**
 * Pull request status of table rows, filled in by the query when a status column is requested.
 * Keyed by row so column renderers, which only receive the row, can look it up.
 */
export const rowPullStatuses = new WeakMap<object, PullStatus>();
