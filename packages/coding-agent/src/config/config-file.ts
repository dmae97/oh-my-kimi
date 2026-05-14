import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ErrorObject } from "ajv";
import { JSONC, YAML } from "bun";

function migrateJsonToYml(jsonPath: string, ymlPath: string) {
	try {
		if (fs.existsSync(ymlPath)) return;
		if (!fs.existsSync(jsonPath)) return;

		const content = fs.readFileSync(jsonPath, "utf-8");
		const parsed = JSON.parse(content);
		if (!parsed) {
			logger.warn("migrateJsonToYml: invalid json structure", { path: jsonPath });
			return;
		}
		fs.writeFileSync(ymlPath, YAML.stringify(parsed, null, 2));
	} catch (error) {
		logger.warn("migrateJsonToYml: migration failed", { error: String(error) });
	}
}

export interface IConfigFile<T> {
	readonly id: string;
	readonly schema: TSchema;
	path?(): string;
	load(): T | null;
	invalidate?(): void;
}

export class ConfigError extends Error {
	readonly #message: string;
	constructor(
		public readonly id: string,
		public readonly schemaErrors: ErrorObject[] | null | undefined,
		public readonly other?: { err: unknown; stage: string },
	) {
		let messages: string[] | undefined;
		let cause: Error | undefined;
		let klass: string;

		if (schemaErrors) {
			klass = "Schema";
			messages = schemaErrors.map(e => `${e.instancePath || "root"}: ${e.message}`);
		} else if (other) {
			klass = other.stage;
			if (other.err instanceof Error) {
				messages = [other.err.message];
				cause = other.err;
			} else {
				messages = [String(other.err)];
			}
		} else {
			klass = "Unknown";
		}

		const title = `Failed to load config file ${id}, ${klass} error:`;
		let message: string;
		switch (messages?.length ?? 0) {
			case 0:
				message = title.slice(0, -1);
				break;
			case 1:
				message = `${title} ${messages![0]}`;
				break;
			default:
				message = `${title}\n${messages!.map(m => `  - ${m}`).join("\n")}`;
				break;
		}

		super(message, { cause });
		this.name = "LoadError";
		this.#message = message;
	}

	get message(): string {
		return this.#message;
	}

	toString(): string {
		return this.message;
	}
}

export type LoadStatus = "ok" | "error" | "not-found";

export type LoadResult<T> =
	| { value?: null; error: ConfigError; status: "error" }
	| { value: T; error?: undefined; status: "ok" }
	| { value?: null; error?: unknown; status: "not-found" };

export class ConfigFile<T> implements IConfigFile<T> {
	readonly #basePath: string;
	#cache?: LoadResult<T>;
	#auxValidate?: (value: T) => void;

	constructor(
		readonly id: string,
		readonly schema: TSchema,
		configPath: string = path.join(getAgentDir(), `${id}.yml`),
	) {
		this.#basePath = configPath;
		if (configPath.endsWith(".yml")) {
			const jsonPath = `${configPath.slice(0, -4)}.json`;
			migrateJsonToYml(jsonPath, configPath);
		} else if (configPath.endsWith(".yaml")) {
			const jsonPath = `${configPath.slice(0, -5)}.json`;
			migrateJsonToYml(jsonPath, configPath);
		} else if (configPath.endsWith(".json") || configPath.endsWith(".jsonc")) {
			// JSON configs are still supported without migration.
		} else {
			throw new Error(`Invalid config file path: ${configPath}`);
		}
	}

	relocate(configPath?: string): ConfigFile<T> {
		if (!configPath || configPath === this.#basePath) return this;
		const result = new ConfigFile<T>(this.id, this.schema, configPath);
		result.#auxValidate = this.#auxValidate;
		return result;
	}

	getMtimeMs(): number | null {
		try {
			return fs.statSync(this.path()).mtimeMs;
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	}

	withValidation(name: string, validate: (value: T) => void): this {
		const prev = this.#auxValidate;
		this.#auxValidate = (value: T) => {
			prev?.(value);
			try {
				validate(value);
			} catch (error) {
				throw new ConfigError(this.id, undefined, { err: error, stage: `Validate(${name})` });
			}
		};
		return this;
	}

	createDefault(): T {
		return Value.Default(this.schema, [], undefined) as T;
	}

	#storeCache(result: LoadResult<T>): LoadResult<T> {
		this.#cache = result;
		return result;
	}

	tryLoad(): LoadResult<T> {
		if (this.#cache) return this.#cache;

		try {
			const content = fs.readFileSync(this.path(), "utf-8").trim();

			let parsed: unknown;
			if (this.#basePath.endsWith(".json") || this.#basePath.endsWith(".jsonc")) {
				parsed = JSONC.parse(content);
			} else if (this.#basePath.endsWith(".yml") || this.#basePath.endsWith(".yaml")) {
				parsed = YAML.parse(content);
			} else {
				throw new Error(`Invalid config file path: ${this.#basePath}`);
			}

			if (!Value.Check(this.schema, parsed)) {
				const schemaErrors: ErrorObject[] = [];
				for (const err of Value.Errors(this.schema, parsed)) {
					schemaErrors.push({ instancePath: err.path, message: err.message } as ErrorObject);
					if (schemaErrors.length >= 50) break;
				}
				const error = new ConfigError(this.id, schemaErrors);
				logger.warn("Failed to parse config file", { path: this.path(), error });
				return this.#storeCache({ error, status: "error" });
			}
			return this.#storeCache({ value: parsed as T, status: "ok" });
		} catch (error) {
			if (isEnoent(error)) {
				return this.#storeCache({ status: "not-found" });
			}
			logger.warn("Failed to parse config file", { path: this.path(), error });
			return this.#storeCache({
				error: new ConfigError(this.id, undefined, { err: error, stage: "Unexpected" }),
				status: "error",
			});
		}
	}

	load(): T | null {
		return this.tryLoad().value ?? null;
	}

	loadOrDefault(): T {
		return this.tryLoad().value ?? this.createDefault();
	}

	path(): string {
		return this.#basePath;
	}

	invalidate() {
		this.#cache = undefined;
	}
}
