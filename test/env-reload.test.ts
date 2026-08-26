import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("../extensions/env-reload.ts", import.meta.url));

// Keys the fixture declares, plus the PI_ mirrors the extension derives from
// OMP_ entries. Every one of them must be snapshot/restored around the test.
function touchedKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) continue;
    keys.push(match[1]!);
    if (match[1]!.startsWith("OMP_")) keys.push(`PI_${match[1]!.slice(4)}`);
  }
  return keys;
}

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
    const fixture = "OMP_TEST_RELOAD_KEY=new-value\nSECOND_KEY=another-value\n";
    const fixtureHome = createEnvFixture(fixture);
    const liveEnv = process.env as Record<string, string | undefined>;
    const previous = new Map<string, string | undefined>();
    const keys = [...touchedKeys(fixture), "HOME"];
    for (const key of keys) previous.set(key, liveEnv[key]);

    liveEnv.HOME = fixtureHome;
    liveEnv.OMP_TEST_RELOAD_KEY = "old-value";
    liveEnv.PI_TEST_RELOAD_KEY = "old-omp-alias";
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
          expect(liveEnv.OMP_TEST_RELOAD_KEY).toBe("old-value");
        },
        modelRegistry: {
          reapplyModelPolicies: async () => {
            events.push("rebuild");
            expect(liveEnv.OMP_TEST_RELOAD_KEY).toBe("new-value");
            expect(liveEnv.PI_TEST_RELOAD_KEY).toBe("new-value");
          },
        },
        ui: { notify(message: string, type?: string) { notifications.push({ message, type }); } },
      });
      expect(events).toEqual(["idle", "rebuild"]);
      expect(liveEnv.OMP_TEST_RELOAD_KEY).toBe("new-value");
      expect(liveEnv.PI_TEST_RELOAD_KEY).toBe("new-value");
      expect(liveEnv.SECOND_KEY).toBe("another-value");
      expect(notifications).toEqual([{ message: "Reloaded ~/.omp/.env", type: "info" }]);
      expect(notifications[0]?.message).not.toContain("new-value");
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete liveEnv[key];
        else liveEnv[key] = value;
      }
    }
  });
});
