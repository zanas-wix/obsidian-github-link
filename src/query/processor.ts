import type { MarkdownPostProcessorContext } from "obsidian";
import { GithubQuery } from "./query";

/**
 * Renders a placeholder immediately and loads the query in the background. Awaiting the query here
 * would hold up Obsidian's reading view rendering for the whole duration of the API calls, and a
 * failed request would leave an empty block with only an unhandled rejection in the console.
 */
export function QueryProcessor(source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
	el.createDiv({ cls: "github-link-query-status", text: "Loading GitHub query…" });
	const query = new GithubQuery(el);
	query
		.init(source)
		.then(() => {
			// Nothing rendered: the params did not match any supported query
			const status = el.querySelector(".github-link-query-status");
			if (status && !el.querySelector(".github-link-table-wrapper, .github-link-cards-wrapper")) {
				status.setText("Nothing to show: check outputType, queryType and query (or org/repo).");
			}
		})
		.catch((err: unknown) => {
			console.error("Github Link: query failed", err);
			el.empty();
			const message =
				err instanceof Error
					? err.message
					: typeof err === "object" && err && "message" in err
						? String(err.message)
						: "unknown error";
			el.createDiv({
				cls: "github-link-query-status github-link-query-error",
				text: `GitHub query failed: ${message}`,
			});
		});
}
