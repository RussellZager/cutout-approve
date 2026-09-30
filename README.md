# cutout-approve

The static page at `https://approve.russellzager.com` for [cutout](../cutout) v1.12 passkeys.
It does three things, chosen by the URL fragment:

| URL | What the owner sees |
|---|---|
| `#register=<token>` (from `cutout passkey add`) | **Add passkey** → "Passkey added. You can close this page." |
| `#code=WDJB-MJHT` (from `cutout login`) | The code, **Confirm** / **Not me** → "Signed in on your Mac." |
| no fragment | **Show requests** → one line per pending agent request; tap for full text; **Approve** / **Deny** |

Every action asks for the passkey again (Face ID / Touch ID). Each bus challenge is single use and bound to that one action: the invite, the login code, the list, or one `request_id` + decision. The page stores nothing: no cookies, no localStorage, no session.

The browser API it calls is the cutout v1.12 SPEC section "Passkeys and phone approvals"; the bus is the WebAuthn verifier.

## Files

| File | Purpose |
|---|---|
| `index.html` | Shell plus the CSP meta tag |
| `app.js` | All logic (ES module, no framework, no build step, no third-party code) |
| `style.css` | Light-only, mobile-first styles (there is no dark theme) |
| `config.js` | Bus base URL; a `?bus=` override works only on `localhost` / `127.0.0.1` |
| `CNAME` | GitHub Pages custom domain |
| `.nojekyll` | Serve files as-is |
| `test/` | Fake bus and Playwright tests (not used by the site) |

## Security notes

- Agent-written text is untrusted. `app.js` puts it in the DOM only as text nodes (`textContent`), so markup shows literally and URLs are never clickable. The code never uses `innerHTML`.
- CSP (meta tag): `default-src 'self'; connect-src <bus origin>; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'`. No inline scripts or styles.
- `frame-ancestors` cannot be set from a meta tag, and GitHub Pages cannot send response headers. So `app.js` refuses to run inside any frame ("Open this page directly.").
- The page has no secrets. The bus allows CORS only from this page's origin.
- **The RP ID is permanent.** Passkeys are bound to `approve.russellzager.com`. Moving the page to another host means registering new passkeys.

## Changing the bus URL

Edit `DEFAULT_BUS_BASE` in `config.js` **and** the `connect-src` origin in `index.html`. They must match, or the CSP blocks every request (the page then says "Network problem.").

## Deploy (GitHub Pages, custom domain)

Nothing is deployed yet. When approved:

```sh
gh repo create RussellZager/cutout-approve --public --source . --push
gh api -X POST repos/RussellZager/cutout-approve/pages -f 'source[branch]=main' -f 'source[path]=/'
gh api -X PUT repos/RussellZager/cutout-approve/pages -f cname=approve.russellzager.com
```

1. In Squarespace DNS add a CNAME record: host `approve`, data `russellzager.github.io`.
2. Wait for the certificate: `gh api repos/RussellZager/cutout-approve/pages --jq .https_certificate.state` must say `approved`.
3. Then enforce HTTPS: `gh api -X PUT repos/RussellZager/cutout-approve/pages -F https_enforced=true`.
4. Check: `curl -sI https://approve.russellzager.com/ | head -1` gives `200`.
5. On the bus, set `PASSKEY_RP_ID=approve.russellzager.com` and `PASSKEY_ORIGIN=https://approve.russellzager.com`.

## Test

Needs `deno` and `bun`. Playwright uses its own Chromium (`bunx playwright install chromium` if missing), never your normal browser profile.

```sh
bun install
bunx playwright test            # phone viewport: every test; desktop viewport: screenshot tests
test/mutation.sh                # breaks escaping, decision binding, frame guard, final-error UI; each named test must go red
SHOTS_DIR=/tmp/shots bunx playwright test   # where screenshots go (default test-results/shots)
```

- `test/fake_bus.ts` implements the browser routes of the bus with real WebAuthn verification (`@simplewebauthn/server`), the contract's CORS rules, and single-use bound challenges. It also serves the page on a second port, so page and bus are cross-origin. RP ID is `localhost`.
- The fake page server rewrites the CSP `connect-src` to the fake bus. `?csp=raw` serves the file as shipped; one test uses it to prove the browser enforces the CSP.
- `test/e2e.spec.ts` drives the page with Chrome's CDP virtual authenticator (CTAP2, internal, resident key, user verification). It covers register, login Confirm / Not me, list + approve + deny, expired code, cancelled passkey, network failure, an XSS probe, CSP, no dark mode, the localhost-only override, the manual base64url fallback, and frame refusal.

### Real local bus

```sh
E2E_TARGET=real bunx playwright test         # project real-phone: test/real.spec.ts only
MUT_TARGET=real test/mutation.sh             # real-bus mutation arms; each must go red
CUTOUT_REPO=/path/to/cutout E2E_TARGET=real bunx playwright test   # default: the usual cutout checkout
```

- `test/real_setup.ts` (globalSetup) starts `python3 tests/run_local_bus.py --passkeys-origin http://localhost:18765 --port 18766` in `CUTOUT_REPO`, then serves the page on **exactly `http://localhost:18765`** (the bus CORS and passkey origin are exact-match). Ports 18765 and 18766 must be free. Teardown sends SIGTERM only. Bus stderr goes to `test-results/real-bus.stderr.log`.
- `test/real.spec.ts` seeds only through the bus API (TypeScript ports of the invite / device / poll / ask / thread recipes), never through test-only routes. It checks that the CLI poll gets the token after Confirm and `access_denied` after Not me, and that the requester's thread shows each approve / deny with `verified_sender_role: operator`, and that a second decision gets "Already decided".
- `test/serve_page.ts` is the shared page server (CSP `connect-src` rewrite, `?csp=raw`), used by both targets.
- GitHub Pages also publishes `test/`, `package.json` and this README. They hold no secrets.
