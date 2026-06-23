/* DigiPay UPG lifecycle sandbox — 100% client-side.
 * State lives in localStorage; all API traffic is proxied through a stateless
 * Cloudflare Worker (CORS + callback bounce). See README + docs/digipay.md. */

"use strict";

const STORE_KEY = "digipay_v1";

const TYPE_CODES = { IPG: 0, WALLET: 11, CREDIT: 5, BNPL: 13, "CREDIT-CARD": 24 };
const PAYMENT_GATEWAY = { 0: "IPG", 3: "WALLET", 4: "CPG/credit" };
const REFUND_STATUS = { 0: "success", 1: "failed", 2: "unknown / re-check" };
const DEST_TYPE = { 0: "Masked PAN", 1: "IBAN", 2: "Wallet", 3: "Credit" };

/* ------------------------------------------------------------------ state */

function defaultState() {
  return {
    env: "production",
    workerBase: "",
    creds: { clientId: "", clientSecret: "", username: "", password: "" },
    steps: {
      login: { done: false, data: {}, error: null },
      ticket: { done: false, data: {}, error: null },
      redirect: { done: false, data: {}, error: null },
      callback: { done: false, data: {}, error: null },
      verify: { done: false, data: {}, error: null },
      final: { done: false, data: {}, error: null },
      track: { done: false, data: {}, error: null },
    },
  };
}

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const base = defaultState();
    return { ...base, ...parsed, creds: { ...base.creds, ...parsed.creds },
             steps: { ...base.steps, ...parsed.steps } };
  } catch (e) {
    return defaultState();
  }
}

function saveState() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }

/* ----------------------------------------------------------------- helpers */

/** Time-based UUID (version 8): 48-bit ms timestamp + random, sortable. */
function uuidv8() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ts = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) { bytes[i] = Number(ts & 0xffn); ts >>= 8n; }
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // version 8
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const h = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function decodeCallbackFragment() {
  const m = location.hash.match(/[#&]cb=([^&]+)/);
  if (!m) return null;
  try {
    let s = decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return JSON.parse(decodeURIComponent(escape(atob(s))));
  } catch (e) { return null; }
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function kv(pairs) {
  return `<div class="kv">${pairs.filter(Boolean)
    .map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`)
    .join("")}</div>`;
}

function maybeJSON(text, label) {
  if (!text || !text.trim()) return undefined;
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`${label}: invalid JSON — ${e.message}`); }
}

/* -------------------------------------------------------------------- HTTP */

async function api(path, { method = "POST", json = null, form = null, auth = null }) {
  const base = (state.workerBase || "").replace(/\/+$/, "");
  if (!base) throw new Error("Set the Worker proxy base URL in settings first.");
  const headers = new Headers();
  headers.set("X-Digipay-Env", state.env);
  headers.set("Agent", "WEB");
  headers.set("Digipay-Version", "2022-02-02");
  if (auth) headers.set("Authorization", auth);
  let body = null;
  if (form) { body = form; /* browser sets multipart content-type */ }
  else if (json !== null) { headers.set("Content-Type", "application/json; charset=UTF-8"); body = JSON.stringify(json); }
  const resp = await fetch(`${base}/api${path}`, { method, headers, body });
  const text = await resp.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { _raw: text }; }
  return { status: resp.status, ok: resp.ok, data };
}

function bearer() {
  const t = state.steps.login.data.access_token;
  if (!t) throw new Error("No access token — complete the Login step first.");
  return `Bearer ${t}`;
}

/* --------------------------------------------------------------- rendering */

const STEP_ORDER = ["login", "ticket", "redirect", "callback", "verify", "final", "track"];
const STEP_TITLES = {
  login: "Login", ticket: "Create Ticket", redirect: "Redirect to Pay",
  callback: "Payment Result (callback)", verify: "Verify Payment",
  final: "Deliver / Reverse / Refund", track: "Track Refund",
};

function render() {
  // settings
  document.getElementById("env").value = state.env;
  document.getElementById("workerBase").value = state.workerBase;

  const flow = document.getElementById("flow");
  flow.innerHTML = "";
  const tpl = document.getElementById("stepTpl");

  let prevDone = true;
  let index = 0;
  STEP_ORDER.forEach((name) => {
    if (name === "track" && state.steps.final.data.choice !== "refund") return;
    index += 1;
    const st = state.steps[name];
    const locked = !prevDone && !st.done;
    const status = st.done ? "done" : locked ? "locked" : st.error ? "error" : "active";

    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.step = name;
    node.classList.add(status === "done" ? "done" : status === "locked" ? "locked" : "active");
    node.querySelector(".step-index").textContent = st.done ? "✓" : index;
    node.querySelector(".step-title").textContent = STEP_TITLES[name];
    const badge = node.querySelector(".step-status");
    badge.textContent = status; badge.dataset.status = status;

    const toggle = node.querySelector(".step-toggle");
    if (st.done) {
      toggle.hidden = false;
      toggle.onclick = () => { st.done = false; saveState(); render(); };
    }

    const body = node.querySelector(".step-body");
    if (!locked) RENDERERS[name](body, st);
    flow.appendChild(node);

    prevDone = st.done;
  });

  document.getElementById("stateInfo").textContent =
    state.steps.login.done ? `token expires ~${tokenRemaining()}s` : "not logged in";
}

function tokenRemaining() {
  const exp = state.steps.login.data.expires_at;
  return exp ? Math.max(0, exp - Math.floor(Date.now() / 1000)) : 0;
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.textContent = busy ? "…" : (label || btn.dataset.label);
}

function outBlock(res) {
  const cls = res.ok ? "out" : "out error";
  return `<pre class="${cls}">HTTP ${res.status}\n${esc(JSON.stringify(res.data, null, 2))}</pre>`;
}

/* ----- per-step renderers ----- */

const RENDERERS = {};

RENDERERS.login = (body, st) => {
  const c = state.creds;
  if (st.done) {
    body.innerHTML = kv([
      ["env", state.env],
      ["access_token", st.data.access_token?.slice(0, 28) + "…"],
      ["expires_in", st.data.expires_in],
      ["scope", st.data.scope],
    ]) + `<div class="actions"><button class="relogin">Re-login</button></div>`;
    body.querySelector(".relogin").onclick = () => { st.done = false; saveState(); render(); };
    return;
  }
  body.innerHTML = `
    <div class="grid2">
      <label>client_id<input id="lg_id" value="${esc(c.clientId)}" autocomplete="off"></label>
      <label>client_secret<input id="lg_secret" type="password" value="${esc(c.clientSecret)}" autocomplete="off"></label>
      <label>username<input id="lg_user" value="${esc(c.username)}" autocomplete="off"></label>
      <label>password<input id="lg_pass" type="password" value="${esc(c.password)}" autocomplete="off"></label>
    </div>
    <p class="note">Credentials stay in this browser's localStorage and are sent only to your Worker proxy.</p>
    <div class="actions"><button id="lg_go">Login</button></div>
    <div id="lg_out"></div>`;
  body.querySelector("#lg_go").onclick = async (e) => {
    const btn = e.target;
    state.creds = {
      clientId: body.querySelector("#lg_id").value.trim(),
      clientSecret: body.querySelector("#lg_secret").value.trim(),
      username: body.querySelector("#lg_user").value.trim(),
      password: body.querySelector("#lg_pass").value.trim(),
    };
    saveState();
    const { clientId, clientSecret, username, password } = state.creds;
    if (!clientId || !clientSecret || !username || !password)
      return (body.querySelector("#lg_out").innerHTML = `<div class="banner err">All four fields are required.</div>`);
    setBusy(btn, true);
    try {
      const fd = new FormData();
      fd.append("username", username);
      fd.append("password", password);
      fd.append("grant_type", "password");
      const auth = "Basic " + btoa(`${clientId}:${clientSecret}`);
      const res = await api("/oauth/token", { form: fd, auth });
      body.querySelector("#lg_out").innerHTML = outBlock(res);
      if (res.ok && res.data.access_token) {
        st.data = { ...res.data, expires_at: Math.floor(Date.now() / 1000) + (res.data.expires_in || 0) };
        st.done = true; st.error = null; saveState(); render();
      }
    } catch (err) {
      body.querySelector("#lg_out").innerHTML = `<div class="banner err">${esc(err.message)}</div>`;
    } finally { setBusy(btn, false); }
  };
};

RENDERERS.ticket = (body, st) => {
  const d = st.data;
  if (!d.providerId) { d.providerId = uuidv8(); saveState(); }
  if (!d.callbackUrl) d.callbackUrl = (state.workerBase || "").replace(/\/+$/, "") + "/cb";
  if (d.amount == null || d.amount === "") { d.amount = 10000; saveState(); }
  if (st.done) {
    body.innerHTML = kv([
      ["providerId", d.providerId], ["amount", d.amount], ["ticket", d.response?.ticket],
      ["redirectUrl", d.response?.redirectUrl],
    ]);
    return;
  }
  body.innerHTML = `
    <div class="grid2">
      <label>amount (Rial)<input id="tk_amount" type="number" value="${esc(d.amount ?? 10000)}" placeholder="10000"></label>
      <label>cellNumber<input id="tk_cell" value="${esc(d.cell || "")}" placeholder="09xxxxxxxxx"></label>
    </div>
    <div class="field-row" style="margin-top:12px">
      <label>providerId (auto, time-based UUIDv8)<input id="tk_pid" value="${esc(d.providerId)}"></label>
      <button class="small ghost" id="tk_regen" type="button">regenerate</button>
    </div>
    <label style="margin-top:12px">callbackUrl<input id="tk_cb" value="${esc(d.callbackUrl)}"></label>
    <label style="margin-top:12px">create type <input id="tk_type" value="${esc(d.type || "11")}"></label>
    <div class="slider" style="margin-top:14px">
      <span class="note">Payment instrument (preferredGateway)</span>
      ${slider("tk_gw", ["Selection page", "Wallet (0)", "IPG (2)"], d.gw || 0)}
    </div>
    <details class="advanced">
      <summary>Advanced: basketDetailsDto / splitDetailsList / additionalInfo (JSON)</summary>
      <label style="margin-top:8px">basketDetailsDto (credit/installment)<textarea id="tk_basket" placeholder='{ "basketId": "...", "items": [ ... ] }'>${esc(d.basket || "")}</textarea></label>
      <label style="margin-top:8px">splitDetailsList (max 2)<textarea id="tk_split" placeholder='[ { "type": "simple", "amount": 1000, "username": "..." } ]'>${esc(d.split || "")}</textarea></label>
      <label style="margin-top:8px">additionalInfo (merged with preferredGateway)<textarea id="tk_extra">${esc(d.extra || "")}</textarea></label>
    </details>
    <div class="actions"><button id="tk_go">Create Ticket</button></div>
    <div id="tk_out"></div>`;

  // persist every field to localStorage as the user edits it
  const persist = (sel, key) => {
    const el = body.querySelector(sel);
    if (el) el.addEventListener("input", () => { d[key] = el.value; saveState(); });
  };
  persist("#tk_amount", "amount");
  persist("#tk_cell", "cell");
  persist("#tk_pid", "providerId");
  persist("#tk_cb", "callbackUrl");
  persist("#tk_type", "type");
  persist("#tk_basket", "basket");
  persist("#tk_split", "split");
  persist("#tk_extra", "extra");

  wireSlider(body, "tk_gw", (i) => { d.gw = i; saveState(); });
  body.querySelector("#tk_regen").onclick = () => { d.providerId = uuidv8(); saveState(); render(); };
  body.querySelector("#tk_go").onclick = async (e) => {
    const btn = e.target;
    const out = body.querySelector("#tk_out");
    try {
      d.amount = Number(body.querySelector("#tk_amount").value);
      d.cell = body.querySelector("#tk_cell").value.trim();
      d.providerId = body.querySelector("#tk_pid").value.trim();
      d.callbackUrl = body.querySelector("#tk_cb").value.trim();
      const type = body.querySelector("#tk_type").value.trim() || "11";
      if (!d.amount || !d.cell || !d.callbackUrl) throw new Error("amount, cellNumber and callbackUrl are required.");
      const payload = { amount: d.amount, cellNumber: d.cell, providerId: d.providerId, callbackUrl: d.callbackUrl };
      const basket = maybeJSON(body.querySelector("#tk_basket").value, "basketDetailsDto");
      if (basket) payload.basketDetailsDto = basket;
      const split = maybeJSON(body.querySelector("#tk_split").value, "splitDetailsList");
      if (split) payload.splitDetailsList = split;
      const extra = maybeJSON(body.querySelector("#tk_extra").value, "additionalInfo") || {};
      const gw = getSlider(body, "tk_gw");
      if (gw === 1) extra.preferredGateway = 0;
      if (gw === 2) extra.preferredGateway = 2;
      if (Object.keys(extra).length) payload.additionalInfo = extra;
      saveState();
      setBusy(btn, true);
      const res = await api(`/tickets/business?type=${encodeURIComponent(type)}`, { json: payload, auth: bearer() });
      out.innerHTML = outBlock(res);
      if (res.ok && res.data.redirectUrl) { d.response = res.data; st.done = true; st.error = null; saveState(); render(); }
    } catch (err) { out.innerHTML = `<div class="banner err">${esc(err.message)}</div>`; }
    finally { setBusy(btn, false); }
  };
};

RENDERERS.redirect = (body, st) => {
  const url = state.steps.ticket.data.response?.redirectUrl;
  body.innerHTML = `
    <p class="note">Open the DigiPay payment page, complete payment, and you'll be sent back here.
    The Worker catches DigiPay's POST and redirects to this app with the result in the URL fragment.</p>
    <div class="actions">
      <a class="btn-link ${url ? "" : "disabled"}" href="${esc(url || "#")}" target="_blank" rel="noopener">Open payment page ↗</a>
      <button id="rd_done" class="ghost">I've completed payment →</button>
    </div>
    <p class="note warn">If your Worker callback URL differs from the ticket's callbackUrl, the result won't return automatically — use the manual paste in the next box.</p>`;
  body.querySelector("#rd_done").onclick = () => { st.done = true; saveState(); render(); };
};

RENDERERS.callback = (body, st) => {
  const d = st.data;
  if (st.done) {
    body.innerHTML = kv([
      ["result", d.result], ["trackingCode", d.trackingCode], ["type", d.type],
      ["amount", d.amount], ["providerId", d.providerId], ["rrn", d.rrn],
    ]);
    return;
  }
  body.innerHTML = `
    <p class="note">After payment DigiPay POSTs: <code>amount, providerId, trackingCode, rrn, result, type</code>.
    If the Worker bounced it back, the fields below are pre-filled. Otherwise paste the JSON.</p>
    <label>Paste callback JSON (optional)<textarea id="cb_paste" placeholder='{ "result": "SUCCESS", "trackingCode": "...", "type": 0, ... }'></textarea></label>
    <div class="actions"><button id="cb_parse" class="ghost">Parse pasted JSON</button></div>
    <div class="grid2" style="margin-top:12px">
      <label>result<input id="cb_result" value="${esc(d.result || "")}" placeholder="SUCCESS"></label>
      <label>trackingCode<input id="cb_tc" value="${esc(d.trackingCode || "")}"></label>
      <label>type<input id="cb_type" value="${esc(d.type ?? "")}" placeholder="0=IPG 11=WALLET 5=CREDIT 13=BNPL 24=CARD"></label>
      <label>amount<input id="cb_amount" value="${esc(d.amount ?? "")}"></label>
    </div>
    <div class="actions"><button id="cb_save">Use these values →</button></div>`;
  body.querySelector("#cb_parse").onclick = () => {
    try {
      const j = JSON.parse(body.querySelector("#cb_paste").value);
      body.querySelector("#cb_result").value = j.result ?? "";
      body.querySelector("#cb_tc").value = j.trackingCode ?? "";
      body.querySelector("#cb_type").value = j.type ?? "";
      body.querySelector("#cb_amount").value = j.amount ?? "";
    } catch (e) { alert("Not valid JSON: " + e.message); }
  };
  body.querySelector("#cb_save").onclick = () => {
    st.data = {
      result: body.querySelector("#cb_result").value.trim(),
      trackingCode: body.querySelector("#cb_tc").value.trim(),
      type: body.querySelector("#cb_type").value.trim(),
      amount: body.querySelector("#cb_amount").value.trim(),
      providerId: d.providerId, rrn: d.rrn,
    };
    if (!st.data.trackingCode) return alert("trackingCode is required to verify.");
    st.done = true; saveState(); render();
  };
};

RENDERERS.verify = (body, st) => {
  const cb = state.steps.callback.data;
  const tk = state.steps.ticket.data;
  const d = st.data;
  if (st.done) {
    const gw = d.response?.paymentGateway;
    body.innerHTML = kv([
      ["paymentGateway", `${gw} (${PAYMENT_GATEWAY[gw] || "?"})`],
      ["amount", d.response?.amount], ["fpName", d.response?.fpName],
    ]);
    return;
  }
  body.innerHTML = `
    <p class="note warn">Mandatory. If not verified in time, DigiPay auto-cancels &amp; refunds.
    Re-check amount + providerId against your records first.</p>
    <div class="grid2">
      <label>type<input id="vf_type" value="${esc(d.type ?? cb.type ?? "")}"></label>
      <label>trackingCode<input id="vf_tc" value="${esc(d.trackingCode ?? cb.trackingCode ?? "")}"></label>
      <label>providerId<input id="vf_pid" value="${esc(d.providerId ?? tk.providerId ?? "")}"></label>
    </div>
    <div class="actions"><button id="vf_go">Verify</button></div>
    <div id="vf_out"></div>`;
  body.querySelector("#vf_go").onclick = async (e) => {
    const btn = e.target; const out = body.querySelector("#vf_out");
    try {
      d.type = body.querySelector("#vf_type").value.trim();
      d.trackingCode = body.querySelector("#vf_tc").value.trim();
      d.providerId = body.querySelector("#vf_pid").value.trim();
      if (!d.type || !d.trackingCode || !d.providerId) throw new Error("type, trackingCode and providerId are required.");
      saveState(); setBusy(btn, true);
      const res = await api(`/purchases/verify?type=${encodeURIComponent(d.type)}`,
        { json: { trackingCode: d.trackingCode, providerId: d.providerId }, auth: bearer() });
      out.innerHTML = outBlock(res);
      if (res.ok) { d.response = res.data; st.done = true; st.error = null; saveState(); render(); }
    } catch (err) { out.innerHTML = `<div class="banner err">${esc(err.message)}</div>`; }
    finally { setBusy(btn, false); }
  };
};

RENDERERS.final = (body, st) => {
  const v = state.steps.verify.data;
  const baseType = v.type || "";
  const trackingCode = v.trackingCode || "";
  const purchasePid = v.providerId || "";
  const d = st.data;

  if (st.done) {
    body.innerHTML = `<p class="note">Action performed: <strong>${esc(d.choice)}</strong></p>` + outBlock({ ok: true, status: 200, data: d.response });
    return;
  }

  const choices = ["deliver", "reverse", "refund"];
  const cur = choices.indexOf(d.choice) >= 0 ? choices.indexOf(d.choice) : 0;
  d.refundPid = d.refundPid || uuidv8();
  saveState();

  body.innerHTML = `
    <p class="note">Pick one follow-up. Per purchase you may call <strong>either reverse OR refund, not both</strong>.</p>
    ${slider("fn_choice", ["Deliver (credit/BNPL)", "Reverse (IPG/DPG, &lt;25m)", "Refund"], cur)}
    <div class="slider-panels"><div class="slider-track" data-track="fn_choice">
      <div class="slider-panel">
        <div class="grid2">
          <label>type<input id="dl_type" value="${esc(baseType || 5)}"></label>
          <label>trackingCode<input id="dl_tc" value="${esc(trackingCode)}"></label>
          <label>invoiceNumber<input id="dl_inv" placeholder="INV-123"></label>
          <label>deliveryDate (epoch ms)<input id="dl_date" value="${Date.now()}"></label>
        </div>
        <label style="margin-top:12px">products (comma separated)<input id="dl_prod" placeholder="product-1, product-2"></label>
        <div class="actions"><button data-act="deliver">Deliver</button></div>
      </div>
      <div class="slider-panel">
        <div class="grid2">
          <label>trackingCode (purchase)<input id="rv_tc" value="${esc(trackingCode)}"></label>
          <label>providerId (purchase)<input id="rv_pid" value="${esc(purchasePid)}"></label>
        </div>
        <div class="actions"><button data-act="reverse">Reverse</button></div>
      </div>
      <div class="slider-panel">
        <div class="grid2">
          <label>type<input id="rf_type" value="${esc(baseType)}"></label>
          <label>amount<input id="rf_amount" placeholder="amount to refund"></label>
          <label>saleTrackingCode (purchase)<input id="rf_sale" value="${esc(trackingCode)}"></label>
          <div class="field-row">
            <label>providerId (NEW, UUIDv8)<input id="rf_pid" value="${esc(d.refundPid)}"></label>
            <button class="small ghost" id="rf_regen" type="button">regen</button>
          </div>
        </div>
        <div class="actions"><button data-act="refund">Refund</button></div>
      </div>
    </div></div>
    <div id="fn_out"></div>`;

  wireSlider(body, "fn_choice", (i) => { d.choice = choices[i]; saveState(); });
  d.choice = choices[cur];
  body.querySelector("#rf_regen").onclick = () => { d.refundPid = uuidv8(); body.querySelector("#rf_pid").value = d.refundPid; saveState(); };

  const out = body.querySelector("#fn_out");
  const run = async (btn, choice, path, payload) => {
    try {
      saveState(); setBusy(btn, true);
      const res = await api(path, { json: payload, auth: bearer() });
      out.innerHTML = outBlock(res);
      if (res.ok) { d.choice = choice; d.response = res.data; st.done = true; st.error = null; saveState(); render(); }
    } catch (err) { out.innerHTML = `<div class="banner err">${esc(err.message)}</div>`; }
    finally { setBusy(btn, false); }
  };

  body.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      if (act === "deliver") {
        const type = body.querySelector("#dl_type").value.trim();
        run(btn, "deliver", `/purchases/deliver?type=${encodeURIComponent(type)}`, {
          deliveryDate: Number(body.querySelector("#dl_date").value),
          invoiceNumber: body.querySelector("#dl_inv").value.trim(),
          trackingCode: body.querySelector("#dl_tc").value.trim(),
          products: body.querySelector("#dl_prod").value.split(",").map((s) => s.trim()).filter(Boolean),
        });
      } else if (act === "reverse") {
        run(btn, "reverse", `/reverse`, {
          purchaseTrackingCode: body.querySelector("#rv_tc").value.trim(),
          providerId: body.querySelector("#rv_pid").value.trim(),
        });
      } else if (act === "refund") {
        const type = body.querySelector("#rf_type").value.trim();
        run(btn, "refund", `/refunds?type=${encodeURIComponent(type)}`, {
          providerId: body.querySelector("#rf_pid").value.trim(),
          amount: Number(body.querySelector("#rf_amount").value),
          saleTrackingCode: body.querySelector("#rf_sale").value.trim(),
        });
      }
    };
  });
};

RENDERERS.track = (body, st) => {
  const refund = state.steps.final.data;
  const d = st.data;
  if (st.done) {
    const r = d.response || {};
    body.innerHTML = kv([
      ["status", `${r.status} (${REFUND_STATUS[r.status] || "?"})`],
      ["destinationType", `${r.destinationType} (${DEST_TYPE[r.destinationType] || "?"})`],
      ["destination", r.destination], ["transferDate", r.transferDate],
    ]);
    return;
  }
  const defaultInquiry = refund.response?.trackingCode || refund.refundPid || "";
  body.innerHTML = `
    <div class="grid2">
      <label>type<input id="tr_type" value="${esc(state.steps.verify.data.type || "")}"></label>
      <label>InquiryId (refund trackingCode or providerId)<input id="tr_id" value="${esc(defaultInquiry)}"></label>
    </div>
    <div class="actions"><button id="tr_go">Track refund</button></div>
    <div id="tr_out"></div>`;
  body.querySelector("#tr_go").onclick = async (e) => {
    const btn = e.target; const out = body.querySelector("#tr_out");
    try {
      const type = body.querySelector("#tr_type").value.trim();
      const id = body.querySelector("#tr_id").value.trim();
      if (!id) throw new Error("InquiryId is required.");
      setBusy(btn, true);
      const res = await api(`/refunds/${encodeURIComponent(id)}?type=${encodeURIComponent(type)}`, { json: {}, auth: bearer() });
      out.innerHTML = outBlock(res);
      if (res.ok) { d.response = res.data; st.done = true; saveState(); render(); }
    } catch (err) { out.innerHTML = `<div class="banner err">${esc(err.message)}</div>`; }
    finally { setBusy(btn, false); }
  };
};

/* ------------------------------------------------------------- slider util */

function slider(id, labels, active) {
  return `
    <div class="slider-tabs" data-slider="${id}">
      ${labels.map((l, i) => `<button type="button" data-i="${i}" class="${i === active ? "active" : ""}">${l}</button>`).join("")}
      <span class="slider-indicator"></span>
    </div>`;
}

function wireSlider(scope, id, onChange) {
  const tabs = scope.querySelector(`.slider-tabs[data-slider="${id}"]`);
  if (!tabs) return;
  const buttons = [...tabs.querySelectorAll("button")];
  const indicator = tabs.querySelector(".slider-indicator");
  const track = scope.querySelector(`.slider-track[data-track="${id}"]`);
  const move = (i) => {
    const b = buttons[i];
    indicator.style.width = `${b.offsetWidth}px`;
    indicator.style.transform = `translateX(${b.offsetLeft - 4}px)`;
    buttons.forEach((x, j) => x.classList.toggle("active", j === i));
    if (track) track.style.transform = `translateX(-${i * 100}%)`;
    tabs.dataset.value = i;
  };
  buttons.forEach((b, i) => (b.onclick = () => { move(i); onChange && onChange(i); }));
  const init = Number(buttons.findIndex((b) => b.classList.contains("active")) || 0);
  tabs.dataset.value = init >= 0 ? init : 0;
  requestAnimationFrame(() => move(init >= 0 ? init : 0));
}

function getSlider(scope, id) {
  const tabs = scope.querySelector(`.slider-tabs[data-slider="${id}"]`);
  return tabs ? Number(tabs.dataset.value || 0) : 0;
}

/* ------------------------------------------------------------------- boot */

function init() {
  // settings wiring
  document.getElementById("env").onchange = (e) => { state.env = e.target.value; saveState(); render(); };
  document.getElementById("workerBase").onchange = (e) => { state.workerBase = e.target.value.trim(); saveState(); render(); };
  document.getElementById("resetBtn").onclick = () => {
    if (confirm("Clear all saved DigiPay sandbox state from this browser?")) {
      localStorage.removeItem(STORE_KEY); state = defaultState(); location.hash = ""; render();
    }
  };

  // auto-fill from callback fragment
  const cb = decodeCallbackFragment();
  if (cb) {
    const c = state.steps.callback;
    c.data = {
      result: cb.result ?? cb.status ?? "",
      trackingCode: cb.trackingCode ?? "",
      type: cb.type ?? "",
      amount: cb.amount ?? "",
      providerId: cb.providerId ?? "",
      rrn: cb.rrn ?? "",
    };
    c.done = false;
    state.steps.redirect.done = true;
    saveState();
    history.replaceState(null, "", location.pathname + location.search);
  }

  render();
}

document.addEventListener("DOMContentLoaded", init);
