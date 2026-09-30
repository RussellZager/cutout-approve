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

function needPasskeys() {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    throw new DOMException("no webauthn", "NotSupportedError");
  }
}
async function createPasskey(optionsJSON) {
  needPasskeys();
  const cred = await navigator.credentials.create({ publicKey: creationOptions(optionsJSON) });
  if (!cred) throw new DOMException("no credential", "NotAllowedError");
  return credentialJSON(cred);
}
// One fresh assertion. `bind` is the auth/options body that binds the challenge.
async function freshAssertion(bind) {
  needPasskeys();
  const { options } = await post("/v1/passkeys/auth/options", bind);
  const cred = await navigator.credentials.get({ publicKey: requestOptions(options) });
  if (!cred) throw new DOMException("no credential", "NotAllowedError");
  return credentialJSON(cred);
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
    case "bad_assertion": return { text: "Passkey not recognized. Run cutout passkey add first.", retry: false };
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

// An error line with an optional Retry button. Returns { el, show(err), clear() }.
function errorLine(ctx) {
  const text = h("span", { class: "error-text" });
  const retry = h("button", { type: "button", class: "retry", hidden: true }, "Retry");
  const el = h("p", { class: "error", role: "alert", hidden: true }, text, retry);
  let onRetry = null;
  retry.addEventListener("click", () => { if (onRetry) onRetry(); });
  return {
    el,
    show(err, again) {
      const { text: msg, retry: canRetry } = explain(err, ctx);
      setText(text, msg);
      onRetry = again;
      retry.hidden = !(canRetry && again);
      el.hidden = false;
      return canRetry;
    },
    clear() { el.hidden = true; retry.hidden = true; setText(text, ""); },
  };
}

// Run fn with the given buttons disabled; report failure on the error line.
// A final error (no Retry, e.g. an expired code) also hides the buttons,
// because pressing them again cannot work.
async function guarded(buttons, errs, fn, again) {
  errs.clear();
  for (const b of buttons) b.disabled = true;
  app.setAttribute("aria-busy", "true");
  try {
    await fn();
  } catch (err) {
    if (!errs.show(err, again)) for (const b of buttons) b.hidden = true;
  } finally {
    for (const b of buttons) b.disabled = false;
    app.removeAttribute("aria-busy");
  }
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
  const run = () => guarded([add], errs, async () => {
    const { options } = await post("/v1/passkeys/register/options", { token });
    const credential = await createPasskey(options);
    await post("/v1/passkeys/register/verify", { token, credential });
    done("Passkey added. You can close this page.");
  }, run);
  add.addEventListener("click", run);
  render(add, errs.el);
}

// ---------------------------------------------------------- mode: device code
const CODE_ALPHABET = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;
function codeMode(raw) {
  const norm = String(raw).toUpperCase().replace(/[-\s]/g, "");
  if (!CODE_ALPHABET.test(norm)) {
    render(h("p", { class: "error", role: "alert" }, "That code looks wrong. Run cutout login again."));
    return;
  }
  const code = `${norm.slice(0, 4)}-${norm.slice(4)}`;
  const errs = errorLine("device");
  const confirm = h("button", { type: "button", class: "primary" }, "Confirm");
  const notMe = h("button", { type: "button", class: "secondary" }, "Not me");
  const decide = (route, message) => {
    const run = () => guarded([confirm, notMe], errs, async () => {
      const assertion = await freshAssertion({ purpose: "device", user_code: code });
      await post(route, { user_code: code, assertion });
      done(message);
    }, run);
    return run;
  };
  confirm.addEventListener("click", decide("/v1/owner/device/approve", "Signed in on your Mac. You can close this page."));
  notMe.addEventListener("click", decide("/v1/owner/device/deny", "Sign-in blocked. You can close this page."));
  render(
    h("p", { class: "label", id: "code-label" }, "Code on your Mac"),
    h("p", { class: "code", "aria-labelledby": "code-label" }, code),
    h("div", { class: "actions" }, confirm, notMe),
    errs.el,
  );
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
  const context = Array.isArray(a.context) ? a.context : [];
  const ctxEls = context.map((c) => {
    const p = h("p", { class: "body" });
    setText(p, str(c && c.body));
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
  const decide = (decision) => {
    const run = () => guarded([approve, deny], errs, async () => {
      try {
        const assertion = await freshAssertion({ purpose: "decide", request_id: a.request_id, decision });
        await post("/v1/approvals/web/decide", { request_id: a.request_id, decision, assertion });
      } catch (err) {
        if (err instanceof ApiError && err.code === "already_decided") { finish("Already decided"); return; }
        throw err;
      }
      finish(decision === "approve" ? "Approved" : "Denied");
    }, run);
    return run;
  };
  approve.addEventListener("click", decide("approve"));
  deny.addEventListener("click", decide("deny"));

  const detail = h("div", { class: "detail", id, hidden: true },
    bodyEl,
    ctxEls.length ? h("div", { class: "context", "aria-label": "Earlier messages" }, ctxEls) : null,
    actions, errs.el);
  row.addEventListener("click", () => {
    const open = detail.hidden;
    detail.hidden = !open;
    row.setAttribute("aria-expanded", String(open));
  });
  return h("li", { class: "item", "data-request-id": str(a.request_id) }, row, detail);
}

function listMode() {
  const errs = errorLine("list");
  const show = h("button", { type: "button", class: "primary" }, "Show requests");
  const out = h("div", { class: "requests" });
  const run = () => guarded([show], errs, async () => {
    const assertion = await freshAssertion({ purpose: "list" });
    const data = await post("/v1/approvals/web/list", { assertion });
    const items = Array.isArray(data && data.approvals) ? data.approvals : [];
    out.replaceChildren(items.length
      ? h("ul", { class: "list", "aria-label": "Requests" }, items.map(requestItem))
      : h("p", { class: "muted" }, "No requests."));
    setText(show, "Refresh");
    show.className = "secondary";
  }, run);
  show.addEventListener("click", run);
  render(show, errs.el, out);
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
