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

async function runAutoCheckout(checkoutUrl, address, proxy) {
  const puppeteer = require("puppeteer");

  // Debug screenshots directory
  const debugDir = path.join(__dirname, "public", "debug");
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
  const ss = async (page, name) => {
    try { await page.screenshot({ path: path.join(debugDir, `${name}.png`), fullPage: true }); } catch {}
  };

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--window-size=1280,900",
  ];

  let proxyAuth = null;
  if (proxy) {
    try {
      const pUrl = new URL(proxy);
      launchArgs.push(`--proxy-server=${pUrl.protocol}//${pUrl.hostname}:${pUrl.port}`);
      if (pUrl.username) {
        proxyAuth = { username: decodeURIComponent(pUrl.username), password: decodeURIComponent(pUrl.password || "") };
      }
    } catch {
      launchArgs.push(`--proxy-server=${proxy}`);
    }
  }

  console.log("[AutoCheckout] Launching browser...");
  const browser = await puppeteer.launch({ headless: "new", args: launchArgs });

  try {
    const page = await browser.newPage();
    if (proxyAuth) await page.authenticate(proxyAuth);
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");

    // ── Step 1: Navigate ──
    console.log("[AutoCheckout] Opening:", checkoutUrl.substring(0, 80) + "...");
    await page.goto(checkoutUrl, { waitUntil: "networkidle2", timeout: 45000 });
    await delay(4000);
    await ss(page, "01_loaded");

    // ── Step 2: Click GoPay ──
    console.log("[AutoCheckout] Selecting GoPay...");
    const gopayClicked = await page.evaluate(() => {
      const allEls = document.querySelectorAll("div, span, label, button, li");
      for (const el of allEls) {
        const txt = el.textContent?.trim();
        if (txt === "GoPay" && el.children.length <= 2) {
          const target = el.closest("[role='radio'], [role='option'], [data-testid], button, label, li") || el.parentElement;
          if (target) { target.click(); return "found"; }
        }
      }
      return null;
    });
    console.log(`[AutoCheckout] GoPay: ${gopayClicked || "NOT FOUND"}`);
    await delay(3000);
    await ss(page, "02_gopay_clicked");

    // ── DEBUG: Dump all form elements ──
    const domDump = await page.evaluate(() => {
      const els = {};
      els.inputs = Array.from(document.querySelectorAll("input")).map(e => ({
        type: e.type, id: e.id, name: e.name, placeholder: e.placeholder,
        autocomplete: e.autocomplete, visible: e.offsetParent !== null, value: e.value
      }));
      els.selects = Array.from(document.querySelectorAll("select")).map(e => ({
        id: e.id, name: e.name, autocomplete: e.autocomplete, optionCount: e.options.length
      }));
      els.buttons = Array.from(document.querySelectorAll("button")).map(e => ({
        text: e.textContent?.trim().substring(0, 40), type: e.type, disabled: e.disabled
      }));
      els.links = Array.from(document.querySelectorAll("a")).map(e => ({
        text: e.textContent?.trim().substring(0, 50), href: e.href?.substring(0, 50)
      }));
      els.checkboxes = Array.from(document.querySelectorAll("[role='checkbox'], input[type='checkbox']")).map(e => ({
        tag: e.tagName, id: e.id, checked: e.checked, ariaChecked: e.getAttribute('aria-checked')
      }));
      els.iframes = Array.from(document.querySelectorAll("iframe")).map(e => ({
        src: e.src?.substring(0, 80), id: e.id, name: e.name
      }));
      return els;
    });
    console.log("[AutoCheckout] === DOM DUMP ===");
    console.log(JSON.stringify(domDump, null, 2));
    console.log("[AutoCheckout] === END DUMP ===");

    // ── Step 3: Fill Name ──
    console.log("[AutoCheckout] Filling name:", address.name);
    const nameSelectors = ["#billingName", "input[autocomplete='name']", "input[placeholder*='Name' i]", "input[name*='name' i]"];
    for (const sel of nameSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(address.name, { delay: 30 });
        console.log("[AutoCheckout] Name filled via:", sel);
        break;
      }
    }
    await delay(500);

    // ── Step 4: Select Country (native <select>) ──
    console.log("[AutoCheckout] Selecting country:", address.country);
    const countrySelectors = ["#billingCountry", "select[autocomplete='country']", "select[name*='country' i]"];
    for (const sel of countrySelectors) {
      const el = await page.$(sel);
      if (el) {
        // Use page.select with the country code
        try {
          await page.select(sel, address.country);
          console.log("[AutoCheckout] Country selected via:", sel);
        } catch {
          // Fallback: try matching by text
          await page.evaluate((selector, code) => {
            const select = document.querySelector(selector);
            if (!select) return;
            const opt = Array.from(select.options).find(o => o.value === code || o.text.includes(code));
            if (opt) { select.value = opt.value; select.dispatchEvent(new Event('change', { bubbles: true })); }
          }, sel, address.country);
        }
        break;
      }
    }
    await delay(2000);

    // ── Step 5: Click "Enter address manually" link ──
    console.log("[AutoCheckout] Looking for 'Enter address manually' link...");
    const manualClicked = await page.evaluate(() => {
      const links = document.querySelectorAll("a, button, span, div");
      for (const link of links) {
        const txt = link.textContent?.trim().toLowerCase();
        if (txt && (txt.includes("enter address manually") || txt.includes("manual") || txt.includes("enter address"))) {
          link.click();
          return txt;
        }
      }
      return null;
    });
    console.log(`[AutoCheckout] Manual address link: ${manualClicked || "NOT FOUND (fields may already be visible)"}`);
    await delay(2000);
    await ss(page, "03_manual_address");

    // ── Step 6: Fill Address Line 1 ──
    console.log("[AutoCheckout] Filling address line 1:", address.addressLine1);
    const addr1Selectors = ["#billingAddressLine1", "input[autocomplete='address-line1']", "input[placeholder*='Address line 1' i]", "input[placeholder*='Address' i]:not([placeholder*='line 2' i])", "input[name*='addressLine1' i]"];
    for (const sel of addr1Selectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(address.addressLine1, { delay: 25 });
        console.log("[AutoCheckout] Address1 filled via:", sel);
        break;
      }
    }
    await delay(500);

    // ── Step 7: Fill Address Line 2 (optional) ──
    if (address.addressLine2) {
      console.log("[AutoCheckout] Filling address line 2...");
      const addr2Selectors = ["#billingAddressLine2", "input[autocomplete='address-line2']", "input[placeholder*='Address line 2' i]"];
      for (const sel of addr2Selectors) {
        const el = await page.$(sel);
        if (el) {
          await el.click({ clickCount: 3 });
          await el.type(address.addressLine2, { delay: 25 });
          break;
        }
      }
      await delay(300);
    }

    // ── Step 8: Fill City ──
    console.log("[AutoCheckout] Filling city:", address.city);
    const citySelectors = ["#billingLocality", "input[autocomplete='address-level2']", "input[placeholder*='City' i]", "input[name*='city' i]", "input[name*='locality' i]"];
    for (const sel of citySelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(address.city, { delay: 25 });
        break;
      }
    }
    await delay(300);

    // ── Step 9: Fill ZIP ──
    console.log("[AutoCheckout] Filling ZIP:", address.zip);
    const zipSelectors = ["#billingPostal", "input[autocomplete='postal-code']", "input[placeholder*='ZIP' i]", "input[placeholder*='Postal' i]", "input[name*='postal' i]"];
    for (const sel of zipSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.type(address.zip, { delay: 25 });
        break;
      }
    }
    await delay(300);

    // ── Step 10: Select State (native <select>) ──
    if (address.state) {
      console.log("[AutoCheckout] Selecting state:", address.state);
      const stateSelectors = ["#billingAdministrativeArea", "select[autocomplete='address-level1']", "select[name*='state' i]", "select[name*='administrativeArea' i]"];
      for (const sel of stateSelectors) {
        const el = await page.$(sel);
        if (el) {
          try {
            await page.select(sel, address.state);
            console.log("[AutoCheckout] State selected via:", sel);
          } catch {
            await page.evaluate((selector, code) => {
              const select = document.querySelector(selector);
              if (!select) return;
              const opt = Array.from(select.options).find(o => o.value === code || o.text.includes(code));
              if (opt) { select.value = opt.value; select.dispatchEvent(new Event('change', { bubbles: true })); }
            }, sel, address.state);
          }
          break;
        }
      }
      await delay(500);
    }

    await ss(page, "04_form_filled");

    // ── Step 11: Handle terms checkbox ──
    console.log("[AutoCheckout] Checking terms checkbox...");
    // First scroll down to make checkbox visible
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(500);

    const checkboxResult = await page.evaluate(() => {
      let result = [];

      // Strategy 1: Find checkbox input directly
      const checkboxes = document.querySelectorAll("input[type='checkbox']");
      for (const cb of checkboxes) {
        if (!cb.checked) {
          cb.click();
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          cb.dispatchEvent(new Event('input', { bubbles: true }));
          result.push("input-click");
        }
      }

      // Strategy 2: Find by role='checkbox'
      const roleCheckboxes = document.querySelectorAll("[role='checkbox']");
      for (const cb of roleCheckboxes) {
        if (cb.getAttribute('aria-checked') !== 'true') {
          cb.click();
          result.push("role-click");
        }
      }

      // Strategy 3: Find the terms text container and click its checkbox/label area
      const allEls = document.querySelectorAll("div, span, p, label");
      for (const el of allEls) {
        const txt = el.textContent?.toLowerCase() || "";
        if (txt.includes("you'll be charged") || txt.includes("terms of use") || txt.includes("you agree")) {
          // Find checkbox near this text
          const parent = el.closest("div, label, section");
          if (parent) {
            const cb = parent.querySelector("input[type='checkbox'], [role='checkbox']");
            if (cb) {
              cb.click();
              result.push("terms-parent-click");
            }
            // Also try clicking the parent container itself
            const clickable = parent.querySelector("label, [class*='checkbox'], [class*='Checkbox']");
            if (clickable) {
              clickable.click();
              result.push("terms-label-click");
            }
          }
          break;
        }
      }

      // Strategy 4: Click any unchecked checkbox-looking element
      const checkboxLike = document.querySelectorAll("[class*='checkbox' i], [class*='Checkbox'], [data-testid*='checkbox' i]");
      for (const el of checkboxLike) {
        el.click();
        result.push("class-click");
      }

      return result.length ? result.join(", ") : "none-found";
    });
    console.log(`[AutoCheckout] Checkbox strategies used: ${checkboxResult}`);

    // Also try Puppeteer native click on any checkbox
    try {
      const cbHandle = await page.$("input[type='checkbox']");
      if (cbHandle) {
        const isChecked = await page.evaluate(el => el.checked, cbHandle);
        if (!isChecked) {
          await cbHandle.click();
          console.log("[AutoCheckout] Puppeteer native checkbox click");
        }
      }
    } catch {}
    await delay(1000);
    await ss(page, "05_checkbox_done");

    // ── Step 12: Scroll down and Click Subscribe ──
    console.log("[AutoCheckout] Clicking Subscribe...");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(500);

    const subClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button, [role='button']");
      for (const btn of buttons) {
        const txt = btn.textContent?.trim().toLowerCase();
        if (txt && txt.includes("subscribe")) {
          btn.scrollIntoView();
          btn.click();
          return txt;
        }
      }
      // Fallback: submit button
      const submit = document.querySelector("button[type='submit']");
      if (submit) { submit.click(); return "submit-fallback"; }
      return null;
    });
    console.log(`[AutoCheckout] Subscribe: ${subClicked || "NOT FOUND"}`);

    if (!subClicked) {
      await ss(page, "06_subscribe_NOT_FOUND");
      // Dump page HTML for debugging
      const html = await page.content();
      const allButtons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button')).map(b => ({
          text: b.textContent?.trim().substring(0, 50),
          type: b.type,
          disabled: b.disabled,
          visible: b.offsetParent !== null
        }));
      });
      console.log("[AutoCheckout] All buttons on page:", JSON.stringify(allButtons, null, 2));
      throw new Error("Could not find Subscribe button — check /debug/ screenshots");
    }
    await ss(page, "06_subscribe_clicked");

    // ── Step 13: Wait for redirect to midtrans/gopay ──
    console.log("[AutoCheckout] Waiting for GoPay redirect...");
    let gopayUrl = null;

    try {
      await page.waitForFunction(
        () => window.location.href.includes("midtrans.com") || window.location.href.includes("gopay"),
        { timeout: 60000 }
      );
      gopayUrl = page.url();
    } catch {
      await delay(5000);
      const currentUrl = page.url();
      if (currentUrl !== checkoutUrl && !currentUrl.includes("stripe.com")) {
        gopayUrl = currentUrl;
      }
    }

    console.log(`[AutoCheckout] Final URL: ${gopayUrl || "NO REDIRECT"}`);

    return {
      success: !!gopayUrl,
      stripeUrl: checkoutUrl,
      gopayUrl: gopayUrl,
      addressUsed: address.label,
      error: gopayUrl ? null : "No redirect detected — checkout may have failed",
    };
  } finally {
    await browser.close();
    console.log("[AutoCheckout] Browser closed.");
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Auto-checkout endpoint ────────────────────────────────────────────────
app.post("/api/auto-checkout", requireAuth, async (req, res) => {
  const { checkoutUrl } = req.body;
  if (!checkoutUrl) return res.status(400).json({ error: "checkoutUrl required" });

  const cfg = loadConfig();
  const addresses = cfg.addresses || [];
  if (addresses.length === 0) return res.status(400).json({ error: "No addresses configured. Add addresses in Admin Panel." });

  // Auto-rotate address
  const address = addresses[addressRotationIndex % addresses.length];
  addressRotationIndex++;

  const proxy = cfg.checkoutProxy || null;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`[AutoCheckout] Starting — Address: "${address.label}" | Proxy: ${proxy ? "yes" : "none"}`);
  console.log(`${"═".repeat(60)}`);

  try {
    const result = await runAutoCheckout(checkoutUrl, address, proxy);
    return res.json(result);
  } catch (err) {
    console.error("[AutoCheckout] ERROR:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Diaa Store GPT Pay running at http://localhost:${PORT}\n`);
});
