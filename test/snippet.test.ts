import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { SNIPPET } from "../src/snippet.js";

interface Sent {
  url: string;
  init: { body: string; method: string; keepalive: boolean };
}

function run(attrs: Record<string, string> = {}, cookie = "", search = "", withFbq = false) {
  const sent: Sent[] = [];
  const fbqCalls: unknown[][] = [];
  const script = { src: "https://gw.example.com/snippet.js", getAttribute: (k: string) => attrs[k] ?? null };
  const sandbox: Record<string, unknown> = {
    document: { currentScript: script, cookie },
    location: { href: "https://shop.example.com/p?x=1", search },
    URL,
    Date,
    Math,
    JSON,
    RegExp,
    decodeURIComponent,
    fetch: (url: string, init: Sent["init"]) => {
      sent.push({ url, init });
      return Promise.resolve();
    },
  };
  sandbox.window = sandbox;
  sandbox.crypto = { randomUUID: () => "uuid-1" };
  if (withFbq) sandbox.fbq = (...a: unknown[]) => fbqCalls.push(a);
  runInNewContext(SNIPPET, sandbox);
  return { sandbox, sent, fbqCalls, capi: sandbox.capi as { track: (...a: unknown[]) => string; consent: (g: boolean) => void } };
}

describe("browser snippet", () => {
  it("derives the endpoint from the script origin", () => {
    const { capi, sent } = run();
    capi.track("Lead");
    expect(sent[0]?.url).toBe("https://gw.example.com/events");
  });
  it("honours data-endpoint", () => {
    const { capi, sent } = run({ "data-endpoint": "https://t.example.com/e" });
    capi.track("Lead");
    expect(sent[0]?.url).toBe("https://t.example.com/e");
  });
  it("sends event id, source url, cookies and custom data", () => {
    const { capi, sent } = run({}, "_fbp=fb.1.1700000000000.55; other=1");
    const id = capi.track("AddToCart", { value: 5, currency: "BDT" }, { email: "a@b.com" });
    expect(id).toBe("uuid-1");
    const body = JSON.parse(sent[0]!.init.body);
    expect(body).toMatchObject({
      event_name: "AddToCart",
      event_id: "uuid-1",
      event_source_url: "https://shop.example.com/p?x=1",
      custom_data: { value: 5, currency: "BDT" },
      user: { email: "a@b.com", fbp: "fb.1.1700000000000.55" },
    });
    expect(sent[0]?.init.keepalive).toBe(true);
  });
  it("builds fbc from fbclid when no cookie exists", () => {
    const { capi, sent } = run({}, "", "?fbclid=AbC123");
    capi.track("Lead");
    expect(JSON.parse(sent[0]!.init.body).user.fbc).toMatch(/^fb\.1\.\d+\.AbC123$/);
  });
  it("fires the pixel with the same eventID for deduplication", () => {
    const { capi, fbqCalls } = run({}, "", "", true);
    capi.track("Purchase", { value: 1, currency: "USD" });
    capi.track("QuizDone");
    expect(fbqCalls[0]).toEqual(["track", "Purchase", { value: 1, currency: "USD" }, { eventID: "uuid-1" }]);
    expect(fbqCalls[1]?.[0]).toBe("trackCustom");
  });
  it("queues events until consent is granted", () => {
    const { capi, sent, fbqCalls } = run({ "data-require-consent": "true" }, "", "", true);
    capi.track("Lead");
    expect(sent).toHaveLength(0);
    expect(fbqCalls).toHaveLength(0);
    capi.consent(true);
    expect(sent).toHaveLength(1);
    expect(fbqCalls).toHaveLength(1);
  });
  it("drops queued events when consent is revoked", () => {
    const { capi, sent } = run({ "data-require-consent": "true" });
    capi.track("Lead");
    capi.consent(false);
    capi.consent(true);
    expect(sent).toHaveLength(0);
  });
  it("sends an automatic PageView when enabled", () => {
    const { sent } = run({ "data-auto-pageview": "true" });
    expect(JSON.parse(sent[0]!.init.body).event_name).toBe("PageView");
  });
});
