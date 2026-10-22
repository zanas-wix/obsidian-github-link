export const STATUS_COLUMNS = ["ci", "review", "merge"];

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
