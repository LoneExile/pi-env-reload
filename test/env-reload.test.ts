import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("../extensions/env-reload.ts", import.meta.url));

function createEnvFixture(content: string): string {
  const home = mkdtempSync(join(tmpdir(), "pi-env-reload-test-"));
  mkdirSync(join(home, ".omp"), { recursive: true });
  writeFileSync(join(home, ".omp", ".env"), content);
  return home;
}

function createPi() {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
  return {
    commands,
    handlers,
    api: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, options);
      },
      on(event: string, handler: (event: unknown, ctx: unknown) => void) {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      },
    },
    fire(event: string, ctx: unknown) {
      for (const handler of handlers.get(event) ?? []) handler({}, ctx);
    },
  };
}

type Notification = { message: string; type?: string };

// Mirrors the session context passed to `pi.on(...)` handlers. `managedTimers`
// picks the harness: OMP exposes ctx.setInterval/ctx.clearTimer, Pi does not.
function createSession(options: { idle?: boolean; managedTimers?: boolean } = {}) {
  let idle = options.idle ?? true;
  let rebuilds = 0;
  const scheduled: Array<{ callback: () => Promise<void> | void; ms: number }> = [];
  const cleared: unknown[] = [];
  const notifications: Notification[] = [];
  const ctx: Record<string, unknown> = {
    isIdle: () => idle,
    waitForIdle: async () => {},
    modelRegistry: {
      reapplyModelPolicies: async () => {
        rebuilds += 1;
      },
    },
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  };
  if (options.managedTimers !== false) {
    ctx.setInterval = (callback: () => Promise<void> | void, ms: number) => {
      scheduled.push({ callback, ms });
      return { managed: scheduled.length };
    };
    ctx.clearTimer = (handle: unknown) => {
      cleared.push(handle);
    };
  }
  return {
    ctx,
    scheduled,
    cleared,
    notifications,
    rebuildCount: () => rebuilds,
    setIdle(value: boolean) {
      idle = value;
    },
  };
}

type LiveEnv = Record<string, string | undefined>;

function setupEnv(fixture: string, key: string, aliasKey: string | null): { liveEnv: LiveEnv; keys: string[]; fixtureHome: string } {
  const fixtureHome = createEnvFixture(fixture);
  const liveEnv = process.env as LiveEnv;
  const keys = [key, ...(aliasKey ? [aliasKey] : []), "SECOND_KEY", "HOME"];
  const previous = new Map<string, string | undefined>();
  for (const name of keys) previous.set(name, liveEnv[name]);
  liveEnv.HOME = fixtureHome;
  liveEnv[key] = "old-value";
  if (aliasKey) liveEnv[aliasKey] = "old-alias";
  delete liveEnv.SECOND_KEY;
  return { liveEnv, keys, fixtureHome };
}

function restoreEnv(liveEnv: LiveEnv, keys: string[], previous: Map<string, string | undefined>): void {
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete liveEnv[key];
    else liveEnv[key] = value;
  }
}

describe("env-reload extension", () => {
  test("registers the env-reload command", async () => {
    const { api, commands } = createPi();
    const module = await import(extensionPath);
    module.default(api);
    expect(commands.has("env-reload")).toBe(true);
  });

  test("uses OMP reapplyModelPolicies when present", async () => {
    const fixture = "OMP_TEST_RELOAD_KEY=new-value\nSECOND_KEY=another-value\n";
    const { liveEnv, keys } = setupEnv(fixture, "OMP_TEST_RELOAD_KEY", "PI_TEST_RELOAD_KEY");
    const previous = new Map<string, string | undefined>();
    for (const key of keys) previous.set(key, liveEnv[key]);
    const { api, commands } = createPi();
    const module = await import(extensionPath);
    module.default(api);
    const events: string[] = [];
    const notifications: Array<{ message: string; type?: string }> = [];
    try {
      await commands.get("env-reload")?.handler("", {
        waitForIdle: async () => { events.push("idle"); },
        modelRegistry: {
          reapplyModelPolicies: async () => {
            events.push("omp-rebuild");
            expect(liveEnv.OMP_TEST_RELOAD_KEY).toBe("new-value");
            expect(liveEnv.PI_TEST_RELOAD_KEY).toBe("new-value");
          },
          refresh: async () => { events.push("pi-refresh"); },
        },
        ui: { notify(message: string, type?: string) { notifications.push({ message, type }); } },
      });
      expect(events).toEqual(["idle", "omp-rebuild"]);
      expect(liveEnv.SECOND_KEY).toBe("another-value");
      expect(notifications).toEqual([{ message: `Reloaded ${join(liveEnv.HOME, ".omp", ".env")}`, type: "info" }]);
    } finally {
      restoreEnv(liveEnv, keys, previous);
    }
  });

  test("uses Pi refresh when reapplyModelPolicies is absent", async () => {
    const fixture = "PI_TEST_RELOAD_KEY=new-value\nSECOND_KEY=another-value\n";
    const { liveEnv, keys } = setupEnv(fixture, "PI_TEST_RELOAD_KEY", null);
    const previous = new Map<string, string | undefined>();
    for (const key of keys) previous.set(key, liveEnv[key]);
    const { api, commands } = createPi();
    const module = await import(extensionPath);
    module.default(api);
    const events: string[] = [];
    const notifications: Array<{ message: string; type?: string }> = [];
    try {
      await commands.get("env-reload")?.handler("", {
        waitForIdle: async () => { events.push("idle"); },
        modelRegistry: {
          refresh: async (options?: { force?: boolean }) => {
            events.push(`pi-refresh-force=${options?.force === true}`);
            expect(liveEnv.PI_TEST_RELOAD_KEY).toBe("new-value");
          },
        },
        ui: { notify(message: string, type?: string) { notifications.push({ message, type }); } },
      });
      expect(events).toEqual(["idle", "pi-refresh-force=true"]);
      expect(liveEnv.SECOND_KEY).toBe("another-value");
      expect(notifications).toEqual([{ message: `Reloaded ${join(liveEnv.HOME, ".omp", ".env")}`, type: "info" }]);
    } finally {
      restoreEnv(liveEnv, keys, previous);
    }
  });

  test("honors PI_ENV_RELOAD_CONFIG_DIR override (Pi path)", async () => {
    const fixtureHome = createEnvFixture("PI_TEST_RELOAD_KEY=new-value\nSECOND_KEY=another-value\n");
    const liveEnv = process.env as LiveEnv;
    const previous = new Map<string, string | undefined>();
    const keys = ["PI_TEST_RELOAD_KEY", "SECOND_KEY", "HOME", "PI_ENV_RELOAD_CONFIG_DIR"];
    for (const key of keys) previous.set(key, liveEnv[key]);
    const piAgent = join(fixtureHome, ".pi", "agent");
    mkdirSync(piAgent, { recursive: true });
    writeFileSync(join(piAgent, ".env"), "PI_TEST_RELOAD_KEY=new-value\nSECOND_KEY=another-value\n");
    liveEnv.HOME = fixtureHome;
    liveEnv.PI_ENV_RELOAD_CONFIG_DIR = piAgent;
    liveEnv.PI_TEST_RELOAD_KEY = "old-value";
    delete liveEnv.SECOND_KEY;
    const { api, commands } = createPi();
    const module = await import(extensionPath);
    module.default(api);
    const notifications: Array<{ message: string; type?: string }> = [];
    try {
      await commands.get("env-reload")?.handler("", {
        waitForIdle: async () => {},
        modelRegistry: {
          refresh: async () => {},
        },
        ui: { notify(message: string, type?: string) { notifications.push({ message, type }); } },
      });
      expect(liveEnv.PI_TEST_RELOAD_KEY).toBe("new-value");
      expect(liveEnv.SECOND_KEY).toBe("another-value");
      expect(notifications).toEqual([{ message: `Reloaded ${piAgent}/.env`, type: "info" }]);
    } finally {
      restoreEnv(liveEnv, keys, previous);
    }
  });

  test("fails without mutating env when no model-rebuild API exists", async () => {
    const fixture = "ONLY_KEY=new-value\n";
    const { liveEnv, keys, fixtureHome } = setupEnv(fixture, "ONLY_KEY", null);
    const previous = new Map<string, string | undefined>();
    for (const key of keys) previous.set(key, liveEnv[key]);
    const { api, commands } = createPi();
    const module = await import(extensionPath);
    module.default(api);
    const notifications: Array<{ message: string; type?: string }> = [];
    try {
      await commands.get("env-reload")?.handler("", {
        waitForIdle: async () => {},
        modelRegistry: {},
        ui: { notify(message: string, type?: string) { notifications.push({ message, type }); } },
      });
      expect(liveEnv.ONLY_KEY).toBe("old-value");
      expect(notifications).toEqual([{ message: `Cannot reload ${join(fixtureHome, ".omp", ".env")}: model configuration was not rebuilt`, type: "error" }]);
    } finally {
      restoreEnv(liveEnv, keys, previous);
    }
  });
});

const AUTO_ENV_KEYS = [
  "HOME",
  "PI_ENV_RELOAD_AUTO",
  "PI_ENV_RELOAD_CONFIG_DIR",
  "PI_CONFIG_DIR",
  "OMP_PROFILE",
  "PI_PROFILE",
  "AUTO_TEST_KEY",
];

function setupAuto(auto: string | undefined, content = "AUTO_TEST_KEY=old-value\n") {
  const fixtureHome = createEnvFixture(content);
  const liveEnv = process.env as LiveEnv;
  const previous = new Map<string, string | undefined>();
  for (const key of AUTO_ENV_KEYS) previous.set(key, liveEnv[key]);
  for (const key of ["PI_ENV_RELOAD_CONFIG_DIR", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE"]) delete liveEnv[key];
  liveEnv.HOME = fixtureHome;
  liveEnv.AUTO_TEST_KEY = "old-value";
  if (auto === undefined) delete liveEnv.PI_ENV_RELOAD_AUTO;
  else liveEnv.PI_ENV_RELOAD_AUTO = auto;
  return {
    liveEnv,
    envPath: join(fixtureHome, ".omp", ".env"),
    restore: () => restoreEnv(liveEnv, AUTO_ENV_KEYS, previous),
  };
}

async function loadExtension(api: unknown): Promise<void> {
  const module = await import(extensionPath);
  module.default(api);
}

describe("env-reload auto reload", () => {
  test("schedules nothing when PI_ENV_RELOAD_AUTO is unset", async () => {
    const fixture = setupAuto(undefined);
    const { api, fire } = createPi();
    const session = createSession();
    try {
      await loadExtension(api);
      fire("session_start", session.ctx);
      expect(session.scheduled).toEqual([]);
      expect(session.notifications).toEqual([]);
    } finally {
      fixture.restore();
    }
  });

  test("schedules on the configured interval", async () => {
    const fixture = setupAuto("5m");
    const { api, fire } = createPi();
    const session = createSession();
    try {
      await loadExtension(api);
      fire("session_start", session.ctx);
      expect(session.scheduled.map((entry) => entry.ms)).toEqual([300_000]);
      expect(session.notifications).toEqual([]);
    } finally {
      fixture.restore();
    }
  });

  test("reads a bare interval as seconds", async () => {
    const fixture = setupAuto("90");
    const { api, fire } = createPi();
    const session = createSession();
    try {
      await loadExtension(api);
      fire("session_start", session.ctx);
      expect(session.scheduled.map((entry) => entry.ms)).toEqual([90_000]);
    } finally {
      fixture.restore();
    }
  });

  test("clamps an interval below the floor and warns", async () => {
    const fixture = setupAuto("5s");
    const { api, fire } = createPi();
    const session = createSession();
    try {
      await loadExtension(api);
      fire("session_start", session.ctx);
      expect(session.scheduled.map((entry) => entry.ms)).toEqual([30_000]);
      expect(session.notifications).toEqual([
        { message: "PI_ENV_RELOAD_AUTO=5s is below the 30s minimum; using 30s", type: "warning" },
      ]);
    } finally {
      fixture.restore();
    }
  });

  test("warns and schedules nothing for an unparseable interval", async () => {
    const fixture = setupAuto("soon");
    const { api, fire } = createPi();
    const session = createSession();
    try {
      await loadExtension(api);
      fire("session_start", session.ctx);
      expect(session.scheduled).toEqual([]);
      expect(session.notifications).toEqual([
        {
          message: "Ignoring PI_ENV_RELOAD_AUTO=soon: expected a duration such as 5m, 30s, or off",
          type: "warning",
        },
      ]);
    } finally {
      fixture.restore();
    }
  });

  test("treats off as disabled without warning", async () => {
    const fixture = setupAuto("off");
    const { api, fire } = createPi();
    const session = createSession();
    try {
      await loadExtension(api);
      fire("session_start", session.ctx);
      expect(session.scheduled).toEqual([]);
      expect(session.notifications).toEqual([]);
    } finally {
      fixture.restore();
    }
  });

  test("leaves an unchanged dotenv file alone", async () => {
    const fixture = setupAuto("5m");
    const { api, fire } = createPi();
    const session = createSession();
    try {
      await loadExtension(api);
      fire("session_start", session.ctx);
      await session.scheduled[0].callback();
      expect(session.rebuildCount()).toBe(0);
      expect(session.notifications).toEqual([]);
      expect(fixture.liveEnv.AUTO_TEST_KEY).toBe("old-value");
    } finally {
      fixture.restore();
    }
  });

  test("applies a changed dotenv file and names the auto reload", async () => {
    const fixture = setupAuto("5m");
    const { api, fire } = createPi();
    const session = createSession();
    try {
      await loadExtension(api);
      fire("session_start", session.ctx);
      writeFileSync(fixture.envPath, "AUTO_TEST_KEY=rotated-value\n");
      await session.scheduled[0].callback();
      expect(fixture.liveEnv.AUTO_TEST_KEY).toBe("rotated-value");
      expect(session.rebuildCount()).toBe(1);
      expect(session.notifications).toEqual([{ message: `Reloaded ${fixture.envPath} (auto)`, type: "info" }]);
      // A second tick over the now-applied file must not rebuild again.
      await session.scheduled[0].callback();
      expect(session.rebuildCount()).toBe(1);
    } finally {
      fixture.restore();
    }
  });

  test("skips while the agent is streaming, then applies once idle", async () => {
    const fixture = setupAuto("5m");
    const { api, fire } = createPi();
    const session = createSession({ idle: false });
    try {
      await loadExtension(api);
      fire("session_start", session.ctx);
      writeFileSync(fixture.envPath, "AUTO_TEST_KEY=rotated-value\n");
      await session.scheduled[0].callback();
      expect(fixture.liveEnv.AUTO_TEST_KEY).toBe("old-value");
      expect(session.rebuildCount()).toBe(0);
      session.setIdle(true);
      await session.scheduled[0].callback();
      expect(fixture.liveEnv.AUTO_TEST_KEY).toBe("rotated-value");
      expect(session.rebuildCount()).toBe(1);
    } finally {
      fixture.restore();
    }
  });

  test("falls back to a raw unref'd timer and clears it on shutdown (Pi)", async () => {
    const fixture = setupAuto("30s");
    const { api, fire } = createPi();
    const session = createSession({ managedTimers: false });
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const raw: Array<{ handle: { unref(): void }; ms: number; unrefs: number }> = [];
    const cleared: unknown[] = [];
    try {
      await loadExtension(api);
      globalThis.setInterval = ((_callback: () => void, ms: number) => {
        const entry = { handle: { unref: () => { entry.unrefs += 1; } }, ms, unrefs: 0 };
        raw.push(entry);
        return entry.handle;
      }) as unknown as typeof globalThis.setInterval;
      globalThis.clearInterval = ((handle: unknown) => {
        cleared.push(handle);
      }) as unknown as typeof globalThis.clearInterval;
      fire("session_start", session.ctx);
      fire("session_shutdown", session.ctx);
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      fixture.restore();
    }
    expect(raw.map((entry) => entry.ms)).toEqual([30_000]);
    expect(raw[0].unrefs).toBe(1);
    expect(cleared).toEqual([raw[0].handle]);
    expect(session.cleared).toEqual([]);
  });

  test("clears a managed timer on shutdown", async () => {
    const fixture = setupAuto("5m");
    const { api, fire } = createPi();
    const session = createSession();
    try {
      await loadExtension(api);
      fire("session_start", session.ctx);
      fire("session_shutdown", session.ctx);
      expect(session.cleared).toEqual([{ managed: 1 }]);
    } finally {
      fixture.restore();
    }
  });

  test("manual reload rebaselines the auto watcher", async () => {
    const fixture = setupAuto("5m");
    const { api, fire, commands } = createPi();
    const session = createSession();
    try {
      await loadExtension(api);
      fire("session_start", session.ctx);
      writeFileSync(fixture.envPath, "AUTO_TEST_KEY=rotated-value\n");
      await commands.get("env-reload")?.handler("", session.ctx);
      expect(fixture.liveEnv.AUTO_TEST_KEY).toBe("rotated-value");
      expect(session.rebuildCount()).toBe(1);
      await session.scheduled[0].callback();
      expect(session.rebuildCount()).toBe(1);
      expect(session.notifications).toEqual([{ message: `Reloaded ${fixture.envPath}`, type: "info" }]);
    } finally {
      fixture.restore();
    }
  });
});
