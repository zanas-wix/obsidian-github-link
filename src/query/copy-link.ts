import { Notice } from "obsidian";

/**
 * Cmd/Ctrl+C while a pull request card is the active selection copies that PR's link, instead of
 * whatever the editor has selected (clicking a card leaves the query block's source selected).
 */
let active: { host: HTMLElement; url: () => string | null } | null = null;
let installed = false;

/**
 * Make `url()` what the next copy puts on the clipboard, until the user clicks outside `host`.
 */
export function setCopyTarget(host: HTMLElement, url: () => string | null): void {
	if (!installed) {
		installed = true;
		// Capture phase, so this runs before the editor's own copy handling
		document.addEventListener("mousedown", onMouseDown, true);
		document.addEventListener("copy", onCopy, true);
	}
	active = { host, url };
}

function onMouseDown(event: MouseEvent): void {
	if (active && !active.host.contains(event.target as Node)) {
		active = null;
	}
}

function onCopy(event: ClipboardEvent): void {
	if (!active?.host.isConnected) {
		return;
	}
	// Text the user selected inside the list is theirs to copy as usual
	const selection = window.getSelection();
	if (selection && !selection.isCollapsed && active.host.contains(selection.anchorNode)) {
		return;
	}
	const url = active.url();
	if (!url || !event.clipboardData) {
		return;
	}
	event.clipboardData.setData("text/plain", url);
	event.preventDefault();
	event.stopPropagation();
	new Notice(`Copied ${url}`, 2000);
}
