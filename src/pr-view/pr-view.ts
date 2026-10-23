import {
	ItemView,
	MarkdownRenderer,
	Menu,
	Modal,
	Notice,
	setIcon,
	type App,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";
import {
	closePullRequest,
	getPullDetail,
	postPullComment,
	setPullAutoMerge,
	setPullDraft,
	squashMergePullRequest,
} from "../github/github";
import type { CheckState, PullDetail, ReviewState, TimelineComment, TimelineItem } from "../github/pull-detail";
import { POLL_DELAY_MS, pollDelayMs, pullKey, type PullRef, type PullStatus } from "../github/pull-status";
import { IssueStatus } from "../github/response";
import { setPRIcon } from "../icon";
import { diffAnchor } from "../github/diff-anchor";
import { relativeTime } from "../util";
import { pullWatcher } from "../watch/watcher";
import { pullStateChannel } from "../query/pull-state";
import { findCiReport, queryParams } from "./ci-report";
import { bindCountdown, formatCountdown } from "./countdown";
import { getDraftAction, getMergeAction } from "./merge-action";
import { formatForLlm } from "./llm-copy";
import { QUICK_COMMENTS } from "./quick-comments";
import { getReadiness, type Tone } from "./readiness";
import { setPaneSelection } from "./selection";

export const PULL_VIEW_TYPE = "github-link-pull-request";

/** One pull request of a stack, for the pane's stack navigator */
export interface PaneSibling {
	ref: PullRef;
	title: string;
	status: IssueStatus;
}

export interface PullPaneTarget {
	ref: PullRef;
	/** The whole stack the pull request belongs to, bottom first; empty when it is not stacked */
	stack: PaneSibling[];
}

const TONE_ICON: Record<Tone, string> = {
	success: "lucide-check",
	danger: "lucide-x",
	attention: "lucide-clock",
	neutral: "lucide-minus",
};

const REVIEW_ICON: Record<ReviewState, [Tone, string]> = {
	approved: ["success", "Approved"],
	"changes-requested": ["danger", "Changes requested"],
	commented: ["neutral", "Commented"],
	dismissed: ["neutral", "Dismissed"],
	pending: ["attention", "Pending"],
};

const CHECK_TONE: Record<CheckState, Tone> = {
	success: "success",
	failure: "danger",
	pending: "attention",
	neutral: "neutral",
};

/** The parts of a PR's detail that decide how often it needs checking */
function toPollInput(pull: PullDetail): Pick<PullStatus, "draft" | "merge" | "review" | "ci"> {
	const state = pull.checks.some((check) => check.state === "pending")
		? "pending"
		: pull.checks.some((check) => check.state === "failure")
			? "failure"
			: pull.checks.length > 0
				? "success"
				: null;
	return {
		draft: pull.draft,
		merge: pull.mergeable,
		review: pull.review,
		ci: { state, passed: 0, total: pull.checks.length },
	};
}

function pullUrl(ref: PullRef): string {
	return `https://github.com/${ref.org}/${ref.repo}/pull/${ref.number}`;
}

function pullStatus(pull: PullDetail): IssueStatus {
	if (pull.state === "merged") return IssueStatus.Done;
	if (pull.state === "closed") return IssueStatus.Closed;
	return pull.draft ? IssueStatus.Draft : IssueStatus.Open;
}

/**
 * Side pane with everything about one pull request: merge readiness, stack, reviewers, checks,
 * description, conversation and changed files. Follows whichever card was last selected.
 */
export class PullRequestView extends ItemView {
	private target: PullPaneTarget | null = null;
	private detail: PullDetail | null = null;
	private onlyUnresolved = false;
	/** Guards against a slow response replacing a newer one */
	private loadId = 0;
	private refreshTimer: number | null = null;
	private nextRefreshAt: number | null = null;
	private lastRefreshAt: number | null = null;
	private refreshing = false;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return PULL_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.target ? `#${this.target.ref.number} ${this.detail?.title ?? ""}`.trim() : "Pull request";
	}

	getIcon(): string {
		return "git-pull-request";
	}

	onOpen(): Promise<void> {
		this.contentEl.addClass("github-link-pr");
		this.register(() => this.clearRefreshTimer());
		// A watch also ends by itself (notified, merged, closed), which changes the bell
		this.register(
			pullWatcher.subscribe(() => {
				const scroll = this.contentEl.scrollTop;
				this.render();
				this.contentEl.scrollTop = scroll;
			}),
		);
		this.render();
		return Promise.resolve();
	}

	/** Keeps the pane's pull request across Obsidian restarts */
	getState(): Record<string, unknown> {
		return { ref: this.target?.ref ?? null };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const ref = (state as { ref?: PullRef | null } | null)?.ref;
		if (ref) {
			await this.setTarget({ ref, stack: [] });
		}
		await super.setState(state, result);
	}

	async setTarget(target: PullPaneTarget): Promise<void> {
		this.target = target;
		// Query cards follow the pane, e.g. when jumping through a stack from its navigator
		setPaneSelection(pullKey(target.ref));
		this.detail = null;
		this.render();
		await this.refresh(false);
	}

	/**
	 * Fetch the pull request. A silent reload (auto refresh) keeps the scroll position and does not
	 * redraw when nothing changed.
	 */
	private async refresh(silent: boolean): Promise<void> {
		const target = this.target;
		if (!target) {
			return;
		}
		const id = ++this.loadId;
		this.refreshing = true;
		if (!silent) {
			this.contentEl.addClass("is-loading");
		}
		try {
			const detail = await getPullDetail(target.ref);
			if (id !== this.loadId) {
				return;
			}
			const unchanged = silent && JSON.stringify(detail) === JSON.stringify(this.detail);
			this.detail = detail;
			// Every list showing this PR follows what GitHub says now (e.g. it was merged)
			pullStateChannel.publish({ key: pullKey(detail.ref), state: detail.state, draft: detail.draft });
			if (!unchanged) {
				const scroll = this.contentEl.scrollTop;
				this.render();
				this.contentEl.scrollTop = scroll;
			}
			(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
		} catch (error) {
			if (id === this.loadId && !silent) {
				this.renderError(error);
			}
		} finally {
			if (id === this.loadId) {
				this.contentEl.removeClass("is-loading");
				this.refreshing = false;
				this.lastRefreshAt = Date.now();
				this.scheduleRefresh();
			}
		}
	}

	private clearRefreshTimer(): void {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = null;
		this.nextRefreshAt = null;
	}

	/**
	 * Quietly re-check the pull request, as soon as what it is doing calls for (see `pollTier`):
	 * often while CI runs, rarely while it is stuck, never once it is merged or closed. A hidden pane
	 * skips the request and looks again at the same pace.
	 */
	private scheduleRefresh(): void {
		this.clearRefreshTimer();
		const pull = this.detail;
		if (!this.target || (pull && pull.state !== "open")) {
			return;
		}
		const delay = pull ? pollDelayMs([toPollInput(pull)]) : POLL_DELAY_MS.waiting;
		this.nextRefreshAt = Date.now() + delay;
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			if (this.containerEl.isShown() && !document.hidden) {
				void this.refresh(true);
			} else {
				this.scheduleRefresh();
			}
		}, delay);
	}

	/**
	 * One live line: when the pane last updated and when it will next ask GitHub, plus the notification
	 * check if this PR is watched. Ticks every second without redrawing the pane.
	 */
	private renderPollInfo(parent: HTMLElement, pull: PullDetail): void {
		const info = parent.createDiv({ cls: "github-link-pr-poll" });
		bindCountdown(info, () => {
			if (this.refreshing) {
				return "Refreshing…";
			}
			const parts: string[] = [];
			if (this.lastRefreshAt !== null) {
				parts.push(`updated ${formatCountdown(Date.now() - this.lastRefreshAt)} ago`);
			}
			parts.push(
				this.nextRefreshAt !== null
					? `refresh in ${formatCountdown(this.nextRefreshAt - Date.now())}`
					: "no auto-refresh",
			);
			const next = pullWatcher.nextCheckAt();
			if (pullWatcher.has(pull.ref) && next !== null) {
				parts.push(`notification check in ${formatCountdown(next - Date.now())}`);
			}
			return parts.join(" · ");
		});
	}

	private renderError(error: unknown): void {
		this.contentEl.empty();
		const message =
			error instanceof Error
				? error.message
				: typeof error === "object" && error && "message" in error
					? String(error.message)
					: "unknown error";
		this.contentEl.createDiv({ cls: "github-link-pr-empty", text: `Could not load the pull request: ${message}` });
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		if (!this.target) {
			el.createDiv({ cls: "github-link-pr-empty", text: "Select a pull request card to see its details here." });
			return;
		}
		const pull = this.detail;
		if (!pull) {
			el.createDiv({ cls: "github-link-pr-empty", text: `Loading #${this.target.ref.number}…` });
			return;
		}

		// The bar is a direct child of the scrolling element (which has no padding), so it sticks flush
		// to the top; everything else sits in a padded body below it
		this.renderStatusBar(el, pull);
		const body = el.createDiv({ cls: "github-link-pr-body" });
		this.renderHeader(body, pull);
		this.renderReadiness(body, pull);
		this.renderStack(body, pull);
		this.renderReviewers(body, pull);
		this.renderChecks(body, pull);
		this.renderCiReport(body, pull);
		this.renderDescription(body, pull);
		this.renderConversation(body, pull);
		this.renderFiles(body, pull);
	}

	private section(parent: HTMLElement, title: string, open = true, summary?: string): HTMLElement {
		const details = parent.createEl("details", { cls: "github-link-pr-section" });
		details.open = open;
		const head = details.createEl("summary");
		head.createSpan({ text: title });
		if (summary) {
			head.createSpan({ cls: "github-link-pr-section-summary", text: summary });
		}
		return details.createDiv({ cls: "github-link-pr-section-body" });
	}

	private renderHeader(parent: HTMLElement, pull: PullDetail): void {
		const header = parent.createDiv({ cls: "github-link-pr-header" });

		const top = header.createDiv({ cls: "github-link-pr-header-top" });
		setPRIcon(top.createSpan({ cls: "github-link-status-icon" }), pullStatus(pull));
		top.createSpan({
			cls: "github-link-pr-state",
			text: pull.state === "open" ? (pull.draft ? "Draft" : "Open") : pull.state === "merged" ? "Merged" : "Closed",
		});
		const reference = `${pull.ref.org}/${pull.ref.repo}#${pull.ref.number}`;
		const ref = top.createSpan({
			cls: "github-link-pr-ref",
			text: reference,
			attr: { "aria-label": "Click to copy" },
		});
		ref.addEventListener("click", () => this.copy(reference, `Copied ${reference}`));

		header.createEl("a", {
			cls: "github-link-pr-title",
			text: pull.title,
			href: pull.url,
			attr: { target: "_blank" },
		});

		const meta = header.createDiv({ cls: "github-link-pr-meta" });
		if (pull.author) {
			this.person(meta, pull.author.login, pull.author.avatarUrl);
		}
		meta.createSpan({ text: `opened ${relativeTime(pull.createdAt)}`, attr: { title: pull.createdAt } });
		meta.createSpan({ text: `updated ${relativeTime(pull.updatedAt)}`, attr: { title: pull.updatedAt } });

		const branches = header.createDiv({ cls: "github-link-pr-branches" });
		for (const [i, branch] of [pull.headRef, pull.baseRef].entries()) {
			if (i === 1) {
				setIcon(branches.createSpan(), "lucide-arrow-right");
			}
			const code = branches.createEl("code", {
				cls: "github-link-pr-branch",
				text: branch,
				attr: { "aria-label": "Click to copy the branch name", title: branch },
			});
			code.addEventListener("click", () => this.copy(branch, `Copied ${branch}`));
		}

		if (pull.labels.length > 0) {
			const labels = header.createDiv({ cls: "github-link-pr-labels" });
			for (const label of pull.labels) {
				const chip = labels.createSpan({ cls: "github-link-table-label", text: label.name });
				chip.style.setProperty("--status-color", `#${label.color}`);
			}
		}

		const actions = header.createDiv({ cls: "github-link-pr-actions" });
		this.action(actions, "lucide-external-link", "Open on GitHub", () => window.open(pull.url, "_blank"));
		this.action(actions, "lucide-link", "Copy as Markdown link", () =>
			this.copy(`[#${pull.ref.number} ${pull.title}](${pull.url})`, "Copied Markdown link"),
		);
		if ((this.target?.stack.length ?? 0) > 1) {
			this.action(actions, "lucide-list-ordered", "Copy the whole stack as a Markdown list", () => {
				const lines = (this.target?.stack ?? []).map(
					(sibling, i) => `${i + 1}. [#${sibling.ref.number} ${sibling.title}](${pullUrl(sibling.ref)})`,
				);
				this.copy(lines.join("\n"), `Copied ${lines.length} stacked PRs`);
			});
		}
		if (getDraftAction(pull) === "draft") {
			const toDraft = this.action(actions, "lucide-git-pull-request-draft", "Convert to draft", () =>
				this.setDraft(toDraft, pull, true),
			);
		}
		if (pull.state === "open" && pull.canUpdate) {
			const close = this.action(actions, "lucide-circle-x", "Close this PR without merging", () =>
				new ConfirmModal(
					this.app,
					`Close #${pull.ref.number} "${pull.title}" without merging? It can be reopened on GitHub.`,
					"Close pull request",
					() =>
						void this.runAction(close, "Close pull request", async () => {
							await closePullRequest(pull.ref, pull.nodeId);
							return `Closed #${pull.ref.number}`;
						}),
				).open(),
			);
		}
		if (pull.state === "open") {
			const watching = pullWatcher.has(pull.ref);
			const muted = pullWatcher.isMuted(pull.ref);
			this.action(
				actions,
				watching ? "lucide-bell-ring" : muted ? "lucide-bell-off" : "lucide-bell",
				watching
					? "Notifications on for this PR: click to mute it"
					: muted
						? "Muted: click to turn notifications back on"
						: "Notify me when this PR can be merged",
				() => this.toggleWatch(pull),
			).toggleClass("is-active", watching);
		}
		this.action(actions, "lucide-refresh-cw", "Refresh", () => void this.refresh(false));
		this.renderPollInfo(header, pull);
	}

	/**
	 * Switch notifications for this pull request on or off. Switching on checks it right away, so a PR
	 * that is already ready is announced immediately rather than a minute later. Switching off also keeps
	 * query blocks with `notify: true` from watching it again.
	 */
	private toggleWatch(pull: PullDetail): void {
		if (pullWatcher.has(pull.ref)) {
			pullWatcher.remove(pull.ref);
			new Notice(`Muted #${pull.ref.number}: no more notifications for it`, 3000);
			return;
		}
		pullWatcher.add({ ref: pull.ref, title: pull.title });
		new Notice(`Notifications on for #${pull.ref.number}`, 3000);
		void pullWatcher.tick();
	}

	private action(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
		const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(button, icon);
		button.addEventListener("click", onClick);
		return button;
	}

	private copy(text: string, notice: string, durationMs = 2000): void {
		void window.navigator.clipboard.writeText(text).then(() => new Notice(notice, durationMs));
	}

	private person(parent: HTMLElement, login: string, avatar: string | null): HTMLElement {
		const person = parent.createSpan({ cls: "github-link-pr-person" });
		if (avatar) {
			person.createEl("img", { cls: "github-link-table-avatar", attr: { src: avatar } });
		}
		person.createSpan({ text: login });
		return person;
	}

	private tonePill(parent: HTMLElement, tone: Tone, text: string): HTMLElement {
		const pill = parent.createDiv({ cls: "github-link-pr-row" });
		pill.dataset.tone = tone;
		setIcon(pill.createSpan({ cls: "github-link-pr-row-icon" }), TONE_ICON[tone]);
		pill.createSpan({ text });
		return pill;
	}

	/**
	 * The CI bot's "Validation Failures" and "Deploy previews" tables, lifted out of the conversation.
	 * Preview links keep the address as written and can copy just their query parameters, which the
	 * bot's Markdown link text often hides.
	 */
	private renderCiReport(parent: HTMLElement, pull: PullDetail): void {
		const report = findCiReport(pull.timeline);
		if (!report) {
			return;
		}

		if (report.failures.length > 0) {
			const body = this.section(parent, "Validation failures", true, `${report.failures.length}`);
			// One grid; every row is a subgrid of it, so the columns line up across rows
			const grid = body.createDiv({ cls: "github-link-pr-failures" });
			for (const failure of report.failures) {
				const row = grid.createDiv({ cls: "github-link-pr-failure" });
				row.createSpan({ cls: "github-link-pr-failure-validation", text: failure.validation });
				row.createSpan({ cls: "github-link-pr-failure-package", text: failure.pkg });
				if (failure.logUrl) {
					row.createEl("a", { text: "View log", href: failure.logUrl, attr: { target: "_blank" } });
				}
			}
		}

		if (report.previews.length > 0) {
			const body = this.section(parent, "Deploy previews", true, `${report.previews.length}`);
			let pkg: string | null = null;
			for (const preview of report.previews) {
				if (preview.pkg !== pkg) {
					pkg = preview.pkg;
					body.createDiv({ cls: "github-link-pr-preview-package", text: preview.pkg });
				}
				const row = body.createDiv({ cls: "github-link-pr-preview" });
				row.createEl("a", {
					cls: "github-link-pr-preview-link",
					text: preview.label,
					href: preview.url,
					attr: { target: "_blank", title: preview.url },
				});
				row.createSpan({ cls: "github-link-pr-preview-type", text: preview.type });
				this.action(row, "lucide-copy", "Copy link", () => this.copy(preview.url, "Copied link"));
				// These belong to one test site and editor session, so they stay out of what gets copied
				const params = queryParams(preview.url, ["metaSiteId", "editorSessionId"]);
				if (params) {
					this.action(row, "lucide-code", "Copy query parameters only (without metaSiteId and editorSessionId)", () =>
						this.copy(params, `Copied: ${params.length > 140 ? `${params.slice(0, 140)}…` : params}`, 6000),
					);
				}
			}
		}
	}

	private renderReadiness(parent: HTMLElement, pull: PullDetail): void {
		const readiness = getReadiness(pull);
		const summary =
			pull.state !== "open" ? "" : readiness.blockers === 0 ? "ready to merge" : `${readiness.blockers} to resolve`;
		// The sticky bar carries the verdict; the full checklist is one click away
		const body = this.section(parent, "Merge readiness", false, summary);
		for (const item of readiness.items) {
			this.tonePill(body, item.tone, item.label);
		}
	}

	/**
	 * Sticky bar: the verdict at a glance (checks, review, conflicts) and the one action that fits.
	 */
	private renderStatusBar(parent: HTMLElement, pull: PullDetail): void {
		const bar = parent.createDiv({ cls: "github-link-pr-bar" });
		const chips = bar.createDiv({ cls: "github-link-pr-bar-chips" });

		if (pull.state !== "open") {
			this.chip(chips, "neutral", pull.state === "merged" ? "Merged" : "Closed");
			return;
		}
		if (pull.draft) {
			this.chip(chips, "danger", "Draft");
		}
		if (pull.review) {
			const [tone, label] = {
				approved: ["success", "Approved"],
				"changes-requested": ["danger", "Changes requested"],
				"review-required": ["attention", "Review required"],
			}[pull.review] as [Tone, string];
			this.chip(chips, tone, label);
		}
		if (pull.checks.length > 0) {
			const failing = pull.checks.some((check) => check.state === "failure");
			const running = pull.checks.some((check) => check.state === "pending");
			const passed = pull.checks.filter((check) => check.state === "success" || check.state === "neutral").length;
			this.chip(chips, failing ? "danger" : running ? "attention" : "success", `CI ${passed}/${pull.checks.length}`);
		}
		if (pull.mergeable === "conflicting") {
			this.chip(chips, "danger", "Conflicts");
		}
		if (pull.autoMerge) {
			this.chip(chips, "success", "Auto-merge on");
		}

		const actions = bar.createDiv({ cls: "github-link-pr-bar-actions" });
		this.renderCommentMenu(actions, pull);
		this.renderMergeAction(actions, pull);
	}

	/**
	 * Dropdown of comments that trigger automation (#skipreview, #rebuild), plus a free-form comment.
	 */
	private renderCommentMenu(parent: HTMLElement, pull: PullDetail): void {
		const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Post a comment" } });
		setIcon(button.createSpan(), "lucide-message-square-plus");
		setIcon(button.createSpan(), "lucide-chevron-down");

		const post = (body: string) =>
			void this.runAction(button, "Post comment", async () => {
				await postPullComment(pull.ref, pull.nodeId, body);
				return `Posted "${body.length > 30 ? `${body.slice(0, 30)}…` : body}" on #${pull.ref.number}`;
			});

		button.addEventListener("click", (event) => {
			const menu = new Menu();
			for (const quick of QUICK_COMMENTS) {
				menu.addItem((item) =>
					item
						.setTitle(`${quick.body} — ${quick.hint}`)
						.setIcon(quick.icon)
						.onClick(() => {
							if (quick.confirm) {
								new ConfirmModal(
									this.app,
									`Post "${quick.body}" on #${pull.ref.number}? ${quick.confirm}`,
									"Post comment",
									() => post(quick.body),
								).open();
							} else {
								post(quick.body);
							}
						}),
				);
			}
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Write a comment…")
					.setIcon("lucide-pencil")
					.onClick(() => new CommentModal(this.app, pull.ref.number, post).open()),
			);
			menu.showAtMouseEvent(event);
		});
	}

	private chip(parent: HTMLElement, tone: Tone, text: string): void {
		const chip = parent.createSpan({ cls: "github-link-pr-chip" });
		chip.dataset.tone = tone;
		setIcon(chip.createSpan({ cls: "github-link-pr-row-icon" }), TONE_ICON[tone]);
		chip.createSpan({ text });
	}

	private renderMergeAction(parent: HTMLElement, pull: PullDetail): void {
		// A draft cannot be merged or set to auto-merge, so marking it ready is its one action
		if (getDraftAction(pull) === "ready") {
			const button = this.actionButton(parent, "Ready for review", "lucide-eye", true);
			button.addEventListener("click", () => this.setDraft(button, pull, false));
			return;
		}

		const action = getMergeAction(pull);
		if (action.kind === "none") {
			return;
		}
		const label = {
			merge: "Squash & merge",
			"enable-auto-merge": "Enable auto-merge",
			"disable-auto-merge": "Disable auto-merge",
		}[action.kind];
		const icon = {
			merge: "lucide-git-merge",
			"enable-auto-merge": "lucide-zap",
			"disable-auto-merge": "lucide-zap-off",
		}[action.kind];
		const button = this.actionButton(parent, label, icon, action.kind === "merge");

		const run = () =>
			this.runAction(button, label, async () => {
				if (action.kind === "merge") {
					await squashMergePullRequest(pull.ref, pull.nodeId);
					return `Squash-merged #${pull.ref.number}`;
				}
				const enable = action.kind === "enable-auto-merge";
				await setPullAutoMerge(pull.ref, pull.nodeId, enable);
				return `Auto-merge ${enable ? "enabled" : "disabled"} for #${pull.ref.number}`;
			});
		button.addEventListener("click", () => {
			if (action.kind === "merge") {
				// Merging cannot be undone, unlike auto-merge
				new ConfirmModal(
					this.app,
					`Squash and merge #${pull.ref.number} "${pull.title}" into ${pull.baseRef}?`,
					"Squash & merge",
					() => void run(),
				).open();
			} else {
				void run();
			}
		});
	}

	private actionButton(parent: HTMLElement, label: string, icon: string, primary: boolean): HTMLButtonElement {
		const button = parent.createEl("button", { cls: primary ? "mod-cta" : "", attr: { "aria-label": label } });
		setIcon(button.createSpan(), icon);
		button.createSpan({ text: label });
		return button;
	}

	private setDraft(button: HTMLElement, pull: PullDetail, draft: boolean): void {
		const label = draft ? "Convert to draft" : "Ready for review";
		void this.runAction(button, label, async () => {
			await setPullDraft(pull.ref, pull.nodeId, draft);
			return draft ? `#${pull.ref.number} is a draft again` : `#${pull.ref.number} is ready for review`;
		});
	}

	/**
	 * Run a change to the pull request with the button locked meanwhile, then reload the pane. A failure
	 * is shown as a notice with GitHub's message and unlocks the button.
	 */
	private async runAction(button: HTMLElement, label: string, task: () => Promise<string>): Promise<void> {
		button.setAttribute("disabled", "");
		button.addClass("is-loading");
		try {
			new Notice(await task());
			await this.refresh(false);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: typeof error === "object" && error && "message" in error
						? String(error.message)
						: "unknown error";
			new Notice(`GitHub Link: ${label} failed: ${message}`, 8000);
			button.removeAttribute("disabled");
			button.removeClass("is-loading");
		}
	}

	private renderStack(parent: HTMLElement, pull: PullDetail): void {
		const stack = this.target?.stack ?? [];
		if (stack.length < 2) {
			return;
		}
		const body = this.section(parent, "Stack", true, `${stack.length} PRs`);
		stack.forEach((sibling, i) => {
			const row = body.createDiv({ cls: "github-link-pr-stack-item" });
			row.toggleClass("is-current", sibling.ref.number === pull.ref.number && sibling.ref.repo === pull.ref.repo);
			row.createSpan({ cls: "github-link-pr-stack-index", text: `${i + 1}` });
			setPRIcon(row.createSpan({ cls: "github-link-status-icon" }), sibling.status);
			row.createSpan({ cls: "github-link-pr-stack-title", text: sibling.title });
			row.createSpan({ cls: "github-link-pr-stack-number", text: `#${sibling.ref.number}` });
			row.addEventListener("click", () => {
				if (this.target) {
					void this.setTarget({ ref: sibling.ref, stack: this.target.stack });
				}
			});
		});
	}

	private renderReviewers(parent: HTMLElement, pull: PullDetail): void {
		if (pull.reviewers.length === 0 && pull.requestedReviewers.length === 0) {
			return;
		}
		const body = this.section(parent, "Reviewers");
		for (const reviewer of pull.reviewers) {
			const [tone, label] = REVIEW_ICON[reviewer.state];
			const row = this.tonePill(body, tone, "");
			row.empty();
			setIcon(row.createSpan({ cls: "github-link-pr-row-icon" }), TONE_ICON[tone]);
			this.person(row, reviewer.person.login, reviewer.person.avatarUrl);
			row.createSpan({ cls: "github-link-pr-row-detail", text: `${label} ${relativeTime(reviewer.at)}` });
		}
		for (const name of pull.requestedReviewers) {
			const row = this.tonePill(body, "attention", "");
			row.empty();
			setIcon(row.createSpan({ cls: "github-link-pr-row-icon" }), TONE_ICON.attention);
			row.createSpan({ text: name });
			row.createSpan({ cls: "github-link-pr-row-detail", text: "review requested" });
		}
	}

	private renderChecks(parent: HTMLElement, pull: PullDetail): void {
		if (pull.checks.length === 0) {
			return;
		}
		const passed = pull.checks.filter((check) => check.state === "success" || check.state === "neutral").length;
		const body = this.section(parent, "Checks", true, `${passed}/${pull.checks.length} passed`);

		// Groups by state, worst first. What needs attention starts open; green and skipped checks start collapsed.
		const groups: { state: CheckState; title: string; open: boolean }[] = [
			{ state: "failure", title: "Failing", open: true },
			{ state: "pending", title: "Running", open: true },
			{ state: "success", title: "Passed", open: false },
			{ state: "neutral", title: "Skipped / neutral", open: false },
		];
		for (const group of groups) {
			const checks = pull.checks.filter((check) => check.state === group.state);
			if (checks.length === 0) {
				continue;
			}
			const details = body.createEl("details", { cls: "github-link-pr-checks-group" });
			details.open = group.open;
			const summary = details.createEl("summary");
			summary.dataset.tone = CHECK_TONE[group.state];
			setIcon(summary.createSpan({ cls: "github-link-pr-row-icon" }), TONE_ICON[CHECK_TONE[group.state]]);
			summary.createSpan({ text: `${group.title} (${checks.length})` });
			for (const check of checks) {
				const row = details.createDiv({ cls: "github-link-pr-row" });
				row.dataset.tone = CHECK_TONE[check.state];
				if (check.url) {
					row.createEl("a", { text: check.name, href: check.url, attr: { target: "_blank" } });
				} else {
					row.createSpan({ text: check.name });
				}
			}
		}
	}

	private renderDescription(parent: HTMLElement, pull: PullDetail): void {
		const body = this.section(parent, "Description");
		if (!pull.body.trim()) {
			body.createDiv({ cls: "github-link-pr-empty", text: "No description." });
			return;
		}
		this.markdown(body, pull.body);
	}

	/** Render GitHub-flavoured Markdown with Obsidian's renderer; HTML comments (PR templates) are noise */
	private markdown(parent: HTMLElement, text: string): void {
		const container = parent.createDiv({ cls: "github-link-pr-markdown markdown-rendered" });
		void MarkdownRenderer.render(this.app, text.replace(/<!--[\s\S]*?-->/g, ""), container, "", this);
	}

	private renderConversation(parent: HTMLElement, pull: PullDetail): void {
		const threads = pull.timeline.filter((item) => item.kind === "thread").length;
		const body = this.section(parent, "Conversation", true, `${pull.timeline.length}`);

		if (threads > 0) {
			const filter = body.createEl("label", { cls: "github-link-pr-filter" });
			const checkbox = filter.createEl("input", { attr: { type: "checkbox" } });
			checkbox.checked = this.onlyUnresolved;
			filter.createSpan({ text: `Only unresolved threads (${pull.unresolvedThreads})` });
			checkbox.addEventListener("change", () => {
				this.onlyUnresolved = checkbox.checked;
				const scroll = this.contentEl.scrollTop;
				this.render();
				this.contentEl.scrollTop = scroll;
			});
		}

		const items = this.onlyUnresolved
			? pull.timeline.filter((item) => item.kind === "thread" && !item.resolved)
			: pull.timeline;
		if (items.length === 0) {
			body.createDiv({ cls: "github-link-pr-empty", text: "Nothing here." });
		}
		for (const item of items) {
			this.renderTimelineItem(body, item, pull);
		}
	}

	private renderTimelineItem(parent: HTMLElement, item: TimelineItem, pull: PullDetail): void {
		// Clicking any comment copies the whole item (a review thread as one piece) as text for an LLM
		const copyText = formatForLlm(pull, item);
		if (item.kind === "thread") {
			const details = parent.createEl("details", { cls: "github-link-pr-thread" });
			// Resolved threads stay out of the way
			details.open = !item.resolved;
			const summary = details.createEl("summary");
			setIcon(summary.createSpan(), item.resolved ? "lucide-check" : "lucide-message-square");
			summary.createSpan({
				cls: "github-link-pr-thread-path",
				text: item.line ? `${item.path}:${item.line}` : item.path,
			});
			if (item.outdated) summary.createSpan({ cls: "github-link-pr-badge", text: "outdated" });
			if (item.resolved) summary.createSpan({ cls: "github-link-pr-badge", text: "resolved" });
			this.diffHunk(details, item.diffHunk);
			for (const comment of item.comments) {
				this.renderComment(details, comment, undefined, copyText);
			}
			return;
		}

		const wrapper = parent.createDiv({ cls: "github-link-pr-item" });
		if (item.kind === "review") {
			const [tone, label] = REVIEW_ICON[item.state];
			wrapper.dataset.tone = tone;
			this.renderComment(wrapper, item, label, copyText);
		} else {
			this.renderComment(wrapper, item, undefined, copyText);
		}
	}

	private renderComment(
		parent: HTMLElement,
		comment: TimelineComment,
		tag: string | undefined,
		copyText: string,
	): void {
		const box = parent.createDiv({
			cls: "github-link-pr-comment is-copyable",
			attr: { "aria-label": "Click to copy for an LLM" },
		});
		box.addEventListener("click", (event) => {
			// Leave links, code blocks and text selection alone, so reading and copying by hand still work
			if ((event.target as HTMLElement).closest("a, button, pre, code") || window.getSelection()?.toString()) {
				return;
			}
			this.copy(copyText, "Copied for an LLM");
		});
		const head = box.createDiv({ cls: "github-link-pr-comment-head" });
		this.person(head, comment.author.login, comment.author.avatarUrl);
		if (tag) head.createSpan({ cls: "github-link-pr-badge", text: tag });
		head.createEl("a", {
			cls: "github-link-pr-comment-time",
			text: relativeTime(comment.at),
			href: comment.url,
			attr: { target: "_blank", title: comment.at },
		});
		if (comment.body.trim()) {
			this.markdown(box, comment.body);
		}
	}

	/** The last lines of a diff hunk are the code a review comment is about */
	private diffHunk(parent: HTMLElement, hunk: string): void {
		const lines = hunk.split("\n").slice(-4);
		if (lines.length === 0 || !hunk) {
			return;
		}
		const pre = parent.createEl("pre", { cls: "github-link-pr-diff" });
		for (const line of lines) {
			const row = pre.createDiv({ text: line || " " });
			if (line.startsWith("+")) row.addClass("is-added");
			else if (line.startsWith("-")) row.addClass("is-removed");
		}
	}

	private renderFiles(parent: HTMLElement, pull: PullDetail): void {
		if (pull.files.length === 0) {
			return;
		}
		const body = this.section(
			parent,
			"Files changed",
			true,
			`${pull.changedFiles} · +${pull.additions} −${pull.deletions}`,
		);
		// The whole tab, from the section header (a link inside <summary> does not toggle the section)
		const filesTab = `${pull.url}/changes`;
		const headerLink = body.parentElement?.querySelector("summary")?.createEl("a", {
			cls: "github-link-pr-section-link",
			href: filesTab,
			attr: { target: "_blank", "aria-label": "Open Files changed on GitHub" },
		});
		if (headerLink) {
			setIcon(headerLink, "lucide-external-link");
		}

		const largest = Math.max(...pull.files.map((file) => file.additions + file.deletions), 1);
		for (const file of pull.files) {
			// Opens the files tab right away; once the file's anchor is computed it also scrolls to the file
			const row = body.createEl("a", {
				cls: "github-link-pr-file",
				href: filesTab,
				attr: { target: "_blank", "aria-label": `Open ${file.path} on GitHub` },
			});
			void diffAnchor(file.path).then((anchor) => row.setAttribute("href", `${filesTab}#${anchor}`));
			row.createSpan({ cls: "github-link-pr-file-path", text: file.path, attr: { title: file.path } });
			const bar = row.createSpan({ cls: "github-link-pr-file-bar" });
			const added = bar.createSpan({ cls: "is-added" });
			added.style.width = `${(file.additions / largest) * 100}%`;
			const removed = bar.createSpan({ cls: "is-removed" });
			removed.style.width = `${(file.deletions / largest) * 100}%`;
			row.createSpan({ cls: "github-link-pr-file-count", text: `+${file.additions} −${file.deletions}` });
		}
		if (pull.changedFiles > pull.files.length) {
			body.createDiv({ cls: "github-link-pr-empty", text: `…and ${pull.changedFiles - pull.files.length} more files` });
		}
	}
}

/**
 * A small confirmation dialog, used before the one action that cannot be undone
 */
class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly message: string,
		private readonly confirmLabel: string,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: this.message });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		const confirm = buttons.createEl("button", { cls: "mod-cta", text: this.confirmLabel });
		confirm.addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * A dialog for a free-form comment on the pull request
 */
class CommentModal extends Modal {
	constructor(
		app: App,
		private readonly number: number,
		private readonly onSubmit: (body: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(`Comment on #${this.number}`);
		const input = this.contentEl.createEl("textarea", {
			cls: "github-link-pr-comment-input",
			attr: { rows: "6", placeholder: "Leave a comment" },
		});
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		const post = buttons.createEl("button", { cls: "mod-cta", text: "Comment" });
		const submit = () => {
			if (input.value.trim()) {
				this.close();
				this.onSubmit(input.value);
			}
		};
		post.addEventListener("click", submit);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				submit();
			}
		});
		input.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
