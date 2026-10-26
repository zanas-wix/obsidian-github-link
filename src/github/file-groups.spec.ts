import { describe, expect, it } from "@jest/globals";
import { fileGroup, groupFilesByExtension } from "./file-groups";

describe("fileGroup", () => {
	it("uses the extension, lower-cased", () => {
		expect(fileGroup("src/app/Button.ts")).toBe(".ts");
		expect(fileGroup("styles/main.SCSS")).toBe(".scss");
		expect(fileGroup("package-lock.json")).toBe(".json");
	});

	it("gives spec, test, type-declaration and similar variants their own group", () => {
		expect(fileGroup("src/a.spec.ts")).toBe(".spec.ts");
		expect(fileGroup("src/a.test.tsx")).toBe(".test.tsx");
		expect(fileGroup("types/a.d.ts")).toBe(".d.ts");
		expect(fileGroup("ui/a.module.scss")).toBe(".module.scss");
		expect(fileGroup("vite.config.ts")).toBe(".config.ts");
	});

	it("does not treat an ordinary dotted name as a variant", () => {
		expect(fileGroup("src/my.component.ts")).toBe(".ts");
		expect(fileGroup("v1.2.3.md")).toBe(".md");
	});

	it("handles dotfiles and files without an extension", () => {
		expect(fileGroup(".gitignore")).toBe(".gitignore");
		expect(fileGroup("src/.eslintrc")).toBe(".eslintrc");
		expect(fileGroup("Dockerfile")).toBe("(no extension)");
		expect(fileGroup("docs/LICENSE")).toBe("(no extension)");
	});
});

describe("groupFilesByExtension", () => {
	it("sums lines per group and keeps .spec.ts out of .ts", () => {
		const groups = groupFilesByExtension([
			{ path: "a.ts", additions: 2, deletions: 2 },
			{ path: "b.ts", additions: 1, deletions: 0 },
			{ path: "a.spec.ts", additions: 3, deletions: 2 },
			{ path: "x.scss", additions: 2, deletions: 2 },
		]);

		expect(groups).toEqual([
			{ group: ".spec.ts", files: 1, additions: 3, deletions: 2 },
			{ group: ".ts", files: 2, additions: 3, deletions: 2 },
			{ group: ".scss", files: 1, additions: 2, deletions: 2 },
		]);
	});

	it("orders by size of change, then name, and is empty for no files", () => {
		expect(
			groupFilesByExtension([
				{ path: "a.ts", additions: 1, deletions: 1 },
				{ path: "a.md", additions: 1, deletions: 1 },
			]).map((g) => g.group),
		).toEqual([".md", ".ts"]);
		expect(groupFilesByExtension([])).toEqual([]);
	});
});
