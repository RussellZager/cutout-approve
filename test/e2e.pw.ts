// End-to-end tests for the approve page against test/fake_bus.ts (real WebAuthn
// verification) with Chrome's CDP virtual authenticator.
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BUS_PORT, PAGE_PORT } from "../playwright.config";
import { clearGestures, gestureReport, inTap, installGestureSpy } from "./gesture_spy";

const PAGE = `http://localhost:${PAGE_PORT}`;
const BUS = `http://localhost:${BUS_PORT}/functions/v1/cutout`;
const CTL = `http://127.0.0.1:${BUS_PORT}`;
const ROOT = join(__dirname, "..");
const SHOTS = process.env.SHOTS_DIR ?? join(ROOT, "test-results", "shots");
mkdirSync(SHOTS, { recursive: true });

async function ctl<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`${CTL}/__test/${path}`, { method: path === "state" ? "GET" : "POST", body: path === "state" ? undefined : JSON.stringify(body) });
  return (await r.json()) as T;
}
interface State { passkeys: number; decisions: { request_id: string; decision: string }[]; devices: Record<string, string>; log: { route: string; status: number; code?: string; body?: Record<string, unknown> }[] }

function url(hash = "", extra = ""): string {
  return `${PAGE}/?bus=${encodeURIComponent(BUS)}${extra}${hash ? `#${hash}` : ""}`;
}

async function authenticator(page: Page, isUserVerified = true): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified, automaticPresenceSimulation: true },
  });
  return { cdp, id: authenticatorId };
}

async function shot(page: Page, name: string) {
  const proj = test.info().project.name;
  await page.screenshot({ path: join(SHOTS, `${proj}-${name}.png`), fullPage: true });
}

async function registerViaPage(page: Page) {
  const { token } = await ctl<{ token: string }>("invite", { name: "iPhone" });
  await page.goto(url(`register=${token}`));
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByText("Passkey added. You can close this page.")).toBeVisible();
}

let dialogs: string[] = [];
test.beforeEach(async ({ page }) => {
  await ctl("reset");
  dialogs = [];
  page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
});

test("register adds a passkey @shots", async ({ page }) => {
  await authenticator(page);
  const { token } = await ctl<{ token: string }>("invite", { name: "iPhone" });
  await page.goto(url(`register=${token}`));
  const btn = page.getByRole("button", { name: "Add passkey" });
  await expect(btn).toBeVisible();
  await shot(page, "register-idle");
  await btn.click();
  await expect(page.getByText("Passkey added. You can close this page.")).toBeVisible();
  await expect(btn).toBeHidden();
  await shot(page, "register-done");
  expect((await ctl<State>("state")).passkeys).toBe(1);
});

test("used invite says the link expired", async ({ page }) => {
  await authenticator(page);
  const { token } = await ctl<{ token: string }>("invite", { name: "iPhone" });
  await page.goto(url(`register=${token}`));
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByText("Passkey added. You can close this page.")).toBeVisible();
  await page.goto(url(`register=${token}`, "&again=1"));
  // Options are fetched on load, so the dead link is reported before any tap.
  await expect(page.getByText("That link expired. Run cutout passkey add again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Add passkey" })).toBeHidden();
});

test("device code: Confirm signs the Mac in @shots", async ({ page }) => {
  await authenticator(page);
  await registerViaPage(page);
  const { user_code } = await ctl<{ user_code: string }>("device");
  await page.goto(url(`code=${user_code}`));
  await expect(page.getByText(user_code, { exact: true })).toBeVisible();
  await expect(page.getByText("Only confirm if you just ran cutout login and this code matches.", { exact: true })).toBeVisible();
  await shot(page, "code-idle");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Signed in on your Mac. You can close this page.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm" })).toBeHidden();
  await shot(page, "code-done");
  const st = await ctl<State>("state");
  expect(st.devices[user_code.replace("-", "")]).toBe("approved");
});

test("device code: Not me blocks the sign-in @shots", async ({ page }) => {
  await authenticator(page);
  await registerViaPage(page);
  const { user_code } = await ctl<{ user_code: string }>("device");
  await page.goto(url(`code=${user_code.toLowerCase()}`));
  await expect(page.getByText(user_code, { exact: true })).toBeVisible(); // shown upper-case
  await page.getByRole("button", { name: "Not me" }).click();
  await expect(page.getByText("Sign-in blocked. You can close this page.")).toBeVisible();
  await shot(page, "code-notme");
  expect((await ctl<State>("state")).devices[user_code.replace("-", "")]).toBe("denied");
});

test("expired code says so, without Retry @shots", async ({ page }) => {
  await authenticator(page);
  await registerViaPage(page);
  const { user_code } = await ctl<{ user_code: string }>("device");
  await ctl("expire_device", { user_code });
  await page.goto(url(`code=${user_code}`));
  // The device options are fetched on load, so the expiry shows before any tap.
  await expect(page.getByText("That code expired. Run cutout login again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeHidden();
  // Final error: the buttons go away, since pressing them again cannot work.
  await expect(page.getByRole("button", { name: "Confirm" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Not me" })).toBeHidden();
  await shot(page, "code-expired");
});

test("malformed code is refused before any passkey prompt", async ({ page }) => {
  await page.goto(url("code=<b>x</b>"));
  await expect(page.getByText("That code looks wrong. Run cutout login again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm" })).toHaveCount(0);
  expect(await page.locator("main b").count()).toBe(0);
});

test("list, expand, approve one and deny one @shots", async ({ page }) => {
  await authenticator(page);
  await registerViaPage(page);
  const five = new Date(Date.now() - 5 * 60_000).toISOString();
  const two = new Date(Date.now() - 2 * 3600_000).toISOString();
  const a = await ctl<{ request_id: string }>("approval", {
    from: "mac.cutout.s1", created_at: two,
    body: "Deploy cutout 1.12 to prod?\nIt passes the conformance suite.\nSee https://example.com/run/42",
    context: [{ id: "msg_c1", from: "mac.cutout.s1", type: "note", created_at: two, body: "Running conformance now." }],
  });
  const b = await ctl<{ request_id: string }>("approval", { from: "ci.bot", created_at: five, body: "Delete the old staging bucket?" });

  await page.goto(url());
  await shot(page, "list-idle");
  await page.getByRole("button", { name: "Show requests" }).click();
  const rowA = page.locator(`[data-request-id="${a.request_id}"]`);
  const rowB = page.locator(`[data-request-id="${b.request_id}"]`);
  await expect(rowA).toContainText("mac.cutout.s1");
  await expect(rowA).toContainText("Deploy cutout 1.12 to prod?");
  await expect(rowA).toContainText("2h");
  await expect(rowB).toContainText("ci.bot");
  await expect(rowB).toContainText("5m");
  // Collapsed rows show only the first line.
  await expect(rowA.getByText("It passes the conformance suite.")).toBeHidden();
  await shot(page, "list-collapsed");

  await rowA.getByRole("button", { name: /mac\.cutout\.s1/ }).click();
  await expect(rowA.getByText("It passes the conformance suite.", { exact: false })).toBeVisible();
  await expect(rowA).toContainText("Running conformance now.");
  await expect(rowA.locator(".first")).toBeHidden(); // summary line not repeated when open
  await expect(rowA).toContainText("https://example.com/run/42");
  expect(await rowA.locator("a").count()).toBe(0); // URL shown as text, not a link
  await shot(page, "list-expanded");

  await rowA.getByRole("button", { name: "Approve" }).click();
  await expect(rowA.getByText("Approved", { exact: true })).toBeVisible();
  await expect(rowA.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

  await rowB.getByRole("button", { name: /ci\.bot/ }).click();
  await rowB.getByRole("button", { name: "Deny" }).click();
  await expect(rowB.getByText("Denied", { exact: true })).toBeVisible();
  await shot(page, "list-decided");

  const st = await ctl<State>("state");
  expect(st.decisions).toEqual([
    { request_id: a.request_id, decision: "approve" },
    { request_id: b.request_id, decision: "deny" },
  ]);
  // Expanding a row prefetches one options request per decision, each bound to
  // request_id + decision; the decide call then used the matching one.
  const decideOpts = st.log.filter((l) => l.route === "/v1/passkeys/auth/options" && l.body?.purpose === "decide");
  expect(decideOpts.map((l) => [l.body?.request_id, l.body?.decision, l.status])).toEqual([
    [a.request_id, "approve", 200],
    [a.request_id, "deny", 200],
    [b.request_id, "approve", 200],
    [b.request_id, "deny", 200],
  ]);
  expect(st.log.filter((l) => l.route === "/v1/approvals/web/decide").map((l) => l.status)).toEqual([201, 201]);
});

test("empty list says No requests @shots", async ({ page }) => {
  await authenticator(page);
  await registerViaPage(page);
  await page.goto(url());
  await page.getByRole("button", { name: "Show requests" }).click();
  await expect(page.getByText("No requests.")).toBeVisible();
  await shot(page, "list-empty");
});

test("cancelled passkey says so, and Retry recovers @shots", async ({ page }) => {
  const auth = await authenticator(page);
  await registerViaPage(page);
  await ctl("approval", { from: "mac.cutout.s1", body: "Merge the branch?" });
  await auth.cdp.send("WebAuthn.setUserVerified", { authenticatorId: auth.id, isUserVerified: false });
  await page.goto(url());
  await page.getByRole("button", { name: "Show requests" }).click();
  await expect(page.getByText("Passkey cancelled.")).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await shot(page, "error-cancelled");
  await auth.cdp.send("WebAuthn.setUserVerified", { authenticatorId: auth.id, isUserVerified: true });
  await retry.click();
  await expect(page.locator(".first", { hasText: "Merge the branch?" })).toBeVisible();
  await expect(page.getByText("Passkey cancelled.")).toBeHidden();
});

test("network failure says so with Retry", async ({ page }) => {
  await authenticator(page);
  await page.route(`${BUS}/**`, (r) => r.abort("internetdisconnected"));
  const { token } = await ctl<{ token: string }>("invite", {});
  await page.goto(url(`register=${token}`));
  await expect(page.getByText("Network problem. Try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add passkey" })).toBeDisabled();
  await page.unroute(`${BUS}/**`);
  await page.getByRole("button", { name: "Retry" }).click(); // refetches the options only
  await expect(page.getByText("Network problem. Try again.")).toBeHidden();
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByText("Passkey added. You can close this page.")).toBeVisible();
});

test("XSS probe: agent text renders as text only", async ({ page }) => {
  await authenticator(page);
  await registerViaPage(page);
  const evil = `Hi <img src=x onerror="window.__xss=1;alert('img')"> <a href="javascript:alert('a')">click</a> javascript:alert('c')`;
  const r = await ctl<{ request_id: string }>("approval", {
    from: `<b onmouseover="alert('from')">bot</b>`, body: evil,
    context: [{ id: "c1", from: "x", type: "note", created_at: new Date().toISOString(), body: `<script>window.__xss=2</script><svg onload="alert('svg')"></svg>` }],
  });
  await page.goto(url());
  await page.getByRole("button", { name: "Show requests" }).click();
  const row = page.locator(`[data-request-id="${r.request_id}"]`);
  await expect(row).toContainText(`<b onmouseover="alert('from')">bot</b>`);
  await row.getByRole("button", { name: /bot/ }).click();
  await expect(row).toContainText(`<img src=x onerror="window.__xss=1;alert('img')">`);
  await expect(row).toContainText(`<a href="javascript:alert('a')">click</a>`);
  await expect(row).toContainText(`<script>window.__xss=2</script>`);
  await page.waitForTimeout(500);
  const injected = await page.evaluate(() => ({
    n: document.querySelectorAll("main img, main a, main script, main svg, main b, main iframe").length,
    xss: (window as unknown as { __xss?: number }).__xss ?? null,
  }));
  expect(injected).toEqual({ n: 0, xss: null });
  expect(dialogs).toEqual([]);
});

test("CSP: shipped file carries the strict policy, and the browser enforces it", async ({ page }) => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  expect(m, "CSP meta tag").not.toBeNull();
  const csp = m![1];
  for (const d of [
    "default-src 'self'", "connect-src https://ulnxanoxrkfhohxiwuxn.supabase.co", "img-src 'self' data:",
    "style-src 'self'", "script-src 'self'", "base-uri 'none'", "form-action 'none'",
  ]) expect(csp).toContain(d);
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // no inline scripts
  expect(html).not.toMatch(/\sstyle=/); // no inline styles
  // Positive control that the policy is live: served as shipped (?csp=raw), the page may
  // not reach the local bus, so the fetch is blocked and the user sees a network error.
  await authenticator(page);
  const violations: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  const { token } = await ctl<{ token: string }>("invite", {});
  await page.goto(url(`register=${token}`, "&csp=raw"));
  await expect(page.getByText("Network problem. Try again.")).toBeVisible();
  expect(violations.join("\n")).toContain("connect-src");
  expect((await ctl<State>("state")).log.length).toBe(0);
});

test("no dark mode anywhere", async ({ page }) => {
  for (const f of ["index.html", "style.css", "app.js"]) {
    const t = readFileSync(join(ROOT, f), "utf8");
    expect(t, f).not.toMatch(/prefers-color-scheme/i);
    expect(t, f).not.toMatch(/color-scheme\s*:\s*[^;]*dark/i);
    expect(t, f).not.toMatch(/name="color-scheme"[^>]*dark/i);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(url());
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: "light" });
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(dark).toBe(light);
  expect(light).toBe("rgb(255, 255, 255)");
});

test("bus override is honoured on localhost only", async ({ page }) => {
  await page.goto(url());
  const local = await page.evaluate(async () => (await import("/config.js")).BUS_BASE);
  expect(local).toBe(BUS);
  await page.goto(`http://approve.test:${PAGE_PORT}/?bus=${encodeURIComponent("https://evil.example/x")}`);
  const remote = await page.evaluate(async () => (await import("/config.js")).BUS_BASE);
  expect(remote).toBe("https://ulnxanoxrkfhohxiwuxn.supabase.co/functions/v1/cutout");
  // A non-http(s) override is ignored even on localhost.
  await page.goto(`${PAGE}/?bus=${encodeURIComponent("javascript:alert(1)")}`);
  const bad = await page.evaluate(async () => (await import("/config.js")).BUS_BASE);
  expect(bad).toBe("https://ulnxanoxrkfhohxiwuxn.supabase.co/functions/v1/cutout");
});

test("works without the JSON helper APIs (manual base64url fallback)", async ({ page }) => {
  await page.addInitScript(() => {
    const P = PublicKeyCredential as unknown as Record<string, unknown>;
    delete P.parseCreationOptionsFromJSON;
    delete P.parseRequestOptionsFromJSON;
    delete (PublicKeyCredential.prototype as unknown as Record<string, unknown>).toJSON;
    (window as unknown as { __noJsonApi: boolean }).__noJsonApi =
      !("parseCreationOptionsFromJSON" in PublicKeyCredential) && !("toJSON" in PublicKeyCredential.prototype);
  });
  await authenticator(page);
  await registerViaPage(page);
  expect(await page.evaluate(() => (window as unknown as { __noJsonApi: boolean }).__noJsonApi)).toBe(true);
  const { user_code } = await ctl<{ user_code: string }>("device");
  await page.goto(url(`code=${user_code}`));
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Signed in on your Mac. You can close this page.")).toBeVisible();
});

test("refuses to run inside a frame", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/style.css`);
  await page.setContent(`<iframe src="${url()}" width="400" height="300"></iframe>`);
  const frame = page.frameLocator("iframe");
  await expect(frame.getByText("Open this page directly.")).toBeVisible();
  await expect(frame.getByRole("button", { name: "Show requests" })).toHaveCount(0);
});

test("every passkey prompt starts inside the tap, with no fetch before it", async ({ page }) => {
  await installGestureSpy(page);
  await authenticator(page);
  await registerViaPage(page);
  expect(await gestureReport(page)).toEqual([inTap("create")]);
  await clearGestures(page);

  const { user_code } = await ctl<{ user_code: string }>("device");
  await page.goto(url(`code=${user_code}`));
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Signed in on your Mac. You can close this page.")).toBeVisible();
  expect(await gestureReport(page)).toEqual([inTap("get")]);
  await clearGestures(page);

  const a = await ctl<{ request_id: string }>("approval", { body: "First?" });
  const b = await ctl<{ request_id: string }>("approval", { body: "Second?" });
  await page.goto(url());
  await page.getByRole("button", { name: "Show requests" }).click();
  const rowA = page.locator(`[data-request-id="${a.request_id}"]`);
  const rowB = page.locator(`[data-request-id="${b.request_id}"]`);
  await rowA.locator("button.row").click();
  await rowA.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(rowA.getByText("Approved", { exact: true })).toBeVisible();
  await rowB.locator("button.row").click();
  await rowB.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(rowB.getByText("Denied", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("No requests.")).toBeVisible();
  expect(await gestureReport(page)).toEqual([inTap("get"), inTap("get"), inTap("get"), inTap("get")]);
  expect((await ctl<State>("state")).decisions.map((d) => d.decision)).toEqual(["approve", "deny"]);
});

test("stale prefetched challenge: refetch, ask for one more tap, never loop", async ({ page }) => {
  await installGestureSpy(page);
  await authenticator(page);
  await registerViaPage(page);
  await clearGestures(page);
  const { user_code } = await ctl<{ user_code: string }>("device");
  await page.clock.install();
  await page.goto(url(`code=${user_code}`));
  await expect(page.getByRole("button", { name: "Confirm" })).toBeEnabled();
  await page.clock.fastForward("04:10"); // past the 240 s freshness limit
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("That took too long. Try again.")).toBeVisible();
  expect(await gestureReport(page)).toEqual([]); // no passkey prompt with the stale challenge
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Signed in on your Mac. You can close this page.")).toBeVisible();
  expect(await gestureReport(page)).toEqual([inTap("get")]);
  const opts = (await ctl<State>("state")).log.filter((l) => l.route === "/v1/passkeys/auth/options" && l.body?.purpose === "device");
  expect(opts.length).toBe(2);
});

test("bad_challenge after the prompt: refetch and Retry, one prompt per tap", async ({ page }) => {
  await installGestureSpy(page);
  await authenticator(page);
  await registerViaPage(page);
  await ctl("approval", { body: "Ship it?" });
  await page.goto(url());
  await clearGestures(page);
  await ctl("fail_next", { code: "bad_challenge" });
  await page.getByRole("button", { name: "Show requests" }).click();
  await expect(page.getByText("That took too long. Try again.")).toBeVisible();
  await page.waitForTimeout(500);
  expect(await gestureReport(page)).toEqual([inTap("get")]); // no automatic second prompt
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".first", { hasText: "Ship it?" })).toBeVisible();
  expect(await gestureReport(page)).toEqual([inTap("get"), inTap("get")]);
});

test("bad_assertion offers Retry, and Retry recovers", async ({ page }) => {
  await authenticator(page);
  await registerViaPage(page);
  await ctl("approval", { body: "Rotate the key?" });
  await page.goto(url());
  await ctl("fail_next", { code: "bad_assertion" });
  await page.getByRole("button", { name: "Show requests" }).click();
  await expect(page.getByText("Passkey not recognized. Try again, or run cutout passkey add.")).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.locator(".first", { hasText: "Rotate the key?" })).toBeVisible();
});

test("register Retry fetches new options after a failed create()", async ({ page }) => {
  const auth = await authenticator(page);
  await auth.cdp.send("WebAuthn.setUserVerified", { authenticatorId: auth.id, isUserVerified: false });
  const { token } = await ctl<{ token: string }>("invite", { name: "iPhone" });
  await page.goto(url(`register=${token}`));
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByText("Passkey cancelled.")).toBeVisible();
  await auth.cdp.send("WebAuthn.setUserVerified", { authenticatorId: auth.id, isUserVerified: true });
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Passkey added. You can close this page.")).toBeVisible();
  const st = await ctl<State>("state");
  expect(st.log.filter((l) => l.route === "/v1/passkeys/register/options").map((l) => l.status)).toEqual([200, 200]);
  expect(st.log.filter((l) => l.route === "/v1/passkeys/register/verify").map((l) => l.status)).toEqual([201]);
});

test("root page: Have a code? opens the code screen @shots", async ({ page }) => {
  await authenticator(page);
  await registerViaPage(page);
  const { user_code } = await ctl<{ user_code: string }>("device");
  await page.goto(url());
  const input = page.getByLabel("Have a code?");
  await expect(input).toBeVisible();
  await shot(page, "root");
  await input.fill("bcdf");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByText("That code looks wrong.", { exact: true })).toBeVisible();
  await input.fill(user_code.replace("-", "").toLowerCase()); // any case, no dash
  await input.press("Enter");
  await expect(page.getByText(user_code, { exact: true })).toBeVisible();
  await expect(page.getByText("Only confirm if you just ran cutout login and this code matches.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Signed in on your Mac. You can close this page.")).toBeVisible();
  expect((await ctl<State>("state")).devices[user_code.replace("-", "")]).toBe("approved");
});

test("text cut at the bus cap is marked (shortened)", async ({ page }) => {
  await authenticator(page);
  await registerViaPage(page);
  const cap = "Long plan:\n" + "é".repeat(1989); // 2000 code points: what the bus cut
  const long = await ctl<{ request_id: string }>("approval", {
    body: cap,
    context: [{ id: "c1", from: "x", type: "note", created_at: new Date().toISOString(), body: "y".repeat(2000) }],
  });
  const short = await ctl<{ request_id: string }>("approval", { body: "x".repeat(1999) });
  await page.goto(url());
  await page.getByRole("button", { name: "Show requests" }).click();
  const rowL = page.locator(`[data-request-id="${long.request_id}"]`);
  const rowS = page.locator(`[data-request-id="${short.request_id}"]`);
  await rowL.locator("button.row").click();
  await rowS.locator("button.row").click();
  await expect(rowL.locator(".detail .shortened")).toHaveCount(2); // body and context
  await expect(rowL.locator(".detail .shortened").first()).toHaveText("(shortened)");
  await expect(rowS.locator(".detail .shortened")).toHaveCount(0);
});
