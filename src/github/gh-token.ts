import { PluginSettings } from "../plugin";
import { logger } from "../plugin";

// undefined = not yet fetched, null = tried and failed
let cached: string | null | undefined;
let pendingFetch: Promise<string | null> | null = null;

// macOS GUI apps get a minimal PATH; add common locations where gh is installed
const EXTRA_PATHS = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
];

function enrichedPath(): string {
	const existing = process?.env?.PATH ?? "";
	const parts = existing.split(":");
	const missing = EXTRA_PATHS.filter((p) => !parts.includes(p));
	return [...parts, ...missing].join(":");
}

export function getGhToken(force = false): Promise<string | null> {
	if (!force && cached !== undefined) {
		return Promise.resolve(cached);
	}

	// If a fetch is already in-flight, reuse it
	if (!force && pendingFetch) {
		return pendingFetch;
	}

	pendingFetch = (async () => {
		try {
			// Lazy-load child_process so mobile builds don't crash at import time
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { execFile } = require("child_process") as typeof import("child_process");
			const ghPath = PluginSettings.ghCliPath || "gh";

			const token = await new Promise<string | null>((resolve) => {
				execFile(
					ghPath,
					["auth", "token"],
					{ timeout: 5000, env: { ...process.env, PATH: enrichedPath() } },
					(err: Error | null, stdout: string) => {
						if (err) {
							logger.debug(`gh auth token failed: ${err}`);
							resolve(null);
						} else {
							const trimmed = stdout.trim();
							resolve(trimmed || null);
						}
					},
				);
			});

			cached = token;
			return token;
		} catch {
			// child_process not available (mobile) or other environment issue
			logger.debug("child_process not available, gh CLI auth disabled");
			cached = null;
			return null;
		} finally {
			pendingFetch = null;
		}
	})();

	return pendingFetch;
}

/**
 * Returns the pending token fetch if one is in-flight, or null if the token is already resolved.
 * Use this to await the token before making API requests.
 */
export function getGhTokenPending(): Promise<string | null> | null {
	return pendingFetch;
}

export function getGhTokenSync(): string | null | undefined {
	return cached;
}

export async function refreshGhToken(): Promise<void> {
	cached = undefined;
	await getGhToken(true);
}
