// Mock of the real checkout pages, faithful to the DOM the monitor asserts on.
// Modes (query ?mode=): ok (default) | slow | challenge | neterr | empty | error | noembed
// Records hits to /api/a2a/contact and /tr (fake pixel) so tests can prove they were blocked.
const http = require("http");
const url = require("url");
const hits = { contact: 0, pixel: 0, elements: 0 };

const elementsJs = `
(function(){
  window.WhopElements = function(){};
  window.__mountWhop = function(containerSel, mode){
    var c = document.querySelector(containerSel);
    var wrap = document.createElement('div'); wrap.style.position='relative';
    var f = document.createElement('iframe');
    f.src = 'http://cdn.whop.com:PORT/frame/elements/amber/payments/payment/en/index-D9B24790.html#host=x';
    // Real path is js.whop.cloud/...; monitor matches on "js.whop.cloud" AND "payments/payment" — mock sets both via srcdoc-less trick below
    f.setAttribute('data-src-real','https://js.whop.cloud/elements/amber/payments/payment/en/index.html');
    f.style.cssText='border:0;width:100%;height:0px;display:block';
    wrap.appendChild(f); c.appendChild(wrap);
    var delay = mode==='slow' ? 12000 : 1500;
    if (mode !== 'empty') setTimeout(function(){ f.style.height='574px'; }, delay);
  };
})();`;

function page(kind, mode) {
  const p = kind === "aieb" ? "aieb" : "a2a";
  const scriptSrc = mode === "noembed" ? "" : `http://cdn.whop.com:PORT/elements/amber/elements.js?mode=${mode}`;
  const twoStep = kind !== "aieb";
  return `<!doctype html><html><head><title>Mock ${kind}</title>
<script src="http://www.facebook.com:PORT/tr?id=1"></script>
</head><body>
<div id="${p}-checkout" style="padding:20px">
  ${twoStep ? `
  <div id="a2a-pane1">
    <input id="a2a-first" placeholder="First"><input id="a2a-last" placeholder="Last">
    <input id="a2a-email" type="email" placeholder="Email"><input id="a2a-email-confirm" type="email" placeholder="Confirm Email"><input id="a2a-phone" type="tel" placeholder="Phone">
    ${mode === "newfield" ? `<input id="a2a-referral" type="text" placeholder="How did you hear about us?">` : ""}
    <button id="a2a-minus">−</button><span id="a2a-qty">0</span><button id="a2a-plus">+</button>
    <div id="a2a-companywrap" hidden><input id="a2a-company"></div>
    <button id="a2a-continue">Continue to Payment →</button>
    <p id="a2a-notice" hidden></p>
  </div>
  <div id="a2a-pane2" hidden>
    ${kind === "a2a-clarity" ? `<button class="a2a-btn">Apply with ClarityPay</button>` : `<div id="a2a-payment-element" style="min-height:60px"></div><button id="a2a-pay">Complete Order</button>`}
  </div>` : `
  <div id="aieb-payment-element" style="min-height:60px"></div>
  <button id="aieb-pay">Complete Order</button>`}
  <div class="${p}-error" style="display:none"></div>
</div>
<script>
(function(){
  var mode = ${JSON.stringify(mode)};
  function showError(msg){ var e=document.querySelector('.${p}-error'); e.textContent=msg; e.style.display='block'; }
  function loadElements(){ return new Promise(function(res,rej){
    if (window.WhopElements) return res();
    var s=document.createElement('script'); s.src=${JSON.stringify(scriptSrc)};
    s.onload=function(){res()}; s.onerror=function(){rej(new Error('Could not load payment elements'))};
    document.head.appendChild(s);
  });}
  function mount(){
    loadElements().then(function(){
      if (mode==='error') return showError('Card declined test error');
      window.__mountWhop('#${p}-payment-element', mode);
    }).catch(function(){ showError('Checkout could not load. Please refresh the page.'); });
  }
  ${twoStep ? `
  // Mirrors the live A2A form (6 Oct 2026): Continue is never disabled; pressing it checks the fields and
  // shows a red notice right after the first missing one.
  function v(id){ var e=document.getElementById(id); return e ? e.value.trim() : ''; }
  function missing(){
    if (!v('a2a-first')) return ['a2a-first','Enter your first name.'];
    if (!/@/.test(v('a2a-email'))) return ['a2a-email','Enter a valid email address.'];
    if (!v('a2a-email-confirm')) return ['a2a-email-confirm','Please confirm your email address.'];
    if (v('a2a-email-confirm').toLowerCase() !== v('a2a-email').toLowerCase()) return ['a2a-email-confirm',"Email addresses don't match."];
    if (!v('a2a-phone')) return ['a2a-phone','Enter your phone number.'];
    if (document.getElementById('a2a-referral') && !v('a2a-referral')) return ['a2a-referral','Tell us how you heard about us.'];
    if (mode==='stuck') return ['a2a-first','Something went wrong. Please try again.'];
    return null;
  }
  function notice(id,msg){ var n=document.getElementById('a2a-notice'); var f=document.getElementById(id); f.parentNode.insertBefore(n, f.nextSibling); n.textContent=msg; n.hidden=false; f.focus(); }
  document.querySelector('#a2a-plus').addEventListener('click', function(){ document.querySelector('#a2a-qty').textContent='1'; document.querySelector('#a2a-companywrap').hidden=false; });
  document.querySelector('#a2a-continue').addEventListener('click', function(){
    var m=missing(); if (m) return notice(m[0], m[1]);
    document.getElementById('a2a-notice').hidden=true;
    document.querySelector('#a2a-pane1').hidden=true; document.querySelector('#a2a-pane2').hidden=false;
    fetch('/api/a2a/contact',{method:'POST',body:'{}'}).catch(function(){});
    ${kind === "a2a-clarity" ? "" : "mount();"}
  });` : `mount();`}
})();
</script></body></html>`;
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const host = req.headers.host || "";
  if (u.pathname === "/api/a2a/contact") { hits.contact++; res.end("{}"); return; }
  if (u.pathname === "/tr") { hits.pixel++; res.end(""); return; }
  if (u.pathname === "/__hits") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(hits)); return; }
  if (u.pathname === "/__reset") { hits.contact = hits.pixel = hits.elements = 0; res.end("ok"); return; }
  if (u.pathname.startsWith("/elements/amber/elements.js")) {
    hits.elements++;
    const mode = u.query.mode;
    if (mode === "challenge") { res.writeHead(403, { "cf-mitigated": "challenge", "content-type": "text/html" }); res.end("<html>Just a moment...</html>"); return; }
    if (mode === "neterr") { req.socket.destroy(); return; }
    res.writeHead(200, { "content-type": "application/javascript", "cache-control": "max-age=30" });
    res.end(elementsJs.replace(/PORT/g, String(PORT))); return;
  }
  if (u.pathname.startsWith("/frame/")) { res.setHeader("content-type", "text/html"); res.end("<html><body>card fields</body></html>"); return; }
  if (u.query.mode === "redirect") { res.writeHead(302, { location: "/sales-page" }); res.end(); return; }
  if (u.pathname === "/sales-page") { res.setHeader("content-type", "text/html"); res.end("<html><body><h1>Sales page</h1><a href='#'>Buy</a></body></html>"); return; }
  if (u.query.mode === "closed") { res.setHeader("content-type", "text/html"); res.end(`<html><body><div class="aieb-error" style="display:block">ga is not on sale right now</div></body></html>`); return; }
  const m = u.pathname.match(/^\/(aieb|a2a|a2a-clarity)$/);
  if (m) { res.setHeader("content-type", "text/html"); res.end(page(m[1], u.query.mode || "ok").replace(/PORT/g, String(PORT))); return; }
  res.writeHead(404); res.end("nope");
});
const PORT = Number(process.env.PORT || 8787);
server.listen(PORT, () => console.log("mock on", PORT));
