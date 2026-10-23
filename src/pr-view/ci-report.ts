import type { TimelineItem } from "../github/pull-detail";

export interface ValidationFailure {
	pkg: string;
	validation: string;
	logUrl: string | null;
}

export interface DeployPreview {
	pkg: string;
	type: string;
	/** The link text as written in the comment; often the bare address, with the query parameters only in `url` */
	label: string;
	url: string;
}

export interface CiReport {
	failures: ValidationFailure[];
	previews: DeployPreview[];
}

/**
 * Comments the CI bot writes carry a "Validation Failures" table and a collapsed "Deploy previews"
 * table; both are Markdown tables with links in their cells.
 */
const REPORT_MARKER = /re-trigger the build|validation failures|<summary[^>]*>\s*deploy previews/i;

export function parseCiReport(body: string): CiReport {
	const lines = body.split("\n");

	const failureRows = tableAfter(
		lines,
		lines.findIndex((line) => /^#+\s*validation failures/i.test(line.trim())),
	);
	const failures = failureRows.map(([pkg, validation, log]) => ({
		pkg,
		validation,
		logUrl: cellLink(log)?.url ?? null,
	}));

	const previewRows = tableAfter(
		lines,
		lines.findIndex((line) => /<summary[^>]*>\s*deploy previews/i.test(line)),
	);
	const previews: DeployPreview[] = [];
	let pkg = "";
	for (const [packageCell, type, info] of previewRows) {
		// A package with several preview URLs names itself only on its first row
		pkg = packageCell || pkg;
		const link = cellLink(info);
		if (link) {
			previews.push({ pkg, type, label: link.label, url: link.url });
		}
	}

	return { failures, previews };
}

/**
 * The report in the newest CI comment, or null when there is none. Only that one comment counts: an
 * older run's failures must not show once a newer run passed.
 */
export function findCiReport(timeline: TimelineItem[]): CiReport | null {
	for (const item of [...timeline].reverse()) {
		if (item.kind === "comment" && REPORT_MARKER.test(item.body)) {
			const report = parseCiReport(item.body);
			return report.failures.length > 0 || report.previews.length > 0 ? report : null;
		}
	}
	return null;
}

/**
 * Everything after the first `?`, so it can be pasted next to another address, minus the parameters
 * named in `exclude`. Parameters keep their original encoding. Empty when none are left.
 */
export function queryParams(url: string, exclude: string[] = []): string {
	const start = url.indexOf("?");
	if (start === -1) {
		return "";
	}
	const end = url.indexOf("#", start);
	const query = url.slice(start + 1, end === -1 ? undefined : end);
	return query
		.split("&")
		.filter((param) => param && !exclude.includes(param.split("=")[0]))
		.join("&");
}

/** Body rows of the first Markdown table within a few lines after `headingIndex`, as trimmed cells */
function tableAfter(lines: string[], headingIndex: number): string[][] {
	if (headingIndex === -1) {
		return [];
	}
	const first = lines.findIndex((line, i) => i > headingIndex && i <= headingIndex + 4 && line.trim().startsWith("|"));
	if (first === -1) {
		return [];
	}
	const rows: string[][] = [];
	for (let i = first; i < lines.length && lines[i].trim().startsWith("|"); i++) {
		rows.push(
			lines[i]
				.trim()
				.replace(/^\||\|$/g, "")
				.split("|")
				.map((cell) => cell.trim()),
		);
	}
	// Drop the header row and the `| --- |` separator
	return rows.slice(2);
}

/** The first Markdown link `[label](url)` in a cell, or a bare address */
function cellLink(cell: string | undefined): { label: string; url: string } | null {
	if (!cell) {
		return null;
	}
	const markdown = /\[([^\]]*)\]\(([^)\s]+)\)/.exec(cell);
	if (markdown) {
		return { label: markdown[1], url: markdown[2] };
	}
	const bare = /https?:\/\/\S+/.exec(cell);
	return bare ? { label: bare[0], url: bare[0] } : null;
}
