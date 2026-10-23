/**
 * Mutations that change a pull request. Squash is the only merge method offered.
 */

/** GraphQL node ids are interpolated into the mutation, so anything but their alphabet is rejected */
const NODE_ID = /^[A-Za-z0-9_=-]+$/;

function validNodeId(id: string): string {
	if (!NODE_ID.test(id)) {
		throw new Error(`Invalid pull request id: ${id}`);
	}
	return id;
}

export function buildMergeMutation(nodeId: string): string {
	return `mutation { mergePullRequest(input: { pullRequestId: "${validNodeId(nodeId)}", mergeMethod: SQUASH }) { pullRequest { id } } }`;
}

export function buildAutoMergeMutation(nodeId: string, enable: boolean): string {
	const id = validNodeId(nodeId);
	return enable
		? `mutation { enablePullRequestAutoMerge(input: { pullRequestId: "${id}", mergeMethod: SQUASH }) { pullRequest { id } } }`
		: `mutation { disablePullRequestAutoMerge(input: { pullRequestId: "${id}" }) { pullRequest { id } } }`;
}

/**
 * `draft: true` converts to a draft, `false` marks it ready for review
 */
export function buildDraftMutation(nodeId: string, draft: boolean): string {
	const id = validNodeId(nodeId);
	return draft
		? `mutation { convertPullRequestToDraft(input: { pullRequestId: "${id}" }) { pullRequest { id } } }`
		: `mutation { markPullRequestReadyForReview(input: { pullRequestId: "${id}" }) { pullRequest { id } } }`;
}

/**
 * Post a comment on the pull request. The text goes through JSON.stringify, whose output is a valid
 * GraphQL string literal, so any text is safe to embed.
 */
export function buildCommentMutation(nodeId: string, body: string): string {
	if (!body.trim()) {
		throw new Error("A comment cannot be empty.");
	}
	return `mutation { addComment(input: { subjectId: "${validNodeId(nodeId)}", body: ${JSON.stringify(body)} }) { commentEdge { node { id } } } }`;
}

/**
 * Close without merging. The pull request can be reopened on GitHub.
 */
export function buildCloseMutation(nodeId: string): string {
	return `mutation { closePullRequest(input: { pullRequestId: "${validNodeId(nodeId)}" }) { pullRequest { id } } }`;
}
