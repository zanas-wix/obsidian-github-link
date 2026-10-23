import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { pullKey, type PullRef, type PullStatus } from "../github/pull-status";
import { PullWatcher, type WatchedPull } from "./watcher";

const ref = (number: number): PullRef => ({ org: "o", repo: "r", number });
const pull = (number: number): WatchedPull => ({ ref: ref(number), title: `PR ${number}` });
const status = (overrides: Partial<PullStatus> = {}): PullStatus => ({
	state: "open",
	draft: false,
	review: "approved",
	merge: "mergeable",
	ci: { state: "success", passed: 1, total: 1 },
	...overrides,
});

describe("PullWatcher", () => {
	let statuses: Map<string, PullStatus>;
	let fetchStatuses: jest.Mock<(refs: PullRef[], maxAgeMs: number) => Promise<Map<string, PullStatus>>>;
	let notifyReady: jest.Mock<(pull: WatchedPull) => void>;
	let save: jest.Mock<(watched: WatchedPull[]) => void>;
	let watcher: PullWatcher;

	beforeEach(() => {
		statuses = new Map();
		fetchStatuses = jest.fn(() => Promise.resolve(statuses));
		notifyReady = jest.fn();
		save = jest.fn();
		watcher = new PullWatcher();
		watcher.init({ fetchStatuses, notifyReady, save, log: jest.fn() }, []);
	});

	it("notifies once when a watched pull request becomes ready, then stops watching it", async () => {
		watcher.add(pull(1));
		statuses.set(pullKey(ref(1)), status({ review: "review-required" }));

		await watcher.tick();
		expect(notifyReady).not.toHaveBeenCalled();
		expect(watcher.has(ref(1))).toBe(true);

		statuses.set(pullKey(ref(1)), status());
		await watcher.tick();
		await watcher.tick();
		expect(notifyReady).toHaveBeenCalledTimes(1);
		expect(watcher.has(ref(1))).toBe(false);
		expect(save).toHaveBeenLastCalledWith([]);
	});

	it("drops merged and closed pull requests without notifying", async () => {
		watcher.add(pull(1));
		watcher.add(pull(2));
		statuses.set(pullKey(ref(1)), status({ state: "merged" }));
		statuses.set(pullKey(ref(2)), status({ state: "closed" }));

		await watcher.tick();

		expect(notifyReady).not.toHaveBeenCalled();
		expect(watcher.list()).toEqual([]);
	});

	it("keeps watching a pull request GitHub did not return", async () => {
		watcher.add(pull(1));
		await watcher.tick();
		expect(watcher.has(ref(1))).toBe(true);
	});

	it("checks all watched pull requests in one fetch, and does nothing when none are watched", async () => {
		await watcher.tick();
		expect(fetchStatuses).not.toHaveBeenCalled();

		watcher.add(pull(1));
		watcher.add(pull(2));
		await watcher.tick();
		expect(fetchStatuses).toHaveBeenCalledTimes(1);
		expect(fetchStatuses.mock.calls[0][0].map((r) => r.number)).toEqual([1, 2]);
	});

	it("backs off after a failed check instead of retrying every tick", async () => {
		watcher.add(pull(1));
		fetchStatuses.mockRejectedValueOnce(new Error("403"));

		await watcher.tick(); // fails
		await watcher.tick(); // skipped
		expect(fetchStatuses).toHaveBeenCalledTimes(1);

		await watcher.tick(); // retries after the skip
		expect(fetchStatuses).toHaveBeenCalledTimes(2);
	});

	it("tells subscribers when a watch is added, removed or ended by the watcher", async () => {
		const listener = jest.fn();
		const stop = watcher.subscribe(listener);

		watcher.add(pull(1));
		statuses.set(pullKey(ref(1)), status());
		await watcher.tick();
		expect(listener).toHaveBeenCalledTimes(2);

		stop();
		watcher.add(pull(2));
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("restores watches from saved data", () => {
		watcher.init({ fetchStatuses, notifyReady, save, log: jest.fn() }, [pull(5)]);
		expect(watcher.has(ref(5))).toBe(true);
	});
});
