export interface ChangedFile {
	path: string;
	additions: number;
	deletions: number;
}

export interface FileGroup {
	/** ".ts", ".spec.ts", ".scss", ".gitignore", "(no extension)" */
	group: string;
	files: number;
	additions: number;
	deletions: number;
}

/** Parts before the last extension that mark a different kind of file: `.spec.ts` is not `.ts` */
const VARIANT_MARKERS = new Set([
	"spec",
	"test",
	"e2e",
	"d",
	"stories",
	"story",
	"module",
	"config",
	"mock",
	"snap",
	"min",
]);

/**
 * The group a file counts in. The extension, except that variant files get their own group: `a.spec.ts`
 * is ".spec.ts" and is not counted in ".ts". Dotfiles are their own group, files without one are "(no extension)".
 */
export function fileGroup(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const parts = name.split(".");
	if (name.startsWith(".") && parts.length === 2) {
		return name.toLowerCase();
	}
	if (parts.length < 2) {
		return "(no extension)";
	}
	const extension = `.${parts[parts.length - 1].toLowerCase()}`;
	const variant = parts.length >= 3 ? parts[parts.length - 2].toLowerCase() : null;
	return variant && VARIANT_MARKERS.has(variant) ? `.${variant}${extension}` : extension;
}

/**
 * Lines added and removed per file group, biggest change first.
 */
export function groupFilesByExtension(files: ChangedFile[]): FileGroup[] {
	const groups = new Map<string, FileGroup>();
	for (const file of files) {
		const key = fileGroup(file.path);
		const group = groups.get(key) ?? { group: key, files: 0, additions: 0, deletions: 0 };
		group.files++;
		group.additions += file.additions;
		group.deletions += file.deletions;
		groups.set(key, group);
	}
	return [...groups.values()].sort(
		(a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.group.localeCompare(b.group),
	);
}
