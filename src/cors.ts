/** Match an Origin against an allow-list. Supports "*" and "https://*.example.com". */
export function isOriginAllowed(origin: string, allowList: string[]): boolean {
  const o = origin.toLowerCase().replace(/\/+$/, "");
  for (const entry of allowList) {
    const e = entry.toLowerCase().replace(/\/+$/, "");
    if (e === "*") return true;
    if (e === o) return true;
    const m = /^(https?:\/\/)\*\.(.+)$/.exec(e);
    if (m) {
      const [, scheme, host] = m;
      if (o.startsWith(scheme!) && o.slice(scheme!.length).endsWith("." + host!)) {
        const sub = o.slice(scheme!.length, o.length - host!.length - 1);
        if (sub.length > 0 && !sub.includes("/") && !sub.includes("@")) return true;
      }
    }
  }
  return false;
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
  };
}
