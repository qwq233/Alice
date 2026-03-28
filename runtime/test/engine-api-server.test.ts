/**
 * Engine API route integration tests.
 *
 * Verifies strict capability mode observes dynamic registry changes without restart.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import * as dbQueries from "../src/db/queries.js";
import { routeRequest } from "../src/engine-api/server.js";
import { WorldModel } from "../src/graph/world-model.js";
import type { Registry } from "../src/skills/registry.js";

let dynamicRegistry: Registry = {};

vi.mock("../src/skills/registry.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/skills/registry.js")>();
  return {
    ...original,
    loadRegistry: vi.fn(() => dynamicRegistry),
    mergeRegistryWithBuiltIns: vi.fn((registry: Registry) => ({
      "alice-system": {
        name: "alice-system",
        version: "1.0.0",
        hash: "builtin-system",
        storePath: "/tmp/skills/system-bin",
        commandPath: "/tmp/skills/system-bin/irc",
        installedAt: "2026-03-11T00:00:00.000Z",
        actions: ["irc", "self", "engine", "ctl", "ask"],
        categories: ["app"],
        capabilities: [
          "chat.read",
          "graph.read",
          "telegram.send",
          "telegram.read",
          "telegram.react",
          "telegram.join",
          "telegram.leave",
          "telegram.forward",
          "query",
        ],
        backend: "shell",
      },
      ...registry,
    })),
  };
});

function makeReq(skill?: string): IncomingMessage {
  return {
    method: "GET",
    url: "/config/timezoneOffset",
    headers: skill ? { "x-alice-skill": skill } : {},
  } as IncomingMessage;
}

function makeChatReq(chatId: string, skill?: string, limit?: number): IncomingMessage {
  return {
    method: "GET",
    url: `/chat/${chatId}/tail${limit ? `?limit=${limit}` : ""}`,
    headers: skill ? { "x-alice-skill": skill } : {},
  } as IncomingMessage;
}

function makeTelegramReq(action: string, skill?: string): IncomingMessage {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    method: "POST",
    url: `/telegram/${action}`,
    headers: skill ? { "x-alice-skill": skill } : {},
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    on(event: string, cb: (...args: any[]) => void) {
      listeners[event] ??= [];
      listeners[event].push(cb);
      return this;
    },
    [Symbol.for("vitest.dispatchListeners")]: listeners,
    resume() {
      return this;
    },
  } as unknown as IncomingMessage;
}

function makeDispatchReq(skill?: string, body?: unknown): IncomingMessage {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    method: "POST",
    url: "/dispatch/DECLARE_ACTION",
    headers: skill ? { "x-alice-skill": skill } : {},
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    on(event: string, cb: (...args: any[]) => void) {
      listeners[event] ??= [];
      listeners[event].push(cb);
      return this;
    },
    [Symbol.for("vitest.dispatchListeners")]: listeners,
    resume() {
      return this;
    },
  } as unknown as IncomingMessage;
}

function makeQueryReq(skill?: string, body?: unknown): IncomingMessage {
  void body; // body 通过 runBody() 单独注入，此处仅保持接口对称
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const listeners: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    method: "POST",
    url: "/query/contact_profile",
    headers: skill ? { "x-alice-skill": skill } : {},
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    on(event: string, cb: (...args: any[]) => void) {
      listeners[event] ??= [];
      listeners[event].push(cb);
      return this;
    },
    [Symbol.for("vitest.dispatchListeners")]: listeners,
    resume() {
      return this;
    },
  } as unknown as IncomingMessage;
}

async function runBody(req: IncomingMessage, body?: unknown): Promise<void> {
  const listeners = (req as unknown as Record<PropertyKey, unknown>)[
    Symbol.for("vitest.dispatchListeners")
    // biome-ignore lint/suspicious/noExplicitAny: test mock callback
  ] as Record<string, Array<(...args: any[]) => void>> | undefined;
  if (!listeners) return;
  if (body !== undefined) {
    for (const cb of listeners.data ?? []) cb(Buffer.from(JSON.stringify(body)));
  }
  for (const cb of listeners.end ?? []) cb();
}

function makeRes() {
  let statusCode = 200;
  let body = "";
  const res: {
    headersSent: boolean;
    writeHead(code: number): unknown;
    end(chunk?: string): unknown;
  } = {
    headersSent: false,
    writeHead(code: number) {
      statusCode = code;
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? "";
      this.headersSent = true;
      return this;
    },
  };

  return {
    res: res as unknown as ServerResponse,
    snapshot: () => ({
      statusCode,
      body: body ? JSON.parse(body) : null,
    }),
  };
}

describe("Engine API route", () => {
  it("strict mode picks up newly installed skills without restart", async () => {
    dynamicRegistry = {};

    const G = new WorldModel();
    G.addAgent("self");

    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: true,
      registry: {},
    };

    const deniedRes = makeRes();
    await routeRequest(makeReq("calendar"), deniedRes.res, deps);
    expect(deniedRes.snapshot()).toEqual({
      statusCode: 403,
      body: { error: 'skill "calendar" lacks capability "config.read"' },
    });

    dynamicRegistry = {
      calendar: {
        name: "calendar",
        version: "1.0.0",
        hash: "hash-calendar",
        storePath: "/tmp/skills/store/hash-calendar",
        commandPath: "/tmp/skills/store/hash-calendar/calendar",
        installedAt: "2026-03-11T00:00:00.000Z",
        actions: ["use_calendar_app"],
        categories: ["app"],
        capabilities: ["config.read"],
        backend: "shell",
      },
    };

    const allowedRes = makeRes();
    await routeRequest(makeReq("calendar"), allowedRes.res, deps);
    expect(allowedRes.snapshot()).toEqual({
      statusCode: 200,
      body: { value: 8 },
    });
  });

  it("query syscall is capability-gated and forwards to dispatcher query bridge", async () => {
    dynamicRegistry = {
      observer: {
        name: "observer",
        version: "1.0.0",
        hash: "hash-observer",
        storePath: "/tmp/skills/store/hash-observer",
        commandPath: "/tmp/skills/store/hash-observer/observer",
        installedAt: "2026-03-11T00:00:00.000Z",
        actions: ["do_observer_thing"],
        categories: ["app"],
        capabilities: ["query"],
        backend: "shell",
      },
    };

    const G = new WorldModel();
    G.addAgent("self");
    const query = vi.fn((_name: string, args: Record<string, unknown>) => ({ seen: args.chatId }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: true,
      registry: {},
      query,
    };

    const deniedRes = makeRes();
    const deniedReq = makeQueryReq("calendar", { chatId: 7 });
    const deniedPromise = routeRequest(deniedReq, deniedRes.res, deps);
    await runBody(deniedReq, { chatId: 7 });
    await deniedPromise;
    expect(deniedRes.snapshot()).toEqual({
      statusCode: 403,
      body: { error: 'skill "calendar" lacks capability "query"' },
    });

    const allowedRes = makeRes();
    const allowedReq = makeQueryReq("observer", { chatId: 7 });
    const allowedPromise = routeRequest(allowedReq, allowedRes.res, deps);
    await runBody(allowedReq, { chatId: 7 });
    await allowedPromise;

    expect(query).toHaveBeenCalledWith("contact_profile", { chatId: 7 });
    expect(allowedRes.snapshot()).toEqual({
      statusCode: 200,
      body: { ok: true, result: { seen: 7 } },
    });
  });

  it("dispatch syscall is capability-gated and forwards to dispatcher bridge", async () => {
    dynamicRegistry = {
      operator: {
        name: "operator",
        version: "1.0.0",
        hash: "hash-operator",
        storePath: "/tmp/skills/store/hash-operator",
        commandPath: "/tmp/skills/store/hash-operator/operator",
        installedAt: "2026-03-11T00:00:00.000Z",
        actions: ["do_operator_thing"],
        categories: ["app"],
        capabilities: ["dispatch"],
        backend: "shell",
      },
    };

    const G = new WorldModel();
    G.addAgent("self");
    const dispatchInstruction = vi.fn((_instruction: string, args: Record<string, unknown>) => ({
      accepted: args.target,
    }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: true,
      registry: {},
      dispatchInstruction,
    };

    const deniedRes = makeRes();
    const deniedReq = makeDispatchReq("calendar", { target: "self" });
    const deniedPromise = routeRequest(deniedReq, deniedRes.res, deps);
    await runBody(deniedReq, { target: "self" });
    await deniedPromise;
    expect(deniedRes.snapshot()).toEqual({
      statusCode: 403,
      body: { error: 'skill "calendar" lacks capability "dispatch"' },
    });

    const allowedRes = makeRes();
    const allowedReq = makeDispatchReq("operator", { target: "self" });
    const allowedPromise = routeRequest(allowedReq, allowedRes.res, deps);
    await runBody(allowedReq, { target: "self" });
    await allowedPromise;

    expect(dispatchInstruction).toHaveBeenCalledWith("DECLARE_ACTION", { target: "self" });
    expect(allowedRes.snapshot()).toEqual({
      statusCode: 200,
      body: { ok: true, result: { accepted: "self" } },
    });
  });

  it("telegram system chat syscalls are gated and forwarded", async () => {
    dynamicRegistry = {};

    const G = new WorldModel();
    G.addAgent("self");
    const telegramSend = vi.fn(async ({ chatId, text }: { chatId: number; text: string }) => ({
      msgId: chatId + text.length,
    }));
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: true,
      registry: {},
      telegramSend,
    };

    const deniedRes = makeRes();
    const deniedReq = makeTelegramReq("send", "calendar");
    const deniedPromise = routeRequest(deniedReq, deniedRes.res, deps);
    await runBody(deniedReq, { chatId: 1, text: "hello" });
    await deniedPromise;
    expect(deniedRes.snapshot()).toEqual({
      statusCode: 403,
      body: { error: 'skill "calendar" lacks capability "telegram.send"' },
    });

    const allowedRes = makeRes();
    const allowedReq = makeTelegramReq("send", "alice-system");
    const allowedPromise = routeRequest(allowedReq, allowedRes.res, deps);
    await runBody(allowedReq, { chatId: 7, text: "hello" });
    await allowedPromise;

    expect(telegramSend).toHaveBeenCalledWith({ chatId: 7, text: "hello", replyTo: undefined });
    expect(allowedRes.snapshot()).toEqual({
      statusCode: 200,
      body: { msgId: 12 },
    });
  });

  it("chat tail is capability-gated and reads recent messages", async () => {
    const tailSpy = vi.spyOn(dbQueries, "getRecentMessagesByChat").mockReturnValue([
      {
        msgId: 1,
        senderName: "Alice",
        senderId: "self",
        text: "hello",
        isOutgoing: true,
        isDirected: false,
        mediaType: null,
        createdAt: new Date("2026-03-11T00:00:00.000Z"),
      },
    ]);

    const G = new WorldModel();
    G.addAgent("self");
    const deps = {
      config: {
        timezoneOffset: 8,
        exaApiKey: "",
        musicApiBaseUrl: "",
        youtubeApiKey: "",
      },
      G,
      strictCapabilities: true,
      registry: {},
    };

    const deniedRes = makeRes();
    await routeRequest(makeChatReq("123", "calendar", 5), deniedRes.res, deps);
    expect(deniedRes.snapshot()).toEqual({
      statusCode: 403,
      body: { error: 'skill "calendar" lacks capability "chat.read"' },
    });

    const allowedRes = makeRes();
    await routeRequest(makeChatReq("123", "alice-system", 5), allowedRes.res, deps);
    expect(tailSpy).toHaveBeenCalledWith("channel:123", 5);
    expect(allowedRes.snapshot()).toEqual({
      statusCode: 200,
      body: {
        messages: [
          {
            msgId: 1,
            senderName: "Alice",
            senderId: "self",
            text: "hello",
            isOutgoing: true,
            isDirected: false,
            mediaType: null,
            createdAt: "2026-03-11T00:00:00.000Z",
          },
        ],
      },
    });
  });
});
