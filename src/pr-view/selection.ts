/**
 * Which pull request the side pane shows, shared with every query block so their cards can follow it.
 * Keys are `pullKey(ref)`.
 */

type Listener<T> = (owner: T, key: string | null) => void;

interface Subscription {
	owner: WeakRef<object>;
	listener: Listener<never>;
}

let current: string | null = null;
const subscriptions = new Set<Subscription>();

export function getPaneSelection(): string | null {
	return current;
}

export function setPaneSelection(key: string | null): void {
	if (key === current) {
		return;
	}
	current = key;
	for (const subscription of [...subscriptions]) {
		const owner = subscription.owner.deref();
		if (owner === undefined) {
			// The query block that subscribed is gone; its note was closed or re-rendered
			subscriptions.delete(subscription);
		} else {
			(subscription.listener as Listener<object>)(owner, key);
		}
	}
}

/**
 * Listen for pane selection changes without keeping `owner` alive: the listener gets the owner as an
 * argument (it must not capture it), and a subscription whose owner was garbage collected is dropped.
 */
export function onPaneSelection<T extends object>(owner: T, listener: Listener<T>): void {
	subscriptions.add({ owner: new WeakRef(owner), listener: listener as Listener<never> });
}
