import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

// Two targets:
//   default          test/fake_bus.ts (real WebAuthn verification, in-memory state)
//   E2E_TARGET=real  the real local cutout bus (tests/run_local_bus.py in the cutout repo),
//                    started by test/real_setup.ts; runs test/real.spec.ts only.

// Ports for the fake bus (test/fake_bus.ts) and the page it serves.
export const PAGE_PORT = Number(process.env.PAGE_PORT ?? 18765);
export const BUS_PORT = Number(process.env.BUS_PORT ?? 18766);
const REAL = process.env.E2E_TARGET === "real";

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

const fake: Partial<PlaywrightTestConfig> = {
  projects: [
    { name: "phone", testIgnore: /real\.spec\.ts/, use: phone },
    { name: "desktop", testIgnore: /real\.spec\.ts/, grep: /@shots/, use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: "deno run --config test/deno.json --allow-net --allow-read --allow-env test/fake_bus.ts",
    url: `http://127.0.0.1:${BUS_PORT}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PAGE_PORT: String(PAGE_PORT), BUS_PORT: String(BUS_PORT) },
    stdout: "pipe",
  },
};

const real: Partial<PlaywrightTestConfig> = {
  projects: [{ name: "real-phone", testMatch: /real\.spec\.ts/, use: phone }],
  globalSetup: "./test/real_setup.ts",
};

export default defineConfig({
  testDir: "test",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1, // one shared bus, reset (fake) or seeded per test
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    headless: true,
    // Lets one test load the page from a non-localhost name (config override must be ignored).
    launchOptions: { args: ["--host-resolver-rules=MAP approve.test 127.0.0.1"] },
  },
  ...(REAL ? real : fake),
});
