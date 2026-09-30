import { defineConfig } from "@playwright/test";

// Ports for the fake bus (test/fake_bus.ts) and the page it serves.
export const PAGE_PORT = Number(process.env.PAGE_PORT ?? 18765);
export const BUS_PORT = Number(process.env.BUS_PORT ?? 18766);

export default defineConfig({
  testDir: "test",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1, // one shared in-memory fake bus, reset before every test
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    headless: true,
    // Lets one test load the page from a non-localhost name (config override must be ignored).
    launchOptions: { args: ["--host-resolver-rules=MAP approve.test 127.0.0.1"] },
  },
  projects: [
    { name: "phone", use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } },
    { name: "desktop", grep: /@shots/, use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: "deno run --config test/deno.json --allow-net --allow-read --allow-env test/fake_bus.ts",
    url: `http://127.0.0.1:${BUS_PORT}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PAGE_PORT: String(PAGE_PORT), BUS_PORT: String(BUS_PORT) },
    stdout: "pipe",
  },
});
