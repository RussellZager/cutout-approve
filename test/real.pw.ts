// E2E_TARGET=real: the page against the real local Switchboard bus (tests/run_local_bus.py).
// Seeding and read-back use the bus's own API, as in scratch/v112/recipes.sh:
// invite (operator key), device start + token poll (the CLI side), agent question,
// agent thread read (what the requester sees). No test-only routes.
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LB_FILE, REAL_PAGE_PORT, ROOT } from "./real_setup";
import { clearGestures, gestureReport, inTap, installGestureSpy } from "./gesture_spy";

interface LB { base_url: string; operator_id: string; operator_key: string; agent_id: string; agent_key: string; owner_id: string }
const lb: LB = JSON.parse(readFileSync(LB_FILE, "utf8"));
const B = lb.base_url.replace(/\/+$/, "");
const PAGE = `http://localhost:${REAL_PAGE_PORT}`;
const SHOTS = process.env.SHOTS_DIR ?? join(ROOT, "test-results", "shots");
mkdirSync(SHOTS, { recursive: true });
const RUN = Math.random().toString(16).slice(2, 8);

// ---------------------------------------------------------------- recipes
type Res = { status: number; body: Record<string, unknown> };
async function call(method: string, path: string, body?: unknown, auth?: { key: string; id: string }): Promise<Res> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) { headers.Authorization = `Bearer ${auth.key}`; headers["X-Agent-Id"] = auth.id; }
  const r = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
const operator = { key: lb.operator_key, id: lb.operator_id };
const agent = { key: lb.agent_key, id: lb.agent_id };
const recipe = {
  invite: (name: string) => call("POST", "/v1/passkeys/invite", { name }, operator),
  device: () => call("POST", "/v1/owner/device", {}),
  poll: (device_code: string) => call("POST", "/v1/owner/device/token", { device_code }),
  ask: (thread_id: string, body: string) => call("POST", "/v1/messages", {
    from: lb.agent_id, to: lb.operator_id, thread_id, type: "question", body, metadata: { approval_request: true },
  }, agent),
  thread: (thread_id: string) => call("GET", `/v1/messages?thread_id=${encodeURIComponent(thread_id)}`, undefined, agent),
};

// The CLI side of `switchboard login`: poll the token endpoint, honouring interval and slow_down.
async function pollUntilDone(device_code: string, interval: number, deadlineMs = 90_000): Promise<Res> {
  const end = Date.now() + deadlineMs;
  let wait = interval;
  for (;;) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    const r = await recipe.poll(device_code);
    if (r.status === 400 && r.body.code === "authorization_pending") { if (Date.now() > end) return r; continue; }
    if (r.status === 400 && r.body.code === "slow_down") { wait += 5; continue; }
    return r;
  }
}

// What the requester sees: approval messages in its thread.
async function decisionsSeen(thread_id: string) {
  const r = await recipe.thread(thread_id);
  expect(r.status).toBe(200);
  const msgs = (r.body.messages as Record<string, unknown>[]) ?? [];
  return msgs.filter((m) => m.type === "approval").map((m) => ({
    from: m.from, reply_to: m.reply_to, decision: (m.metadata as Record<string, unknown>)?.decision,
    verified_sender_role: m.verified_sender_role,
  }));
}

// ------------------------------------------------------------- browser helpers
async function authenticator(page: Page): Promise<{ cdp: CDPSession; id: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, id: authenticatorId };
}
// Copy the passkey (with its current sign count) from one virtual authenticator to another.
async function copyCredentials(from: { cdp: CDPSession; id: string }, to: { cdp: CDPSession; id: string }) {
  const { credentials } = await from.cdp.send("WebAuthn.getCredentials", { authenticatorId: from.id });
  await to.cdp.send("WebAuthn.clearCredentials", { authenticatorId: to.id });
  for (const credential of credentials) await to.cdp.send("WebAuthn.addCredential", { authenticatorId: to.id, credential });
  return credentials.length;
}
const url = (hash = "") => `${PAGE}/?bus=${encodeURIComponent(B)}${hash ? `#${hash}` : ""}`;
// Every passkey prompt so far started inside its tap with no fetch first; then reset.
async function expectTapGestures(page: Page, calls: string[]) {
  expect(await gestureReport(page)).toEqual(calls.map(inTap));
  await clearGestures(page);
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(SHOTS, `real-phone-${name}.png`), fullPage: true });
}

test("real bus: register, login confirm, Not me, list, approve, deny, already decided", async ({ page, context }) => {
  test.setTimeout(420_000);
  const dialogs: string[] = [];
  page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await installGestureSpy(page);
  const auth = await authenticator(page);

  await test.step("register a passkey from an operator-key invite", async () => {
    const inv = await recipe.invite(`test-page-phone-${RUN}`);
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const token = String(inv.body.token);
    expect(String(inv.body.url)).toBe(`${PAGE}/#register=${token}`);
    await page.goto(url(`register=${token}`));
    await shot(page, "register-idle");
    await page.getByRole("button", { name: "Add passkey" }).click();
    await expect(page.getByText("Passkey added. You can close this page.")).toBeVisible();
    await shot(page, "register-done");
    await expectTapGestures(page, ["create"]);
  });

  await test.step("device login: Confirm, and the CLI poll gets a session once", async () => {
    const dev = await recipe.device();
    expect(dev.status, JSON.stringify(dev.body)).toBe(200);
    const code = String(dev.body.user_code);
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(dev.body.verification_uri_complete).toBe(`${PAGE}/#code=${code}`);
    const first = await recipe.poll(String(dev.body.device_code));
    expect([first.status, first.body.code]).toEqual([400, "authorization_pending"]);
    await page.goto(url(`code=${code}`));
    await expect(page.getByText(code, { exact: true })).toBeVisible();
    await expect(page.getByText("Only confirm if you just ran switchboard login and this code matches.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm" })).toBeEnabled(); // device options prefetched
    await shot(page, "code-idle");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Signed in on your Mac. You can close this page.")).toBeVisible();
    await shot(page, "code-done");
    await expectTapGestures(page, ["get"]);
    const tok = await pollUntilDone(String(dev.body.device_code), Number(dev.body.interval ?? 5));
    expect(tok.status, JSON.stringify(tok.body)).toBe(200);
    expect(String(tok.body.session_token)).toMatch(/^cos_/);
    expect(tok.body.owner_id).toBe(lb.owner_id);
    expect(tok.body.acts_as).toBe(lb.operator_id);
    const again = await pollUntilDone(String(dev.body.device_code), Number(dev.body.interval ?? 5));
    expect([again.status, again.body.code]).toEqual([400, "invalid_grant"]);
  });

  await test.step("device login: Not me, and the CLI poll is denied", async () => {
    const dev = await recipe.device();
    expect(dev.status).toBe(200);
    const code = String(dev.body.user_code);
    await page.goto(url(`code=${code}`));
    await page.getByRole("button", { name: "Not me" }).click();
    await expect(page.getByText("Sign-in blocked. You can close this page.")).toBeVisible();
    await shot(page, "code-notme");
    await expectTapGestures(page, ["get"]);
    const tok = await pollUntilDone(String(dev.body.device_code), Number(dev.body.interval ?? 5));
    expect([tok.status, tok.body.code]).toEqual([400, "access_denied"]);
  });

  const t = (n: string) => `test-page-${RUN}-${n}`;
  const asks: Record<string, string> = {};
  await test.step("agent posts four approval requests", async () => {
    const bodies: Record<string, string> = {
      approve: "May I rotate the staging key?\nThe old one expires Friday.\nRunbook: https://example.com/runbook",
      deny: "Delete the old staging bucket?",
      xss: `Hi <img src=x onerror="window.__xss=1;alert('img')"> <a href="javascript:alert('a')">click</a> javascript:alert('c')`,
      race: "Merge the release branch?",
    };
    for (const [k, body] of Object.entries(bodies)) {
      const r = await recipe.ask(t(k), body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      asks[k] = String(r.body.id);
      expect(await decisionsSeen(t(k))).toEqual([]);
    }
  });

  const row = (p: Page, k: string) => p.locator(`[data-request-id="${asks[k]}"]`);
  await test.step("list shows every request, one line each", async () => {
    await page.goto(url());
    await expect(page.getByLabel("Have a code?")).toBeVisible();
    await expect(page.getByRole("button", { name: "Show requests" })).toBeEnabled();
    await shot(page, "root");
    await page.getByRole("button", { name: "Show requests" }).click();
    for (const k of Object.keys(asks)) await expect(row(page, k)).toContainText(lb.agent_id);
    await expect(row(page, "approve")).toContainText("May I rotate the staging key?");
    await expect(row(page, "approve").getByText("The old one expires Friday.")).toBeHidden();
    await shot(page, "list");
  });

  await test.step("approve: the requester sees an operator approval", async () => {
    await row(page, "approve").getByRole("button", { name: new RegExp(lb.agent_id.replace(/\./g, "\\.")) }).click();
    await expect(row(page, "approve")).toContainText("https://example.com/runbook");
    expect(await row(page, "approve").locator("a").count()).toBe(0);
    await shot(page, "list-expanded");
    await row(page, "approve").getByRole("button", { name: "Approve", exact: true }).click();
    await expect(row(page, "approve").getByText("Approved", { exact: true })).toBeVisible();
    expect(await decisionsSeen(t("approve"))).toEqual([
      { from: lb.operator_id, reply_to: asks.approve, decision: "approve", verified_sender_role: "operator" },
    ]);
  });

  await test.step("deny: the requester sees an operator denial", async () => {
    await row(page, "deny").locator("button.row").click();
    await row(page, "deny").getByRole("button", { name: "Deny", exact: true }).click();
    await expect(row(page, "deny").getByText("Denied", { exact: true })).toBeVisible();
    expect(await decisionsSeen(t("deny"))).toEqual([
      { from: lb.operator_id, reply_to: asks.deny, decision: "deny", verified_sender_role: "operator" },
    ]);
  });

  await test.step("agent text renders as text only", async () => {
    await row(page, "xss").locator("button.row").click();
    await expect(row(page, "xss")).toContainText(`<img src=x onerror="window.__xss=1;alert('img')">`);
    await expect(row(page, "xss")).toContainText(`<a href="javascript:alert('a')">click</a>`);
    await page.waitForTimeout(500);
    const injected = await page.evaluate(() => ({
      n: document.querySelectorAll("main img, main a, main script, main svg, main iframe").length,
      xss: (window as unknown as { __xss?: number }).__xss ?? null,
    }));
    expect(injected).toEqual({ n: 0, xss: null });
    expect(dialogs).toEqual([]);
    await row(page, "xss").locator("button.row").click(); // collapse again
    await shot(page, "decided");
  });

  await test.step("already decided: another tab approves first, this tab's Deny is refused", async () => {
    const other = await context.newPage();
    const auth2 = await authenticator(other);
    expect(await copyCredentials(auth, auth2)).toBe(1);
    await other.goto(url());
    await other.getByRole("button", { name: "Show requests" }).click();
    await row(other, "race").locator("button.row").click();
    await row(other, "race").getByRole("button", { name: "Approve", exact: true }).click();
    await expect(row(other, "race").getByText("Approved", { exact: true })).toBeVisible();
    // Bring the higher sign count back to the first tab's authenticator.
    expect(await copyCredentials(auth2, auth)).toBe(1);
    await other.close();

    await row(page, "race").locator("button.row").click();
    await row(page, "race").getByRole("button", { name: "Deny", exact: true }).click();
    await expect(row(page, "race").getByText("Already decided", { exact: true })).toBeVisible();
    await expect(row(page, "race").getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
    await shot(page, "already-decided");
    // list, approve, deny, and this Deny: four prompts, each inside its tap.
    await expectTapGestures(page, ["get", "get", "get", "get"]);
    expect(await decisionsSeen(t("race"))).toEqual([
      { from: lb.operator_id, reply_to: asks.race, decision: "approve", verified_sender_role: "operator" },
    ]);
  });

  await test.step("refresh lists only the undecided request", async () => {
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(row(page, "xss")).toBeVisible();
    for (const k of ["approve", "deny", "race"]) await expect(row(page, k)).toHaveCount(0);
    await expectTapGestures(page, ["get"]);
  });
});
