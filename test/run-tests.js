// Runs monitor.js against the mock server in each failure mode and asserts the verdicts.
// Proves: (1) healthy pages PASS, (2) each real-world failure mode FAILs with the right reason,
// (3) the monitor never hits the contact API or the Meta pixel.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, "..");
const STATE = path.join(__dirname, ".state");
const RESOLVER = `--host-resolver-rules=MAP js.whop.cloud 127.0.0.1,MAP www.facebook.com 127.0.0.1`;

const cases = [
  // name,               url,                        expected status, expected reason
  ["aieb healthy",       "/aieb",                    "PASS", null],
  ["a2a healthy (2-step)", "/a2a",                   "PASS", null],
  ["clarity healthy",    "/a2a-clarity",             "PASS", null],
  ["aieb slow (12s)",    "/aieb?mode=slow",          "WARN", null],
  ["cloudflare challenge", "/aieb?mode=challenge",   "FAIL", "cloudflare_challenge"],
  ["network error",      "/aieb?mode=neterr",        "FAIL", "elements_js_network_error"],
  ["iframe never renders", "/aieb?mode=empty",       "FAIL", "payment_iframe_empty"],
  ["error shown to buyer", "/aieb?mode=error",       "FAIL", "checkout_error_shown"],
  ["embed missing",      "/nope",                    "FAIL", "page_http_error"],
  ["a2a challenge",      "/a2a?mode=challenge",      "FAIL", "cloudflare_challenge"],
];

(async () => {
  const server = spawn("node", [path.join(__dirname, "mock-server.js")], { env: { ...process.env, PORT }, stdio: "inherit" });
  await new Promise((r) => setTimeout(r, 800));
  let failed = 0;
  try {
    await fetch(`${BASE}/__reset`);
    const pages = { pages: cases.map(([name, url], i) => ({ id: `t${i}`, label: name, funnel: "test", type: url.startsWith("/a2a-clarity") ? "a2a-clarity" : url.startsWith("/a2a") ? "a2a" : "aieb", url: BASE + url, enabled: true })) };
    fs.rmSync(STATE, { recursive: true, force: true });
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(path.join(STATE, "pages.json"), JSON.stringify(pages));

    const t0 = Date.now();
    const run = spawnSync("node", [path.join(ROOT, "monitor.js"), "--pages", path.join(STATE, "pages.json"), "--state", STATE],
      { env: { ...process.env, CHROMIUM_EXTRA_ARGS: RESOLVER, SLACK_WEBHOOK_URL: "", VANTAGE: "test-harness" }, encoding: "utf8", timeout: 400000 });
    console.log(run.stdout); if (run.stderr) console.error(run.stderr);
    console.log(`monitor exit code ${run.status} in ${Math.round((Date.now() - t0) / 1000)}s\n`);

    const status = JSON.parse(fs.readFileSync(path.join(STATE, "status.json"), "utf8"));
    for (const [i, [name, , expStatus, expReason]] of cases.entries()) {
      const r = status.results.find((x) => x.id === `t${i}`);
      const ok = r && r.status === expStatus && (expReason === null || r.reason === expReason);
      if (!ok) failed++;
      console.log(`${ok ? "✔" : "✘"} ${name.padEnd(26)} got ${r ? r.status : "none"}${r && r.reason ? ` / ${r.reason}` : ""}  expected ${expStatus}${expReason ? ` / ${expReason}` : ""}`);
    }
    const hits = await fetch(`${BASE}/__hits`).then((r) => r.json());
    const hygiene = hits.contact === 0 && hits.pixel === 0;
    if (!hygiene) failed++;
    console.log(`${hygiene ? "✔" : "✘"} side-effect hygiene: contact API hits=${hits.contact} (want 0), pixel hits=${hits.pixel} (want 0), elements.js fetched ${hits.elements}×`);
    const shots = fs.existsSync(path.join(STATE, "screenshots")) ? fs.readdirSync(path.join(STATE, "screenshots")) : [];
    console.log(`  screenshots captured for failures: ${shots.length}`);
    if (run.status !== 2) { failed++; console.log("✘ expected exit code 2 (failures present), got", run.status); }
  } finally { server.kill(); }
  console.log(failed ? `\n${failed} TEST(S) FAILED` : "\nALL TESTS PASSED");
  process.exit(failed ? 1 : 0);
})();
