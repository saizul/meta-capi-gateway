import type { ServerEvent } from "../src/types.js";

export function okResponse(extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ events_received: 1, messages: [], fbtrace_id: "TRACE", ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function errResponse(status: number, error: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { message: "boom", type: "OAuthException", code: 100, ...error } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function makeEvent(n = 1, over: Partial<ServerEvent> = {}): ServerEvent {
  return {
    event_name: "Lead",
    event_time: 1_700_000_000,
    event_id: `evt-${n}`,
    action_source: "website",
    user_data: { client_user_agent: "UA" },
    ...over,
  };
}

export function makeEvents(count: number): ServerEvent[] {
  return Array.from({ length: count }, (_, i) => makeEvent(i));
}
