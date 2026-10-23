export interface GraphqlResponse<T> {
	data?: T | null;
	errors?: { message: string }[];
}

/**
 * The data of a GraphQL response, or an error.
 *
 * GitHub answers a refused mutation with `data: { someMutation: null }` plus `errors`, so a mutation
 * (`strict`) fails on any error. A query tolerates partial data, e.g. one PR in a repo we cannot see.
 */
export function unwrapGraphql<T>(response: GraphqlResponse<T>, strict: boolean): T {
	const messages = response.errors?.map((error) => error.message).join("; ");
	if (!response.data || (strict && messages)) {
		throw new Error(messages ?? "Empty GraphQL response");
	}
	return response.data;
}
