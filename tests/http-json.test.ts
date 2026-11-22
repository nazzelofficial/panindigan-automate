import { describe, expect, it } from "vitest";
import {
  computeJazoest,
  interpretFacebookError,
  parseFacebookJson,
  HttpTransport,
} from "../src/transport/http/index.js";
import { APIError, PermissionError } from "../src/errors/index.js";
import { resolveConfig } from "../src/config/index.js";
import { CookieStore } from "../src/auth/index.js";
import { MiddlewareManager } from "../src/middleware/index.js";
import { DiagnosticsCollector } from "../src/diagnostics/index.js";
import { createRootLogger } from "../src/logger/index.js";

function makeTransport(): HttpTransport {
  return new HttpTransport({
    config: resolveConfig({ storageAdapter: "memory", persistSession: false }),
    cookies: CookieStore.fromCookies([]),
    middleware: new MiddlewareManager(),
    diagnostics: new DiagnosticsCollector(),
    logger: createRootLogger({ level: "silent", prettyPrint: false, logFile: null, transports: [] }),
  });
}

const emptyResponse = (overrides: Partial<{ status: number; url: string; body: string; json: unknown }> = {}) => ({
  status: 200,
  url: "https://www.facebook.com/messaging/send/",
  headers: {} as Record<string, string>,
  body: "",
  json: null,
  ...overrides,
});

describe("HttpTransport.check — mutation empty-body handling", () => {
  it("treats an empty body as success (fixes addParticipant/unsend/group mutations)", () => {
    const http = makeTransport();
    expect(http.check("addParticipant", emptyResponse())).toBeNull();
  });

  it("still throws on a non-empty malformed body", () => {
    const http = makeTransport();
    expect(() => http.check("addParticipant", emptyResponse({ body: "<html>checkpoint</html>" }))).toThrow(APIError);
  });

  it("still throws on an error envelope in JSON", () => {
    const http = makeTransport();
    expect(() => http.check("addParticipant", emptyResponse({ body: '{"error":1357004}', json: { error: 1357004 } }))).toThrow();
  });
});

describe("parseFacebookJson", () => {
  it("parses a single JSON document", () => {
    expect(parseFacebookJson('{"ok":true}')).toEqual({ ok: true });
  });

  it("strips the anti-hijacking prefixes", () => {
    expect(parseFacebookJson('for (;;);{"payload":{"id":"1"}}')).toEqual({
      payload: { id: "1" },
    });
    expect(parseFacebookJson('while(1);[1,2]')).toEqual([1, 2]);
  });

  it("returns null for empty and malformed bodies", () => {
    expect(parseFacebookJson("   ")).toBeNull();
    expect(parseFacebookJson("{not json")).toBeNull();
    expect(parseFacebookJson('{"a":1} {"b":')).toBeNull();
  });

  it("parses concatenated graphqlbatch documents into an array", () => {
    const body = [
      '{"o0":{"data":{"message_thread":{"id":"1"}}}}',
      '{"error_results":0,"successful_results":1}',
    ].join("\n");
    expect(parseFacebookJson(body)).toEqual([
      { o0: { data: { message_thread: { id: "1" } } } },
      { error_results: 0, successful_results: 1 },
    ]);
  });

  it("does not split braces inside strings", () => {
    const body = '{"a":"}{"} {"b":2}';
    expect(parseFacebookJson(body)).toEqual([{ a: "}{" }, { b: 2 }]);
  });

  it("keeps single documents unwrapped even with trailing whitespace", () => {
    expect(parseFacebookJson('\n {"error_results":0}\n\n')).toEqual({
      error_results: 0,
    });
  });
});

describe("interpretFacebookError", () => {
  it("finds errors in any document of a batch", () => {
    const error = interpretFacebookError("batch", [
      { o0: { data: {} } },
      { error: 1545012 },
      { error_results: 1, successful_results: 0 },
    ]);
    expect(error).toBeInstanceOf(PermissionError);
    expect(error.code).toBe("PERMISSION_NOT_PARTICIPANT");
  });

  it("reports a failed batch summary with no detail", () => {
    const error = interpretFacebookError("batch", [
      { o0: { data: {} } },
      { error_results: 1, successful_results: 0 },
    ]);
    expect(error?.code).toBe("API_ERROR");
  });

  it("maps admin and group-only rejections to permission errors", () => {
    const notAdmin = interpretFacebookError("changeAdminStatus", { error: 1976004 });
    expect(notAdmin).toBeInstanceOf(PermissionError);
    expect(notAdmin?.code).toBe("PERMISSION_NOT_ADMIN");

    const groupOnly = interpretFacebookError("changeGroupName", { error: 1545003 });
    expect(groupOnly).toBeInstanceOf(PermissionError);
    expect(groupOnly?.code).toBe("PERMISSION_DENIED");
  });

  it("returns null for a clean batch", () => {
    expect(
      interpretFacebookError("batch", [
        { o0: { data: {} } },
        { error_results: 0, successful_results: 1 },
      ]),
    ).toBeNull();
  });
});

describe("computeJazoest", () => {
  it("prefixes the character-code sum with 2", () => {
    expect(computeJazoest("ab")).toBe("2195");
  });
});
