import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env } from "@oh-my-pi/pi-utils";
import type { ProviderDefinition } from "./types";

let cachedVertexAdcCredentialsExists: boolean | null = null;

function hasVertexAdcCredentials(): boolean {
	if (cachedVertexAdcCredentialsExists === null) {
		const gacPath = $env.GOOGLE_APPLICATION_CREDENTIALS;
		if (gacPath) {
			cachedVertexAdcCredentialsExists = fs.existsSync(gacPath);
		} else {
			cachedVertexAdcCredentialsExists = fs.existsSync(
				path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"),
			);
		}
	}
	return cachedVertexAdcCredentialsExists;
}

export const googleVertexProvider = {
	id: "google-vertex",
	name: "Google Vertex AI",
	// Vertex AI supports either GOOGLE_CLOUD_API_KEY or Application Default Credentials.
	envKeys: () => {
		if ($env.GOOGLE_CLOUD_API_KEY) {
			return $env.GOOGLE_CLOUD_API_KEY;
		}
		const hasCredentials = hasVertexAdcCredentials();
		const hasProject = !!($env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT);
		const hasLocation = !!($env.GOOGLE_VERTEX_LOCATION || $env.GOOGLE_CLOUD_LOCATION || $env.VERTEX_LOCATION);
		if (hasCredentials && hasProject && hasLocation) {
			return "<authenticated>";
		}
	},
} as const satisfies ProviderDefinition;
