// Shared by test/e2e.spec.ts and test/real.spec.ts.
import type { Page } from "@playwright/test";

// Gesture spy. WebKit may refuse navigator.credentials.* when an awaited fetch sits
// between the tap and the call. The spy logs clicks, fetches, and passkey calls;
// `inTap` is true only while the click is still being dispatched (capture listener
// on window sets it, bubble listener on window clears it after the button's handler).
export async function installGestureSpy(page: Page) {
  await page.addInitScript(() => {
    const ev: { t: string; inTap: boolean; u?: string }[] = [];
    let inTap = false;
    (window as unknown as { __ev: typeof ev }).__ev = ev;
    window.addEventListener("click", () => { inTap = true; ev.push({ t: "click", inTap }); }, true);
    window.addEventListener("click", () => { inTap = false; }, false);
    const f = window.fetch.bind(window);
    window.fetch = (...a: Parameters<typeof fetch>) => { ev.push({ t: "fetch", inTap, u: String(a[0]) }); return f(...a); };
    const c = navigator.credentials;
    const get = c.get.bind(c), create = c.create.bind(c);
    c.get = (o?: CredentialRequestOptions) => { ev.push({ t: "get", inTap }); return get(o); };
    c.create = (o?: CredentialCreationOptions) => { ev.push({ t: "create", inTap }); return create(o); };
  });
}
// One entry per passkey call: did it start inside the tap, and how many fetches ran
// between the tap and the call (-1: no tap before it at all).
export async function gestureReport(page: Page) {
  return page.evaluate(() => {
    const ev = (window as unknown as { __ev: { t: string; inTap: boolean; u?: string }[] }).__ev;
    const calls: { t: string; inTap: boolean; fetchesSinceTap: number }[] = [];
    let since = -1;
    for (const e of ev) {
      if (e.t === "click") since = 0;
      else if (e.t === "fetch") { if (since >= 0) since++; }
      else calls.push({ t: e.t, inTap: e.inTap, fetchesSinceTap: since });
    }
    return calls;
  });
}
export const inTap = (t: string) => ({ t, inTap: true, fetchesSinceTap: 0 });
// A goto that changes only the #fragment keeps the same document (and spy log).
export async function clearGestures(page: Page) {
  await page.evaluate(() => { (window as unknown as { __ev: unknown[] }).__ev.length = 0; });
}
