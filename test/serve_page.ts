// Static server for the approve page in tests.
//
// It serves only the four page files. In index.html it rewrites the CSP connect-src
// from the production bus origin to the bus under test, unless the request has
// ?csp=raw (then the file is served exactly as shipped).
//
// Used two ways:
//   - imported by fake_bus.ts (fake-bus target);
//   - run directly for the real-bus target:
//       PAGE_PORT=18765 CONNECT_ORIGIN=http://127.0.0.1:18766 \
//         deno run --allow-net --allow-read --allow-env test/serve_page.ts

export const PROD_BUS_ORIGIN = "https://switchboard.russellzager.com";

const TYPES: Record<string, string> = {
  "/index.html": "text/html; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/config.js": "text/javascript; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
};

export function pageHandler(pageDir: string, connectOrigin: string) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname === "/" ? "/index.html" : url.pathname;
    const type = TYPES[p];
    if (!type) return new Response("not found", { status: 404 });
    let text = await Deno.readTextFile(`${pageDir}${p}`);
    if (p === "/index.html" && url.searchParams.get("csp") !== "raw") {
      text = text.replaceAll(PROD_BUS_ORIGIN, connectOrigin);
    }
    return new Response(text, { headers: { "content-type": type, "cache-control": "no-store" } });
  };
}

// Serve on both loopback families, because "localhost" may resolve to either.
export function servePage(port: number, handler: (r: Request) => Promise<Response>) {
  Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {} }, handler);
  Deno.serve({ port, hostname: "::1", onListen: () => {} }, handler);
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PAGE_PORT") ?? 18765);
  const connect = Deno.env.get("CONNECT_ORIGIN");
  if (!connect) {
    console.error("CONNECT_ORIGIN is required (the bus origin the page may call)");
    Deno.exit(2);
  }
  const dir = Deno.env.get("PAGE_DIR") ?? new URL("..", import.meta.url).pathname;
  servePage(port, pageHandler(dir, connect));
  // Health path for Playwright's webServer readiness check.
  console.log(`page http://localhost:${port}  connect-src ${connect}`);
}
