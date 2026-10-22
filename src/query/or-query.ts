/**
 * GitHub's legacy search has no OR between qualifiers, so an OR query is expanded into the
 * equivalent list of plain queries whose results are merged afterwards.
 *
 * Grammar (same precedence as GitHub): AND binds tighter than OR, parentheses group, whitespace is AND.
 * `is:pr (author:me OR assignee:me) is:open` => `is:pr author:me is:open`, `is:pr assignee:me is:open`
 */

const MAX_SEGMENTS = 20;

type Conjunction = string[];

export function expandOrQuery(query: string): string[] {
	if (!/\bor\b/i.test(query)) {
		return [query];
	}

	const tokens = tokenize(query);
	let pos = 0;

	const parseOr = (): Conjunction[] => {
		const result = parseAnd();
		while (isKeyword(tokens[pos], "OR")) {
			pos++;
			result.push(...parseAnd());
		}
		return result;
	};

	const parseAnd = (): Conjunction[] => {
		let result: Conjunction[] = [[]];
		while (pos < tokens.length && !isKeyword(tokens[pos], "OR") && tokens[pos] !== ")") {
			const token = tokens[pos++];
			if (token === "(") {
				const alternatives = parseOr();
				if (tokens[pos++] !== ")") {
					throw new Error(`Unbalanced parentheses in query: ${query}`);
				}
				result = result.flatMap((left) => alternatives.map((right) => [...left, ...right]));
			} else if (!isKeyword(token, "AND")) {
				result = result.map((conjunction) => [...conjunction, token]);
			}
			if (result.length > MAX_SEGMENTS) {
				throw new Error(`Query expands to more than ${MAX_SEGMENTS} searches: ${query}`);
			}
		}
		return result;
	};

	const alternatives = parseOr();
	if (pos < tokens.length) {
		throw new Error(`Unbalanced parentheses in query: ${query}`);
	}
	return alternatives.map((conjunction) => conjunction.join(" ")).filter((segment) => segment.length > 0);
}

/**
 * Split on whitespace, with `(` and `)` as their own tokens. Quoted text (`label:"a b"`) stays in one token.
 */
function tokenize(query: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quoted = false;
	const flush = () => {
		if (current) tokens.push(current);
		current = "";
	};
	for (const char of query) {
		if (char === '"') {
			quoted = !quoted;
			current += char;
		} else if (quoted) {
			current += char;
		} else if (/\s/.test(char)) {
			flush();
		} else if (char === "(" || char === ")") {
			flush();
			tokens.push(char);
		} else {
			current += char;
		}
	}
	flush();
	return tokens;
}

/** OR / AND are accepted in any case; GitHub itself only recognises uppercase */
function isKeyword(token: string | undefined, keyword: "OR" | "AND"): boolean {
	return token?.toUpperCase() === keyword;
}
