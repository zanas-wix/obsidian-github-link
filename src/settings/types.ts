import { LogLevel } from "../logger";
import type { WatchedPull } from "../watch/watcher";

export const DATA_VERSION = 1;

export interface GithubAccount {
	id: string;
	name: string;
	orgs: string[];
	token: string;
	customOAuth?: boolean;
	clientId?: string;
}

export interface GithubLinkPluginData {
	settings: GithubLinkPluginSettings;
	cache: string[] | null;
	dataVersion: number;
	/** Pull requests to notify about once they can be merged; absent in data saved by older versions */
	watched?: WatchedPull[];
}

export interface GithubLinkPluginSettings {
	accounts: GithubAccount[];
	defaultAccount?: string;
	defaultPageSize: number;
	showPagination: boolean;
	showRefresh: boolean;
	showExternalLink: boolean;
	logLevel: LogLevel;
	tagEnableUrlPreview: boolean;
	tagTooltips: boolean;
	tagShowPRMergeable: boolean;
	tagShowFileBranchName: boolean;
	tagShowFileLineNumber: boolean;
	tagShowStatusIcon: boolean;
	tagShowOrg: boolean;
	tagShowRepo: boolean;
	tagShowNumber: boolean;
	tagShowTitle: boolean;
	cacheIntervalSeconds: number;
	maxCacheAgeHours: number;
	minRequestSeconds: number;
	useGhCli: boolean;
	ghCliPath: string;
	maxInlineTagChars: number;
	stripConventionalCommitPrefix: boolean;
}

export const DEFAULT_SETTINGS: GithubLinkPluginSettings = {
	accounts: [],
	defaultPageSize: 10,
	showPagination: true,
	showRefresh: true,
	showExternalLink: true,
	logLevel: LogLevel.Error,
	tagEnableUrlPreview: true,
	tagTooltips: false,
	tagShowPRMergeable: false,
	tagShowFileBranchName: true,
	tagShowFileLineNumber: true,
	tagShowStatusIcon: true,
	tagShowOrg: true,
	tagShowRepo: true,
	tagShowNumber: true,
	tagShowTitle: true,
	cacheIntervalSeconds: 60,
	maxCacheAgeHours: 120,
	minRequestSeconds: 60,
	useGhCli: true,
	ghCliPath: "gh",
	maxInlineTagChars: 40,
	stripConventionalCommitPrefix: false,
};
