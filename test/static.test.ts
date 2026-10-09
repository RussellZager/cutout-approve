// Static guards run by `bun test` (and the pre-push gate). Browser behaviour is
// covered by Playwright: test/e2e.pw.ts (fake bus) and test/real.pw.ts (real bus).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (name: string) => readFileSync(join(ROOT, name), "utf8");

describe("published page", () => {
  test("CNAME is the passkey RP ID", () => {
    expect(read("CNAME").trim()).toBe("approve.russellzager.com");
  });

  test("CSP allows scripts from self only and talks to the production bus only", () => {
    const html = read("index.html");
    const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src https://switchboard.russellzager.com");
    expect(csp).not.toContain("unsafe-inline");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // no inline scripts
  });

  test("agent text never reaches innerHTML-style sinks", () => {
    // Scan code only: app.js's header comment names the sinks it avoids.
    const js = read("app.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("]) {
      expect(js.includes(sink)).toBe(false);
    }
  });

  test("light theme only", () => {
    expect(read("style.css")).not.toMatch(/prefers-color-scheme\s*:\s*dark/);
  });

  test("bus override is limited to localhost", () => {
    const cfg = read("config.js");
    expect(cfg).toContain("https://switchboard.russellzager.com/functions/v1/switchboard");
    expect(cfg).toMatch(/localhost/);
  });

  test("rename v1.13: the page calls /functions/v1/switchboard and shows Switchboard", () => {
    const base = read("config.js").match(/DEFAULT_BUS_BASE\s*=\s*"([^"]+)"/)?.[1] ?? "";
    expect(base).toBe("https://switchboard.russellzager.com/functions/v1/switchboard");
    expect(read("index.html").match(/<title>([^<]*)<\/title>/)?.[1]).toBe("Switchboard");
    expect(read("app.js")).toContain('h("h1", { class: "brand" }, "Switchboard")');
    // Every visible string and CLI hint uses the new name (rpId and CNAME are not text).
    for (const f of ["index.html", "app.js", "config.js"]) {
      expect(read(f).match(/cutout/gi) ?? [], f).toEqual([]);
    }
  });
});
