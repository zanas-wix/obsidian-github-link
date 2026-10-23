/**
 * A broadcast channel whose subscribers are held weakly, so a query block that is closed or re-rendered
 * never needs to unsubscribe and is not kept alive by its subscription.
 */
interface Subscription<T> {
	owner: WeakRef<object>;
	listener: (owner: never, value: T) => void;
}

export class WeakChannel<T> {
	private readonly subscriptions = new Set<Subscription<T>>();

	/**
	 * The listener gets `owner` as an argument and must not capture it, or it would keep it alive.
	 */
	subscribe<O extends object>(owner: O, listener: (owner: O, value: T) => void): void {
		this.subscriptions.add({ owner: new WeakRef(owner), listener: listener as (owner: never, value: T) => void });
	}

	publish(value: T): void {
		for (const subscription of [...this.subscriptions]) {
			const owner = subscription.owner.deref();
			if (owner === undefined) {
				this.subscriptions.delete(subscription);
			} else {
				(subscription.listener as (owner: object, value: T) => void)(owner, value);
			}
		}
	}
}
