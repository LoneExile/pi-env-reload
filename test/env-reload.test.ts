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

describe("env-reload extension", () => {
  test("registers the env-reload command", async () => {
    const { api, commands } = createPi();
    const module = await import(extensionPath);
    module.default(api);
    expect(commands.has("env-reload")).toBe(true);
  });

  test("waits, updates the running env, rebuilds models, and does not expose values", async () => {
    const fixtureHome = createEnvFixture("TEST_RELOAD_KEY=new-value\nSECOND_KEY=another-value\n");
    const previousHome = process.env.HOME;
    const previousKey = process.env.TEST_RELOAD_KEY;
    const previousSecond = process.env.SECOND_KEY;
    const liveEnv = process.env as Record<string, string | undefined>;
    liveEnv.HOME = fixtureHome;
    liveEnv.TEST_RELOAD_KEY = "old-value";
    delete liveEnv.SECOND_KEY;
    const { api, commands } = createPi();
    const module = await import(extensionPath);
    module.default(api);
    const events: string[] = [];
    const notifications: Array<{ message: string; type?: string }> = [];

    try {
      await commands.get("env-reload")?.handler("", {
        waitForIdle: async () => {
          events.push("idle");
          expect(liveEnv.TEST_RELOAD_KEY).toBe("old-value");
        },
        modelRegistry: {
          reapplyModelPolicies: async () => {
            events.push("rebuild");
            expect(liveEnv.TEST_RELOAD_KEY).toBe("new-value");
          },
        },
        ui: { notify(message: string, type?: string) { notifications.push({ message, type }); } },
      });
      expect(events).toEqual(["idle", "rebuild"]);
      expect(liveEnv.TEST_RELOAD_KEY).toBe("new-value");
      expect(liveEnv.SECOND_KEY).toBe("another-value");
      expect(notifications).toEqual([{ message: "Reloaded ~/.omp/.env", type: "info" }]);
      expect(notifications[0]?.message).not.toContain("new-value");
    } finally {
      if (previousHome === undefined) delete liveEnv.HOME;
      else liveEnv.HOME = previousHome;
      if (previousKey === undefined) delete liveEnv.TEST_RELOAD_KEY;
      else liveEnv.TEST_RELOAD_KEY = previousKey;
      if (previousSecond === undefined) delete liveEnv.SECOND_KEY;
      else liveEnv.SECOND_KEY = previousSecond;
    }
  });
});
