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
  return {
    commands,
    api: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, options);
      },
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
