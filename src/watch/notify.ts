import { Notice } from "obsidian";
import { openPullRequestPane } from "../plugin";
import type { WatchedPull } from "./watcher";

/**
 * Native desktop notification (Notification Center on macOS) that the pull request can be merged.
 * Clicking it opens the pull request in the pane. When notifications are blocked, an Obsidian
 * notice is shown instead, so the news is never lost.
 */
export function notifyReady(pull: WatchedPull): void {
	const title = `#${pull.ref.number} is ready to merge`;
	const body = `${pull.title}\n${pull.ref.org}/${pull.ref.repo}`;

	const fallback = () => new Notice(`${title}: ${pull.title}`, 0);
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
