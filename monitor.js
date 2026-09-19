#!/usr/bin/env node
/**
 * TUB Checkout Monitor
 * --------------------
 * Opens every live Whop checkout in a real (headless) Chrome and only calls a page
 * healthy when Whop's payment fields have actually rendered — the same thing a
 * customer has to see before they can pay. "Page returned 200" is not enough:
 * on 16 Sep 2026 every page returned 200 all day while checkout was dead.
 *
 * PASS conditions (all must hold within TIMEOUT_MS):
 *   aieb        our embed rendered (#aieb-checkout), Whop's elements.js loaded,
 *               the Whop payment iframe inside #aieb-payment-element grew to
 *               >= MIN_MOUNT_HEIGHT px (fields drawn), .aieb-error is hidden,
 *               #aieb-pay (Complete Order) is visible.
 *   a2a         same, but after filling step 1 with the monitor identity and
 *               clicking "Continue to Payment". The POST that would create a GHL
 *               contact (and an abandoned cart) is BLOCKED, so no CRM side effects.
 *   a2a-clarity after Continue, step 2 shows the ClarityPay Apply button.
 *
 * Side-effect hygiene: Meta pixel, GA/GTM, Convert, WiserNotify, ManyChat,
 * FirstPromoter and the contact/pay API routes are blocked in the monitor browser,
 * so runs never show up as InitiateCheckout events, abandoned carts or payments.
 *
 * Usage:  node monitor.js [--summary] [--pages pages.json] [--state ./state] [--only id1,id2]
 * Env:    SLACK_WEBHOOK_URL   Slack incoming webhook (optional; prints to stdout if unset)
 *         RUN_URL             link to this run (GitHub Actions sets it in the workflow)
 *         STATUS_PAGE_URL     link to the status page, included in alerts (optional)
 *         MONITOR_EMAIL       identity used on 2-step checkouts (default checkout-monitor@theuncommonbusiness.co)
 * Exit:   0 all pass · 2 one or more pages FAIL · 3 the monitor itself broke
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ---------------------------------------------------------------- config
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const SUMMARY = args.includes("--summary");
const PAGES_FILE = path.resolve(flag("--pages", path.join(__dirname, "pages.json")));
const STATE_DIR = path.resolve(flag("--state", path.join(__dirname, "state")));
const ONLY = (flag("--only", "") || "").split(",").filter(Boolean);
const SHOTS_DIR = path.join(STATE_DIR, "screenshots");

const TIMEOUT_MS = 30000;          // total budget per attempt for payment to mount
const NAV_TIMEOUT_MS = 25000;      // page navigation
const MIN_MOUNT_HEIGHT = 100;      // px — Whop payment iframe is ~574px when rendered, 0 when not
const SLOW_MS = 10000;             // mount slower than this = WARN (degraded)
const CONCURRENCY = 3;
const HISTORY_DAYS = 7;
const RETRY_DELAY_MS = 20000;      // a page that fails is re-checked once before we alert

const MONITOR = {
  first: "Checkout",
  last: "Monitor",
  email: process.env.MONITOR_EMAIL || "checkout-monitor@theuncommonbusiness.co",
  phone: "+15555550100",
  company: "TUB Checkout Monitor",
};

const BLOCKED_HOSTS = [
  "facebook.com", "facebook.net", "google-analytics.com", "googletagmanager.com",
  "doubleclick.net", "convertexperiments.com", "wisernotify.com", "manychat.com",
  "mccdn.me", "firstpromoter.com", "cloudflareinsights.com", "hotjar.com", "clarity.ms",
];
// Never create a contact, an abandoned cart, or a payment from the monitor.
const BLOCKED_PATHS = [/\/api\/a2a\/contact/, /\/api\/[^/]*\/?contact/, /\/api\/a2a\/pay\b/, /\/api\/pay\b/, /\/api\/a2a\/claritypay/];

// Whop has moved its script host before (js.whop.cloud -> cdn.whop.com on 19 Sep 2026). Match any
// whop-owned host so a CDN move never reads as an outage again.
const WHOP_SCRIPT_RE = /https?:\/\/[^/]*whop\.[a-z]+(:\d+)?\/elements\/[^/]+\/elements\.js/;
const WHOP_IFRAME_SEL = 'iframe[src*="whop."][src*="payments/payment"]';
const WHOP_ANY_IFRAME_SEL = 'iframe[src*="whop."]';

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

// ---------------------------------------------------------------- helpers
const now = () => new Date().toISOString();
const ms = (t0) => Date.now() - t0;
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };
const writeJson = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 2)); };
const sleep = (t) => new Promise((r) => setTimeout(r, t));

function shouldBlock(url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (BLOCKED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h))) return true;
  return BLOCKED_PATHS.some((re) => re.test(u.pathname));
}

// ---------------------------------------------------------------- one check
async function checkPage(browser, pg) {
  const t0 = Date.now();
  const r = { id: pg.id, label: pg.label, funnel: pg.funnel, type: pg.type, url: pg.url, checkedAt: now(),
              status: "FAIL", reason: null, detail: null, timings: {}, elementsJs: null, blockedRequests: 0, screenshot: null };

  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "America/Chicago" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);

  await ctx.route("**/*", (route) => {
    if (shouldBlock(route.request().url())) { r.blockedRequests++; return route.abort("blockedbyclient"); }
    return route.continue();
  });

  // Watch Whop's script specifically: status, headers, timing, size.
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("request", (req) => {
    if (WHOP_SCRIPT_RE.test(req.url())) r.elementsJs = Object.assign(r.elementsJs || {}, { url: req.url(), requestedAt: ms(t0) });
  });
  page.on("response", async (resp) => {
    const u = resp.url();
    if (WHOP_SCRIPT_RE.test(u)) {
      const h = resp.headers();
      r.elementsJs = Object.assign(r.elementsJs || {}, { status: resp.status(), ms: ms(t0), cfMitigated: h["cf-mitigated"] || null, cacheControl: h["cache-control"] || null, cfCache: h["cf-cache-status"] || null });
    }
  });
  page.on("requestfailed", (req) => {
    if (WHOP_SCRIPT_RE.test(req.url())) {
      // Keep any status/headers we already saw (Chrome reports a 403 challenge page as
      // ERR_BLOCKED_BY_ORB *after* the response arrived) and add the failure reason.
      const prev = r.elementsJs || {};
      r.elementsJs = Object.assign(prev, { status: prev.status || 0, error: req.failure()?.errorText, ms: prev.ms || ms(t0) });
    }
  });

  try {
    // 1. Navigate
    const resp = await page.goto(pg.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    r.timings.nav = ms(t0);
    r.httpStatus = resp ? resp.status() : null;
    if (!resp || resp.status() >= 400) throw fail("page_http_error", `Page returned HTTP ${resp ? resp.status() : "no response"}`);

    const prefix = pg.type === "aieb" ? "aieb" : "a2a";
    const root = `#${prefix}-checkout`;

    // 2. Our embed must have rendered its container
    try { await page.waitForSelector(root, { timeout: 15000 }); }
    catch { throw fail("embed_missing", `${root} never appeared — our checkout embed (worker) did not render on this page`); }
    r.timings.embed = ms(t0);

    // 3. Two-step checkouts: fill step 1 and continue (contact API is blocked above)
    if (pg.type === "a2a" || pg.type === "a2a-clarity") {
      await page.fill("#a2a-first", MONITOR.first);
      await page.fill("#a2a-last", MONITOR.last);
      await page.fill("#a2a-email", MONITOR.email);
      await page.fill("#a2a-phone", MONITOR.phone);
      if (pg.seats) {
        for (let i = 0; i < pg.seats; i++) await page.click("#a2a-plus");
        const company = page.locator("#a2a-company");
        if (await company.isVisible().catch(() => false)) await company.fill(MONITOR.company);
      }
      const cont = page.locator("#a2a-continue");
      try { await cont.waitFor({ state: "visible", timeout: 5000 }); await page.waitForFunction(() => !document.querySelector("#a2a-continue").disabled, null, { timeout: 8000 }); }
      catch { throw fail("step1_blocked", "Continue to Payment never became clickable after filling step 1 (quote or validation broken)"); }
      await cont.click();
      try { await page.waitForFunction(() => { const p = document.querySelector("#a2a-pane2"); return p && !p.hidden && p.offsetHeight > 0; }, null, { timeout: 8000 }); }
      catch { throw fail("step2_missing", "Clicked Continue but step 2 (payment pane) never showed"); }
      r.timings.step2 = ms(t0);
    }

    // 4. ClarityPay variant: the pass condition is the Apply button
    if (pg.type === "a2a-clarity") {
      const applyBtn = page.locator("#a2a-pane2 button", { hasText: /apply/i }).first();
      try { await applyBtn.waitFor({ state: "visible", timeout: 10000 }); }
      catch { throw fail("clarity_apply_missing", "ClarityPay step 2 rendered without an Apply button"); }
      await assertNoError(page, prefix);
      r.timings.mount = ms(t0);
      r.status = "PASS"; r.detail = "ClarityPay Apply button rendered";
      return r;
    }

    // 5. Whop payment element must actually render (iframe grows from 0 to ~574px)
    const container = `#${prefix}-payment-element`;
    await page.locator(container).scrollIntoViewIfNeeded().catch(() => {});
    const remaining = Math.max(5000, TIMEOUT_MS - ms(t0));
    try {
      await page.waitForFunction(({ container, minH, sel }) => {
        const f = document.querySelector(`${container} ${sel}`);
        return !!f && f.offsetHeight >= minH;
      }, { container, minH: MIN_MOUNT_HEIGHT, sel: WHOP_IFRAME_SEL }, { timeout: remaining, polling: 250 });
    } catch {
      // Work out WHY so the alert says something useful
      const diag = await page.evaluate(({ container, prefix, anySel }) => {
        const err = document.querySelector(`.${prefix}-error`);
        const f = document.querySelector(`${container} ${anySel}`);
        const hostSeen = f ? (f.src.match(/^https?:\/\/([^/]+)/) || [])[1] : null;
        return {
          whopElements: typeof window.WhopElements,
          errorText: err && getComputedStyle(err).display !== "none" ? err.textContent.trim() : "",
          iframePresent: !!f, iframeHeight: f ? f.offsetHeight : null,
          containerHeight: document.querySelector(container)?.offsetHeight ?? null,
          hostSeen,
        };
      }, { container, prefix, anySel: WHOP_ANY_IFRAME_SEL });
      r.diag = diag;
      if (r.elementsJs && r.elementsJs.url && (r.elementsJs.status === undefined || r.elementsJs.status === 0 || r.elementsJs.error)) {
        // Chrome hides a blocked script response (ORB), so ask the same URL directly from this
        // runner and read the headers Cloudflare would have sent to the browser.
        try {
          const p0 = Date.now();
          const pr = await ctx.request.get(r.elementsJs.url, { timeout: 10000, headers: { "User-Agent": UA, Accept: "*/*" }, maxRedirects: 2 });
          const ph = pr.headers();
          r.elementsJs.probe = { status: pr.status(), ms: Date.now() - p0, cfMitigated: ph["cf-mitigated"] || null, cfRay: ph["cf-ray"] || null, server: ph["server"] || null, bytes: (await pr.body().catch(() => Buffer.alloc(0))).length };
          if (r.elementsJs.probe.cfMitigated) r.elementsJs.cfMitigated = r.elementsJs.probe.cfMitigated;
          if (!r.elementsJs.status && r.elementsJs.probe.status) r.elementsJs.status = r.elementsJs.probe.status;
        } catch (e) { r.elementsJs.probe = { error: String(e.message).split("\n")[0].slice(0, 120) }; }
      }
      if (r.elementsJs && r.elementsJs.cfMitigated) throw fail("cloudflare_challenge", `Cloudflare challenged the request for elements.js (cf-mitigated: ${r.elementsJs.cfMitigated}) — a script tag cannot answer a challenge, checkout renders blank`);
      if (r.elementsJs && r.elementsJs.status === 0) throw fail("elements_js_network_error", `elements.js failed at the network level: ${r.elementsJs.error || "unknown"}`);
      if (r.elementsJs && r.elementsJs.error) throw fail("elements_js_blocked", `elements.js returned HTTP ${r.elementsJs.status} but the browser refused to run it (${r.elementsJs.error})`);
      if (r.elementsJs && r.elementsJs.status >= 400) throw fail("elements_js_http_error", `elements.js returned HTTP ${r.elementsJs.status}`);
      if (!r.elementsJs && diag.whopElements === "function") throw fail("monitor_pattern_stale", `Whop's script executed but the monitor did not recognise its URL${diag.hostSeen ? ` (iframe host seen: ${diag.hostSeen})` : ""} — Whop may have moved hosts again. Checkout is probably FINE; update WHOP_SCRIPT_RE in monitor.js`);
      if (!r.elementsJs) throw fail("elements_js_not_requested", "Page never requested Whop's elements.js — embed did not reach loadElements()");
      if (diag.whopElements !== "function") throw fail("elements_js_not_executed", `elements.js downloaded (HTTP ${r.elementsJs.status}) but window.WhopElements is ${diag.whopElements}`);
      if (diag.errorText) throw fail("checkout_error_shown", `Checkout showed an error to the buyer: "${diag.errorText}"`);
      if (!diag.iframePresent) throw fail("payment_not_mounted", "elements.js loaded but no Whop payment iframe was mounted (payments.create failed or quote failed)");
      throw fail("payment_iframe_empty", `Whop payment iframe mounted but stayed ${diag.iframeHeight}px tall after ${Math.round(remaining / 1000)}s — fields never rendered`);
    }
    r.timings.mount = ms(t0);

    // 6. No error visible, pay button present
    await assertNoError(page, prefix);
    const payVisible = await page.locator(`#${prefix}-pay`).isVisible().catch(() => false);
    if (!payVisible) throw fail("pay_button_missing", `Payment rendered but #${prefix}-pay (Complete Order) is not visible`);

    r.status = r.timings.mount > SLOW_MS ? "WARN" : "PASS";
    r.detail = r.status === "WARN" ? `Payment fields rendered but took ${(r.timings.mount / 1000).toFixed(1)}s (slow)` : `Payment fields rendered in ${(r.timings.mount / 1000).toFixed(1)}s`;
    return r;
  } catch (e) {
    r.status = "FAIL";
    r.reason = e.code || "exception";
    r.detail = e.code ? e.message : `Monitor exception: ${e.message.split("\n")[0].slice(0, 300)}`;
    r.consoleErrors = consoleErrors.slice(0, 5);
    try {
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      const file = path.join(SHOTS_DIR, `${pg.id}.png`);
      await page.screenshot({ path: file, fullPage: false });
      r.screenshot = path.relative(STATE_DIR, file);
    } catch {}
    return r;
  } finally {
    r.timings.total = ms(t0);
    await ctx.close().catch(() => {});
  }
}

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

async function assertNoError(page, prefix) {
  const txt = await page.evaluate((prefix) => {
    const el = document.querySelector(`.${prefix}-error`);
    return el && getComputedStyle(el).display !== "none" ? el.textContent.trim() : "";
  }, prefix);
  if (txt) throw fail("checkout_error_shown", `Checkout showed an error to the buyer: "${txt}"`);
}

// ---------------------------------------------------------------- run all
async function runAll(pages) {
  const extra = (process.env.CHROMIUM_EXTRA_ARGS || "").split("|").filter(Boolean); // test hook, "|"-separated, e.g. --host-resolver-rules=...
  const browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled", ...extra] });
  const results = [];
  try {
    const queue = [...pages];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const pg = queue.shift();
        let res = await checkPage(browser, pg);
        if (res.status === "FAIL") {          // confirm before alerting — one blip is not an outage
          console.log(`  ↻ ${pg.id} failed (${res.reason}); re-checking in ${RETRY_DELAY_MS / 1000}s`);
          await sleep(RETRY_DELAY_MS);
          const again = await checkPage(browser, pg);
          again.firstAttempt = { status: res.status, reason: res.reason, detail: res.detail };
          res = again.status === "FAIL" ? again : Object.assign(again, { flapped: true });
        }
        results.push(res);
        console.log(`  ${icon(res.status)} ${pg.id.padEnd(22)} ${res.status.padEnd(4)} ${res.detail}${res.elementsJs ? `  [elements.js ${res.elementsJs.status} ${res.elementsJs.ms}ms]` : ""}`);
      }
    });
    await Promise.all(workers);
  } finally { await browser.close(); }
  return results.sort((a, b) => pages.findIndex((p) => p.id === a.id) - pages.findIndex((p) => p.id === b.id));
}

const icon = (s) => ({ PASS: "✅", WARN: "⚠️", FAIL: "🔴" }[s] || "❔");

// ---------------------------------------------------------------- slack
async function slack(text, blocks) {
  const url = process.env.SLACK_WEBHOOK_URL;
  const payload = { text, ...(blocks ? { blocks } : {}) };
  if (!url) { console.log("\n[slack: no SLACK_WEBHOOK_URL set — would have posted]\n" + text + "\n"); return; }
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) console.error("Slack webhook FAILED:", res.status, await res.text());
    else console.log(`[slack] posted OK (${res.status}): ${text.split("\n")[0].slice(0, 90)}`);
  } catch (e) { console.error("Slack webhook ERROR:", e.message); }
}

function links() {
  const parts = [];
  if (process.env.STATUS_PAGE_URL) parts.push(`<${process.env.STATUS_PAGE_URL}|status page>`);
  if (process.env.RUN_URL) parts.push(`<${process.env.RUN_URL}|this run + screenshots>`);
  return parts.length ? "\n" + parts.join(" · ") : "";
}

async function notify(results, prev, meta) {
  const prevBy = Object.fromEntries((prev.results || []).map((r) => [r.id, r]));
  const failing = results.filter((r) => r.status === "FAIL");
  const newlyFailing = failing.filter((r) => !prevBy[r.id] || prevBy[r.id].status !== "FAIL");
  const stillFailing = failing.filter((r) => prevBy[r.id] && prevBy[r.id].status === "FAIL");
  const recovered = results.filter((r) => r.status !== "FAIL" && prevBy[r.id] && prevBy[r.id].status === "FAIL");
  const warns = results.filter((r) => r.status === "WARN");

  if (newlyFailing.length) {
    const sameReason = newlyFailing.length >= 5 && new Set(newlyFailing.map((r) => r.reason)).size === 1;
    const sanity = sameReason ? `\n⚠️ _${newlyFailing.length} pages failed at once with the same reason (${newlyFailing[0].reason}). When everything fails simultaneously right after a healthy streak, suspect a change on Whop's or our side that the monitor doesn't recognise yet — open one checkout in a real browser before escalating._` : "";
    const lines = newlyFailing.map((r) => `• *${r.label}* — ${r.detail}\n   <${r.url}|${r.url.replace("https://", "")}>` + (r.elementsJs ? `  · elements.js HTTP ${r.elementsJs.status}${r.elementsJs.cfMitigated ? ` (cf-mitigated: ${r.elementsJs.cfMitigated})` : ""}` : ""));
    await slack(`🔴 *CHECKOUT DOWN — ${newlyFailing.length} page${newlyFailing.length > 1 ? "s" : ""} failing* (confirmed on 2 attempts, 20s apart)\n${lines.join("\n")}` +
      (stillFailing.length ? `\n_${stillFailing.length} other page(s) still failing from earlier._` : "") +
      `\n*Checked from:* ${meta.vantage}${sanity}${links()}`);
  } else if (stillFailing.length && meta.everyNthReminder) {
    await slack(`🔴 *Still down:* ${stillFailing.map((r) => r.label).join(", ")} — failing since ${prevBy[stillFailing[0].id].failingSince || "earlier"}${links()}`);
  }
  if (recovered.length) {
    await slack(`✅ *Recovered:* ${recovered.map((r) => `*${r.label}*`).join(", ")} — payment fields rendering again.${links()}`);
  }
  if (warns.length && !newlyFailing.length) {
    const fresh = warns.filter((r) => !prevBy[r.id] || prevBy[r.id].status !== "WARN");
    if (fresh.length) await slack(`⚠️ *Slow checkout:* ${fresh.map((r) => `${r.label} (${(r.timings.mount / 1000).toFixed(1)}s to render payment)`).join(", ")}. Working, but buyers on weak connections may give up.${links()}`);
  }
}

async function dailySummary(results, history) {
  const since = Date.now() - 24 * 3600 * 1000;
  const day = history.filter((h) => new Date(h.t).getTime() >= since);
  const checks = day.reduce((n, h) => n + h.r.length, 0);
  const fails = day.reduce((n, h) => n + h.r.filter((x) => x.s === "FAIL").length, 0);
  const pagesFailed = [...new Set(day.flatMap((h) => h.r.filter((x) => x.s === "FAIL").map((x) => x.id)))];
  const nowFailing = results.filter((r) => r.status === "FAIL");
  const avgMount = Math.round(results.filter((r) => r.timings.mount).reduce((a, r) => a + r.timings.mount, 0) / Math.max(1, results.filter((r) => r.timings.mount).length));
  const head = nowFailing.length ? `🔴 *Checkout monitor — daily summary: ${nowFailing.length} page(s) currently DOWN*` : `✅ *Checkout monitor — daily summary: all ${results.length} checkouts healthy*`;
  await slack(`${head}\n• ${checks} checks in the last 24h across ${results.length} pages, ${fails} failures${pagesFailed.length ? ` (${pagesFailed.join(", ")})` : ""}\n• Avg time for Whop payment fields to render right now: ${(avgMount / 1000).toFixed(1)}s\n• Monitor is alive — this message proves it. If you stop seeing it, the monitor itself is broken.${links()}`);
}

// ---------------------------------------------------------------- main
(async () => {
  const cfg = readJson(PAGES_FILE, null);
  if (!cfg) { console.error("Cannot read", PAGES_FILE); process.exit(3); }
  let pages = cfg.pages.filter((p) => p.enabled !== false);
  if (ONLY.length) pages = pages.filter((p) => ONLY.includes(p.id));
  const vantage = process.env.VANTAGE || (process.env.GITHUB_ACTIONS ? `GitHub Actions runner (${process.env.RUNNER_NAME || "cloud"})` : require("os").hostname());
  const meta = { vantage, everyNthReminder: new Date().getUTCMinutes() < 30 && new Date().getUTCHours() % 4 === 0 };

  console.log(`TUB Checkout Monitor · ${now()} · ${pages.length} pages · from ${vantage}`);
  const prev = readJson(path.join(STATE_DIR, "status.json"), { results: [] });
  fs.rmSync(SHOTS_DIR, { recursive: true, force: true });

  let results;
  try { results = await runAll(pages); }
  catch (e) {
    console.error("MONITOR ITSELF FAILED:", e);
    await slack(`🚨 *Checkout monitor itself failed* (browser/runner error, NOT a checkout result): ${String(e.message).slice(0, 300)}${links()}`);
    process.exit(3);
  }

  // carry "failing since" forward
  const prevBy = Object.fromEntries((prev.results || []).map((r) => [r.id, r]));
  for (const r of results) if (r.status === "FAIL") r.failingSince = prevBy[r.id]?.status === "FAIL" ? (prevBy[r.id].failingSince || prevBy[r.id].checkedAt) : r.checkedAt;

  const status = { updatedAt: now(), vantage, intervalMinutes: Number(process.env.INTERVAL_MINUTES || 30), runUrl: process.env.RUN_URL || null,
                   summary: { total: results.length, pass: results.filter((r) => r.status === "PASS").length, warn: results.filter((r) => r.status === "WARN").length, fail: results.filter((r) => r.status === "FAIL").length },
                   results };
  writeJson(path.join(STATE_DIR, "status.json"), status);

  const histFile = path.join(STATE_DIR, "history.json");
  const history = readJson(histFile, []).filter((h) => new Date(h.t).getTime() > Date.now() - HISTORY_DAYS * 86400 * 1000);
  history.push({ t: status.updatedAt, r: results.map((r) => ({ id: r.id, s: r.status, m: r.timings.mount || null, e: r.elementsJs ? r.elementsJs.status : null, why: r.reason })) });
  writeJson(histFile, history);

  await notify(results, prev, meta);
  if (SUMMARY) await dailySummary(results, history);

  // GitHub Actions job summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => `| ${icon(r.status)} ${r.status} | ${r.label} | ${r.detail} | ${r.elementsJs ? `${r.elementsJs.status} · ${r.elementsJs.ms}ms` : "—"} | [open](${r.url}) |`).join("\n");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Checkout monitor · ${status.summary.fail ? "🔴 FAILURES" : status.summary.warn ? "⚠️ degraded" : "✅ all healthy"}\n\n${status.updatedAt} · from ${vantage}\n\n| Status | Page | Result | elements.js | Link |\n|---|---|---|---|---|\n${rows}\n`);
  }

  console.log(`\n${status.summary.pass} pass · ${status.summary.warn} warn · ${status.summary.fail} fail`);
  process.exit(status.summary.fail ? 2 : 0);
})();
