import { Notice } from "obsidian";
import { openPullRequestPane } from "../plugin";
import type { WatchedPull, WatchEvent } from "./watcher";

/**
 * Native desktop notification (Notification Center on macOS) about a watched pull request: it can be
 * merged, or CI went green / it was approved.
 * Clicking it opens the pull request in the pane. When notifications are blocked, an Obsidian
 * notice is shown instead, so the news is never lost.
 */
export function notify(pull: WatchedPull, event: WatchEvent): void {
	const { title, detail } = describe(pull, event);
	const body = [`${pull.ref.org}/${pull.ref.repo}`, pull.title, detail].filter(Boolean).join("\n");

	// Only "ready" is worth a notice that stays until dismissed
	const fallback = () => new Notice(`${title}: ${pull.title}`, event.kind === "ready" ? 0 : 8000);
	if (typeof Notification === "undefined" || Notification.permission === "denied") {
		fallback();
		return;
	}

	const show = () => {
		const notification = new Notification(title, { body });
		notification.onclick = () => {
			window.focus();
			void openPullRequestPane({ ref: pull.ref, stack: [] });
			notification.close();
		};
	};
	if (Notification.permission === "granted") {
		show();
	} else {
		void Notification.requestPermission().then((permission) => (permission === "granted" ? show() : fallback()));
	}
}

function describe(pull: WatchedPull, event: WatchEvent): { title: string; detail: string } {
	const prefix = `${pull.ref.repo} #${pull.ref.number}`;
	if (event.kind === "ready") {
		return { title: `${prefix} is ready to merge`, detail: "" };
	}
	const what = [event.ciPassed ? "CI passed" : "", event.approved ? "approved" : ""].filter(Boolean).join(" and ");
	return { title: `${prefix}: ${what}`, detail: `Still waiting on: ${event.blockers.join(", ")}` };
}
