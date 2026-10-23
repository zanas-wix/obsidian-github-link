import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";
import { describe, expect, it } from "@jest/globals";
import { diffAnchor } from "./diff-anchor";

// jsdom has neither Web Crypto nor TextEncoder; Obsidian (Electron) has both
if (!globalThis.crypto?.subtle) {
	Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}
if (typeof globalThis.TextEncoder === "undefined") {
	Object.defineProperty(globalThis, "TextEncoder", { value: TextEncoder });
}

describe("diffAnchor", () => {
	it("matches the anchor GitHub uses for a file in the Files changed tab", async () => {
		// Taken from a real link: github.com/wix-private/ricos/pull/10779/changes#diff-98b9…
		expect(await diffAnchor("infra/docs-playground/src/app/theme/state/workspace-selectors.ts")).toBe(
			"diff-98b93b0a5fa64fe7feb68c4f8aa0a2bb57cc140910e72e2dad6c823176d00363",
		);
	});
});
