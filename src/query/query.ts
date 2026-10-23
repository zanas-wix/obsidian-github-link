import { parseYaml, setIcon } from "obsidian";
import {
	searchIssues,
	getIssuesForRepo,
	getMyIssues,
	getPullRequest,
	getPullRequestsForRepo,
	getIssuesForOrganization,
	getPullStatuses,
} from "../github/github";
import { pullKey, rowPullStatuses, STATUS_COLUMNS, type PullRef } from "../github/pull-status";
import { getSearchResultPRStatus, type MaybePaginated, type PaginationMeta } from "../github/response";
import { openPullRequestPane, PluginSettings } from "../plugin";
import { getProp, isEqual, relativeTime, titleCase } from "../util";
import { bindCountdown, formatCountdown } from "../pr-view/countdown";
import { getPaneSelection, onPaneSelection, setPaneSelection } from "../pr-view/selection";
import { pullWatcher } from "../watch/watcher";
import { ALL_COLUMNS, DEFAULT_COLUMNS } from "./column/defaults";
import { applyPullState, pullStateChannel, type PullState } from "./pull-state";
import { setCopyTarget } from "./copy-link";
import { expandOrQuery } from "./or-query";
import { resolveRelativeDates } from "./relative-date";
import { groupIntoStacks, rowStackPositions, type PullBranches } from "./stack";
import type { QueryParams, TableResult } from "./types";
import { OutputType, QueryType } from "./types";

/** `statusRefresh` below this is raised to it; GitHub throttles bursts of requests */
const MIN_STATUS_REFRESH_SECONDS = 30;
/** Longest wait between status polls after repeated failures */
const MAX_STATUS_POLL_DELAY_MS = 10 * 60 * 1000;
/** A normal load may reuse statuses another block fetched this recently */
const INITIAL_STATUS_MAX_AGE_MS = 10 * 1000;

export class GithubQuery {
	private statusMaxAgeMs = INITIAL_STATUS_MAX_AGE_MS;
	/** Cards of this block by pull request key, so they can follow the side pane */
	private readonly cardsByKey = new Map<string, HTMLElement>();
	/** Rows by pull request key, so a state learned elsewhere can update the row */
	private readonly rowsByKey = new Map<string, TableResult[number]>();
	private selectedCard: HTMLElement | null = null;

	/**
	 * Mark the card of the pull request the pane shows. A card hidden in a collapsed stack gets its
	 * stack expanded, and the card is scrolled into view.
	 */
	private applySelection(key: string | null): void {
		if (!this.hostElement.isConnected) {
			return;
		}
		this.selectedCard?.removeClass("is-selected");
		this.selectedCard = null;
		const card = key ? this.cardsByKey.get(key) : undefined;
		if (!card) {
			return;
		}
		card.addClass("is-selected");
		this.selectedCard = card;

		// Only a card hidden by a collapsed stack (every one but the first) needs the stack opened
		const stack = card.parentElement;
		const isFirst = card.previousElementSibling?.hasClass("github-link-cards-stack-header") ?? false;
		if (stack?.hasClass("is-collapsed") && !isFirst) {
			stack.querySelector<HTMLElement>(".github-link-cards-stack-header")?.click();
		}
		card.scrollIntoView({ block: "nearest" });
	}

	/**
	 * Clicking a card (anywhere but a link or button) shows its pull request in the side pane and marks
	 * the card as selected. The pane also gets the stack the PR belongs to, for its stack navigator.
	 */
	private makeCardOpenPane(card: HTMLElement, row: TableResult[number], rows: TableResult[number][]): void {
		const [org, repo] = this.getRepoFullName(row)?.split("/") ?? [];
		if (!org || !repo) {
			return;
		}
		card.addClass("is-clickable");
		this.cardsByKey.set(pullKey({ org, repo, number: row.number }), card);
		card.addEventListener("click", (event) => {
			if ((event.target as HTMLElement).closest("a, button, summary")) {
				return;
			}
			// The pane and every query block follow this selection, ours included
			setPaneSelection(pullKey({ org, repo, number: row.number }));
			// Cmd/Ctrl+C now copies the link of the selected PR (which may change if the pane navigates a stack)
			setCopyTarget(this.hostElement, () => this.rowsByKey.get(getPaneSelection() ?? "")?.html_url ?? null);

			const stack = rowStackPositions.get(row);
			const start = stack ? rows.indexOf(row) - (stack.position - 1) : -1;
			const members = stack ? rows.slice(start, start + stack.size) : [];
			const siblings = members.flatMap((member) => {
				const [memberOrg, memberRepo] = this.getRepoFullName(member)?.split("/") ?? [];
				return memberOrg && memberRepo
					? [
							{
								ref: { org: memberOrg, repo: memberRepo, number: member.number },
								title: member.title,
								status: getSearchResultPRStatus(member),
							},
						]
					: [];
			});
			void openPullRequestPane({ ref: { org, repo, number: row.number }, stack: siblings });
		});
	}

	private params!: QueryParams;
	private result: TableResult | null = null;
	private resultMeta: PaginationMeta | null = null;
	/** Review/merge/CI cells of each card, so polling can redraw them in place */
	private readonly statusCells = new Map<TableResult[number], [string, HTMLElement][]>();
	private pollTimer: number | null = null;
	/** When the next `statusRefresh` poll is due, for the countdown in the footer */
	private nextPollAt: number | null = null;
	private pollFailures = 0;
	/** Stacks the user collapsed, by the URL of their bottom PR; kept across re-renders */
	private readonly collapsedStacks = new Set<string>();

	/**
	 * A stack's container with a clickable header that collapses or expands its cards
	 */
	private createStackContainer(list: HTMLElement, key: string, size: number): HTMLElement {
		const container = list.createDiv({ cls: "github-link-cards-stack" });
		const header = container.createDiv({ cls: "github-link-cards-stack-header" });
		const chevron = header.createSpan({ cls: "github-link-cards-stack-chevron" });
		const label = header.createSpan();
		const hint = header.createSpan({ cls: "github-link-cards-stack-hint" });
		const apply = (collapsed: boolean) => {
			container.toggleClass("is-collapsed", collapsed);
			setIcon(chevron, collapsed ? "lucide-chevron-right" : "lucide-chevron-down");
			label.setText(`Stack of ${size} PRs`);
			hint.setText(collapsed ? `+${size - 1} hidden` : "");
		};
		apply(this.collapsedStacks.has(key));
		header.addEventListener("click", () => {
			const collapsed = !container.hasClass("is-collapsed");
			if (collapsed) {
				this.collapsedStacks.add(key);
			} else {
				this.collapsedStacks.delete(key);
			}
			apply(collapsed);
		});
		return container;
	}

	constructor(private readonly hostElement: HTMLElement) {
		onPaneSelection(this, (query, key) => query.applySelection(key));
		pullStateChannel.subscribe(this, (query, { key, state, draft }) => query.applyState(key, state, draft));
	}

	public async init(source: string): Promise<void> {
		const parsedParams = this.parseCodeblock(source);
		if (!parsedParams) {
			console.error(`Github Link: simplistic parsing failed`);
		} else {
			await this.setParams(parsedParams);
		}
	}

	/**
	 * Setting the parameters triggers calling the API
	 */
	public async setParams(newParams: QueryParams = this.params, forceUpdate = false): Promise<void> {
		const currentParams = this.params;
		this.params = newParams;
		if (forceUpdate || !isEqual(currentParams, newParams)) {
			const result = await this.executeQuery(forceUpdate);
			if (result) {
				this.setResult(result.response, result.meta);
			}
		}
	}

	public setResult(result: TableResult, meta: PaginationMeta): void {
		this.result = result;
		this.resultMeta = meta;
		this.render();
		void this.loadStatusesLazily(result);
		this.watchOpenPullRequests(result);
	}

	/**
	 * `notify: true`: watch every open pull request shown. The watcher skips muted ones and does not
	 * announce what is already true about the rest.
	 */
	private watchOpenPullRequests(result: TableResult): void {
		if (!this.params.notify || this.params.queryType !== QueryType.PullRequest) {
			return;
		}
		const pulls = result.flatMap((row) => {
			const [org, repo] = this.getRepoFullName(row)?.split("/") ?? [];
			return org && repo && row.state === "open" ? [{ ref: { org, repo, number: row.number }, title: row.title }] : [];
		});
		pullWatcher.addAuto(pulls);
	}

	/**
	 * Review, merge and CI state are loaded after the list is on screen, so they never delay it.
	 * The status cells are empty (with a loading mark) until they arrive, then redrawn in place.
	 */
	private async loadStatusesLazily(result: TableResult): Promise<void> {
		if (this.params.queryType !== QueryType.PullRequest || !this.getColumns().some((c) => STATUS_COLUMNS.includes(c))) {
			return;
		}
		this.hostElement.addClass("is-loading-status");
		const ok = await this.loadPullStatuses(result, this.statusMaxAgeMs);
		this.hostElement.removeClass("is-loading-status");
		// A newer result (another page, a refresh) may have replaced this one while loading
		if (ok && this.result === result) {
			this.redrawStatuses();
		}
	}

	public parseCodeblock(source: string): QueryParams | null {
		let params: QueryParams | null;
		try {
			params = parseYaml(source) as QueryParams;
		} catch (e) {
			console.error(`Github Link: YAML Parsing failed, attempting simplistic parsing`);
			console.error(e);
			params = Object.fromEntries(source.split("\n").map((l) => l.split(/:\s?/))) as QueryParams;
		}
		return params ?? null;
	}

	public async executeQuery(skipCache = false): Promise<MaybePaginated<TableResult> | null> {
		const params = this.params.query ? { ...this.params, query: resolveRelativeDates(this.params.query) } : this.params;
		const segments = params.query ? expandOrQuery(params.query) : [];
		let result: MaybePaginated<TableResult> | null;
		if (segments.length > 1) {
			result = await this.fetchUnion(segments, skipCache);
		} else if (params.outputType === OutputType.Cards) {
			result = await this.fetchAllPages(params, skipCache);
		} else {
			result = await this.fetchResult(params, skipCache);
		}
		if (result && this.params.stack && this.params.queryType === QueryType.PullRequest) {
			result.response = await this.groupByStack(result.response, skipCache);
		}
		// A reload from the refresh button asks for fresh data; an ordinary load may reuse seconds-old statuses
		this.statusMaxAgeMs = skipCache ? 0 : INITIAL_STATUS_MAX_AGE_MS;
		return result;
	}

	/**
	 * Columns to show: the requested ones, lowercased, or the defaults for the output type
	 */
	private getColumns(): string[] {
		const queryType = this.params.queryType;
		let columns = this.params.columns;
		if (!columns || columns.length === 0) {
			columns = [...DEFAULT_COLUMNS[queryType]];
			if (this.params.outputType === OutputType.Cards) {
				columns = columns.filter((c) => c !== "author");
			}
			if (this.params.stack && queryType === QueryType.PullRequest) {
				columns.push("stack");
			}
		}
		return columns.map((c) => c.toLowerCase());
	}

	/**
	 * Review, merge and CI state come from GraphQL, 25 PRs per request. Statuses fetched less than
	 * `maxAgeMs` ago (by any query block) are reused. A failure only leaves those cells as they were.
	 * Returns whether the statuses could be loaded.
	 */
	private async loadPullStatuses(rows: TableResult, maxAgeMs = 0): Promise<boolean> {
		const refs: PullRef[] = [];
		for (const row of rows) {
			const [org, repo] = this.getRepoFullName(row)?.split("/") ?? [];
			if (org && repo) {
				refs.push({ org, repo, number: row.number });
			}
		}
		try {
			const statuses = await getPullStatuses(refs, maxAgeMs);
			for (const row of rows) {
				const [org, repo] = this.getRepoFullName(row)?.split("/") ?? [];
				const status = org && repo ? statuses.get(pullKey({ org, repo, number: row.number })) : undefined;
				if (status) {
					rowPullStatuses.set(row, status);
					applyPullState(row, status.state, status.draft);
				}
			}
			return true;
		} catch (e) {
			console.error("Github Link: could not load pull request statuses", e);
			return false;
		}
	}

	/**
	 * Optional polling (`statusRefresh: <seconds>`) of review, merge and CI state. Kept cheap on purpose:
	 * - one batched request per 25 open PRs, never one per PR
	 * - closed and merged PRs are not polled
	 * - nothing is requested while the window is hidden or once the block has left the page
	 * - statuses another block fetched recently are reused
	 * - after a failed poll the delay doubles (up to 10 minutes) instead of hammering GitHub
	 */
	private scheduleStatusPoll(): void {
		const seconds = this.params.statusRefresh;
		if (
			!seconds ||
			this.pollTimer !== null ||
			this.params.queryType !== QueryType.PullRequest ||
			!this.getColumns().some((c) => STATUS_COLUMNS.includes(c))
		) {
			return;
		}
		const intervalMs = Math.max(seconds, MIN_STATUS_REFRESH_SECONDS) * 1000;
		const delay = Math.min(intervalMs * 2 ** this.pollFailures, MAX_STATUS_POLL_DELAY_MS);
		this.nextPollAt = Date.now() + delay;
		this.pollTimer = window.setTimeout(() => {
			this.pollTimer = null;
			this.nextPollAt = null;
			void this.pollStatuses(intervalMs);
		}, delay);
	}

	private async pollStatuses(intervalMs: number): Promise<void> {
		if (!this.hostElement.isConnected) {
			return;
		}
		if (!document.hidden && this.result) {
			const open = this.result.filter((row) => row.state === "open") as TableResult;
			const ok = await this.loadPullStatuses(open, intervalMs * 0.8);
			this.pollFailures = ok ? 0 : this.pollFailures + 1;
			if (ok) {
				this.redrawStatuses();
			}
		}
		this.scheduleStatusPoll();
	}

	/**
	 * Redraw only the status cells; the rest of the list (scroll position, collapsed stacks) is untouched.
	 */
	private redrawStatuses(): void {
		if (this.params.outputType !== OutputType.Cards) {
			this.render();
			return;
		}
		for (const [row, cells] of this.statusCells) {
			for (const [column, cell] of cells) {
				cell.empty();
				void ALL_COLUMNS[this.params.queryType][column]?.cell(row, cell);
			}
		}
		// A status load also learns whether a PR was merged, closed or made draft meanwhile
		for (const key of this.rowsByKey.keys()) {
			this.redrawStateIcon(key);
		}
	}

	/**
	 * A PR's state was learned after this list loaded (the pane reloaded it): update its row and icon.
	 */
	private applyState(key: string, state: PullState, draft: boolean): void {
		const row = this.rowsByKey.get(key);
		if (!this.hostElement.isConnected || !row) {
			return;
		}
		if (applyPullState(row, state, draft)) {
			if (this.params.outputType === OutputType.Cards) {
				this.redrawStateIcon(key);
			} else {
				this.render();
			}
		}
	}

	private redrawStateIcon(key: string): void {
		const row = this.rowsByKey.get(key);
		const cell = this.cardsByKey.get(key)?.querySelector<HTMLElement>(".github-link-card-status");
		if (row && cell) {
			cell.empty();
			void ALL_COLUMNS[this.params.queryType]["status"]?.cell(row, cell);
		}
	}

	/**
	 * OR query: run every segment as its own search (all pages, one after the other) and merge
	 * the results without duplicates. Merged results are never paginated.
	 */
	private async fetchUnion(segments: string[], skipCache: boolean): Promise<MaybePaginated<TableResult> | null> {
		const seen = new Set<string>();
		const rows: TableResult[number][] = [];
		for (const query of segments) {
			const result = await this.fetchAllPages({ ...this.params, query }, skipCache);
			if (!result) {
				return null;
			}
			for (const row of result.response) {
				if (!seen.has(row.html_url)) {
					seen.add(row.html_url);
					rows.push(row);
				}
			}
		}

		// Each segment came back sorted on its own; restore one order when sorting by date
		const field = this.params.sort === "created" ? "created_at" : this.params.sort === "updated" ? "updated_at" : null;
		if (field) {
			const direction = this.params.order === "asc" ? 1 : -1;
			rows.sort((a, b) => direction * (new Date(a[field]).valueOf() - new Date(b[field]).valueOf()));
		}
		return { meta: {}, response: rows as TableResult };
	}

	/**
	 * Follow the `next` links until every result is loaded.
	 */
	private async fetchAllPages(params: QueryParams, skipCache: boolean): Promise<MaybePaginated<TableResult> | null> {
		const base: QueryParams = { ...params, per_page: params.per_page ?? 100 };
		let page = base.page ?? 1;
		const rows: TableResult[number][] = [];
		for (;;) {
			const result = await this.fetchResult({ ...base, page }, skipCache);
			if (!result) {
				return null;
			}
			rows.push(...result.response);
			const next = result.meta.next?.page;
			if (next === undefined || next <= page) {
				return { meta: {}, response: rows as TableResult };
			}
			page = next;
		}
	}

	private async fetchResult(params: QueryParams, skipCache: boolean): Promise<MaybePaginated<TableResult> | null> {
		if (params.outputType === OutputType.Table || params.outputType === OutputType.Cards) {
			// Custom Query
			if (params.query && (params.queryType === QueryType.Issue || params.queryType === QueryType.PullRequest)) {
				const { meta, response } = await searchIssues(params, params.query, params.org, skipCache);
				return { meta, response: response.items };
			}
			// Issue query with org and repo provided
			else if (params.queryType === QueryType.Issue && params.org && params.repo) {
				return await getIssuesForRepo(params, params.org, params.repo, skipCache);
			}
			// Issue query with only org provided
			else if (params.queryType === QueryType.Issue && params.org) {
				// TODO: Handle error case here if provided org cannot be found
				return await getIssuesForOrganization(params, params.org, skipCache);
			}
			// Issue query without org or repo provided
			else if (params.queryType === QueryType.Issue) {
				return await getMyIssues(params, params.org, skipCache);
			}
			// Pull request query with org and repo provided
			else if (params.queryType === QueryType.PullRequest && params.org && params.repo) {
				return await getPullRequestsForRepo(params, params.org, params.repo, skipCache);
			}
		}
		return null;
	}

	/**
	 * Reorder rows so each PR stack is contiguous, bottom PR first. Only PRs in the current page
	 * of results can be stacked. Search results carry no branch names, so those PRs are fetched.
	 */
	private async groupByStack(rows: TableResult, skipCache: boolean): Promise<TableResult> {
		const branches = new Map<object, PullBranches | null>();
		await Promise.all(
			rows.map(async (row) => {
				try {
					branches.set(row, await this.getBranches(row, skipCache));
				} catch (e) {
					console.error(`Github Link: could not load branches for #${row.number}`, e);
					branches.set(row, null);
				}
			}),
		);
		const { ordered, positions } = groupIntoStacks([...rows], (row) => branches.get(row) ?? null);
		for (const [row, position] of positions) {
			rowStackPositions.set(row, position);
		}
		return ordered as TableResult;
	}

	private async getBranches(row: TableResult[number], skipCache: boolean): Promise<PullBranches | null> {
		// Pull request list rows already include both branches
		if ("head" in row && "base" in row) {
			return {
				repo: row.base.repo.full_name,
				base: row.base.ref,
				headRepo: row.head.repo?.full_name ?? "",
				head: row.head.ref,
			};
		}

		// Search results only know the repository, so fetch the pull request itself
		const repositoryUrl = "repository_url" in row ? row.repository_url : "";
		const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(repositoryUrl);
		if (!match) {
			return null;
		}
		const full = await getPullRequest(match[1], match[2], row.number, skipCache);
		return {
			repo: full.base.repo.full_name,
			base: full.base.ref,
			headRepo: full.head.repo?.full_name ?? "",
			head: full.head.ref,
		};
	}

	public render(): void {
		if (!this.result) {
			throw new Error("Attempted to render before there was a result.");
		}

		this.hostElement.empty();
		const queryType = this.params.queryType;

		const columns = this.getColumns();
		this.statusCells.clear();
		this.cardsByKey.clear();
		this.rowsByKey.clear();
		if (queryType === QueryType.PullRequest) {
			for (const row of this.result) {
				const [org, repo] = this.getRepoFullName(row)?.split("/") ?? [];
				if (org && repo) {
					this.rowsByKey.set(pullKey({ org, repo, number: row.number }), row);
				}
			}
		}

		if (this.params.outputType === OutputType.Cards) {
			const wrapper = this.hostElement.createDiv({ cls: "github-link-cards-wrapper" });
			this.renderCards(wrapper, queryType, columns, this.result);
			this.renderFooter(this.params, this.resultMeta, wrapper);
		} else {
			const tableWrapper = this.hostElement.createDiv({ cls: "github-link-table-wrapper" });
			const tableScrollWrapper = tableWrapper.createDiv({ cls: "github-link-table-scroll-wrapper" });
			const table = tableScrollWrapper.createEl("table", { cls: "github-link-table" });
			this.renderFooter(this.params, this.resultMeta, tableWrapper);
			this.renderHeader(table, queryType, columns);
			this.renderBody(table, queryType, columns, this.result);
		}
		this.applySelection(getPaneSelection());
		this.scheduleStatusPoll();
	}

	/**
	 * Compact full-width rows, optionally under one heading per repo (`groupBy: repo`).
	 * Groups keep the order their first PR appeared in; rows keep their order within a group,
	 * so a PR stack stays contiguous.
	 */
	private renderCards(parent: HTMLElement, queryType: QueryType, columns: string[], result: TableResult): void {
		// One grid for the whole block: every card (and group, and stack) is a subgrid of it, so the
		// columns line up across all of them. Tracks: icon, title, one per side cell.
		const sideColumns = columns.filter((c) => !["title", "status", "stack"].includes(c));
		const sideCells =
			sideColumns.length +
			(columns.includes("stack") ? 1 : 0) +
			(sideColumns.some((c) => STATUS_COLUMNS.includes(c)) ? 1 : 0);
		const root = parent.createDiv({ cls: "github-link-cards-root" });
		root.style.setProperty("--side-cells", `${sideCells}`);

		if (this.params.groupBy !== "repo") {
			this.renderCardRows(root.createDiv({ cls: "github-link-cards" }), queryType, columns, [...result]);
			return;
		}

		const groups = new Map<string, TableResult[number][]>();
		for (const row of result) {
			const repo = this.getRepoFullName(row) ?? "";
			groups.set(repo, [...(groups.get(repo) ?? []), row]);
		}
		for (const [repo, rows] of groups) {
			const group = root.createDiv({ cls: "github-link-cards-group" });
			const heading = group.createDiv({ cls: "github-link-cards-group-heading" });
			heading.createEl("a", {
				text: repo || "Unknown repository",
				href: repo ? `https://github.com/${repo}` : "#",
				attr: { target: "_blank" },
			});
			heading.createSpan({ cls: "github-link-cards-group-count", text: `${rows.length}` });
			this.renderCardRows(group.createDiv({ cls: "github-link-cards" }), queryType, columns, rows);
		}
	}

	/**
	 * One row per PR: status icon, linked title, then every other column on the right in the order
	 * given, with the stack position last. PRs in the same stack share a container, bottom first.
	 */
	private renderCardRows(
		list: HTMLElement,
		queryType: QueryType,
		columns: string[],
		rows: TableResult[number][],
	): void {
		const dates: Record<string, (row: TableResult[number]) => string | null | undefined> = {
			created: (row) => row.created_at,
			updated: (row) => row.updated_at,
			closed: (row) => row.closed_at,
		};
		const sideColumns = columns.filter((c) => !["title", "status", "stack"].includes(c));
		const statusRenderer = ALL_COLUMNS[queryType]["status"];

		let stackContainer: HTMLElement | null = null;
		for (const row of rows) {
			const stack = rowStackPositions.get(row);
			if (!stack) {
				stackContainer = null;
			} else if (stack.position === 1 || !stackContainer) {
				stackContainer = this.createStackContainer(list, row.html_url, stack.size);
			}
			const card = (stackContainer ?? list).createDiv({ cls: "github-link-card" });
			if (stack) {
				card.style.setProperty("--stack-depth", `${stack.depth}`);
				card.toggleClass("github-link-card-nested", stack.depth > 0);
			}
			if (queryType === QueryType.PullRequest) {
				this.makeCardOpenPane(card, row, rows);
			}

			if (statusRenderer) {
				void statusRenderer.cell(row, card.createDiv({ cls: "github-link-card-status" }));
			}

			// Plain text, not a link: clicking the card opens the pane, and the number column links to GitHub
			card.createSpan({ cls: "github-link-card-title", text: row.title });

			const side = card.createDiv({ cls: "github-link-card-side" });
			const statusCells: [string, HTMLElement][] = [];
			// Every card renders the same number of cells, empty ones included, so the grid columns line up
			for (const col of sideColumns) {
				if (dates[col]) {
					const date = dates[col](row);
					side.createSpan({ text: date ? relativeTime(date) : "", attr: date ? { title: date } : {} });
				} else {
					const cell = this.renderCardField(side, queryType, col, row);
					if (STATUS_COLUMNS.includes(col)) {
						statusCells.push([col, cell]);
					}
				}
			}
			if (columns.includes("stack")) {
				side.createSpan({
					cls: "github-link-card-stack-position",
					text: stack ? `${stack.position}/${stack.size}` : "",
				});
			}
			if (statusCells.length > 0) {
				this.statusCells.set(row, statusCells);
				this.addStatusRefresh(side, queryType, row, statusCells);
			}
		}
	}

	private getRepoFullName(row: TableResult[number]): string | null {
		if ("repository_url" in row) {
			return /\/repos\/([^/]+\/[^/]+)$/.exec(row.repository_url)?.[1] ?? null;
		}
		return "base" in row ? row.base.repo.full_name : null;
	}

	private renderCardField(
		parent: HTMLElement,
		queryType: QueryType,
		column: string,
		row: TableResult[number],
	): HTMLElement {
		const renderer = ALL_COLUMNS[queryType][column];
		const field = parent.createSpan();
		if (STATUS_COLUMNS.includes(column)) {
			field.addClass("github-link-status-cell");
		}
		if (renderer) {
			void renderer.cell(row, field);
		} else {
			const raw = getProp(row, column);
			field.setText(raw === null ? "" : typeof raw === "string" ? raw : JSON.stringify(raw));
		}
		return field;
	}

	/**
	 * A refresh button that reloads review, merge and CI state of one PR and redraws just its status cells
	 */
	private addStatusRefresh(
		parent: HTMLElement,
		queryType: QueryType,
		row: TableResult[number],
		cells: [string, HTMLElement][],
	): void {
		const button = parent.createEl("button", {
			cls: ["clickable-icon", "github-link-card-refresh"],
			attr: { "aria-label": "Refresh status" },
		});
		setIcon(button, "lucide-refresh-cw");
		button.addEventListener("click", () => {
			if (button.hasClass("is-loading")) {
				return;
			}
			button.addClass("is-loading");
			void this.loadPullStatuses([row] as TableResult).then(() => {
				for (const [column, cell] of cells) {
					cell.empty();
					void ALL_COLUMNS[queryType][column]?.cell(row, cell);
				}
				button.removeClass("is-loading");
			});
		});
	}

	private renderHeader(table: HTMLTableElement, queryType: QueryType, columns: string[]): void {
		const thead = table.createEl("thead");
		for (const col of columns) {
			const th = thead.createEl("th");
			// Get predefined header if available, otherwise try and create a title
			th.setText(ALL_COLUMNS[queryType][col]?.header ?? titleCase(col));
		}
	}

	private renderBody(table: HTMLTableElement, queryType: QueryType, columns: string[], result: TableResult): void {
		const tbody = table.createEl("tbody");
		for (const row of result) {
			const tr = tbody.createEl("tr");
			const stack = rowStackPositions.get(row);
			if (stack) {
				tr.addClass("github-link-table-stack-row");
				if (stack.position === 1) {
					tr.addClass("github-link-table-stack-first");
				}
				if (stack.position === stack.size) {
					tr.addClass("github-link-table-stack-last");
				}
			}
			for (const col of columns) {
				this.renderCell(tr, queryType, col, row);
			}
		}
	}

	private renderCell(tr: HTMLTableRowElement, queryType: QueryType, column: string, row: TableResult[number]): void {
		const cell = tr.createEl("td");
		const renderer = ALL_COLUMNS[queryType][column];
		if (renderer) {
			void renderer.cell(row, cell);
		} else {
			const cellVal = getProp(row, column);
			if (cellVal !== null) {
				cell.setText(typeof cellVal === "string" ? cellVal : JSON.stringify(cellVal));
			} else {
				cell.setText("");
			}
		}
	}

	private renderFooter(params: QueryParams, meta: PaginationMeta | null, parent: HTMLElement): void {
		const footer = parent.createDiv({ cls: "github-link-table-footer" });

		// Add external link to footer if available
		const externalLink = this.getExternalLink(params);
		if (externalLink && PluginSettings.showExternalLink) {
			footer.createEl("a", {
				cls: "github-link-table-footer-external-link",
				text: "View on GitHub",
				href: externalLink,
				attr: { target: "_blank" },
			});
		}

		this.renderPagination(meta, footer);
		this.renderPollInfo(footer);

		if (PluginSettings.showRefresh) {
			const refreshButton = footer.createEl("button", {
				cls: "clickable-icon",
				attr: { "aria-label": "Refresh Results" },
			});
			refreshButton.addEventListener("click", () => {
				void this.setParams(this.params, true);
			});
			setIcon(refreshButton, "refresh-cw");
		}
	}

	/**
	 * When the automatic checks of this block are next due: the status poll (`statusRefresh`) and the
	 * notification watcher (`notify`). Ticks every second without redrawing the list.
	 */
	private renderPollInfo(parent: HTMLElement): void {
		if (!this.params.statusRefresh && !this.params.notify) {
			return;
		}
		const info = parent.createSpan({ cls: "github-link-table-poll" });
		bindCountdown(info, () => {
			const parts: string[] = [];
			if (this.params.statusRefresh && this.nextPollAt !== null) {
				parts.push(`status poll in ${formatCountdown(this.nextPollAt - Date.now())}`);
			}
			const next = pullWatcher.nextCheckAt();
			if (this.params.notify && next !== null) {
				parts.push(`notification check in ${formatCountdown(next - Date.now())}`);
			}
			return parts.join(" · ");
		});
	}

	private renderPagination(meta: PaginationMeta | null, parent: HTMLElement): void {
		if (PluginSettings.showPagination && this.hasSomeRel(meta)) {
			const pagination = parent.createDiv({ cls: "github-link-table-pagination" });

			// First, previous
			if (meta?.first && (!meta.prev || meta.prev.page !== meta.first.page)) {
				const first = pagination.createEl("a", { text: "<<", href: "#", attr: { role: "button" } });
				first.addEventListener("click", () => {
					void this.setParams({ ...this.params, page: meta.first?.page });
				});
			}
			if (meta?.prev) {
				const prev = pagination.createEl("a", { text: meta.prev.page.toString(), href: "#", attr: { role: "button" } });
				prev.addEventListener("click", () => {
					void this.setParams({ ...this.params, page: meta.prev?.page });
				});
			}

			// Current Page
			pagination.createSpan({ text: (this.params.page ?? 1).toString() });

			// Next, last
			if (meta?.next) {
				const next = pagination.createEl("a", { text: meta.next.page.toString(), href: "#", attr: { role: "button" } });
				next.addEventListener("click", () => {
					void this.setParams({ ...this.params, page: meta.next?.page });
				});
			}
			if (meta?.last && (!meta.next || meta.next.page !== meta.last.page)) {
				const last = pagination.createEl("a", { text: ">>", href: "#", attr: { role: "button" } });
				last.addEventListener("click", () => {
					void this.setParams({ ...this.params, page: meta.last?.page });
				});
			}
		}
	}

	private hasSomeRel(meta: PaginationMeta | null): boolean {
		return Boolean(meta && (meta.first || meta.prev || meta.next || meta.last));
	}

	private getExternalLink(params: QueryParams): string | null {
		// Custom search query
		if (params.query && (params.queryType === QueryType.Issue || params.queryType === QueryType.PullRequest)) {
			return `https://github.com/search?q=${encodeURIComponent(params.query)}`;
		} else {
			return null;
		}
	}
}
