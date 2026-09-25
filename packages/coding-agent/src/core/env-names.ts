import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Leaf module: environment-variable names only, so test setup files can import without loading the full config graph. */

function getPackageJsonPath(): string {
	// Walk up from this file to the package root holding package.json.
	let directory = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const candidate = join(directory, "package.json");
		try {
			const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
			if (typeof pkg.name === "string" && pkg.name.includes("pi-coding-agent")) return candidate;
		} catch {
			// Not the package root; keep walking up.
		}
		const parent = dirname(directory);
		if (parent === directory) return candidate;
		directory = parent;
	}
}

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as {
	name?: string;
	version?: string;
	piConfig?: { name?: string; configDir?: string };
};

const piConfigName: string | undefined = pkg.piConfig?.name;
const envPrefix =
	(piConfigName || "pi")
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "") || "PI";

export const ENV_AGENT_DIR = `${envPrefix}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${envPrefix}_SESSION_DIR`;
export const ENV_LEGACY_SESSION_DIR = `${envPrefix}_CODING_AGENT_SESSION_DIR`;
