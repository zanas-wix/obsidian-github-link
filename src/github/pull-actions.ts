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
