/** Amazon session cookies captured by `kindle-mcp login`. Stored with 0600 permissions; treat like a credential. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number; // unix seconds, -1 for session cookies
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface Session {
  savedAt: string;
  cookies: Cookie[];
}

export function loadSession(path: string): Session | null {
  if (!existsSync(path)) return null;
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Session;
    return Array.isArray(s.cookies) ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(path: string, session: Session): void {
  writeFileSync(path, JSON.stringify(session, null, 2), { encoding: "utf8", mode: 0o600 });
}

function hostMatches(host: string, domain: string): boolean {
  const d = domain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** The Cookie header for a URL, RFC 6265 style: domain suffix, path prefix, not expired. */
export function cookieHeader(cookies: Cookie[], url: string): string {
  const u = new URL(url);
  const now = Date.now() / 1000;
  return cookies
    .filter((c) => hostMatches(u.hostname, c.domain))
    .filter((c) => u.pathname.startsWith(c.path || "/"))
    .filter((c) => !(c.expires && c.expires > 0 && c.expires < now))
    .filter((c) => !c.secure || u.protocol === "https:")
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** Apply Set-Cookie headers from a response to the jar (in place). Returns true when anything changed. */
export function applySetCookies(cookies: Cookie[], setCookies: string[], url: string): boolean {
  const u = new URL(url);
  let changed = false;
  for (const raw of setCookies) {
    const [pair, ...attrs] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let domain = u.hostname;
    let path = "/";
    let expires: number | undefined;
    let secure = false;
    let httpOnly = false;
    for (const a of attrs) {
      const [k, ...v] = a.trim().split("=");
      const key = k.toLowerCase();
      const val = v.join("=").trim();
      if (key === "domain" && val) domain = val.startsWith(".") ? val : `.${val}`;
      else if (key === "path" && val) path = val;
      else if (key === "max-age" && val) expires = Date.now() / 1000 + parseInt(val, 10);
      else if (key === "expires" && val && expires === undefined) {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expires = t / 1000;
      } else if (key === "secure") secure = true;
      else if (key === "httponly") httpOnly = true;
    }
    const idx = cookies.findIndex((c) => c.name === name && hostMatches(domain.replace(/^\./, ""), c.domain) && c.path === path);
    const next: Cookie = { name, value, domain, path, expires: expires ?? -1, secure, httpOnly };
    if (idx >= 0) {
      if (cookies[idx].value !== value) changed = true;
      cookies[idx] = { ...cookies[idx], ...next };
    } else {
      cookies.push(next);
      changed = true;
    }
  }
  return changed;
}
