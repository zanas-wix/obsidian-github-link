import { WeakChannel } from "./channel";

/**
 * Which pull request the side pane shows, shared with every query block so their cards can follow it.
 * Keys are `pullKey(ref)`.
 */
let current: string | null = null;
const channel = new WeakChannel<string | null>();

export function getPaneSelection(): string | null {
	return current;
}

export function setPaneSelection(key: string | null): void {
	if (key === current) {
		return;
	}
	current = key;
	channel.publish(key);
}

/**
 * Listen for pane selection changes without keeping `owner` alive: the listener gets the owner as an
 * argument (it must not capture it).
 */
export function onPaneSelection<T extends object>(owner: T, listener: (owner: T, key: string | null) => void): void {
	channel.subscribe(owner, listener);
}
