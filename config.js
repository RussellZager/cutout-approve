// Where the page finds the cutout bus. The page holds no secrets.
//
// Production: the hosted bus below. It must match connect-src in index.html's CSP.
// Tests: `?bus=<http(s) URL>` overrides it, but ONLY when the page itself is served
// from localhost or 127.0.0.1. On any other host the parameter is ignored.

export const DEFAULT_BUS_BASE = "https://ulnxanoxrkfhohxiwuxn.supabase.co/functions/v1/cutout";

function resolveBusBase(loc) {
  const local = loc.hostname === "localhost" || loc.hostname === "127.0.0.1";
  if (!local) return DEFAULT_BUS_BASE;
  const raw = new URLSearchParams(loc.search).get("bus");
  if (!raw) return DEFAULT_BUS_BASE;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return DEFAULT_BUS_BASE;
    return u.href.replace(/\/+$/, "");
  } catch {
    return DEFAULT_BUS_BASE;
  }
}

export const BUS_BASE = resolveBusBase(window.location);
