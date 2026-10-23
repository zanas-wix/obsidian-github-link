/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, GithubLinkPluginSettingsTab } from "./settings";
import { Logger } from "./logger";

import type { GithubLinkPluginData, GithubLinkPluginSettings } from "./settings";
import { InlineRenderer } from "./inline/inline";
import { createInlineViewPlugin } from "./inline/view-plugin";
import { RequestCache } from "./github/cache";
import { QueryProcessor } from "./query/processor";
import { DATA_VERSION } from "./settings/types";
import { getGhToken } from "./github/gh-token";
import { PullRequestView, PULL_VIEW_TYPE, type PullPaneTarget } from "./pr-view/pr-view";
import { getPullStatuses } from "./github/github";
import { notify } from "./watch/notify";
import { pullWatcher } from "./watch/watcher";

/** How often watched pull requests are checked */
const WATCH_INTERVAL_MS = 60 * 1000;

export const PluginSettings: GithubLinkPluginSettings = { ...DEFAULT_SETTINGS };
export const PluginData: GithubLinkPluginData = { cache: null, settings: PluginSettings, dataVersion: DATA_VERSION };
export const logger = new Logger();
let cache: RequestCache;
export function getCache(): RequestCache {
	return cache;
}

let pluginInstance: GithubLinkPlugin | null = null;

/**
 * Open a pull request in the side pane (used by query cards). Does nothing before the plugin has loaded.
 */
export async function openPullRequestPane(target?: PullPaneTarget): Promise<void> {
	await pluginInstance?.openPullRequestPane(target);
}

export class GithubLinkPlugin extends Plugin {
	public cacheInterval: number | undefined;

	/**
	 * Show a pull request in the side pane, reusing the open pane if there is one. Without a target the
	 * pane is just revealed.
	 */
	public async openPullRequestPane(target?: PullPaneTarget): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(PULL_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) {
				new Notice("GitHub Link: could not open a side pane.");
				return;
			}
			await leaf.setViewState({ type: PULL_VIEW_TYPE, active: true });
		}
		void workspace.revealLeaf(leaf);
		if (target && leaf.view instanceof PullRequestView) {
			await leaf.view.setTarget(target);
		}
	}

	private async saveCacheIfUpdated(): Promise<void> {
		if (cache.cacheUpdated) {
			PluginData.cache = cache.toJSON();
			await this.saveData(PluginData);
			cache.cacheUpdated = false;
			logger.info(`Saved request cache with ${PluginData.cache?.length} items.`);
		}
	}

	async onload() {
		pluginInstance = this;
		const data = (await this.loadData()) || {};

		Object.assign(PluginSettings, data.settings);
		Object.assign(PluginData, data);
		logger.logLevel = PluginSettings.logLevel;

		cache = new RequestCache(PluginData.cache);

		if (data.dataVersion === undefined || PluginData.dataVersion < DATA_VERSION) {
			// Always clear cache when data version changes
			const entriesDeleted = cache.clean(new Date());
			PluginData.cache = null;
			PluginData.dataVersion = DATA_VERSION;
			await this.saveData(PluginData);
			new Notice(
				`GitHub link data schema migrated to version ${DATA_VERSION}. Removed ${entriesDeleted} stored items from GitHub Link cache.`,
				3000,
			);
		}

		// Clean cache
		const maxAge = new Date(new Date().getTime() - PluginSettings.maxCacheAgeHours * 60 * 60 * 1000);
		const entriesDeleted = cache.clean(maxAge);
		if (entriesDeleted > 0) {
			PluginData.cache = cache.toJSON();
			await this.saveData(PluginData);
			logger.info(`Cleaned ${entriesDeleted} entries from request cache.`);
		}

		// To show all icons, logger.debug(getIconIds());

		this.addSettingTab(new GithubLinkPluginSettingsTab(this.app, this));
		this.registerMarkdownPostProcessor(InlineRenderer);
		this.registerEditorExtension(createInlineViewPlugin(this));
		this.registerMarkdownCodeBlockProcessor("github-query", QueryProcessor);
		this.registerView(PULL_VIEW_TYPE, (leaf) => new PullRequestView(leaf));
		this.addCommand({
			id: "open-pull-request-pane",
			name: "Open pull request pane",
			callback: () => void openPullRequestPane(),
		});
		this.setCacheInterval();

		pullWatcher.init(
			{
				fetchStatuses: (refs, maxAgeMs) => getPullStatuses(refs, maxAgeMs),
				notify,
				save: async ({ watched, muted }) => {
					PluginData.watched = watched;
					PluginData.muted = muted;
					await this.saveData(PluginData);
				},
				log: (message, error) => logger.warn(`${message}: ${String(error)}`),
			},
			PluginData.watched ?? [],
			PluginData.muted ?? [],
		);
		// Not tied to a note or a visible pane: this is what notifies while Obsidian sits in the background
		this.registerInterval(window.setInterval(() => void pullWatcher.tick(), WATCH_INTERVAL_MS));
		window.setTimeout(() => void pullWatcher.tick(), 5000);

		// Prefetch gh CLI token so the first link preview doesn't pay the subprocess cost
		if (PluginSettings.useGhCli) {
			void getGhToken();
		}
	}

	async onunload() {
		await this.saveCacheIfUpdated();
	}

	/**
	 * Save cache at regular interval
	 */
	public setCacheInterval(): void {
		const checkCache = async () => {
			logger.debug("Checking if cache needs a save.");
			await this.saveCacheIfUpdated();
		};

		window.clearInterval(this.cacheInterval);
		this.cacheInterval = this.registerInterval(
			window.setInterval(() => {
				void checkCache();
			}, PluginSettings.cacheIntervalSeconds * 1000),
		);
	}
}
