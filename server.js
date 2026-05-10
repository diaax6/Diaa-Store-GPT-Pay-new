const express = require("express");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { COUNTRIES_LIST, STATES } = require("./countries");
const whatsapp = require("./whatsapp");
const { automateGoPay, continueWithOTP } = require("./midtrans-auto");

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
// AUTO-CHECKOUT — Direct API (no browser needed!)
// ══════════════════════════════════════════════════════════════════════════

async function runAutoCheckout(checkoutUrl, address) {
  console.log("[DirectAPI] Starting...");

  // Extract session ID from URL
  const csMatch = checkoutUrl.match(/cs_live_[a-zA-Z0-9_]+/);
  if (!csMatch) throw new Error("No checkout session ID in URL");
  const sessionId = csMatch[0];
  console.log("[DirectAPI] Session:", sessionId);

  // OpenAI's Stripe publishable key (public, from checkout page telemetry)
  const pk = "pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRacViovU3kLKvpkjh7IqkW00iXQsjo3n";
  console.log("[DirectAPI] PK: pk_live_51HOrSwC6h1nx...");

  // Fetch session info from Stripe to get expected amount/currency
  let expectedAmount = "0";
  let expectedCurrency = "idr";
  try {
    console.log("[DirectAPI] Fetching session info...");
    const sessRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
      headers: { "Authorization": `Bearer ${pk}` },
    });
    if (sessRes.ok) {
      const sessData = await sessRes.json();
      if (sessData.amount_total != null) expectedAmount = String(sessData.amount_total);
      if (sessData.currency) expectedCurrency = sessData.currency;
      console.log("[DirectAPI] Session data:", expectedAmount, expectedCurrency);
    } else {
      console.log("[DirectAPI] Session fetch status:", sessRes.status, "- using defaults");
    }
  } catch (e) { console.log("[DirectAPI] Session fetch error:", e.message); }

  // Step 2: Confirm payment via Stripe API
  const body = new URLSearchParams();
  body.append("eid", "NA");
  body.append("payment_method_data[type]", "gopay");
  body.append("payment_method_data[billing_details][name]", address.name);
  body.append("payment_method_data[billing_details][address][country]", address.country);
  body.append("payment_method_data[billing_details][address][line1]", address.addressLine1);
  if (address.addressLine2) body.append("payment_method_data[billing_details][address][line2]", address.addressLine2);
  body.append("payment_method_data[billing_details][address][city]", address.city);
  if (address.state) body.append("payment_method_data[billing_details][address][state]", address.state);
  body.append("payment_method_data[billing_details][address][postal_code]", address.zip);
  body.append("expected_amount", expectedAmount);
  body.append("consent[terms_of_service]", "accepted");
  body.append("return_url", checkoutUrl);

  const headers = {
    "Authorization": `Bearer ${pk}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Origin": "https://checkout.stripe.com",
    "Referer": "https://checkout.stripe.com/",
  };

  // Stripe confirm endpoint
  const endpoint = `https://api.stripe.com/v1/payment_pages/${sessionId}/confirm`;

  console.log("[DirectAPI] Confirming:", endpoint);
  const confirmRes = await fetch(endpoint, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  const data = await confirmRes.json();
  console.log("[DirectAPI] Status:", confirmRes.status);
  console.log("[DirectAPI] Response:", JSON.stringify(data).substring(0, 1500));

  if (confirmRes.status !== 200) {
    console.log("[DirectAPI] Confirm failed!");
    return {
      success: false,
      stripeUrl: checkoutUrl,
      gopayUrl: null,
      addressUsed: address.label,
      error: data?.error?.message || "API confirm failed",
      debug: JSON.stringify(data).substring(0, 500)
    };
  }

  // Log top-level keys and key fields
  console.log("[DirectAPI] Response keys:", Object.keys(data).join(", "));
  console.log("[DirectAPI] setup_intent:", JSON.stringify(data.setup_intent)?.substring(0, 200));
  console.log("[DirectAPI] payment_intent:", JSON.stringify(data.payment_intent)?.substring(0, 200));

  // The confirm returns a session — the redirect URL is in the setup_intent/payment_intent
  let gopayUrl = null;

  // Try to get redirect from nested intent objects (if expanded)
  gopayUrl = data?.setup_intent?.next_action?.redirect_to_url?.url
    || data?.payment_intent?.next_action?.redirect_to_url?.url
    || data?.next_action?.redirect_to_url?.url;

  // If setup_intent/payment_intent is just an ID string, fetch it separately
  if (!gopayUrl) {
    const intentId = data?.setup_intent || data?.payment_intent;
    if (typeof intentId === "string" && intentId.startsWith("seti_")) {
      console.log("[DirectAPI] Fetching SetupIntent:", intentId);
      const siRes = await fetch(`https://api.stripe.com/v1/setup_intents/${intentId}`, {
        headers: { "Authorization": `Bearer ${pk}` },
      });
      const siData = await siRes.json();
      console.log("[DirectAPI] SetupIntent status:", siData.status);
      console.log("[DirectAPI] SetupIntent next_action:", JSON.stringify(siData.next_action)?.substring(0, 500));
      gopayUrl = siData?.next_action?.redirect_to_url?.url;
    } else if (typeof intentId === "string" && intentId.startsWith("pi_")) {
      console.log("[DirectAPI] Fetching PaymentIntent:", intentId);
      const piRes = await fetch(`https://api.stripe.com/v1/payment_intents/${intentId}`, {
        headers: { "Authorization": `Bearer ${pk}` },
      });
      const piData = await piRes.json();
      console.log("[DirectAPI] PaymentIntent status:", piData.status);
      console.log("[DirectAPI] PaymentIntent next_action:", JSON.stringify(piData.next_action)?.substring(0, 500));
      gopayUrl = piData?.next_action?.redirect_to_url?.url;
    }
  }

  // Fallback: search entire JSON for midtrans URLs
  if (!gopayUrl) {
    const fullJson = JSON.stringify(data);
    const midtransMatch = fullJson.match(/https?:\/\/[^"]*midtrans\.com[^"]*/);
    if (midtransMatch) gopayUrl = midtransMatch[0].replace(/\\\//g, "/");
  }
  // Follow redirect to get final Midtrans URL
  if (gopayUrl && gopayUrl.includes("stripe.com")) {
    console.log("[DirectAPI] Following redirect:", gopayUrl);
    try {
      const rRes = await fetch(gopayUrl, { redirect: "manual" });
      const location = rRes.headers.get("location");
      if (location) {
        console.log("[DirectAPI] Redirect →", location);
        gopayUrl = location;
        // Follow one more redirect if needed
        if (!location.includes("midtrans.com")) {
          const r2 = await fetch(location, { redirect: "manual" });
          const loc2 = r2.headers.get("location");
          if (loc2) { console.log("[DirectAPI] Redirect →", loc2); gopayUrl = loc2; }
        }
      }
    } catch (e) { console.log("[DirectAPI] Redirect follow error:", e.message); }
  }

  console.log("[DirectAPI] Final GoPay URL:", gopayUrl || "NOT FOUND");
  console.log("[DirectAPI] Done! ✓");

  return {
    success: !!gopayUrl,
    stripeUrl: checkoutUrl,
    gopayUrl,
    addressUsed: address.label,
    error: gopayUrl ? null : "No redirect URL in response",
    debug: gopayUrl ? null : JSON.stringify(data).substring(0, 500)
  };
}

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
  console.log(`[DirectAPI] Starting — Address: "${address.label}"`);
  console.log(`${"═".repeat(60)}`);

  try {
    const result = await runAutoCheckout(checkoutUrl, address);
    return res.json(result);
  } catch (err) {
    console.error("[DirectAPI] ERROR:", err.message);
    return res.status(500).json({ error: err.message });
  }
});


// Get GoPay config (multi-account)
app.get("/api/gopay/config", requireAdmin, (req, res) => {
  const cfg = loadConfig();
  const accounts = cfg.gopayAccounts || [];
  res.json({
    accounts: accounts.map(a => ({ phone: a.phone, pin: a.pin ? "••••••" : "" })),
    activeIndex: cfg.gopayActiveIndex || 0,
    // Legacy single account
    phone: cfg.gopayPhone || "",
    hasPin: !!cfg.gopayPin,
  });
});

// Set GoPay config (multi-account)
app.post("/api/gopay/config", requireAdmin, (req, res) => {
  const { phone, pin, accounts } = req.body;
  const cfg = loadConfig();

  // Support array of accounts
  if (accounts && Array.isArray(accounts)) {
    cfg.gopayAccounts = accounts;
    // Also set first as legacy
    if (accounts.length > 0) {
      cfg.gopayPhone = accounts[0].phone;
      cfg.gopayPin = accounts[0].pin;
    }
  } else if (phone !== undefined) {
    // Legacy single account
    cfg.gopayPhone = phone;
    if (pin !== undefined) cfg.gopayPin = pin;

    // Also add to accounts array
    if (!cfg.gopayAccounts) cfg.gopayAccounts = [];
    const existing = cfg.gopayAccounts.find(a => a.phone === phone);
    if (existing) {
      existing.pin = pin || existing.pin;
    } else {
      cfg.gopayAccounts.push({ phone, pin });
    }
  }

  cfg.gopayActiveIndex = cfg.gopayActiveIndex || 0;
  saveConfig(cfg);
  console.log("[GoPay] Config updated —", (cfg.gopayAccounts || []).length, "accounts");
  res.json({ success: true, accountCount: (cfg.gopayAccounts || []).length });
});

// Test Midtrans automation — with auto-rotation on rate limit
app.post("/api/gopay/test", requireAuth, async (req, res) => {
  const { midtransUrl } = req.body;
  if (!midtransUrl) return res.status(400).json({ error: "midtransUrl required" });

  const cfg = loadConfig();
  const accounts = cfg.gopayAccounts || [];

  // Fallback to legacy single account
  if (accounts.length === 0 && cfg.gopayPhone && cfg.gopayPin) {
    accounts.push({ phone: cfg.gopayPhone, pin: cfg.gopayPin });
  }

  if (accounts.length === 0) {
    return res.status(400).json({ error: "No GoPay accounts configured" });
  }

  let activeIdx = cfg.gopayActiveIndex || 0;
  if (activeIdx >= accounts.length) activeIdx = 0;

  // Try each account until one works
  for (let attempt = 0; attempt < accounts.length; attempt++) {
    const idx = (activeIdx + attempt) % accounts.length;
    const account = accounts[idx];
    console.log(`[GoPay] Trying account ${idx + 1}/${accounts.length}: ${account.phone}`);

    try {
      const result = await automateGoPay(
        midtransUrl,
        account.phone,
        account.pin,
        (timeout) => whatsapp.waitForOTP(timeout)
      );

      // If rate limited, try next account
      if (!result.success && result.error && result.error.includes("5005")) {
        console.log(`[GoPay] Account ${account.phone} rate limited — trying next...`);
        continue;
      }

      // Save which account worked
      cfg.gopayActiveIndex = idx;
      saveConfig(cfg);

      return res.json({ ...result, accountUsed: account.phone });
    } catch (err) {
      console.log(`[GoPay] Account ${account.phone} error:`, err.message);
      continue;
    }
  }

  res.status(429).json({ error: "All accounts rate limited — try again later" });
});

// Manual OTP submission — continue after auto-detect fails
app.post("/api/gopay/submit-otp", requireAuth, async (req, res) => {
  const { referenceId, otp } = req.body;
  if (!referenceId || !otp) return res.status(400).json({ error: "referenceId and otp required" });

  const cfg = loadConfig();
  const accounts = cfg.gopayAccounts || [];
  const activeIdx = cfg.gopayActiveIndex || 0;
  const pin = accounts[activeIdx]?.pin || cfg.gopayPin;

  try {
    const result = await continueWithOTP(referenceId, otp, pin);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// WHATSAPP — Multi-Client OTP Listener endpoints
// ══════════════════════════════════════════════════════════════════════════

// All clients status
app.get("/api/whatsapp/status", requireAuth, (req, res) => {
  res.json(whatsapp.getStatus());
});

// Add a new WhatsApp client
app.post("/api/whatsapp/add", requireAdmin, async (req, res) => {
  const { id, phone } = req.body;
  if (!id || !phone) return res.status(400).json({ error: "id and phone required" });
  try {
    await whatsapp.addClient(id, phone);
    res.json({ success: true, message: `Client ${id} initializing...` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Request pairing code (no QR needed!)
app.post("/api/whatsapp/pair", requireAdmin, async (req, res) => {
  const { id, phone } = req.body;
  if (!id || !phone) return res.status(400).json({ error: "id and phone required" });
  const client = whatsapp.getClient(id);
  if (!client) return res.status(404).json({ error: "Client not found — add it first" });
  const code = await client.requestPairing(phone);
  if (code) {
    res.json({ success: true, pairingCode: code, message: `Enter ${code} on WhatsApp → Linked Devices` });
  } else {
    res.json({ success: false, error: "Could not get pairing code" });
  }
});

// QR code for a specific client
app.get("/api/whatsapp/qr", requireAuth, (req, res) => {
  const id = req.query.id || "wa_0";
  const qr = whatsapp.getQRImage(id);
  const status = whatsapp.getStatus();
  if (!qr) return res.json({ ready: status.anyReady, qr: null, message: status.anyReady ? "Connected" : "Waiting..." });
  res.json({ ready: false, qr });
});

// Get latest OTP from any client
app.get("/api/whatsapp/otp", requireAuth, (req, res) => {
  const status = whatsapp.getStatus();
  const allOtps = status.clients?.flatMap(c => c.otpStore || []) || [];
  allOtps.sort((a, b) => b.timestamp - a.timestamp);
  res.json({ otp: allOtps[0] || null });
});

// ══════════════════════════════════════════════════════════════════════════
// CANCEL SUBSCRIPTION — ChatGPT backend API
// ══════════════════════════════════════════════════════════════════════════

async function cancelSubscription(accessToken, proxy) {
  console.log("[CancelSub] Cancelling subscription...");

  const cancelPayload = JSON.stringify({
    cancellation_reason: "too_expensive",
    is_cancel_immediate: false,
  });

  // Try multiple known cancel endpoints
  const endpoints = [
    { method: "PATCH", url: "https://chatgpt.com/backend-api/accounts/me/subscription" },
    { method: "POST", url: "https://chatgpt.com/backend-api/subscription/cancel" },
    { method: "PATCH", url: "https://chatgpt.com/backend-api/payments/subscription" },
  ];

  for (const ep of endpoints) {
    console.log(`[CancelSub] Trying ${ep.method} ${ep.url}`);
    try {
      const result = await new Promise((resolve, reject) => {
        const args = buildCurlArgs(ep.url, accessToken, cancelPayload, proxy, ep.method);
        execFile(CURL_CHROME, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
          if (err) return reject(err);
          try { resolve(JSON.parse(stdout)); } catch { resolve({ raw: stdout.substring(0, 500) }); }
        });
      });

      console.log("[CancelSub] Response:", JSON.stringify(result).substring(0, 300));

      // Check if successful
      if (!result.error && !result.detail) {
        console.log("[CancelSub] ✅ Success!");
        return { success: true, data: result };
      }
    } catch (e) {
      console.log("[CancelSub] Error:", e.message);
    }
  }

  return { success: false, error: "All cancel endpoints failed" };
}

// Helper: build curl args with custom HTTP method
function buildCurlArgs(url, token, body, proxy, method = "POST") {
  const args = [
    url,
    "-X", method,
    "-H", "Content-Type: application/json",
    "-H", `Authorization: Bearer ${token}`,
    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "-H", "Origin: https://chatgpt.com",
    "-H", "Referer: https://chatgpt.com/",
    "--data-raw", body,
    "--max-time", "30",
    "--compressed",
  ];
  if (proxy) { args.push("--proxy", proxy); args.push("-k"); }
  return args;
}

// Cancel subscription endpoint
app.post("/api/cancel-subscription", requireAuth, async (req, res) => {
  const { accessToken } = req.body;
  if (!accessToken) return res.status(400).json({ error: "accessToken required" });

  const cfg = loadConfig();
  const proxy = req.body.proxy || cfg.globalProxy || null;

  try {
    const result = await cancelSubscription(accessToken, proxy);
    return res.json(result);
  } catch (err) {
    console.error("[CancelSub] ERROR:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// FULL CHECKOUT — End-to-end automation
// ══════════════════════════════════════════════════════════════════════════

app.post("/api/full-checkout", requireAuth, async (req, res) => {
  const { checkoutUrl, accessToken, proxy } = req.body;
  if (!checkoutUrl) return res.status(400).json({ error: "checkoutUrl required" });

  const cfg = loadConfig();
  const addresses = cfg.addresses || [];
  if (addresses.length === 0) return res.status(400).json({ error: "No addresses" });

  const address = addresses[addressRotationIndex % addresses.length];
  addressRotationIndex++;

  const steps = { stripe: null, gopay: null, cancel: null };

  console.log(`\n${'━'.repeat(60)}`);
  console.log(`[FullCheckout] Starting full automation`);
  console.log(`${'━'.repeat(60)}`);

  // Step 1: Stripe → Midtrans link
  try {
    console.log("[FullCheckout] Step 1: Stripe → Midtrans...");
    steps.stripe = await runAutoCheckout(checkoutUrl, address);
    if (!steps.stripe.success) {
      return res.json({ success: false, steps, error: "Stripe checkout failed" });
    }
    console.log("[FullCheckout] Step 1: ✅ Got GoPay URL");
  } catch (err) {
    return res.json({ success: false, steps, error: `Stripe: ${err.message}` });
  }

  // Step 2: GoPay automation
  const gopayPhone = cfg.gopayPhone;
  const gopayPin = cfg.gopayPin;

  if (gopayPhone && gopayPin && steps.stripe.gopayUrl) {
    try {
      console.log("[FullCheckout] Step 2: GoPay automation...");
      steps.gopay = await automateGoPay(
        steps.stripe.gopayUrl,
        gopayPhone,
        gopayPin,
        (timeout) => whatsapp.waitForOTP(timeout)
      );
      console.log("[FullCheckout] Step 2:", steps.gopay.success ? "✅ GoPay Done" : "❌ GoPay Failed");
    } catch (err) {
      steps.gopay = { success: false, error: err.message };
      console.log("[FullCheckout] Step 2: ❌", err.message);
    }
  } else {
    steps.gopay = { status: "manual", url: steps.stripe.gopayUrl, reason: !gopayPhone ? "No phone" : "No PIN" };
    console.log("[FullCheckout] Step 2: Manual —", !gopayPhone ? "gopayPhone not set" : "gopayPin not set");
  }

  // Step 3: Cancel subscription
  if (accessToken) {
    try {
      console.log("[FullCheckout] Step 3: Cancelling subscription...");
      const useProxy = proxy || cfg.globalProxy || null;
      steps.cancel = await cancelSubscription(accessToken, useProxy);
      console.log("[FullCheckout] Step 3:", steps.cancel.success ? "✅ Cancelled" : "❌ Failed");
    } catch (err) {
      steps.cancel = { success: false, error: err.message };
    }
  }

  console.log(`[FullCheckout] Done!\n`);

  return res.json({
    success: true,
    steps,
    gopayUrl: steps.stripe.gopayUrl,
  });
});

// ══════════════════════════════════════════════════════════════════════════
// START SERVER + WhatsApp
// ══════════════════════════════════════════════════════════════════════════

app.listen(PORT, async () => {
  console.log(`\n🚀 Diaa Store GPT Pay running at http://localhost:${PORT}\n`);

  // Auto-initialize WhatsApp clients from gopay accounts
  const cfg = loadConfig();
  const accounts = cfg.gopayAccounts || [];

  if (accounts.length > 0) {
    console.log(`[WhatsApp] Auto-initializing ${accounts.length} client(s)...`);
    for (let i = 0; i < accounts.length; i++) {
      const id = `wa_${i}`;
      whatsapp.addClient(id, accounts[i].phone).catch(err => {
        console.error(`[WhatsApp] Client ${id} failed:`, err.message);
      });
      // Wait 5s between inits to avoid resource issues
      if (i < accounts.length - 1) await new Promise(r => setTimeout(r, 5000));
    }
  } else {
    // Legacy: init single client
    whatsapp.initialize().catch(err => {
      console.error("[WhatsApp] Failed to start:", err.message);
    });
  }
});
