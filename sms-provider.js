// ══════════════════════════════════════════════════════════════════════════
// SMS Provider — Multi-provider support: 5sim.net + hero-sms.com
// Buy virtual Indonesian numbers + receive GoPay OTP via SMS
// ══════════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    return {};
  }
}

function log(...args) { console.log("[SMS]", ...args); }

// ══════════════════════════════════════════════════════════════════════════
// 5SIM.NET Provider
// ══════════════════════════════════════════════════════════════════════════

const fivesim = {
  base: "https://5sim.net/v1",
  headers() {
    const cfg = getConfig();
    return { Authorization: "Bearer " + (cfg.smsApiKey5sim || ""), Accept: "application/json" };
  },

  async getBalance() {
    const res = await fetch(`${this.base}/user/profile`, { headers: this.headers() });
    if (!res.ok) throw new Error(`5sim profile error: ${res.status}`);
    const d = await res.json();
    return { balance: d.balance, email: d.email, provider: "5sim" };
  },

  async buyNumber(product, country, operator) {
    const cfg = getConfig();
    product = product || cfg.smsProduct || "gopay";
    country = country || cfg.smsCountry5sim || "indonesia";
    operator = operator || cfg.smsOperator || "any";
    log(`[5sim] Buying ${product} number (${country}/${operator})...`);
    const res = await fetch(
      `${this.base}/user/buy/activation/${country}/${operator}/${product}`,
      { headers: this.headers() }
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`5sim buy error ${res.status}: ${t}`);
    }
    const d = await res.json();
    log(`[5sim] ✅ Got number: ${d.phone} (order #${d.id})`);
    return { orderId: d.id, phone: d.phone, operator: d.operator, price: d.price, status: d.status };
  },

  async waitForSMS(orderId, timeoutMs = 120000) {
    log(`[5sim] Polling SMS on order #${orderId} (timeout: ${timeoutMs / 1000}s)...`);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await fetch(`${this.base}/user/check/${orderId}`, { headers: this.headers() });
      if (res.ok) {
        const d = await res.json();
        if (d.sms && d.sms.length > 0) {
          const latest = d.sms[d.sms.length - 1];
          log(`[5sim] ✅ SMS: "${latest.text}" → Code: ${latest.code}`);
          return { text: latest.text, code: latest.code, sender: latest.sender };
        }
        if (["CANCELED", "TIMEOUT", "BANNED"].includes(d.status)) {
          throw new Error(`Order #${orderId} status: ${d.status}`);
        }
        log(`[5sim] Waiting... (${((Date.now() - start) / 1000).toFixed(0)}s) status: ${d.status}`);
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error(`5sim SMS timeout after ${timeoutMs / 1000}s`);
  },

  async finishOrder(orderId) {
    log(`[5sim] Finishing order #${orderId}`);
    await fetch(`${this.base}/user/finish/${orderId}`, { headers: this.headers() });
  },

  async cancelOrder(orderId) {
    log(`[5sim] Cancelling order #${orderId}`);
    await fetch(`${this.base}/user/cancel/${orderId}`, { headers: this.headers() });
  },
};

// ══════════════════════════════════════════════════════════════════════════
// HERO-SMS.COM Provider (SMS-Activate compatible API)
// Server: https://hero-sms.com/stubs/handler_api.php
// Auth: apiKeyQuery — api_key as query parameter
// Endpoints: ?action=getBalance | getNumber | getNumberV2 | getStatus |
//            getStatusV2 | setStatus | cancelActivation | finishActivation
// ══════════════════════════════════════════════════════════════════════════

const herosms = {
  base: "https://hero-sms.com/stubs/handler_api.php",

  getKey() {
    const cfg = getConfig();
    return cfg.smsApiKeyHero || "";
  },

  // Core request — all endpoints use ?action=XXX&api_key=YYY&param=val
  async request(action, params = {}) {
    params.action = action;
    params.api_key = this.getKey();
    const url = `${this.base}?${new URLSearchParams(params).toString()}`;
    log(`[hero-sms] → ${action}`, JSON.stringify(params).substring(0, 120));
    const res = await fetch(url);
    const text = await res.text();
    // Parse JSON if possible (V2 endpoints + error responses)
    let json = null;
    try { json = JSON.parse(text); } catch {}
    // Check for API errors
    if (!res.ok || (json && json.title)) {
      const errMsg = json ? `${json.title}: ${json.details}` : text;
      throw new Error(`hero-sms ${action} error (${res.status}): ${errMsg}`);
    }
    return { json, raw: text };
  },

  // ── getBalance → "ACCESS_BALANCE:100.5" ────────────────────────
  async getBalance() {
    const { json, raw } = await this.request("getBalance");
    const m = raw.match(/ACCESS_BALANCE:([\d.]+)/);
    return { balance: m ? parseFloat(m[1]) : 0, provider: "hero-sms", raw };
  },

  // ── getNumberV2 → JSON { activationId, phoneNumber, ... } ─────
  // ── getNumber   → "ACCESS_NUMBER:ID:NUMBER" (fallback) ─────────
  async buyNumber(service, country) {
    const cfg = getConfig();
    service = service || cfg.smsService || "go";
    country = country || cfg.smsCountry || "6";
    log(`[hero-sms] Buying number (service=${service}, country=${country})...`);

    // Try V2 first (returns JSON with full details)
    try {
      const { json } = await this.request("getNumberV2", { service, country });
      if (json && json.activationId && json.phoneNumber) {
        const phone = json.phoneNumber.startsWith("+") ? json.phoneNumber : "+" + json.phoneNumber;
        log(`[hero-sms] ✅ Got number: ${phone} (id: ${json.activationId}, cost: $${json.activationCost})`);
        return {
          orderId: json.activationId,
          phone,
          cost: json.activationCost,
          operator: json.activationOperator,
          status: "PENDING",
        };
      }
    } catch (e) {
      log(`[hero-sms] V2 failed (${e.message}), trying V1...`);
    }

    // Fallback to V1 (returns text)
    const { raw } = await this.request("getNumber", { service, country });
    // Response: ACCESS_NUMBER:123456789:628xxxxxxxxx
    const m = raw.match(/ACCESS_NUMBER:(\d+):(\d+)/);
    if (m) {
      const phone = "+" + m[2];
      log(`[hero-sms] ✅ Got number: ${phone} (id: ${m[1]})`);
      return { orderId: m[1], phone, status: "PENDING" };
    }
    throw new Error(`hero-sms buy failed: ${raw}`);
  },

  // ── getStatusV2 → JSON { sms: { code, text }, ... } ───────────
  // ── getStatus   → "STATUS_OK:CODE" or "STATUS_WAIT_CODE" ──────
  async waitForSMS(orderId, timeoutMs = 120000) {
    log(`[hero-sms] Polling SMS on id #${orderId} (timeout: ${timeoutMs / 1000}s)...`);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      // Try V2 first for structured response
      try {
        const { json } = await this.request("getStatusV2", { id: orderId });
        if (json && json.sms && json.sms.code && json.sms.code !== "code") {
          log(`[hero-sms] ✅ V2 Got code: ${json.sms.code}`);
          return { text: json.sms.text || "", code: json.sms.code, sender: "GoPay" };
        }
      } catch (e) {
        // V2 might not be available, fall through to V1
      }

      // V1 fallback
      const { raw } = await this.request("getStatus", { id: orderId });

      // STATUS_OK:100001 → code received!
      const m = raw.match(/STATUS_OK:(.+)/);
      if (m) {
        const code = m[1].trim();
        log(`[hero-sms] ✅ Got code: ${code}`);
        return { text: raw, code, sender: "GoPay" };
      }
      // STATUS_CANCEL → activation was cancelled
      if (raw.includes("STATUS_CANCEL")) {
        throw new Error("hero-sms: activation cancelled");
      }
      // STATUS_WAIT_CODE / STATUS_WAIT_RETRY / STATUS_WAIT_RESEND → keep polling
      log(`[hero-sms] Waiting... (${((Date.now() - start) / 1000).toFixed(0)}s) → ${raw.substring(0, 80)}`);
      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error(`hero-sms SMS timeout after ${timeoutMs / 1000}s`);
  },

  // ── setStatus 6 = complete activation (code received & confirmed)
  async finishOrder(orderId) {
    log(`[hero-sms] Finishing #${orderId} (status=6)`);
    await this.request("setStatus", { id: orderId, status: "6" });
  },

  // ── setStatus 8 = cancel activation (refund money)
  async cancelOrder(orderId) {
    log(`[hero-sms] Cancelling #${orderId} (status=8)`);
    await this.request("setStatus", { id: orderId, status: "8" });
  },

  // ── setStatus 3 = request SMS resend
  async resendSMS(orderId) {
    log(`[hero-sms] Requesting SMS resend #${orderId} (status=3)`);
    await this.request("setStatus", { id: orderId, status: "3" });
  },
};

// ══════════════════════════════════════════════════════════════════════════
// Unified Interface — auto-select provider from config
// ══════════════════════════════════════════════════════════════════════════

function getProvider() {
  const cfg = getConfig();
  if (cfg.smsProvider === "hero-sms" && cfg.smsApiKeyHero) return herosms;
  if (cfg.smsProvider === "5sim" && cfg.smsApiKey5sim) return fivesim;
  // Auto-detect
  if (cfg.smsApiKeyHero) return herosms;
  if (cfg.smsApiKey5sim) return fivesim;
  throw new Error("No SMS provider configured. Set smsApiKeyHero or smsApiKey5sim in config.json");
}

// Extract OTP from SMS text
function extractOTP(text) {
  if (!text) return null;
  const m = text.match(/\b(\d{4,6})\b/);
  return m ? m[1] : null;
}

module.exports = {
  getProvider,
  extractOTP,
  fivesim,
  herosms,
  getBalance: () => getProvider().getBalance(),
  buyNumber: (...args) => getProvider().buyNumber(...args),
  waitForSMS: (...args) => getProvider().waitForSMS(...args),
  finishOrder: (...args) => getProvider().finishOrder(...args),
  cancelOrder: (...args) => getProvider().cancelOrder(...args),
};
