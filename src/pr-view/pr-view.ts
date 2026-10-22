import {
	ItemView,
	MarkdownRenderer,
	Modal,
	Notice,
	setIcon,
	type App,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";
import { getPullDetail, setPullAutoMerge, squashMergePullRequest } from "../github/github";
import type { CheckState, PullDetail, ReviewState, TimelineComment, TimelineItem } from "../github/pull-detail";
import type { PullRef } from "../github/pull-status";
import { IssueStatus } from "../github/response";
import { setPRIcon } from "../icon";
import { relativeTime } from "../util";
import { getMergeAction } from "./merge-action";
import { getReadiness, type Tone } from "./readiness";

export const PULL_VIEW_TYPE = "github-link-pull-request";

/** How often a visible pane quietly re-checks its pull request */
const AUTO_REFRESH_MS = 60 * 1000;

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
		this.registerInterval(
			window.setInterval(() => {
				if (this.target && this.containerEl.isShown() && !document.hidden) {
					void this.refresh(true);
				}
			}, AUTO_REFRESH_MS),
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
			}
		}
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

		this.renderStatusBar(el, pull);
		this.renderHeader(el, pull);
		this.renderReadiness(el, pull);
		this.renderStack(el, pull);
		this.renderReviewers(el, pull);
		this.renderChecks(el, pull);
		this.renderDescription(el, pull);
		this.renderConversation(el, pull);
		this.renderFiles(el, pull);
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
		top.createSpan({ cls: "github-link-pr-ref", text: `${pull.ref.org}/${pull.ref.repo}#${pull.ref.number}` });

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
		branches.createEl("code", { text: pull.headRef });
		setIcon(branches.createSpan(), "lucide-arrow-right");
		branches.createEl("code", { text: pull.baseRef });

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
		this.action(actions, "lucide-refresh-cw", "Refresh", () => void this.refresh(false));
	}

	private action(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(button, icon);
		button.addEventListener("click", onClick);
	}

	private copy(text: string, notice: string): void {
		void window.navigator.clipboard.writeText(text).then(() => new Notice(notice, 2000));
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

		this.renderMergeAction(bar, pull);
	}

	private chip(parent: HTMLElement, tone: Tone, text: string): void {
		const chip = parent.createSpan({ cls: "github-link-pr-chip" });
		chip.dataset.tone = tone;
		setIcon(chip.createSpan({ cls: "github-link-pr-row-icon" }), TONE_ICON[tone]);
		chip.createSpan({ text });
	}

	private renderMergeAction(parent: HTMLElement, pull: PullDetail): void {
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

		const button = parent.createEl("button", {
			cls: action.kind === "merge" ? "mod-cta" : "",
			attr: { "aria-label": label },
		});
		setIcon(button.createSpan(), icon);
		button.createSpan({ text: label });

		const run = async () => {
			button.disabled = true;
			button.addClass("is-loading");
			try {
				if (action.kind === "merge") {
					await squashMergePullRequest(pull.ref, pull.nodeId);
					new Notice(`Squash-merged #${pull.ref.number}`);
				} else {
					await setPullAutoMerge(pull.ref, pull.nodeId, action.kind === "enable-auto-merge");
					new Notice(
						`Auto-merge ${action.kind === "enable-auto-merge" ? "enabled" : "disabled"} for #${pull.ref.number}`,
					);
				}
				await this.refresh(false);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: typeof error === "object" && error && "message" in error
							? String(error.message)
							: "unknown error";
				new Notice(`GitHub Link: ${label} failed: ${message}`, 8000);
				button.disabled = false;
				button.removeClass("is-loading");
			}
		};
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
		const failing = pull.checks.filter((check) => check.state === "failure").length;
		const passed = pull.checks.filter((check) => check.state === "success" || check.state === "neutral").length;
		// Only open the list when something needs attention
		const body = this.section(parent, "Checks", failing > 0, `${passed}/${pull.checks.length} passed`);
		for (const check of pull.checks) {
			const row = this.tonePill(body, CHECK_TONE[check.state], "");
			row.empty();
			setIcon(row.createSpan({ cls: "github-link-pr-row-icon" }), TONE_ICON[CHECK_TONE[check.state]]);
			if (check.url) {
				row.createEl("a", { text: check.name, href: check.url, attr: { target: "_blank" } });
			} else {
				row.createSpan({ text: check.name });
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
			this.renderTimelineItem(body, item);
		}
	}

	private renderTimelineItem(parent: HTMLElement, item: TimelineItem): void {
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
				this.renderComment(details, comment);
			}
			return;
		}

		const wrapper = parent.createDiv({ cls: "github-link-pr-item" });
		if (item.kind === "review") {
			const [tone, label] = REVIEW_ICON[item.state];
			wrapper.dataset.tone = tone;
			this.renderComment(wrapper, item, label);
		} else {
			this.renderComment(wrapper, item);
		}
	}

	private renderComment(parent: HTMLElement, comment: TimelineComment, tag?: string): void {
		const box = parent.createDiv({ cls: "github-link-pr-comment" });
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
			false,
			`${pull.changedFiles} · +${pull.additions} −${pull.deletions}`,
		);
		const largest = Math.max(...pull.files.map((file) => file.additions + file.deletions), 1);
		for (const file of pull.files) {
			const row = body.createDiv({ cls: "github-link-pr-file" });
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
