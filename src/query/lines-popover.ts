import { groupFilesByExtension, type FileGroup } from "../github/file-groups";
import { getPullFiles } from "../github/github";
import { pullKey, type PullRef } from "../github/pull-status";

/** Resting on the count for this long starts loading, so moving the mouse across a list costs nothing */
const HOVER_DELAY_MS = 250;
/** A breakdown is reused for this long, so hovering the same PR again is instant */
const CACHE_MS = 60 * 1000;

interface Breakdown {
	groups: FileGroup[];
	files: number;
	truncated: boolean;
}

const cache = new Map<string, { at: number; breakdown: Promise<Breakdown> }>();

function load(ref: PullRef): Promise<Breakdown> {
	const key = pullKey(ref);
	const cached = cache.get(key);
	if (cached && Date.now() - cached.at < CACHE_MS) {
		return cached.breakdown;
	}
	const breakdown = getPullFiles(ref).then(({ files, truncated }) => ({
		groups: groupFilesByExtension(files),
		files: files.length,
		truncated,
	}));
	cache.set(key, { at: Date.now(), breakdown });
	// A failed load must not be remembered, or the next hover would show the same error
	breakdown.catch(() => cache.delete(key));
	return breakdown;
}

/** Elements that already have the hover behaviour, with the pull request it currently shows */
const attached = new WeakMap<HTMLElement, { ref: PullRef }>();

/**
 * Show lines added and removed per file group (".ts", ".spec.ts", ...) in a popover while the mouse rests
 * on `el`. The files are fetched on the first hover only.
 *
 * A list redraws the same cell on every status refresh, so calling this again for an element that has
 * the behaviour only updates its pull request. Adding the listeners again would open one more stacked
 * popover per refresh.
 */
export function attachLinesBreakdown(el: HTMLElement, ref: PullRef): void {
	const existing = attached.get(el);
	if (existing) {
		existing.ref = ref;
		return;
	}
	const state = { ref };
	attached.set(el, state);

	let timer: number | null = null;
	let watchdog: number | null = null;
	let popover: HTMLElement | null = null;

	const hide = () => {
		if (timer !== null) window.clearTimeout(timer);
		if (watchdog !== null) window.clearInterval(watchdog);
		timer = watchdog = null;
		popover?.remove();
		popover = null;
	};

	const show = () => {
		timer = null;
		const mine = document.body.createDiv({ cls: "github-link-lines-popover" });
		popover = mine;
		mine.createDiv({ cls: "github-link-lines-popover-note", text: "Loading files…" });
		place(mine, el);
		// The list can redraw this cell while the popover is open, which would never send a mouseleave
		watchdog = window.setInterval(() => {
			if (!el.isConnected) hide();
		}, 1000);

		load(state.ref).then(
			(breakdown) => {
				if (popover !== mine) return;
				fill(mine, breakdown);
				place(mine, el);
			},
			(error: unknown) => {
				if (popover !== mine) return;
				mine.empty();
				const message = error instanceof Error ? error.message : "request failed";
				mine.createDiv({ cls: "github-link-lines-popover-note", text: `Could not load the files: ${message}` });
				place(mine, el);
			},
		);
	};

	el.addEventListener("mouseenter", () => {
		timer = window.setTimeout(show, HOVER_DELAY_MS);
	});
	el.addEventListener("mouseleave", hide);
}

function fill(popover: HTMLElement, breakdown: Breakdown): void {
	popover.empty();
	const grid = popover.createDiv({ cls: "github-link-lines-popover-grid" });
	for (const group of breakdown.groups) {
		grid.createSpan({ cls: "github-link-lines-popover-group", text: group.group });
		const lines = grid.createSpan({ cls: "github-link-lines" });
		lines.createSpan({ cls: "github-link-lines-added", text: `+${group.additions}` });
		lines.createSpan({ text: "/" });
		lines.createSpan({ cls: "github-link-lines-removed", text: `-${group.deletions}` });
		grid.createSpan({
			cls: "github-link-lines-popover-files",
			text: `${group.files} ${group.files === 1 ? "file" : "files"}`,
		});
	}
	popover.createDiv({
		cls: "github-link-lines-popover-note",
		text: breakdown.truncated ? `Only the first ${breakdown.files} files are counted` : `${breakdown.files} files`,
	});
}

/**
 * Below the count and right-aligned with it; above it when there is no room below, and always inside the window.
 */
function place(popover: HTMLElement, anchor: HTMLElement): void {
	const rect = anchor.getBoundingClientRect();
	const margin = 8;
	const left = Math.max(
		margin,
		Math.min(rect.right - popover.offsetWidth, window.innerWidth - popover.offsetWidth - margin),
	);
	const below = rect.bottom + 4;
	const top = below + popover.offsetHeight > window.innerHeight - margin ? rect.top - popover.offsetHeight - 4 : below;
	popover.style.left = `${left}px`;
	popover.style.top = `${Math.max(margin, top)}px`;
}
