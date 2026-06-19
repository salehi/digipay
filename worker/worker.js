/* Stateless DigiPay proxy Worker.
 *
 * Two jobs, nothing stored:
 *   1. /api/*  -> CORS-proxy to the DigiPay REST API (browsers can't call it directly).
 *                 Pick the environment with the `X-Digipay-Env: staging|production` header.
 *   2. /cb     -> DigiPay POSTs the payment result here (browser navigation). We read the
 *                 fields and 303-redirect the user back to the SPA with the result encoded
 *                 in the URL fragment (#cb=...). The fragment never reaches any server.
 *
 * Config (wrangler.toml [vars]):
 *   APP_URL  - the GitHub Pages URL of the SPA, e.g. https://salehi.github.io/digipay/
 */

const BASES = {
  staging: "https://uat.mydigipay.info/digipay/api",
  production: "https://api.mydigipay.com/digipay/api",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type,agent,digipay-version,x-digipay-env",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/cb" || url.pathname === "/callback") {
      return handleCallback(request, url, env);
    }

    if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
      return handleProxy(request, url);
    }

    return new Response(statusPage(env), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", ...CORS },
    });
  },
};

async function handleProxy(request, url) {
  const envName = (request.headers.get("X-Digipay-Env") || "production").toLowerCase();
  const base = BASES[envName];
  if (!base) {
    return json({ error: `unknown env '${envName}' (use staging|production)` }, 400);
  }

  const path = url.pathname.replace(/^\/api/, "") || "/";
  const target = base + path + url.search;

  const headers = new Headers(request.headers);
  ["host", "x-digipay-env", "origin", "referer", "cf-connecting-ip", "cf-ipcountry"]
    .forEach((h) => headers.delete(h));

  const method = request.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

  let upstream;
  try {
    upstream = await fetch(target, { method, headers, body });
  } catch (e) {
    return json({ error: "upstream fetch failed", detail: String(e), target }, 502);
  }

  const respHeaders = new Headers(CORS);
  const ct = upstream.headers.get("content-type");
  if (ct) respHeaders.set("content-type", ct);
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

async function handleCallback(request, url, env) {
  let data = {};
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  try {
    if (request.method === "GET") {
      data = Object.fromEntries(url.searchParams);
    } else if (ct.includes("application/json")) {
      data = await request.json();
    } else {
      const fd = await request.formData();
      data = Object.fromEntries(fd);
    }
  } catch (e) {
    try { data = Object.fromEntries(new URLSearchParams(await request.text())); }
    catch (_) { data = { _parseError: String(e) }; }
  }

  const appUrl = url.searchParams.get("app") || env.APP_URL || "https://salehi.github.io/digipay/";
  const fragment = "#cb=" + b64url(JSON.stringify(data));
  const dest = appUrl.split("#")[0] + fragment;

  // 303 so the browser does a GET to the SPA; include an HTML fallback too.
  return new Response(redirectHtml(dest), {
    status: 303,
    headers: { Location: dest, "content-type": "text/html; charset=utf-8", ...CORS },
  });
}

/* ------------------------------------------------------------------ utils */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function redirectHtml(dest) {
  const safe = dest.replace(/"/g, "&quot;");
  return `<!DOCTYPE html><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${safe}">
<title>Returning…</title>
<p>Payment received. Returning to the app…</p>
<p><a href="${safe}">Continue</a></p>
<script>location.replace("${safe}")</script>`;
}

function statusPage(env) {
  const app = env.APP_URL || "(APP_URL not set)";
  return `<!DOCTYPE html><meta charset="utf-8"><title>DigiPay proxy</title>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;line-height:1.5">
<h1>DigiPay proxy worker</h1>
<p>Stateless. Routes:</p>
<ul>
  <li><code>/api/*</code> — proxy to DigiPay (header <code>X-Digipay-Env: staging|production</code>)</li>
  <li><code>/cb</code> — callback sink; 303-redirects to the SPA with <code>#cb=</code></li>
</ul>
<p>APP_URL = <code>${app}</code></p>
</body>`;
}
