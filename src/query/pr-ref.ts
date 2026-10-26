import type { PullRef } from "../github/pull-status";

/**
 * `org/repo#123` or a pull request URL (`https://github.com/org/repo/pull/123`, with or without a
 * trailing path such as `/files`). Null when it is neither.
 */
export function parsePrRef(text: string): PullRef | null {
	const value = text.trim();
	const short = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)$/.exec(value);
	if (short) {
		return { org: short[1], repo: short[2], number: parseInt(short[3], 10) };
	}
	const url = /^https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(value);
	return url ? { org: url[1], repo: url[2], number: parseInt(url[3], 10) } : null;
}

/** A named set of pull requests, as written in the `groups` option of a query block */
export interface CustomGroup {
	name: string;
	refs: PullRef[];
}

/**
 * Read the `groups` option: a list of `{ name, prs: [...] }`. Anything malformed fails with a message
 * naming the group and the entry, so a typo shows in the block instead of silently dropping a PR.
 */
export function parseGroups(raw: unknown): CustomGroup[] {
	if (!Array.isArray(raw)) {
		throw new Error("`groups` must be a list of { name, prs } entries.");
	}
	return raw.map((entry: unknown, index) => {
		const item = entry as { name?: unknown; prs?: unknown } | null;
		const name = typeof item?.name === "string" ? item.name.trim() : "";
		if (!name) {
			throw new Error(`Group ${index + 1} in \`groups\` needs a \`name\`.`);
		}
		if (!Array.isArray(item?.prs)) {
			throw new Error(`Group "${name}" needs a \`prs\` list.`);
		}
		const refs = item.prs.map((pr: unknown) => {
			const ref = typeof pr === "string" ? parsePrRef(pr) : null;
			if (!ref) {
				throw new Error(`Group "${name}": "${String(pr)}" is not a pull request. Use org/repo#123 or its URL.`);
			}
			return ref;
		});
		return { name, refs };
	});
}
