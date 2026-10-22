/**
 * Comments that trigger automation on the pull request when posted.
 */
export interface QuickComment {
	body: string;
	/** What posting it does */
	hint: string;
	/** Asked before posting, for comments with consequences; none for harmless ones */
	confirm?: string;
	icon: string;
}

export const QUICK_COMMENTS: QuickComment[] = [
	{
		body: "#skipreview",
		hint: "approve the PR",
		confirm: "This approves the pull request without a review.",
		icon: "lucide-check-check",
	},
	{ body: "#rebuild", hint: "re-run CI", icon: "lucide-rotate-cw" },
];
