import {
	isReadyToMerge,
	mergeBlockers,
	POLL_DELAY_MS,
	pollDelayMs,
	pullKey,
	type PullRef,
	type PullStatus,
} from "../github/pull-status";

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

/** After a failed check the wait doubles each time, up to this, so a bad token or an outage is not hammered */
const MAX_BACKOFF_MS = 10 * 60 * 1000;
/** A PR newly added by a query block is checked this soon */
const KICK_DELAY_MS = 3000;
/** Statuses another poll fetched this recently are reused; shorter than the fastest poll, or it would defeat it */
const STATUS_MAX_AGE_MS = POLL_DELAY_MS.active - 5000;
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
	private started = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private nextAt: number | null = null;
	private lastAt: number | null = null;

	init(deps: WatcherDeps, watched: WatchedPull[], muted: string[]): void {
		this.deps = deps;
		this.watched = new Map(watched.map((pull) => [pullKey(pull.ref), pull]));
		this.muted = new Set(muted);
		this.failures = 0;
	}

	/**
	 * Begin checking by itself. How soon the next check comes depends on what the watched pull requests
	 * are doing (see `pollTier`), so there is no fixed interval.
	 */
	start(): void {
		this.started = true;
		this.schedule(KICK_DELAY_MS);
	}

	stop(): void {
		this.started = false;
		this.schedule(null);
	}

	/** When the next check is due (ms timestamp), or null when nothing is scheduled */
	nextCheckAt(): number | null {
		return this.nextAt;
	}

	/** When the last check finished (ms timestamp), or null if none yet */
	lastCheckAt(): number | null {
		return this.lastAt;
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
			// Check what the list just added soon, unless a check is already due sooner
			if (this.started && (this.nextAt === null || this.nextAt - Date.now() > KICK_DELAY_MS)) {
				this.schedule(KICK_DELAY_MS);
			}
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
		if (!deps || this.ticking) {
			return;
		}
		if (this.watched.size === 0) {
			this.schedule(null);
			return;
		}

		this.ticking = true;
		let delay: number = POLL_DELAY_MS.waiting;
		try {
			const watched = this.list();
			const statuses = await deps.fetchStatuses(
				watched.map((pull) => pull.ref),
				STATUS_MAX_AGE_MS,
			);
			this.failures = 0;
			delay = pollDelayMs([...statuses.values()].filter((status) => status.state === "open"));

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
			delay = Math.min(POLL_DELAY_MS.active * 2 ** this.failures, MAX_BACKOFF_MS);
			deps.log("could not check watched pull requests", error);
		} finally {
			this.ticking = false;
			this.lastAt = Date.now();
			this.schedule(this.started && this.watched.size > 0 ? delay : null);
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

	/** Replace the pending check with one in `delayMs`, or cancel it with null */
	private schedule(delayMs: number | null): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
		}
		this.timer = null;
		this.nextAt = null;
		if (delayMs !== null && this.started && this.watched.size > 0) {
			this.nextAt = Date.now() + delayMs;
			this.timer = setTimeout(() => void this.tick(), delayMs);
		}
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
