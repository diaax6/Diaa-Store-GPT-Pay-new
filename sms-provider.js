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

  async buyNumber(product = "gopay", country = "indonesia", operator = "any") {
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
// HERO-SMS.COM Provider (SMS-Activate Protocol)
// ══════════════════════════════════════════════════════════════════════════

const herosms = {
  base: "https://hero-sms.com/stubs/handler_api.php",

  getKey() {
    const cfg = getConfig();
    return cfg.smsApiKeyHero || "";
  },

  async request(params) {
    const url = `${this.base}?api_key=${this.getKey()}&${new URLSearchParams(params).toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`hero-sms error: ${res.status}`);
    return await res.text();
  },

  async getBalance() {
    const text = await this.request({ action: "getBalance" });
    // Response: ACCESS_BALANCE:123.45
    const m = text.match(/ACCESS_BALANCE:([\d.]+)/);
    return { balance: m ? parseFloat(m[1]) : 0, provider: "hero-sms" };
  },

  async buyNumber(service = "go", country = "6") {
    // service codes: "go" = Gojek/GoPay, country: "6" = Indonesia
    log(`[hero-sms] Buying number (service=${service}, country=${country})...`);
    const text = await this.request({ action: "getNumber", service, country });
    // Response: ACCESS_NUMBER:ID:NUMBER (e.g. ACCESS_NUMBER:123456:6281234567890)
    const m = text.match(/ACCESS_NUMBER:(\d+):(\d+)/);
    if (!m) throw new Error(`hero-sms buy failed: ${text}`);
    const orderId = m[1];
    const phone = "+" + m[2];
    log(`[hero-sms] ✅ Got number: ${phone} (id: ${orderId})`);
    return { orderId, phone, status: "PENDING" };
  },

  async markReady(orderId) {
    const text = await this.request({ action: "setStatus", id: orderId, status: "1" });
    log(`[hero-sms] Mark ready: ${text}`);
    return text;
  },

  async waitForSMS(orderId, timeoutMs = 120000) {
    log(`[hero-sms] Polling SMS on id #${orderId} (timeout: ${timeoutMs / 1000}s)...`);
    // Mark ready first
    await this.markReady(orderId);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const text = await this.request({ action: "getStatus", id: orderId });
      // STATUS_OK:CODE or STATUS_WAIT_CODE
      const m = text.match(/STATUS_OK:(.+)/);
      if (m) {
        const code = m[1].trim();
        log(`[hero-sms] ✅ Got code: ${code}`);
        return { text: text, code, sender: "GoPay" };
      }
      if (text.includes("STATUS_CANCEL")) {
        throw new Error("hero-sms: activation cancelled");
      }
      log(`[hero-sms] Waiting... (${((Date.now() - start) / 1000).toFixed(0)}s) → ${text}`);
      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error(`hero-sms SMS timeout after ${timeoutMs / 1000}s`);
  },

  async finishOrder(orderId) {
    log(`[hero-sms] Finishing #${orderId}`);
    await this.request({ action: "setStatus", id: orderId, status: "6" });
  },

  async cancelOrder(orderId) {
    log(`[hero-sms] Cancelling #${orderId}`);
    await this.request({ action: "setStatus", id: orderId, status: "8" });
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
