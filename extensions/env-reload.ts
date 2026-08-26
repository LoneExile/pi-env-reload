import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Environment = Record<string, string | undefined>;

type EnvState = {
	processValue: string | undefined;
	ompValue: string | undefined;
};

type ExtensionContext = {
	cwd: string;
	hasUI: boolean;
	modelRegistry: {
		reapplyModelPolicies(): Promise<void>;
	};
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	waitForIdle(): Promise<void>;
};

type ExtensionAPI = {
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler(args: string, ctx: ExtensionContext): Promise<void>;
		},
	): void;
};

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function resolveOmpEnv(): Environment {
	const global = globalThis as typeof globalThis & { Bun?: { env?: Environment } };
	if (!("Bun" in global)) return process.env;
	const bun = global.Bun;
	if (!bun || !bun.env) return process.env;
	return bun.env;
}

const ompEnv = resolveOmpEnv();

function parseEnvFile(filePath: string): Record<string, string> {
	const values: Record<string, string> = {};
	const content = readFileSync(filePath, "utf8");

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf("=");
		if (separator === -1) continue;

		let key = trimmed.slice(0, separator).trim();
		const exported = key.match(/^export[ \t]+(.*)$/);
		if (exported) key = exported[1].trim();
		if (!ENV_NAME_RE.test(key)) continue;

		const raw = trimmed.slice(separator + 1).replace(/^[ \t]+/, "");
		const quote = raw[0];
		if (quote === '"' || quote === "'" || quote === "`") {
			let close = raw.indexOf(quote, 1);
			while (close !== -1 && raw[close - 1] === "\\") close = raw.indexOf(quote, close + 1);
			const value = close === -1 ? raw.slice(1) : raw.slice(1, close);
			if (!value.includes("\0")) values[key] = value;
			continue;
		}

		const comment = raw.search(/[ \t]#/);
		const value = (comment === -1 ? raw : raw.slice(0, comment)).trimEnd();
		if (!value.includes("\0")) values[key] = value;
	}

	for (const key of Object.keys(values)) {
		if (key.startsWith("OMP_")) values[`PI_${key.slice(4)}`] = values[key];
	}
	return values;
}

function getConfigRootDir(): string {
	const home = process.env.HOME ?? homedir();
	const root = join(home, process.env.PI_CONFIG_DIR || ".omp");
	const profile = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE)?.trim();
	return profile && profile !== "default" ? join(root, "profiles", profile) : root;
}

function setLiveEnv(key: string, value: string): void {
	process.env[key] = value;
	const global = globalThis as typeof globalThis & { Bun?: { env?: Environment } };
	if (global.Bun?.env) global.Bun.env[key] = value;
}

function restoreLiveEnv(key: string, state: EnvState): void {
	if (state.processValue === undefined) delete process.env[key];
	else process.env[key] = state.processValue;
	const global = globalThis as typeof globalThis & { Bun?: { env?: Environment } };
	if (global.Bun?.env) {
		if (state.ompValue === undefined) delete global.Bun.env[key];
		else global.Bun.env[key] = state.ompValue;
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("env-reload", {
		description: "Reload ~/.omp/.env into the active session",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const envPath = join(getConfigRootDir(), ".env");
			let values: Record<string, string>;
			try {
				values = parseEnvFile(envPath);
			} catch {
				ctx.ui.notify("Cannot reload ~/.omp/.env: file is missing or unreadable", "error");
				return;
			}

			const previous = new Map<string, EnvState>();
			for (const key of Object.keys(values)) {
				previous.set(key, {
					processValue: process.env[key],
					ompValue: ompEnv[key],
				});
			}
			for (const [key, value] of Object.entries(values)) setLiveEnv(key, value);

			try {
				await ctx.modelRegistry.reapplyModelPolicies();
			} catch {
				for (const [key, state] of previous) restoreLiveEnv(key, state);
				ctx.ui.notify("Cannot reload ~/.omp/.env: model configuration was not rebuilt", "error");
				return;
			}

			ctx.ui.notify("Reloaded ~/.omp/.env", "info");
		},
	});
}
