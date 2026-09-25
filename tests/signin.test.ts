/**
 * A refused sign-in: renewed once without the user when possible, otherwise reported with what
 * to do. The browser renewal itself is stubbed here; tests/browser.test.ts runs the real one.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { AuthRequired } from "../src/notebook/client.js";
import { loadSession, saveSession } from "../src/notebook/session.js";
import { Store } from "../src/store.js";
import { syncCloud } from "../src/sync.js";
import { startFakeAmazon, type FakeAmazon } from "./helpers/fake-amazon.js";

let amazon: FakeAmazon;
beforeAll(async () => {
  amazon = await startFakeAmazon();
});
afterAll(() => amazon.close());

const cookie = (value: string) => [{ name: "session-id", value, domain: "127.0.0.1", path: "/", expires: -1 }];

function setup(saved: string | null): { cfg: Config; store: Store } {
  const home = mkdtempSync(join(tmpdir(), "kindle-signin-"));
  const cfg = loadConfig({ KINDLE_MCP_HOME: home, KINDLE_NOTEBOOK_BASE: amazon.base, KINDLE_REQUEST_DELAY: "0" });
  if (saved) saveSession(cfg.sessionPath, { savedAt: "2026-09-20T08:00:00.000Z", cookies: cookie(saved) });
  return { cfg, store: new Store(cfg.dbPath) };
}

/** A stand-in for the browser renewal: records its calls and, if told to, saves working cookies. */
function renewal(works: boolean) {
  const calls: number[] = [];
  const refresh = async (cfg: Config, timeoutMs: number): Promise<boolean> => {
    calls.push(timeoutMs);
    if (works) saveSession(cfg.sessionPath, { savedAt: "2026-09-25T09:00:00.000Z", signedInAt: "2026-09-25T09:00:00.000Z", cookies: cookie("abc") });
    return works;
  };
  return { calls, refresh };
}

describe("a refused sign-in", () => {
  it("is renewed once without the user, and the sync carries on", async () => {
    const { cfg, store } = setup("stale");
    const { calls, refresh } = renewal(true);
    const stats = await syncCloud(cfg, store, { log: () => {}, refresh, deadline: Date.now() + 40_000 });
    expect(stats).toMatchObject({ books_seen: 2, highlights_new: 3, session_refreshed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(0);
    expect(calls[0]).toBeLessThanOrEqual(20_000);
    const session = loadSession(cfg.sessionPath)!;
    expect(session.signedInAt).toBe("2026-09-25T09:00:00.000Z"); // kept through the cookie write-back
    expect(session.cookies.some((c) => c.name === "session-token" && c.value === "rotated")).toBe(true);
    store.close();
  });

  it("is reported with the date and what to do when renewal fails, and the saved cookies are left alone", async () => {
    const { cfg, store } = setup("stale");
    const before = readFileSync(cfg.sessionPath, "utf8");
    const { calls, refresh } = renewal(false);
    const err = await syncCloud(cfg, store, { log: () => {}, refresh }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthRequired);
    expect((err as AuthRequired).reason).toBe("expired");
    expect((err as Error).message).toMatch(/the saved sign-in is from 2026-09-2\d/);
    expect((err as Error).message).toMatch(/Sign me in to Kindle.*Keep me signed in.*kindle-mcp login/);
    expect(calls).toHaveLength(1);
    expect(readFileSync(cfg.sessionPath, "utf8")).toBe(before); // the refusal's cookie-clearing reply was not saved
    expect(store.status().last_run?.error).toMatch(/Amazon wants you to sign in again/);
    store.close();
  });

  it("is tried only once even when the renewal claims success", async () => {
    const { cfg, store } = setup("stale");
    const calls: number[] = [];
    const refresh = async (_cfg: Config, t: number): Promise<boolean> => (calls.push(t), true); // but saves nothing
    await expect(syncCloud(cfg, store, { log: () => {}, refresh })).rejects.toBeInstanceOf(AuthRequired);
    expect(calls).toHaveLength(1);
    store.close();
  });

  it("with nothing saved, says so and where it looked, without trying a renewal", async () => {
    const { cfg, store } = setup(null);
    const { calls, refresh } = renewal(true);
    const err = await syncCloud(cfg, store, { log: () => {}, refresh }).catch((e: unknown) => e);
    expect((err as AuthRequired).reason).toBe("missing");
    expect((err as Error).message).toContain(`No Amazon sign-in is saved yet (looked in ${cfg.home})`);
    expect(calls).toHaveLength(0);
    store.close();
  });

  it("isn't renewed when too little of the budget is left to finish", async () => {
    const { cfg, store } = setup("stale");
    const { calls, refresh } = renewal(true);
    await expect(syncCloud(cfg, store, { log: () => {}, refresh, deadline: Date.now() + 5_000 })).rejects.toBeInstanceOf(AuthRequired);
    expect(calls).toHaveLength(0);
    store.close();
  });
});
