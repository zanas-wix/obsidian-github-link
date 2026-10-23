import { isReadyToMerge, mergeBlockers, pullKey, type PullRef, type PullStatus } from "../github/pull-status";

/**
 * Pull requests the user asked to be told about once they can be merged.
 */
export interface WatchedPull {
	ref: PullRef;
	/** Title when the watch was set, for the notification text */
	title: string;
	/** What the last check saw; milestones are changes from this. Unset until the first check. */
	seen?: { ci: PullStatus["ci"]["state"]; review: PullStatus["review"] };
}

/**
 * What a notification announces: the pull request can be merged, or a milestone on the way there
 * (CI went green, it was approved) together with what is still outstanding.
 */
export type WatchEvent =
	| { kind: "ready" }
	| { kind: "progress"; ciPassed: boolean; approved: boolean; blockers: string[] };

export interface WatcherDeps {
	/** Batched status lookup; `maxAgeMs` lets it reuse statuses fetched moments ago */
	fetchStatuses: (refs: PullRef[], maxAgeMs: number) => Promise<Map<string, PullStatus>>;
	notify: (pull: WatchedPull, event: WatchEvent) => void;
	save: (watched: WatchedPull[]) => void | Promise<void>;
	log: (message: string, error?: unknown) => void;
}

/** After a failed check the watcher skips this many ticks, doubling each time, so a bad token or an outage is not hammered */
const MAX_SKIP_TICKS = 16;
/** Statuses another poll fetched this recently are reused */
const STATUS_MAX_AGE_MS = 30 * 1000;

/**
 * Polls watched pull requests (one batched request per 25). Notifies when CI turns green, when the
 * PR is approved, and once more when it can be merged, which ends the watch (as does merging or
 * closing it). Milestones are changes seen between checks, so a PR that is already green when the
 * watch starts is not announced as news.
 */
export class PullWatcher {
	private deps: WatcherDeps | null = null;
	private watched = new Map<string, WatchedPull>();
	private listeners = new Set<() => void>();
	private ticking = false;
	private failures = 0;
	private skip = 0;

	init(deps: WatcherDeps, initial: WatchedPull[]): void {
		this.deps = deps;
		this.watched = new Map(initial.map((pull) => [pullKey(pull.ref), pull]));
		this.failures = 0;
		this.skip = 0;
	}

	has(ref: PullRef): boolean {
		return this.watched.has(pullKey(ref));
	}

	list(): WatchedPull[] {
		return [...this.watched.values()];
	}

	add(pull: WatchedPull): void {
		this.watched.set(pullKey(pull.ref), pull);
		this.changed();
	}

	remove(ref: PullRef): void {
		if (this.watched.delete(pullKey(ref))) {
			this.changed();
		}
	}

	/**
	 * Be told when the watched set changes (also when the watcher itself ends a watch). Returns the unsubscribe.
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * One round: check every watched pull request. Overlapping rounds are dropped.
	 */
	async tick(): Promise<void> {
		const deps = this.deps;
		if (!deps || this.watched.size === 0 || this.ticking) {
			return;
		}
		if (this.skip > 0) {
			this.skip--;
			return;
		}

		this.ticking = true;
		try {
			const watched = this.list();
			const statuses = await deps.fetchStatuses(
				watched.map((pull) => pull.ref),
				STATUS_MAX_AGE_MS,
			);
			this.failures = 0;

			let finished = false;
			let seenChanged = false;
			for (const pull of watched) {
				const status = statuses.get(pullKey(pull.ref));
				// Missing means GitHub did not return it (no access); keep waiting rather than guess
				if (!status) {
					continue;
				}
				if (status.state !== "open") {
					this.watched.delete(pullKey(pull.ref));
					finished = true;
				} else if (isReadyToMerge(status)) {
					deps.notify(pull, { kind: "ready" });
					this.watched.delete(pullKey(pull.ref));
					finished = true;
				} else {
					const previous = pull.seen;
					const ciPassed = previous !== undefined && previous.ci !== "success" && status.ci.state === "success";
					const approved = previous !== undefined && previous.review !== "approved" && status.review === "approved";
					if (ciPassed || approved) {
						deps.notify(pull, { kind: "progress", ciPassed, approved, blockers: mergeBlockers(status) });
					}
					if (previous?.ci !== status.ci.state || previous?.review !== status.review) {
						pull.seen = { ci: status.ci.state, review: status.review };
						seenChanged = true;
					}
				}
			}
			if (finished) {
				this.changed();
			} else if (seenChanged) {
				// Remember it for the next start, but nothing visible changed
				void deps.save(this.list());
			}
		} catch (error) {
			this.failures++;
			this.skip = Math.min(2 ** (this.failures - 1), MAX_SKIP_TICKS);
			deps.log("could not check watched pull requests", error);
		} finally {
			this.ticking = false;
		}
	}

	private changed(): void {
		void this.deps?.save(this.list());
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}

/** The one watcher of the plugin; set up by the plugin on load */
export const pullWatcher = new PullWatcher();
