/**
 * "12s", "1m 05s"; "now" once it is due.
 */
export function formatCountdown(ms: number): string {
	const seconds = Math.ceil(ms / 1000);
	if (seconds <= 0) {
		return "now";
	}
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Keep `el`'s text up to date every second, without re-rendering anything, until it leaves the page.
 */
export function bindCountdown(el: HTMLElement, text: () => string): void {
	const update = () => el.setText(text());
	update();
	const id = window.setInterval(() => {
		if (el.isConnected) {
			update();
		} else {
			window.clearInterval(id);
		}
	}, 1000);
}
