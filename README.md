# TUB Checkout Monitor

Every 30 minutes, a real headless Chrome opens **every live Whop checkout** and only calls it healthy when
**Whop's payment fields have actually rendered** — the thing a buyer has to see before they can pay.

Built after 16 Sep 2026, when every checkout page returned HTTP 200 all day while the payment form was blank
for anyone on certain home/office networks. A "does the page load" check would have said everything was fine.

## What one check does

1. Opens the checkout in Chrome (1280×900, real user agent).
2. Waits for **our** embed to render (`#aieb-checkout` / `#a2a-checkout`). Missing → `embed_missing`.
3. **A2A (two-step) pages only:** fills step 1 with `Checkout Monitor <checkout-monitor@theuncommonbusiness.co>`
   and clicks *Continue to Payment*. The `POST /api/a2a/contact` call is **blocked**, so no GHL contact and no
   abandoned-cart ping is ever created by the monitor.
4. Watches the request for `https://js.whop.cloud/elements/amber/elements.js` (status, `cf-mitigated`, timing).
5. Waits up to 30s for the Whop payment iframe inside `#…-payment-element` to grow to **≥ 100px**. It is 0px until
   the card fields draw and ~574px after. This is the pass/fail signal.
6. Confirms the `.…-error` box is hidden and *Complete Order* is visible.
7. Any FAIL is **re-checked once after 20s** before alerting. A screenshot is saved for every failure.

Result per page: `PASS` (rendered < 10s) · `WARN` (rendered, but > 10s) · `FAIL` with a reason:

| reason | meaning |
|---|---|
| `cloudflare_challenge` | Cloudflare challenged the request for elements.js (`cf-mitigated: challenge`). A script tag can't answer a challenge, so checkout renders blank. **This is what happened on 16 Sep.** |
| `elements_js_network_error` | elements.js never arrived (connection reset, DNS, TLS, timeout). |
| `elements_js_http_error` / `elements_js_blocked` | elements.js came back 4xx/5xx, or the browser refused to execute the response. |
| `elements_js_not_executed` | Downloaded, but `window.WhopElements` never appeared (broken bundle). |
| `payment_not_mounted` | Script ran but no payment iframe was created (`payments.create()` or our `quote()` failed). |
| `payment_iframe_empty` | Iframe created but stayed 0px — Whop's side never drew the fields. |
| `checkout_error_shown` | Our error box is visible to the buyer (text included in the alert). |
| `step1_blocked` / `step2_missing` | A2A step 1 → 2 flow broken (quote/validation). |
| `embed_missing` / `page_http_error` | Our worker didn't render, or the page itself is 4xx/5xx. |

Blocked in the monitor browser so runs leave **no trace in analytics or the CRM**: Meta pixel, GA/GTM,
Convert, WiserNotify, ManyChat, FirstPromoter, Cloudflare Insights, and the `contact` / `pay` / `claritypay` API routes.

## Where to see it

- **Slack** — set `SLACK_WEBHOOK_URL` (repo secret). You get: 🔴 one alert when a page goes down (with reason,
  elements.js status and links), a "still down" reminder every ~4h while it stays down, ✅ one message when it
  recovers, ⚠️ a note when a page turns slow, 🚨 a message if the *monitor itself* crashes, and a daily 9am ET
  summary that doubles as a heartbeat (if it stops arriving, the monitor is broken, not the checkout).
- **Status page** — `docs/index.html`, published by the workflow to the `monitor-state` branch together with
  `status.json` / `history.json`. Enable GitHub Pages → *Deploy from branch* → `monitor-state` / root, then put
  that URL in the repo variable `STATUS_PAGE_URL` so alerts link to it. Shows current status, render time, the
  elements.js response and a 48-check history strip per page.
- **GitHub Actions tab** — every run writes a job summary table; failure screenshots are attached as an artifact.

## Setup (10 minutes)

```bash
# 1. Create the repo in the The-Uncommon-Business org and push this folder
git init && git add -A && git commit -m "checkout monitor" && git branch -M main
git remote add origin git@github.com:The-Uncommon-Business/mktg-checkout-monitor.git && git push -u origin main
```

2. **Slack**: create an Incoming Webhook (Slack → Apps → Incoming Webhooks) for the channel you want alerts in
   (#war-room, or a new #checkout-monitor). Repo → Settings → Secrets → Actions → `SLACK_WEBHOOK_URL`.
3. **Pages**: Settings → Pages → Deploy from branch → `monitor-state` / `(root)`. The branch appears after the
   first run. Copy the Pages URL into Settings → Variables → Actions → `STATUS_PAGE_URL`.
4. Actions tab → *Checkout monitor* → **Run workflow** once to seed the state and confirm the Slack hook.
5. Optional: repo variable `MONITOR_EMAIL` if you want a different identity on the A2A step-1 form.

### Filter the monitor identity out of GHL (belt and braces)
The contact call is blocked client-side, so nothing should reach GHL. If you ever see
`checkout-monitor@theuncommonbusiness.co` in GHL or Whop, that means a new code path is creating records —
tell the build team, and add an exclusion for that email in the W2 abandoned-cart workflow meanwhile.

## Day-to-day

- **Change cadence**: edit the first `cron` line in `.github/workflows/checkout-monitor.yml`
  (`*/30` → `*/15` for cart-open / cart-close days). Also update `INTERVAL_MINUTES` there so the page says the right thing.
- **Add / pause a checkout**: edit `pages.json`. `type` is `aieb` (one-step), `a2a` (two-step) or `a2a-clarity`.
  Set `"enabled": false` to pause.
- **Check one page now**: Actions → Run workflow → `only: a2a-founder`.
- **Fire drill** (recommended weekly): temporarily change a URL in `pages.json` to a non-existent slug, run the
  workflow, confirm the 🔴 alert arrives, revert. Or run `npm test` locally — it replays every failure mode against
  a mock and asserts the verdicts, including the 16 Sep Cloudflare-challenge case.

## Run locally

```bash
npm install && npx playwright install chromium
node monitor.js                         # all pages, prints results, writes ./state/status.json
node monitor.js --only aieb-vip         # one page
SLACK_WEBHOOK_URL=https://hooks.slack.com/... node monitor.js --summary
npm test                                # mock-based test suite (no network needed)
```

## Known limits (read this)

- **Vantage point.** Runs come from GitHub's cloud runners (US datacenter IPs). The 16 Sep incident also hit
  *residential and office* networks specifically. A green board plus customer complaints means **believe the
  customers** — the monitor cannot see every ISP. To add a home/office vantage point, install a
  [self-hosted GitHub runner](https://docs.github.com/en/actions/hosting-your-own-runners) on a spare machine in
  an office and add it to the `runs-on` matrix; the code needs no changes.
- **Schedule drift.** GitHub may delay cron jobs by a few minutes under load. The status page shows a banner if
  the last check is older than 2.5× the interval.
- **It tests rendering, not paying.** The monitor never submits a payment. A Whop-side decline storm or a broken
  webhook after payment would not show here; watch the InitiateCheckout → Purchase ratio for that.
