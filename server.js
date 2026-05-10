const express = require("express");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { COUNTRIES_LIST, STATES } = require("./countries");

const app = express();
const PORT = 3000;
const CONFIG_PATH = path.join(__dirname, "config.json");
const CURL_CHROME = "/usr/local/bin/curl_chrome116";

// ── Helpers ───────────────────────────────────────────────────────────────
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// Sessions (in-memory)
const sessions = new Map(); // token → { role: "admin"|"user", createdAt }
const SESSION_TTL = 60 * 60 * 1000; // 1 hour

// Address rotation counter
let addressRotationIndex = 0;

function createSession(role) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { role, createdAt: Date.now() });
  return token;
}

function getSession(req) {
  const token = req.cookies?.["session"];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  return s;
}

// Cookie parser middleware (simple)
app.use((req, res, next) => {
  req.cookies = {};
  const hdr = req.headers.cookie;
  if (hdr) hdr.split(";").forEach(c => {
    const [k, ...v] = c.trim().split("=");
    req.cookies[k] = v.join("=");
  });
  next();
});

app.use(express.json({ limit: "10mb" }));

// ── Auth middleware ───────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not authenticated" });
  req.userRole = session.role;
  next();
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session || session.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  req.userRole = "admin";
  next();
}

// ── Static files (login page always accessible) ───────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Auth routes ───────────────────────────────────────────────────────────
app.post("/api/auth/login", (req, res) => {
  const { password } = req.body;
  const cfg = loadConfig();

  // Site login — user password only
  if (password !== cfg.userPassword) return res.status(401).json({ error: "Invalid password" });

  const token = createSession("user");
  res.setHeader("Set-Cookie", `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`);
  return res.json({ success: true, role: "user" });
});

// Admin unlock (separate password)
app.post("/api/auth/admin", (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not authenticated" });

  const { password } = req.body;
  const cfg = loadConfig();

  if (password !== cfg.adminPassword) return res.status(401).json({ error: "Invalid admin password" });

  // Upgrade session to admin
  const token = req.cookies?.["session"];
  if (token) sessions.set(token, { ...session, role: "admin" });
  return res.json({ success: true, role: "admin" });
});

app.post("/api/auth/logout", (req, res) => {
  const token = req.cookies?.["session"];
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", `session=; Path=/; HttpOnly; Max-Age=0`);
  return res.json({ success: true });
});

app.get("/api/auth/me", (req, res) => {
  const session = getSession(req);
  if (!session) return res.json({ authenticated: false });
  return res.json({ authenticated: true, role: session.role });
});

// ── Admin routes ──────────────────────────────────────────────────────────
app.get("/api/admin/config", requireAdmin, (req, res) => {
  const cfg = loadConfig();
  return res.json({
    globalProxy: cfg.globalProxy || "",
    checkoutProxy: cfg.checkoutProxy || "",
    userPassword: cfg.userPassword || "",
  });
});

app.post("/api/admin/proxy", requireAdmin, (req, res) => {
  const { proxy } = req.body;
  const cfg = loadConfig();
  cfg.globalProxy = proxy || "";
  saveConfig(cfg);
  console.log(`[Admin] Global proxy set to: ${cfg.globalProxy || "(none)"}`);
  return res.json({ success: true, globalProxy: cfg.globalProxy });
});

app.post("/api/admin/checkout-proxy", requireAdmin, (req, res) => {
  const { proxy } = req.body;
  const cfg = loadConfig();
  cfg.checkoutProxy = proxy || "";
  saveConfig(cfg);
  console.log(`[Admin] Checkout proxy set to: ${cfg.checkoutProxy || "(none)"}`);
  return res.json({ success: true, checkoutProxy: cfg.checkoutProxy });
});

app.post("/api/admin/passwords", requireAdmin, (req, res) => {
  const { adminPassword, userPassword } = req.body;
  const cfg = loadConfig();
  if (adminPassword) cfg.adminPassword = adminPassword;
  if (userPassword) cfg.userPassword = userPassword;
  saveConfig(cfg);
  return res.json({ success: true });
});

// ── Address Management ───────────────────────────────────────────────────
app.get("/api/admin/addresses", requireAdmin, (req, res) => {
  const cfg = loadConfig();
  return res.json({ addresses: cfg.addresses || [] });
});

app.post("/api/admin/addresses", requireAdmin, (req, res) => {
  const { label, name, country, addressLine1, addressLine2, city, zip, state } = req.body;
  if (!name || !country || !addressLine1 || !city || !zip) {
    return res.status(400).json({ error: "name, country, addressLine1, city, zip are required" });
  }
  const cfg = loadConfig();
  if (!cfg.addresses) cfg.addresses = [];
  cfg.addresses.push({ label: label || `Address ${cfg.addresses.length + 1}`, name, country, addressLine1, addressLine2: addressLine2 || "", city, zip, state: state || "" });
  saveConfig(cfg);
  return res.json({ success: true, addresses: cfg.addresses });
});

app.put("/api/admin/addresses/:index", requireAdmin, (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const cfg = loadConfig();
  if (!cfg.addresses || idx < 0 || idx >= cfg.addresses.length) {
    return res.status(404).json({ error: "Address not found" });
  }
  const { label, name, country, addressLine1, addressLine2, city, zip, state } = req.body;
  cfg.addresses[idx] = { label: label || cfg.addresses[idx].label, name: name || cfg.addresses[idx].name, country: country || cfg.addresses[idx].country, addressLine1: addressLine1 || cfg.addresses[idx].addressLine1, addressLine2: addressLine2 !== undefined ? addressLine2 : cfg.addresses[idx].addressLine2, city: city || cfg.addresses[idx].city, zip: zip || cfg.addresses[idx].zip, state: state !== undefined ? state : cfg.addresses[idx].state };
  saveConfig(cfg);
  return res.json({ success: true, addresses: cfg.addresses });
});

app.delete("/api/admin/addresses/:index", requireAdmin, (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const cfg = loadConfig();
  if (!cfg.addresses || idx < 0 || idx >= cfg.addresses.length) {
    return res.status(404).json({ error: "Address not found" });
  }
  cfg.addresses.splice(idx, 1);
  saveConfig(cfg);
  return res.json({ success: true, addresses: cfg.addresses });
});

// ── Countries/States API ──────────────────────────────────────────────────
app.get("/api/countries", (req, res) => {
  return res.json({ countries: COUNTRIES_LIST, states: STATES });
});

// ── Country configs ───────────────────────────────────────────────────────
const PROMO = { promo_campaign_id: "plus-1-month-free", is_coupon_from_query_param: false };
const COUNTRIES = {
  ID: { currency: "IDR", promo: PROMO },
  US: { currency: "USD", promo: PROMO },
  JP: { currency: "JPY", promo: PROMO },
  GB: { currency: "GBP", promo: PROMO },
};

// ── Parse session ─────────────────────────────────────────────────────────
app.post("/api/parse-session", requireAuth, (req, res) => {
  const { sessionData } = req.body;
  if (!sessionData) return res.status(400).json({ error: "No data" });

  const raw = typeof sessionData === "string" ? sessionData.trim() : JSON.stringify(sessionData);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }

  const extract = (field, regex) => {
    if (parsed) {
      const keys = field.split(".");
      let val = parsed;
      for (const k of keys) { val = val?.[k]; }
      if (val) return val;
    }
    const m = raw.match(regex);
    return m ? m[1] : null;
  };

  const accessToken = extract("accessToken", /"accessToken"\s*:\s*"(eyJ[A-Za-z0-9_\-\.]+)"/);
  const userName = extract("user.name", /"name"\s*:\s*"([^"]+)"/);
  const userEmail = extract("user.email", /"email"\s*:\s*"([^"]+)"/);
  const planType = extract("account.planType", /"planType"\s*:\s*"([^"]+)"/);
  const structure = extract("account.structure", /"structure"\s*:\s*"([^"]+)"/);
  const expires = extract("expires", /"expires"\s*:\s*"([^"]+)"/);

  if (!accessToken) return res.status(400).json({ error: "No accessToken found." });

  return res.json({
    success: true,
    info: {
      user: { name: userName || "Unknown", email: userEmail || "Unknown" },
      account: { planType: planType || "free", structure: structure || "Unknown" },
      expires,
      accessToken,
      hasValidToken: true,
    },
  });
});

// ── curl-impersonate checkout ─────────────────────────────────────────────
function curlCheckout(accessToken, payload, proxy) {
  return new Promise((resolve, reject) => {
    const args = [
      "-s",
      "-X", "POST",
      "-H", `Authorization: Bearer ${accessToken}`,
      "-H", "Content-Type: application/json",
      "-H", "Accept: application/json",
      "-d", JSON.stringify(payload),
      "--max-time", "20",
    ];
    if (proxy) args.push("-x", proxy);
    args.push("https://chatgpt.com/backend-api/payments/checkout");

    execFile(CURL_CHROME, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`curl error: ${err.message}`));
      try {
        const data = JSON.parse(stdout);
        resolve(data);
      } catch (e) {
        if (stdout.includes("<html")) reject(new Error("Cloudflare blocked"));
        else reject(new Error(`Invalid response: ${stdout.substring(0, 200)}`));
      }
    });
  });
}

// ── Generate link ─────────────────────────────────────────────────────────
app.post("/api/generate-link", requireAuth, async (req, res) => {
  const { accessToken, offerCountry = "JP", billingCountry = "ID", mode = "hosted", proxy: userProxy } = req.body;

  const offer = offerCountry || "JP";
  const billing = billingCountry || "ID";

  if (!accessToken) return res.status(400).json({ error: "accessToken required" });

  const offerCC = COUNTRIES[offer];
  const billingCC = COUNTRIES[billing];
  if (!offerCC) return res.status(400).json({ error: "Unsupported offer country" });
  if (!billingCC) return res.status(400).json({ error: "Unsupported billing country" });

  // Determine proxy: user proxy → global proxy → none
  const cfg = loadConfig();
  const proxy = userProxy || cfg.globalProxy || null;

  let payload;
  if (mode === "hosted") {
    payload = {
      plan_name: "chatgptplusplan",
      billing_details: { country: billing, currency: billingCC.currency },
      cancel_url: "https://chatgpt.com/#pricing",
      checkout_ui_mode: "hosted",
    };
    if (offerCC.promo) payload.promo_campaign = offerCC.promo;
  } else {
    payload = {
      entry_point: "all_plans_pricing_modal",
      plan_name: "chatgptplusplan",
      billing_details: { country: billing, currency: billingCC.currency },
      checkout_ui_mode: "custom",
    };
    if (offerCC.promo) payload.promo_campaign = offerCC.promo;
  }

  try {
    console.log(`[${new Date().toISOString()}] Generate — offer:${offer} billing:${billing} | ${mode} | proxy:${proxy ? "yes" : "none"}`);

    let data;
    let promoSkipped = false;
    try {
      data = await curlCheckout(accessToken, payload, proxy);
      if (data.detail || data.error) throw new Error(data.detail || data.error);
    } catch (e) {
      if (payload.promo_campaign) {
        console.log("  → Promo failed, retrying without...");
        const noPromo = { ...payload };
        delete noPromo.promo_campaign;
        data = await curlCheckout(accessToken, noPromo, proxy);
        if (data.detail || data.error) {
          return res.status(502).json({ error: data.detail || data.error || e.message });
        }
        promoSkipped = true;
      } else {
        return res.status(502).json({ error: e.message });
      }
    }

    console.log("  → ✓ Success");

    const output = { success: true, mode, promoSkipped, raw: data };
    if (mode === "hosted") {
      output.link = data.url || data.stripe_hosted_url || data.checkout_url;
      output.checkout_session_id = data.checkout_session_id;
    } else {
      const entity = data.processor_entity || "openai_llc";
      const sid = data.checkout_session_id;
      output.link = sid ? `https://chatgpt.com/checkout/${entity}/${sid}` : null;
      output.checkout_session_id = sid;
    }
    if (!output.link) { output.success = false; output.error = "No link in response"; }

    console.log("  →", output.link ? `✓ ${output.link.substring(0, 60)}...` : "✗ No link");
    return res.json(output);
  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// AUTO-CHECKOUT — Puppeteer automation on Stripe hosted checkout
// ══════════════════════════════════════════════════════════════════════════

async function runAutoCheckout(checkoutUrl, address) {
  const puppeteer = require("puppeteer");
  const debugDir = path.join(__dirname, "public", "debug");
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });

  console.log("[AutoCheckout] Launching browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    console.log("[AutoCheckout] Loading page...");
    await page.goto(checkoutUrl, { waitUntil: "networkidle2", timeout: 45000 });
    await delay(3000);
    await page.screenshot({ path: path.join(debugDir, "01_loaded.png"), fullPage: true });

    // Click GoPay radio
    console.log("[AutoCheckout] Clicking GoPay...");
    const gopay = await page.evaluate(() => {
      for (const el of document.querySelectorAll("div, span, label, li")) {
        if (el.textContent?.trim() === "GoPay") {
          const r = el.closest("[role='radio'], label, li, [data-testid]") || el.parentElement;
          if (r) { r.click(); return true; }
        }
      }
      return false;
    });
    console.log("[AutoCheckout] GoPay:", gopay ? "OK" : "NOT FOUND");
    await delay(3000);
    await page.screenshot({ path: path.join(debugDir, "02_gopay.png"), fullPage: true });

    // Fill Name + Country + Click manual address
    console.log("[AutoCheckout] Filling name & country...");
    const p2 = await page.evaluate((addr) => {
      const log = [];
      function setVal(el, v) {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        s.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const name = document.querySelector("#billingName, input[autocomplete='name'], input[placeholder*='Name' i]");
      if (name) { name.focus(); setVal(name, addr.name); log.push("name-ok"); } else log.push("name-MISS");
      const country = document.querySelector("#billingCountry, select[autocomplete='country']");
      if (country) { country.value = addr.country; country.dispatchEvent(new Event("change", { bubbles: true })); log.push("country-ok"); } else log.push("country-MISS");
      for (const l of document.querySelectorAll("a, button, span")) {
        if (l.textContent?.trim().toLowerCase().includes("enter address manually")) { l.click(); log.push("manual-ok"); break; }
      }
      return log;
    }, address);
    console.log("[AutoCheckout] Phase2:", p2.join(", "));
    await delay(2000);
    await page.screenshot({ path: path.join(debugDir, "03_manual.png"), fullPage: true });

    // Fill address fields + checkbox
    console.log("[AutoCheckout] Filling address...");
    const p3 = await page.evaluate((addr) => {
      const log = [];
      function setVal(el, v) {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        s.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const a1 = document.querySelector("#billingAddressLine1, input[autocomplete='address-line1'], input[placeholder*='Address line 1' i]");
      if (a1) { a1.focus(); setVal(a1, addr.addressLine1); log.push("addr1-ok"); } else log.push("addr1-MISS");
      if (addr.addressLine2) { const a2 = document.querySelector("#billingAddressLine2, input[autocomplete='address-line2']"); if (a2) setVal(a2, addr.addressLine2); }
      const city = document.querySelector("#billingLocality, input[autocomplete='address-level2'], input[placeholder*='City' i]");
      if (city) { city.focus(); setVal(city, addr.city); log.push("city-ok"); } else log.push("city-MISS");
      const zip = document.querySelector("#billingPostal, input[autocomplete='postal-code'], input[placeholder*='ZIP' i]");
      if (zip) { zip.focus(); setVal(zip, addr.zip); log.push("zip-ok"); } else log.push("zip-MISS");
      if (addr.state) {
        const st = document.querySelector("#billingAdministrativeArea, select[autocomplete='address-level1']");
        if (st) { st.value = addr.state; st.dispatchEvent(new Event("change", { bubbles: true })); log.push("state-ok"); } else log.push("state-MISS");
      }
      const cb = document.querySelector("input[type='checkbox']");
      if (cb && !cb.checked) { cb.click(); log.push("cb-ok"); }
      const rcb = document.querySelector("[role='checkbox']");
      if (rcb) { rcb.click(); log.push("rcb-ok"); }
      return log;
    }, address);
    console.log("[AutoCheckout] Phase3:", p3.join(", "));
    await delay(1000);
    await page.screenshot({ path: path.join(debugDir, "04_filled.png"), fullPage: true });

    // Click Pay/Subscribe button
    console.log("[AutoCheckout] Clicking Pay...");
    const btn = await page.evaluate(() => {
      for (const b of document.querySelectorAll("button")) {
        const t = b.textContent?.trim().toLowerCase();
        if (t && (t.includes("subscribe") || t.includes("pay"))) { b.scrollIntoView(); b.click(); return t; }
      }
      const sub = document.querySelector("button[type='submit']");
      if (sub) { sub.click(); return "submit"; }
      return null;
    });
    console.log("[AutoCheckout] Button:", btn || "NOT FOUND");
    if (!btn) {
      await page.screenshot({ path: path.join(debugDir, "05_no_btn.png"), fullPage: true });
      throw new Error("No Pay/Subscribe button");
    }

    // Wait for GoPay redirect
    console.log("[AutoCheckout] Waiting redirect...");
    let gopayUrl = null;
    try {
      await page.waitForFunction(() => window.location.href.includes("midtrans.com") || window.location.href.includes("gopay"), { timeout: 60000 });
      gopayUrl = page.url();
    } catch {
      await delay(5000);
      const cur = page.url();
      if (cur !== checkoutUrl && !cur.includes("stripe.com") && !cur.includes("pay.openai.com")) gopayUrl = cur;
    }
    await page.screenshot({ path: path.join(debugDir, "06_final.png"), fullPage: true });
    console.log("[AutoCheckout] Result:", gopayUrl || "NO REDIRECT");

    return { success: !!gopayUrl, stripeUrl: checkoutUrl, gopayUrl, addressUsed: address.label, error: gopayUrl ? null : "No redirect" };
  } finally {
    await browser.close();
    console.log("[AutoCheckout] Done.");
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Auto-checkout endpoint ────────────────────────────────────────────────
app.post("/api/auto-checkout", requireAuth, async (req, res) => {
  const { checkoutUrl } = req.body;
  if (!checkoutUrl) return res.status(400).json({ error: "checkoutUrl required" });

  const cfg = loadConfig();
  const addresses = cfg.addresses || [];
  if (addresses.length === 0) return res.status(400).json({ error: "No addresses configured." });

  const address = addresses[addressRotationIndex % addresses.length];
  addressRotationIndex++;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`[AutoCheckout] Starting — Address: "${address.label}"`);
  console.log(`${"═".repeat(60)}`);

  try {
    const result = await runAutoCheckout(checkoutUrl, address);
    return res.json(result);
  } catch (err) {
    console.error("[AutoCheckout] ERROR:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Diaa Store GPT Pay running at http://localhost:${PORT}\n`);
});
