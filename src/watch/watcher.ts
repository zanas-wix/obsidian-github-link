import { isReadyToMerge, mergeBlockers, pullKey, type PullRef, type PullStatus } from "../github/pull-status";

/**
 * A pull request to be told about: set by the user (the bell), or added automatically because a
 * query block has `notify: true`.
 */
export interface WatchedPull {
	ref: PullRef;
	/** Title when the watch was set, for the notification text */
	title: string;
	/** Added by a query block rather than by the user */
	auto?: boolean;
	/** What the last check saw; announcements are changes from this. Unset until the first check. */
	seen?: { ci: PullStatus["ci"]["state"]; review: PullStatus["review"]; ready: boolean };
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
	save: (state: { watched: WatchedPull[]; muted: string[] }) => void | Promise<void>;
	log: (message: string, error?: unknown) => void;
}

/** After a failed check the watcher skips this many ticks, doubling each time, so a bad token or an outage is not hammered */
const MAX_SKIP_TICKS = 16;
/** Statuses another poll fetched this recently are reused */
const STATUS_MAX_AGE_MS = 30 * 1000;
/** Muted pull requests are remembered up to this many, oldest forgotten first */
const MAX_MUTED = 500;

/**
 * Polls watched pull requests (one batched request per 25) and announces changes: CI turning green,
 * approval, and becoming mergeable (again, if it stops being mergeable and later is once more).
 * A watch ends when the pull request is merged or closed, or when the user mutes it.
 *
 * Announcements are changes between checks, so what was already true when a watch started is not news.
 * One exception: a PR the user explicitly watches that is already mergeable is announced straight away.
 */
export class PullWatcher {
	private deps: WatcherDeps | null = null;
	private watched = new Map<string, WatchedPull>();
	/** Keys the user switched off; query blocks do not watch these again */
	private muted = new Set<string>();
	private listeners = new Set<() => void>();
	private ticking = false;
	private failures = 0;
	private skip = 0;

	init(deps: WatcherDeps, watched: WatchedPull[], muted: string[]): void {
		this.deps = deps;
		this.watched = new Map(watched.map((pull) => [pullKey(pull.ref), pull]));
		this.muted = new Set(muted);
		this.failures = 0;
		this.skip = 0;
	}

	has(ref: PullRef): boolean {
		return this.watched.has(pullKey(ref));
	}

	/** Switched off by the user, so query blocks leave it alone */
	isMuted(ref: PullRef): boolean {
		return this.muted.has(pullKey(ref));
	}

	list(): WatchedPull[] {
		return [...this.watched.values()];
	}

	/**
	 * The user asks to be told about this pull request (also undoes a mute).
	 */
	add(pull: WatchedPull): void {
		const key = pullKey(pull.ref);
		this.muted.delete(key);
		this.watched.set(key, { ...this.watched.get(key), ...pull, auto: false });
		this.changed();
	}

	/**
	 * A query block with `notify: true` shows these pull requests: watch the ones not watched yet and
	 * not muted. Does not announce what is already true about them.
	 */
	addAuto(pulls: WatchedPull[]): void {
		let added = false;
		for (const pull of pulls) {
			const key = pullKey(pull.ref);
			if (!this.watched.has(key) && !this.muted.has(key)) {
				this.watched.set(key, { ...pull, auto: true });
				added = true;
			}
		}
		if (added) {
			this.changed();
		}
	}

	/**
	 * Stop telling the user about this pull request, and keep query blocks from watching it again.
	 */
	remove(ref: PullRef): void {
		const key = pullKey(ref);
		this.watched.delete(key);
		this.muted.delete(key);
		this.muted.add(key);
		if (this.muted.size > MAX_MUTED) {
			this.muted.delete(this.muted.values().next().value as string);
		}
		this.changed();
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

			let ended = false;
			let remembered = false;
			for (const pull of watched) {
				const status = statuses.get(pullKey(pull.ref));
				// Missing means GitHub did not return it (no access); keep waiting rather than guess
				if (!status) {
					continue;
				}
				if (status.state !== "open") {
					this.watched.delete(pullKey(pull.ref));
					ended = true;
					continue;
				}
				remembered = this.check(pull, status, deps) || remembered;
			}
			if (ended) {
				this.changed();
			} else if (remembered) {
				// Remember it for the next start, but nothing visible changed
				this.save();
			}
		} catch (error) {
			this.failures++;
			this.skip = Math.min(2 ** (this.failures - 1), MAX_SKIP_TICKS);
			deps.log("could not check watched pull requests", error);
		} finally {
			this.ticking = false;
		}
	}

	/**
	 * Announce what changed since the last check of this open pull request. Returns whether what it
	 * remembers about it changed.
	 */
	private check(pull: WatchedPull, status: PullStatus, deps: WatcherDeps): boolean {
		const previous = pull.seen;
		const ready = isReadyToMerge(status);

		if (ready) {
			// First sight of an automatically added PR is a baseline, not news
			const isNews = previous ? !previous.ready : !pull.auto;
			if (isNews) {
				deps.notify(pull, { kind: "ready" });
			}
		} else if (previous) {
			const ciPassed = previous.ci !== "success" && status.ci.state === "success";
			const approved = previous.review !== "approved" && status.review === "approved";
			if (ciPassed || approved) {
				deps.notify(pull, { kind: "progress", ciPassed, approved, blockers: mergeBlockers(status) });
			}
		}

		const next = { ci: status.ci.state, review: status.review, ready };
		if (previous?.ci === next.ci && previous.review === next.review && previous.ready === next.ready) {
			return false;
		}
		pull.seen = next;
		return true;
	}

	private changed(): void {
		this.save();
		for (const listener of [...this.listeners]) {
			listener();
		}
	}

	private save(): void {
		void this.deps?.save({ watched: this.list(), muted: [...this.muted] });
	}
}

/** The one watcher of the plugin; set up by the plugin on load */
export const pullWatcher = new PullWatcher();
