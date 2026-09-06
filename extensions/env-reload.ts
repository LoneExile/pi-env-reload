import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Environment = Record<string, string | undefined>;

type EnvState = {
	processValue: string | undefined;
	ompValue: string | undefined;
};

type ModelRegistry = {
	reapplyModelPolicies?(): Promise<void>;
	refresh?(options?: { force?: boolean; signal?: AbortSignal }): Promise<unknown>;
};

type ExtensionUI = {
	notify(message: string, type?: "info" | "warning" | "error"): void;
};

/**
 * The slice of the harness context a reload needs. Both the command context
 * and the session context handed to `pi.on(...)` handlers satisfy it.
 */
type ReloadContext = {
	modelRegistry: ModelRegistry;
	ui: ExtensionUI;
};

type ExtensionCommandContext = ReloadContext & {
	cwd: string;
	hasUI: boolean;
	waitForIdle(): Promise<void>;
};

/**
 * Context passed to `pi.on(...)` handlers. OMP exposes managed timers here —
 * unref'd, throws contained, cleared on `session_shutdown`. Pi does not, so
 * `setInterval`/`clearTimer` are optional and we fall back to raw timers.
 */
type ExtensionSessionContext = ReloadContext & {
	isIdle?(): boolean;
	setInterval?(callback: () => Promise<void> | void, ms: number): unknown;
	clearTimer?(timer: unknown): void;
};

type ExtensionAPI = {
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
		},
	): void;
	on?(
		event: "session_start" | "session_shutdown",
		handler: (event: unknown, ctx: ExtensionSessionContext) => void,
	): void;
};

type AutoTimer = { kind: "managed"; handle: unknown } | { kind: "raw"; handle: NodeJS.Timeout };

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AUTO_INTERVAL_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/;
const AUTO_DISABLED: Record<string, true> = { "": true, "0": true, off: true, no: true, false: true };
const AUTO_UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const MIN_AUTO_INTERVAL_MS = 30_000;

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

// PI_ENV_RELOAD_CONFIG_DIR overrides the config root that holds the .env
// file. OMP defaults to ~/.omp, Pi to ~/.pi/agent; set it explicitly when the
// file lives somewhere else (Pi users: PI_ENV_RELOAD_CONFIG_DIR=$HOME/.pi/agent).
function getConfigRootDir(): string {
	const override = process.env.PI_ENV_RELOAD_CONFIG_DIR;
	if (override && override.length > 0) return override;
	const home = process.env.HOME ?? homedir();
	const root = join(home, process.env.PI_CONFIG_DIR || ".omp");
	const profile = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE)?.trim();
	return profile && profile !== "default" ? join(root, "profiles", profile) : root;
}

function getEnvPath(): string {
	return join(getConfigRootDir(), ".env");
}

/**
 * Cheap change detector for the auto reload: mtime plus size, so an unchanged
 * file costs one stat and nothing else. `null` means the file is unreadable.
 */
function fileSignature(filePath: string): string | null {
	try {
		const stats = statSync(filePath);
		return `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return null;
	}
}

/** A bare number means seconds: `300`, `5m`, `30s`, `1h`, or `off`. */
function parseAutoInterval(raw: string | undefined): number | "disabled" | "invalid" {
	if (raw === undefined) return "disabled";
	const value = raw.trim().toLowerCase();
	if (AUTO_DISABLED[value]) return "disabled";
	const match = value.match(AUTO_INTERVAL_RE);
	if (!match) return "invalid";
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return "invalid";
	return amount * AUTO_UNIT_MS[match[2] ?? "s"];
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
	// Signature of the dotenv file as last applied (or last attempted) by this
	// extension. The auto reload compares against it, so an unchanged file
	// means no parse, no registry rebuild, and no notification.
	let appliedSignature: string | null = null;
	let autoTimer: AutoTimer | null = null;
	let reloading = false;

	async function reload(ctx: ReloadContext, options: { notifyUnreadable: boolean; label: string }): Promise<void> {
		const envPath = getEnvPath();
		const signature = fileSignature(envPath);

		let values: Record<string, string>;
		try {
			values = parseEnvFile(envPath);
		} catch {
			if (options.notifyUnreadable) {
				ctx.ui.notify(`Cannot reload ${envPath}: file is missing or unreadable`, "error");
			}
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
			const registry = ctx.modelRegistry;
			if (typeof registry.reapplyModelPolicies === "function") {
				await registry.reapplyModelPolicies();
			} else if (typeof registry.refresh === "function") {
				await registry.refresh({ force: true });
			} else {
				throw new Error("no supported model-rebuild API");
			}
		} catch {
			for (const [key, state] of previous) restoreLiveEnv(key, state);
			// Record the failed signature too: a broken file or registry must
			// not make the timer retry — and re-notify — on every tick.
			// `/env-reload` stays available to retry explicitly.
			appliedSignature = signature;
			ctx.ui.notify(`Cannot reload ${envPath}: model configuration was not rebuilt`, "error");
			return;
		}

		appliedSignature = signature;
		ctx.ui.notify(`Reloaded ${envPath}${options.label}`, "info");
	}

	async function tick(ctx: ExtensionSessionContext): Promise<void> {
		if (reloading) return;
		// Never mutate the environment or rebuild the registry mid-stream. The
		// next tick picks the change up once the agent is idle again.
		if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
		const signature = fileSignature(getEnvPath());
		if (signature === null || signature === appliedSignature) return;
		reloading = true;
		try {
			await reload(ctx, { notifyUnreadable: false, label: " (auto)" });
		} finally {
			reloading = false;
		}
	}

	function stopAuto(ctx: ExtensionSessionContext): void {
		if (!autoTimer) return;
		if (autoTimer.kind === "raw") clearInterval(autoTimer.handle);
		else if (typeof ctx.clearTimer === "function") ctx.clearTimer(autoTimer.handle);
		autoTimer = null;
	}

	function startAuto(ctx: ExtensionSessionContext): void {
		stopAuto(ctx);

		const raw = process.env.PI_ENV_RELOAD_AUTO;
		const interval = parseAutoInterval(raw);
		if (interval === "disabled") return;
		if (interval === "invalid") {
			ctx.ui.notify(
				`Ignoring PI_ENV_RELOAD_AUTO=${raw}: expected a duration such as 5m, 30s, or off`,
				"warning",
			);
			return;
		}

		let intervalMs = interval;
		if (intervalMs < MIN_AUTO_INTERVAL_MS) {
			const floorSeconds = MIN_AUTO_INTERVAL_MS / 1000;
			ctx.ui.notify(
				`PI_ENV_RELOAD_AUTO=${raw} is below the ${floorSeconds}s minimum; using ${floorSeconds}s`,
				"warning",
			);
			intervalMs = MIN_AUTO_INTERVAL_MS;
		}

		// The file the process already loaded at startup is the baseline: only
		// a later change to it triggers a reload.
		appliedSignature = fileSignature(getEnvPath());

		const callback = () => tick(ctx);
		if (typeof ctx.setInterval === "function") {
			autoTimer = { kind: "managed", handle: ctx.setInterval(callback, intervalMs) };
			return;
		}

		// Pi has no managed timers: keep the handle unref'd so it never holds
		// the process open, and clear it on session_shutdown.
		const handle = setInterval(() => {
			void callback().catch(() => {});
		}, intervalMs);
		if (typeof handle === "object" && "unref" in handle) handle.unref();
		autoTimer = { kind: "raw", handle };
	}

	pi.registerCommand("env-reload", {
		description: "Reload the dotenv file into the active session",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await reload(ctx, { notifyUnreadable: true, label: "" });
		},
	});

	pi.on?.("session_start", (_event, ctx) => {
		startAuto(ctx);
	});
	pi.on?.("session_shutdown", (_event, ctx) => {
		stopAuto(ctx);
	});
}
