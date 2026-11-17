/**
 * Regression tests for how `SessionManager.prepareLogin()` picks between the
 * supplied credentials and a persisted jar.
 *
 * Background: the persisted jar used to win unconditionally whenever it
 * matched the account and passed date-based validation. Server-side session
 * revocation (Facebook 1357004) is invisible to date-based validation, so a
 * re-exported appstate was silently ignored forever and every login reused
 * the dead jar. These tests pin down the fixed selection rules.
 */

import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SerializedCookieJar } from "tough-cookie";
import { CookieStore } from "../src/auth/index.js";
import type { NormalizedCookie } from "../src/auth/index.js";
import { STORAGE_KEYS } from "../src/constants.js";
import { resolveConfig } from "../src/config/index.js";
import { createRootLogger } from "../src/logger/index.js";
import { SessionManager } from "../src/session/index.js";
import { MemoryStorage } from "../src/storage/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const FUTURE = () => Date.now() + 30 * DAY_MS;

function cookie(name: string, value: string, expiresAtMs: number | null = FUTURE()): NormalizedCookie {
  return {
    name,
    value,
    domain: ".facebook.com",
    path: "/",
    expiresAtMs,
    hostOnly: false,
    httpOnly: name === "xs",
    secure: true,
    sameSite: undefined,
  };
}

/** The "old" credential set — what a deployment had been using. */
function staleJarCookies(): readonly NormalizedCookie[] {
  return [
    cookie("c_user", "100000000000001"),
    cookie("xs", "stale-xs-value"),
    cookie("datr", "stale-datr-value"),
    cookie("fr", "stale-fr-value"),
  ];
}

/** The "fresh export" — same account, rotated required cookies. */
function freshJarCookies(): readonly NormalizedCookie[] {
  return [
    cookie("c_user", "100000000000001"),
    cookie("xs", "fresh-xs-value"),
    cookie("datr", "fresh-datr-value"),
    cookie("fr", "fresh-fr-value"),
  ];
}

function appStateJson(cookies: readonly NormalizedCookie[]): Array<Record<string, unknown>> {
  return cookies.map((c) => ({
    key: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    ...(c.expiresAtMs === null ? {} : { expirationDate: Math.floor(c.expiresAtMs / 1000) }),
    hostOnly: c.hostOnly,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }));
}

async function makeManager() {
  const storage = new MemoryStorage();
  const config = resolveConfig({ logLevel: "silent" });
  const logger = createRootLogger({ level: "silent", transports: [] });
  const session = new SessionManager({ config, storage, logger });
  return { session, storage };
}

/** Writes a persisted session document that is date-valid but possibly server-stale. */
async function writePersisted(
  storage: MemoryStorage,
  cookies: readonly NormalizedCookie[],
  savedAt: number,
): Promise<void> {
  const jar = CookieStore.fromCookies(cookies);
  const document = {
    version: 1,
    userId: "100000000000001",
    loginTime: savedAt,
    savedAt,
    lastSeqId: null,
    syncToken: null,
    region: null,
    cookies: jar.toSerialized() as SerializedCookieJar,
  };
  await storage.set(STORAGE_KEYS.session, document);
}

function jarHeader(session: SessionManager): string {
  return session.cookies.headerFor("https://www.facebook.com");
}

describe("prepareLogin cookie-jar selection", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    while (tmpDirs.length > 0) {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("supplied in-memory credentials win when they differ from the persisted jar", async () => {
    const { session, storage } = await makeManager();
    await writePersisted(storage, staleJarCookies(), Date.now() - DAY_MS);

    const prepared = await session.prepareLogin(appStateJson(freshJarCookies()) as never);

    expect(prepared.userId).toBe("100000000000001");
    expect(jarHeader(session)).toContain("xs=fresh-xs-value");
    expect(jarHeader(session)).toContain("datr=fresh-datr-value");
  });

  it("a fresh appstate file wins when its mtime is newer than the last persist", async () => {
    const { session, storage } = await makeManager();
    const savedAt = Date.now() - 10 * DAY_MS;
    await writePersisted(storage, staleJarCookies(), savedAt);

    const dir = mkdtempSync(join(tmpdir(), "panindigan-test-"));
    tmpDirs.push(dir);
    const file = join(dir, "appstate.json");
    writeFileSync(file, JSON.stringify(appStateJson(freshJarCookies())));
    // The export happened after the persisted session was written.
    const now = new Date();
    utimesSync(file, now, now);

    await session.prepareLogin(file);

    expect(jarHeader(session)).toContain("xs=fresh-xs-value");
  });

  it("a file older than the last persist loses to the background-refreshed jar", async () => {
    const { session, storage } = await makeManager();
    const savedAt = Date.now();
    await writePersisted(storage, staleJarCookies(), savedAt);

    const dir = mkdtempSync(join(tmpdir(), "panindigan-test-"));
    tmpDirs.push(dir);
    const file = join(dir, "appstate.json");
    writeFileSync(file, JSON.stringify(appStateJson(freshJarCookies())));
    // The file predates the last persisted refresh — background refresh wins.
    const past = new Date(Date.now() - 10 * DAY_MS);
    utimesSync(file, past, past);

    await session.prepareLogin(file);

    expect(jarHeader(session)).toContain("xs=stale-xs-value");
  });

  it("identical required cookies keep the persisted jar even when other cookies changed", async () => {
    const { session, storage } = await makeManager();
    const persistedCookies = [
      cookie("c_user", "100000000000001"),
      cookie("xs", "same-xs"),
      cookie("datr", "same-datr"),
      cookie("fr", "persisted-fr"),
    ];
    const providedCookies = [
      cookie("c_user", "100000000000001"),
      cookie("xs", "same-xs"),
      cookie("datr", "same-datr"),
      cookie("fr", "supplied-fr"),
    ];
    await writePersisted(storage, persistedCookies, Date.now() - DAY_MS);

    await session.prepareLogin(appStateJson(providedCookies) as never);

    expect(jarHeader(session)).toContain("fr=persisted-fr");
  });

  it("a persisted session for a different account is ignored", async () => {
    const { session, storage } = await makeManager();
    const jar = CookieStore.fromCookies(staleJarCookies());
    await storage.set(STORAGE_KEYS.session, {
      version: 1,
      userId: "999999999999999",
      loginTime: Date.now() - DAY_MS,
      savedAt: Date.now() - DAY_MS,
      lastSeqId: null,
      syncToken: null,
      region: null,
      cookies: jar.toSerialized() as SerializedCookieJar,
    });

    await session.prepareLogin(appStateJson(freshJarCookies()) as never);

    expect(jarHeader(session)).toContain("xs=fresh-xs-value");
  });

  it("a persisted session with revoked-date-valid cookies still yields to a fresh file export", async () => {
    // The deployment scenario: dates unexpired, server said no (1357004).
    // User re-exports; the new file must be picked up on the next boot.
    const { session, storage } = await makeManager();
    const savedAt = Date.now() - 10 * DAY_MS;
    await writePersisted(storage, staleJarCookies(), savedAt);

    const dir = mkdtempSync(join(tmpdir(), "panindigan-test-"));
    tmpDirs.push(dir);
    const file = join(dir, "appstate.json");
    writeFileSync(file, JSON.stringify(appStateJson(freshJarCookies())));

    await session.prepareLogin(file);

    expect(jarHeader(session)).toContain("xs=fresh-xs-value");
  });
});
