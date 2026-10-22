import { setIcon } from "obsidian";
import { IssueStatus, type IssueOnlyStatus } from "./github/response";
import { PluginSettings } from "./plugin";

const PRIcon: Readonly<Record<IssueStatus, string>> = {
	[IssueStatus.Open]: "lucide-git-pull-request-arrow",
	[IssueStatus.Closed]: "lucide-git-pull-request-closed",
	[IssueStatus.Done]: "lucide-git-merge",
	[IssueStatus.Draft]: "lucide-git-pull-request-draft",
};

const PRStatusText: Readonly<Record<IssueStatus, string>> = {
	[IssueStatus.Open]: "Pull request open",
	[IssueStatus.Closed]: "Pull request closed",
	[IssueStatus.Done]: "Pull request merged",
	[IssueStatus.Draft]: "Draft pull request",
};

const PRMergeableIcon: Readonly<Record<`${boolean}`, string>> = {
	true: "lucide-check",
	false: "lucide-x",
};

const PRMergeableText: Readonly<Record<`${boolean}`, string>> = {
	true: "Mergeable",
	false: "Not mergeable",
};

const IssueIcon: Readonly<Record<IssueOnlyStatus, string>> = {
	[IssueStatus.Open]: "lucide-circle-dot",
	[IssueStatus.Closed]: "lucide-circle-slash",
	[IssueStatus.Done]: "lucide-check-circle",
};

const IssueStatusText: Readonly<Record<IssueOnlyStatus, string>> = {
	[IssueStatus.Open]: "Issue open",
	[IssueStatus.Closed]: "Issue closed as not planned",
	[IssueStatus.Done]: "Issue closed as completed",
};

export function setPRIcon(icon: HTMLElement, status: IssueStatus): void {
	if (PluginSettings.tagTooltips) {
		icon.setAttribute("aria-label", PRStatusText[status]);
	}

	setIcon(icon, PRIcon[status]);
	icon.classList.add("pull-request");
	icon.dataset.status = status;
}

export function setIssueIcon(icon: HTMLElement, status: IssueOnlyStatus): void {
	if (PluginSettings.tagTooltips) {
		icon.setAttribute("aria-label", IssueStatusText[status]);
	}

	setIcon(icon, IssueIcon[status]);
	icon.classList.add("issue");
	icon.dataset.status = status;
}

export function setFileIcon(icon: HTMLElement): void {
	setIcon(icon, "file");
}

export function setPRMergeableIcon(icon: HTMLElement, mergeable: boolean): void {
	if (PluginSettings.tagTooltips) {
		icon.setAttribute("aria-label", PRMergeableText[`${mergeable}`]);
	}

	setIcon(icon, PRMergeableIcon[`${mergeable}`]);
	icon.classList.add("pull-request-mergeable");
	icon.dataset.status = `${mergeable}`;
}
