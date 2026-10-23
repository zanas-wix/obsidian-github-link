/**
 * The anchor of a file in a pull request's "Files changed" tab: `diff-` plus the SHA-256 of the path.
 * Opening `<pr url>/changes#<anchor>` scrolls GitHub to that file.
 */
export async function diffAnchor(path: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
	const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `diff-${hex}`;
}
