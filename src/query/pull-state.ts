import { getSearchResultPRStatus, type IssueSearchResponse } from "../github/response";
import { WeakChannel } from "../pr-view/channel";

export type PullState = "open" | "closed" | "merged";

/** The fields a list row carries that decide its state icon */
type Patchable = Pick<
	IssueSearchResponse["items"][number],
	"state" | "state_reason" | "pull_request" | "closed_at" | "draft"
>;

/**
 * Update a list row to a state learned after the list was loaded (the pane reloaded the PR, a status
 * poll came back). Returns whether its state icon changes.
 */
export function applyPullState(row: object, state: PullState, draft: boolean, now = new Date().toISOString()): boolean {
	// Rows of every query shape (search, repo list) carry these fields; the cast only names the ones we touch
	const pull = row as Patchable;
	const before = getSearchResultPRStatus(pull);

	pull.state = state === "open" ? "open" : "closed";
	pull.closed_at = state === "open" ? null : pull.closed_at ?? now;
	pull.draft = state === "open" && draft;
	pull.pull_request = {
		diff_url: pull.pull_request?.diff_url ?? null,
		html_url: pull.pull_request?.html_url ?? null,
		patch_url: pull.pull_request?.patch_url ?? null,
		url: pull.pull_request?.url ?? null,
		merged_at: state === "merged" ? pull.pull_request?.merged_at ?? now : null,
	};

	return getSearchResultPRStatus(pull) !== before;
}

/**
 * A pull request's current state, announced by whoever just learned it so every list showing it can follow.
 * Keys are `pullKey(ref)`.
 */
export const pullStateChannel = new WeakChannel<{ key: string; state: PullState; draft: boolean }>();
