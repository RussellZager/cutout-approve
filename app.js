// cutout approve page: add a passkey, confirm a CLI login code, approve or deny
// agent requests. Plain ES module, no framework, no third-party code.
//
// Safety rules:
// - Agent-written text is untrusted. It only ever reaches the DOM as text nodes
//   (textContent / createTextNode). This file never uses innerHTML or similar.
// - URLs in agent text stay text; nothing here creates links.
// - Nothing is stored: no cookies, no localStorage. Every action asks for a fresh
//   passkey assertion whose server challenge is bound to that one action.

import { BUS_BASE } from "./config.js";

const app = document.getElementById("app");

// ---------------------------------------------------------------- DOM helpers
// h("p", {class: "x"}, "text", node) -> element. Strings become text nodes.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "onclick") el.addEventListener("click", v);
    else if (k === "hidden") el.hidden = true;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}
function setText(el, text) { el.textContent = text; }
function render(...nodes) { app.replaceChildren(h("h1", { class: "brand" }, "cutout"), ...nodes); }

// ------------------------------------------------------------- base64url codec
function b64uToBuf(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
function bufToB64u(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --------------------------------------------------- WebAuthn JSON conversion
// Prefer the browser's own JSON helpers; fall back to converting by hand.
function creationOptions(json) {
  if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function") {
    return PublicKeyCredential.parseCreationOptionsFromJSON(json);
  }
  return {
    ...json,
    challenge: b64uToBuf(json.challenge),
    user: { ...json.user, id: b64uToBuf(json.user.id) },
    excludeCredentials: (json.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  };
}
function requestOptions(json) {
  if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function") {
    return PublicKeyCredential.parseRequestOptionsFromJSON(json);
  }
  return {
    ...json,
    challenge: b64uToBuf(json.challenge),
    allowCredentials: (json.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  };
}
function credentialJSON(cred) {
  if (typeof cred.toJSON === "function") return cred.toJSON();
  const r = cred.response;
  const out = {
    id: cred.id,
    rawId: bufToB64u(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    response: { clientDataJSON: bufToB64u(r.clientDataJSON) },
  };
  if (cred.authenticatorAttachment) out.authenticatorAttachment = cred.authenticatorAttachment;
  if (r.attestationObject) {
    out.response.attestationObject = bufToB64u(r.attestationObject);
    if (typeof r.getTransports === "function") out.response.transports = r.getTransports();
  } else {
    out.response.authenticatorData = bufToB64u(r.authenticatorData);
    out.response.signature = bufToB64u(r.signature);
    if (r.userHandle) out.response.userHandle = bufToB64u(r.userHandle);
  }
  return out;
}

// -------------------------------------------------------------------- bus API
class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
async function post(path, body) {
  let res;
  try {
    res = await fetch(BUS_BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new ApiError(0, "network");
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new ApiError(res.status, (data && typeof data.code === "string" && data.code) || `http_${res.status}`);
  return data;
}

const AUTH_OPTIONS = "/v1/passkeys/auth/options";

function needPasskeys() {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new DOMException("no webauthn", "NotSupportedError");
  }
}
// Both start the browser's passkey prompt synchronously, before their first await.
async function createPasskey(optionsJSON) {
  needPasskeys();
  const cred = await navigator.credentials.create({ publicKey: creationOptions(optionsJSON) });
  if (!cred) throw new DOMException("no credential", "NotAllowedError");
  return credentialJSON(cred);
}
async function getAssertion(optionsJSON) {
  needPasskeys();
  const cred = await navigator.credentials.get({ publicKey: requestOptions(optionsJSON) });
  if (!cred) throw new DOMException("no credential", "NotAllowedError");
  return credentialJSON(cred);
}

// ------------------------------------------------ prefetched passkey options
// Safari can refuse navigator.credentials.* when an awaited fetch runs between
// the tap and the call. So the options (with their server challenge) are fetched
// BEFORE the tap, and a tap starts the prompt at once.
// Challenges live 300 s; after FRESH_MS the page gets a new one and asks for one
// more tap. It never retries on its own.
const FRESH_MS = 240_000;
class Ticket {
  constructor(path, body) {
    this.path = path;
    this.body = body;
    this.state = "idle"; // idle | loading | ready | used | failed
    this.options = null;
    this.at = 0;
    this.error = null;
    this.seq = 0;
    this.listeners = [];
  }
  on(fn) { this.listeners.push(fn); }
  emit() { for (const fn of this.listeners) fn(this); }
  load() {
    const seq = ++this.seq;
    this.state = "loading";
    this.options = null;
    this.error = null;
    this.emit();
    post(this.path, this.body).then((data) => {
      if (seq !== this.seq) return;
      this.options = data && data.options;
      this.at = Date.now();
      this.state = "ready";
      this.emit();
    }, (err) => {
      if (seq !== this.seq) return;
      this.error = err;
      this.state = "failed";
      this.emit();
    });
  }
  ensure() { if (this.state === "idle") this.load(); }
  // Synchronous. Fresh options, single use; null when not ready or too old.
  take() {
    if (this.state !== "ready" || Date.now() - this.at > FRESH_MS) return null;
    const options = this.options;
    this.state = "used";
    this.options = null;
    this.emit();
    return options;
  }
}

// ------------------------------------------------------------ plain-word errors
// ctx: "register" | "device" | "list" | "decide". Returns { text, retry }.
function explain(err, ctx) {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
      case "AbortError": return { text: "Passkey cancelled.", retry: true };
      case "InvalidStateError": return { text: "This device already has a passkey.", retry: false };
      case "NotSupportedError": return { text: "This browser can't use passkeys.", retry: false };
      case "SecurityError": return { text: "Passkeys don't work on this address.", retry: false };
    }
    return { text: "Passkey problem. Try again.", retry: true };
  }
  if (!(err instanceof ApiError)) return { text: "Something went wrong. Try again.", retry: true };
  switch (err.code) {
    case "network": return { text: "Network problem. Try again.", retry: true };
    case "rate_limited": return { text: "Too many tries. Wait a minute, then try again.", retry: true };
    case "unavailable": return { text: "Server busy. Try again.", retry: true };
    case "bad_challenge": return { text: "That took too long. Try again.", retry: true };
    case "bad_invite": return { text: "That link expired. Run cutout passkey add again.", retry: false };
    case "duplicate_credential": return { text: "This passkey is already added.", retry: false };
    case "name_taken": return { text: "That name is taken. Run cutout passkey add with another name.", retry: false };
    case "bad_registration": return { text: "Passkey not accepted. Try again.", retry: true };
    case "bad_assertion": return { text: "Passkey not recognized. Try again, or run cutout passkey add.", retry: true };
    case "not_found":
      if (ctx === "device") return { text: "That code expired. Run cutout login again.", retry: false };
      return { text: "Not available. Try again later.", retry: false };
    case "already_decided":
      if (ctx === "device") return { text: "That code was already used. Run cutout login again.", retry: false };
      return { text: "Already decided.", retry: false };
    case "not_an_approval_request": return { text: "That request is gone.", retry: false };
  }
  return { text: "Something went wrong. Try again.", retry: true };
}

// An error line with an optional Retry button. Returns { el, retryEl, show(err, again), clear() }.
function errorLine(ctx) {
  const text = h("span", { class: "error-text" });
  const retry = h("button", { type: "button", class: "retry", hidden: true }, "Retry");
  const el = h("p", { class: "error", role: "alert", hidden: true }, text, retry);
  let onRetry = null;
  retry.addEventListener("click", () => { if (onRetry) onRetry(); });
  return {
    el,
    retryEl: retry,
    show(err, again) {
      const { text: msg, retry: canRetry } = explain(err, ctx);
      setText(text, msg);
      onRetry = again;
      retry.hidden = !(canRetry && again);
      el.hidden = false;
      return canRetry;
    },
    clear() { el.hidden = true; retry.hidden = true; setText(text, ""); onRetry = null; },
  };
}

// Wire buttons to prefetched options: pairs = [[button, ticket], ...].
// A tap (or a Retry tap) calls prompt(options) with no await before it; then
// after(button, credentialJSON) finishes the job. Buttons stay disabled until
// their options are ready. A final error (no Retry, e.g. an expired code) hides
// the buttons, because pressing them again cannot work.
function passkeyButtons({ errs, pairs, prompt, after, reloadAfter = false }) {
  const buttons = pairs.map(([b]) => b);
  const tickets = [...new Set(pairs.map(([, t]) => t))];
  let busy = false;
  let waitFor = null; // the ticket the visible Retry needs
  let loadError = false; // the visible error came from fetching options
  const sync = () => {
    for (const [b, t] of pairs) b.disabled = busy || t.state !== "ready";
    errs.retryEl.disabled = busy || (waitFor !== null && waitFor.state === "loading");
  };
  const stop = () => { for (const b of buttons) b.hidden = true; };

  for (const t of tickets) {
    t.on(() => {
      if (t.state === "failed") {
        loadError = true;
        waitFor = t;
        if (!errs.show(t.error, () => t.load())) stop();
      } else if (t.state === "ready" && loadError && waitFor === t) {
        loadError = false;
        waitFor = null;
        errs.clear();
      }
      sync();
    });
  }

  function tap(b, t) {
    if (busy) return;
    const options = t.take();
    if (!options) {
      if (t.state === "ready") {
        // Older than FRESH_MS: get a new challenge and ask for one more tap.
        t.load();
        loadError = false;
        waitFor = t;
        errs.show(new ApiError(401, "bad_challenge"), () => tap(b, t));
        sync();
      }
      return;
    }
    errs.clear();
    loadError = false;
    waitFor = null;
    let cred;
    try { cred = prompt(options); } catch (e) { cred = Promise.reject(e); }
    busy = true;
    app.setAttribute("aria-busy", "true");
    sync();
    (async () => {
      try {
        await after(b, await cred);
        if (reloadAfter) t.load();
      } catch (err) {
        waitFor = t;
        const canRetry = errs.show(err, () => tap(b, t));
        if (canRetry) t.load(); // a new challenge for the Retry tap
        else stop();
      } finally {
        busy = false;
        app.removeAttribute("aria-busy");
        sync();
      }
    })();
  }

  for (const [b, t] of pairs) b.addEventListener("click", () => tap(b, t));
  sync();
  return { load() { for (const t of tickets) t.ensure(); } };
}

function done(message) {
  render(h("p", { class: "result", role: "status" }, message));
}

// ------------------------------------------------------------ mode: register
function registerMode(token) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    render(h("p", { class: "error", role: "alert" }, "That link looks wrong. Run cutout passkey add again."));
    return;
  }
  const errs = errorLine("register");
  const add = h("button", { type: "button", class: "primary" }, "Add passkey");
  const ticket = new Ticket("/v1/passkeys/register/options", { token });
  render(add, errs.el);
  passkeyButtons({
    errs, pairs: [[add, ticket]], prompt: createPasskey,
    after: async (_b, credential) => {
      await post("/v1/passkeys/register/verify", { token, credential });
      done("Passkey added. You can close this page.");
    },
  }).load();
}

// ---------------------------------------------------------- mode: device code
const CODE_ALPHABET = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;
const normCode = (raw) => String(raw).toUpperCase().replace(/[-\s]/g, "");
function codeMode(raw) {
  const norm = normCode(raw);
  if (!CODE_ALPHABET.test(norm)) {
    render(h("p", { class: "error", role: "alert" }, "That code looks wrong. Run cutout login again."));
    return;
  }
  const code = `${norm.slice(0, 4)}-${norm.slice(4)}`;
  const errs = errorLine("device");
  const confirm = h("button", { type: "button", class: "primary" }, "Confirm");
  const notMe = h("button", { type: "button", class: "secondary" }, "Not me");
  const routes = new Map([
    [confirm, ["/v1/owner/device/approve", "Signed in on your Mac. You can close this page."]],
    [notMe, ["/v1/owner/device/deny", "Sign-in blocked. You can close this page."]],
  ]);
  // One device challenge serves either button (it is bound to the code only).
  const ticket = new Ticket(AUTH_OPTIONS, { purpose: "device", user_code: code });
  render(
    h("p", { class: "label", id: "code-label" }, "Code on your Mac"),
    h("p", { class: "code", "aria-labelledby": "code-label" }, code),
    h("p", { class: "warn" }, "Only confirm if you just ran cutout login and this code matches."),
    h("div", { class: "actions" }, confirm, notMe),
    errs.el,
  );
  passkeyButtons({
    errs, pairs: [[confirm, ticket], [notMe, ticket]], prompt: getAssertion,
    after: async (b, assertion) => {
      const [route, message] = routes.get(b);
      await post(route, { user_code: code, assertion });
      done(message);
    },
  }).load();
}

// ------------------------------------------------------------ mode: approvals
function age(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function firstLine(text) {
  const line = String(text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.trim().slice(0, 200) || "(no text)";
}
const str = (v) => (typeof v === "string" ? v : "");

// The bus cuts each body to BODY_CAP characters (code points) and sends no flag
// (page_api.md). Honour a flag if one appears; else text at the cap was cut.
const BODY_CAP = 2000;
function wasShortened(text, item) {
  if (item && (item.truncated === true || item.body_truncated === true)) return true;
  return Array.from(text).length >= BODY_CAP;
}
function markShortened(el, text, item) {
  if (wasShortened(text, item)) el.append(" ", h("span", { class: "shortened" }, "(shortened)"));
}

let rowSeq = 0;
function requestItem(a) {
  const id = `req-${++rowSeq}`;
  const badge = h("span", { class: "badge", hidden: true });
  const row = h("button", { type: "button", class: "row", "aria-expanded": "false", "aria-controls": id },
    h("span", { class: "row-top" },
      h("span", { class: "from" }, str(a.from) || "(unknown)"),
      badge,
      h("time", { class: "age", datetime: str(a.created_at) }, age(a.created_at))),
    h("span", { class: "first" }, firstLine(a.body)));

  const bodyEl = h("p", { class: "body" });
  setText(bodyEl, str(a.body));
  markShortened(bodyEl, str(a.body), a);
  const context = Array.isArray(a.context) ? a.context : [];
  const ctxEls = context.map((c) => {
    const p = h("p", { class: "body" });
    setText(p, str(c && c.body));
    markShortened(p, str(c && c.body), c);
    return h("div", { class: "ctx" },
      h("p", { class: "ctx-meta" }, `${str(c && c.from)} · ${age(c && c.created_at)}`), p);
  });

  const errs = errorLine("decide");
  const approve = h("button", { type: "button", class: "primary" }, "Approve");
  const deny = h("button", { type: "button", class: "secondary" }, "Deny");
  const actions = h("div", { class: "actions" }, approve, deny);
  const finish = (label) => {
    actions.remove();
    setText(badge, label);
    badge.hidden = false;
    badge.className = `badge ${label === "Approved" ? "ok" : label === "Denied" ? "no" : ""}`;
  };
  // Each decision has its own challenge, bound to request_id + decision.
  const decideTicket = (decision) => new Ticket(AUTH_OPTIONS, { purpose: "decide", request_id: a.request_id, decision });
  const decisionOf = new Map([[approve, "approve"], [deny, "deny"]]);
  const wired = passkeyButtons({
    errs, pairs: [[approve, decideTicket("approve")], [deny, decideTicket("deny")]], prompt: getAssertion,
    after: async (b, assertion) => {
      const decision = decisionOf.get(b);
      try {
        await post("/v1/approvals/web/decide", { request_id: a.request_id, decision, assertion });
      } catch (err) {
        if (err instanceof ApiError && err.code === "already_decided") { finish("Already decided"); return; }
        throw err;
      }
      finish(decision === "approve" ? "Approved" : "Denied");
    },
  });

  const detail = h("div", { class: "detail", id, hidden: true },
    bodyEl,
    ctxEls.length ? h("div", { class: "context", "aria-label": "Earlier messages" }, ctxEls) : null,
    actions, errs.el);
  row.addEventListener("click", () => {
    const open = detail.hidden;
    detail.hidden = !open;
    row.setAttribute("aria-expanded", String(open));
    if (open) wired.load(); // fetch both decision challenges before Approve/Deny can be tapped
  });
  return h("li", { class: "item", "data-request-id": str(a.request_id) }, row, detail);
}

// "Have a code?": the fallback when the CLI cannot open the browser.
function codeEntry() {
  const input = h("input", {
    id: "code-in", type: "text", autocomplete: "off", autocapitalize: "characters",
    spellcheck: "false", maxlength: "12", placeholder: "XXXX-XXXX",
  });
  const open = h("button", { type: "button", class: "secondary open" }, "Open");
  const bad = h("p", { class: "error", role: "alert", hidden: true }, "That code looks wrong.");
  const go = () => {
    const norm = normCode(input.value);
    if (!CODE_ALPHABET.test(norm)) { bad.hidden = false; return; }
    location.hash = `code=${norm.slice(0, 4)}-${norm.slice(4)}`;
  };
  open.addEventListener("click", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  input.addEventListener("input", () => { bad.hidden = true; });
  return h("div", { class: "have-code" },
    h("label", { class: "label", for: "code-in" }, "Have a code?"),
    h("div", { class: "code-entry" }, input, open),
    bad);
}

function listMode() {
  const errs = errorLine("list");
  const show = h("button", { type: "button", class: "primary" }, "Show requests");
  const out = h("div", { class: "requests" });
  const ticket = new Ticket(AUTH_OPTIONS, { purpose: "list" });
  render(show, errs.el, out, codeEntry());
  passkeyButtons({
    errs, pairs: [[show, ticket]], prompt: getAssertion, reloadAfter: true,
    after: async (_b, assertion) => {
      const data = await post("/v1/approvals/web/list", { assertion });
      const items = Array.isArray(data && data.approvals) ? data.approvals : [];
      out.replaceChildren(items.length
        ? h("ul", { class: "list", "aria-label": "Requests" }, items.map(requestItem))
        : h("p", { class: "muted" }, "No requests."));
      setText(show, "Refresh");
      show.className = "secondary";
    },
  }).load();
}

// ------------------------------------------------------------------- routing
function start() {
  if (window.top !== window.self) {
    render(h("p", { class: "error", role: "alert" }, "Open this page directly."));
    return;
  }
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has("register")) registerMode(params.get("register") ?? "");
  else if (params.has("code")) codeMode(params.get("code") ?? "");
  else listMode();
}

window.addEventListener("hashchange", start);
start();
