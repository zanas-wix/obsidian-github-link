import { describe, expect, it } from "@jest/globals";
import type { TimelineItem } from "../github/pull-detail";
import { findCiReport, parseCiReport, queryParams } from "./ci-report";

const BODY = `<h3> &#9940;&nbsp; Status: Failed </h3>
<p>To re-trigger the build, add the comment <code>#rebuild</code></p>
<table><tr><td><a href="https://wix-bo.com/x/preview-releases">Deploy Previews</a></td></tr></table>

### Validation Failures

| package name | validation name | log |
| ------------ | --------------- | --- |
| ricos-integration-tests | test:types script | [View Log](https://wix-bo.com/log-viewer/?url=a%3Db) |
| @wix/ricos-playground | test:sled3 script | [View Log](https://wix-bo.com/log-viewer/?url=c) |

<details>
<summary>Deploy previews</summary>

| Package | Type | Info |
| ------- | ---- | ---- |
| @wix/ricos-playground | preview url 1 | [https://ricos.dev](https://ricos.dev/?ricos-playground-override=38989c) |
| @wix/ricos-tpa | preview url 1 | [https://editor.wix.com/a?x=1](https://editor.wix.com/a?x=1&ricos-tpa-override=f7e794) |
|  | preview url 2 | [https://avivm6.wixsite.com/v2](https://avivm6.wixsite.com/v2?ricos-tpa-override=f7e794) |
| @wix/www-ricos | preview url 1 | [https://m.wix.com/{route}](https://m.wix.com/%7Broute%7D?www-ricos-override=7e1187) |

</details>`;

describe("parseCiReport", () => {
	const report = parseCiReport(BODY);

	it("reads the validation failures with their log links", () => {
		expect(report.failures).toEqual([
			{
				pkg: "ricos-integration-tests",
				validation: "test:types script",
				logUrl: "https://wix-bo.com/log-viewer/?url=a%3Db",
			},
			{ pkg: "@wix/ricos-playground", validation: "test:sled3 script", logUrl: "https://wix-bo.com/log-viewer/?url=c" },
		]);
	});

	it("takes the real address from the link target, not the link text that hides the query parameters", () => {
		expect(report.previews[0]).toEqual({
			pkg: "@wix/ricos-playground",
			type: "preview url 1",
			label: "https://ricos.dev",
			url: "https://ricos.dev/?ricos-playground-override=38989c",
		});
	});

	it("gives a package's later preview rows the package named on its first row", () => {
		expect(report.previews.map((preview) => [preview.pkg, preview.type])).toEqual([
			["@wix/ricos-playground", "preview url 1"],
			["@wix/ricos-tpa", "preview url 1"],
			["@wix/ricos-tpa", "preview url 2"],
			["@wix/www-ricos", "preview url 1"],
		]);
	});

	it("finds nothing in an ordinary comment", () => {
		expect(parseCiReport("Looks good to me")).toEqual({ failures: [], previews: [] });
	});
});

describe("queryParams", () => {
	it("returns only what follows the ?, without a fragment", () => {
		expect(queryParams("https://e.wix.com/a?x=1&ricos-tpa-override=f7e#frag")).toBe("x=1&ricos-tpa-override=f7e");
		expect(queryParams("https://ricos.dev/")).toBe("");
	});

	it("leaves out the excluded parameters and keeps the rest as written", () => {
		const url = "https://e.wix.com/a?metaSiteId=266b&editorSessionId=be80&ricos-tpa-override=f7e%2F94";
		expect(queryParams(url, ["metaSiteId"])).toBe("editorSessionId=be80&ricos-tpa-override=f7e%2F94");
		expect(queryParams("https://e.wix.com/a?metaSiteId=266b", ["metaSiteId"])).toBe("");
	});
});

describe("findCiReport", () => {
	const comment = (body: string, at: string): TimelineItem => ({
		kind: "comment",
		author: { login: "bot", avatarUrl: null },
		body,
		at,
		url: "u",
	});

	it("uses only the newest CI comment, so a passing run hides an older run's failures", () => {
		const passing = "<p>To re-trigger the build, add the comment #rebuild</p> Status: Passed";
		expect(findCiReport([comment(BODY, "2026-01-01"), comment(passing, "2026-01-02")])).toBeNull();
		expect(findCiReport([comment(passing, "2026-01-01"), comment(BODY, "2026-01-02")])?.failures).toHaveLength(2);
	});

	it("ignores comments that are not CI reports", () => {
		expect(findCiReport([comment(BODY, "2026-01-01"), comment("thanks!", "2026-01-02")])?.previews).toHaveLength(4);
		expect(findCiReport([comment("thanks!", "2026-01-01")])).toBeNull();
	});
});
