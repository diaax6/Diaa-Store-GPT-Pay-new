// ══════════════════════════════════════════════════════════════════════════
// Midtrans GoPay Automation — HYBRID: Direct API + Puppeteer capture
// Step 1 (Midtrans linking) → Direct API ✅
// Step 2 (GoPay auth/Hubungkan) → Puppeteer (to capture API)
// Step 3+ (OTP, PIN) → Puppeteer (until APIs captured)
// ══════════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const CAPTURED_FILE = path.join(__dirname, "midtrans_api.json");

// Known Midtrans auth (captured from Snap page)
const MIDTRANS_AUTH = "Basic TWlkLWNsaWVudC0zVFg4blVhLWZfUmdOcmt5Og==";

// ──────────────────────────────────────────────────────────────────────
// Step 1: Direct API — Midtrans Linking (NO BROWSER!)
// ──────────────────────────────────────────────────────────────────────

async function linkGoPay(snapToken, phoneNumber) {
  console.log("[DirectAPI] Linking GoPay — token:", snapToken, "phone:", phoneNumber);

  const url = `https://app.midtrans.com/snap/v3/accounts/${snapToken}/linking`;
  const body = JSON.stringify({
    type: "gopay",
    country_code: "62",
    phone_number: phoneNumber,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": MIDTRANS_AUTH,
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
      "Referer": `https://app.midtrans.com/snap/v4/redirection/${snapToken}`,
      "x-source": "snap",
      "x-source-version": "2.3.0",
      "x-source-app-type": "redirection",
    },
    body,
  });

  const data = await res.json();
  console.log("[DirectAPI] Linking response:", JSON.stringify(data).substring(0, 300));

  return {
    success: data.status_code === "201",
    activationUrl: data.activation_link_url,
    status: data.account_status,
    raw: data,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Step 2+: Puppeteer — GoPay auth page + OTP + PIN
// Captures all API calls from gopayapi.com for future Direct API
// ──────────────────────────────────────────────────────────────────────

async function automateGoPay(midtransUrl, phoneNumber, pin, waitForOTP) {
  console.log("[Midtrans] Starting automation...");
  console.log("[Midtrans] URL:", midtransUrl);
  console.log("[Midtrans] Phone:", phoneNumber);

  const capturedAPIs = [];
  const debugDir = path.join(__dirname, "public", "debug");
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });

  // Extract snap token from URL
  const snapToken = midtransUrl.split("/redirection/")[1]?.split("?")[0]?.split("#")[0];
  if (!snapToken) {
    return { success: false, error: "Could not extract snap token from URL" };
  }
  console.log("[Midtrans] Snap token:", snapToken);

  // ── Step 1: Direct API — Link GoPay (NO BROWSER!) ─────────────────
  console.log("[Midtrans] Step 1: Direct API linking...");
  let linkResult;
  try {
    linkResult = await linkGoPay(snapToken, phoneNumber);
    if (!linkResult.success) {
      return { success: false, error: "Linking failed: " + JSON.stringify(linkResult.raw), capturedAPIs: 0 };
    }
    console.log("[Midtrans] Step 1: ✅ Linked! Activation URL:", linkResult.activationUrl);

    capturedAPIs.push({
      step: 1, method: "POST",
      url: `https://app.midtrans.com/snap/v3/accounts/${snapToken}/linking`,
      body: JSON.stringify({ type: "gopay", country_code: "62", phone_number: phoneNumber }),
      response: { status: 201, body: JSON.stringify(linkResult.raw) },
    });
  } catch (err) {
    return { success: false, error: "Linking error: " + err.message, capturedAPIs: 0 };
  }

  if (!linkResult.activationUrl) {
    return { success: false, error: "No activation URL in response", capturedAPIs: 1 };
  }

  // ── Step 2: Puppeteer — Open GoPay auth page + click Hubungkan ────
  console.log("[Midtrans] Step 2: Opening GoPay auth page...");

  let puppeteer;
  try {
    puppeteer = require("puppeteer-extra");
    const StealthPlugin = require("puppeteer-extra-plugin-stealth");
    puppeteer.use(StealthPlugin());
    console.log("[Midtrans] Using stealth mode");
  } catch {
    puppeteer = require("puppeteer");
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 430, height: 932 });
    await page.setUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // ── Network Interception — capture ALL domains ──────────────────
    page.on("request", (req) => {
      if (req.method() !== "GET") {
        const url = req.url();
        if (url.includes("gopayapi.com") || url.includes("midtrans.com") || url.includes("gojek") || url.includes("gopay")) {
          capturedAPIs.push({
            step: capturedAPIs.length + 1,
            method: req.method(),
            url: url,
            headers: req.headers(),
            body: req.postData()?.substring(0, 2000) || null,
            timestamp: Date.now(),
          });
          console.log(`[GoPay] [API] ${req.method()} → ${url}`);
          if (req.postData()) console.log(`[GoPay] [API] Body: ${req.postData()?.substring(0, 500)}`);
        }
      }
    });

    page.on("response", async (res) => {
      const url = res.url();
      if (res.request().method() !== "GET" && (url.includes("gopayapi.com") || url.includes("midtrans.com") || url.includes("gojek") || url.includes("gopay"))) {
        try {
          const body = await res.text();
          const api = capturedAPIs.find(a => a.url === url && !a.response);
          if (api) {
            api.response = { status: res.status(), body: body.substring(0, 2000) };
            console.log(`[GoPay] [API] Response ${res.status()} from ${url}`);
            console.log(`[GoPay] [API] Body: ${body.substring(0, 500)}`);
          }
        } catch {}
      }
    });

    // Go to GoPay activation page
    console.log("[Midtrans] Opening:", linkResult.activationUrl);
    await page.goto(linkResult.activationUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(5000);
    await page.screenshot({ path: path.join(debugDir, "mt_gopay_auth.png"), fullPage: true });

    // Dump page content
    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || "");
    console.log("[Midtrans] Page text:", pageText.substring(0, 300));

    // Check for rate limit
    if (pageText.includes("kebanyakan") || pageText.includes("too many")) {
      console.log("[Midtrans] ⚠️ Rate limited by GoPay!");
      saveCapture(capturedAPIs);
      return { success: false, error: "GoPay rate limit — try again later", capturedAPIs: capturedAPIs.length };
    }

    // Click "Hubungkan" to trigger OTP
    console.log("[Midtrans] Clicking Hubungkan...");
    const hubClicked = await clickButton(page, [
      "Hubungkan", "Connect", "Link", "Authorize", "Lanjut", "Lanjutkan", "Continue", "OK",
    ]);

    if (hubClicked) {
      console.log("[Midtrans] ✅ Hubungkan clicked!");
    } else {
      console.log("[Midtrans] ⚠️ Hubungkan not found");
      await dumpButtons(page);
    }

    await delay(3000);
    await page.screenshot({ path: path.join(debugDir, "mt_after_hubungkan.png"), fullPage: true });

    // ── Step 3: Wait for OTP ──────────────────────────────────────────
    console.log("[Midtrans] Waiting for OTP on WhatsApp (up to 120s)...");
    let otpCode = null;
    try {
      const otpResult = await waitForOTP(120000);
      otpCode = otpResult.code;
      console.log("[Midtrans] ✅ OTP received:", otpCode);
    } catch (e) {
      console.log("[Midtrans] ❌ OTP timeout");
      saveCapture(capturedAPIs);
      await page.screenshot({ path: path.join(debugDir, "mt_otp_timeout.png"), fullPage: true });
      return { success: false, error: "OTP timeout", capturedAPIs: capturedAPIs.length };
    }

    // Find and fill OTP input
    await delay(2000);
    const otpInput = await findInput(page, [
      "input[name='otp']", "input[type='number']", "input[type='tel']",
      "input[placeholder*='OTP']", "input[placeholder*='kode']",
      "input[maxlength='6']", "input[maxlength='4']",
    ]);

    if (otpInput) {
      await otpInput.click({ clickCount: 3 });
      await delay(300);
      await otpInput.type(otpCode, { delay: 80 });
      console.log("[Midtrans] OTP filled!");
      await delay(500);
      await page.screenshot({ path: path.join(debugDir, "mt_otp_filled.png"), fullPage: true });
      await clickButton(page, ["Konfirmasi", "Verify", "Submit", "Lanjut", "Continue", "OK"]);
      await delay(3000);
    } else {
      // Try individual digit inputs (6 separate boxes)
      const allInputs = await page.$$("input");
      const visibleInputs = [];
      for (const inp of allInputs) {
        const vis = await inp.isIntersectingViewport().catch(() => false);
        if (vis) visibleInputs.push(inp);
      }
      if (visibleInputs.length >= 4) {
        for (let i = 0; i < otpCode.length && i < visibleInputs.length; i++) {
          await visibleInputs[i].type(otpCode[i], { delay: 100 });
        }
        console.log("[Midtrans] OTP filled (individual boxes)!");
      } else {
        console.log("[Midtrans] No OTP input found");
        await dumpInputs(page);
      }
      await delay(3000);
    }

    await page.screenshot({ path: path.join(debugDir, "mt_after_otp.png"), fullPage: true });

    // ── Step 4: Enter PIN ───────────────────────────────────────────
    console.log("[Midtrans] Looking for PIN input...");
    await delay(2000);
    await enterPIN(page, pin, debugDir, "mt_pin1");

    // ── Step 5: Pay button ──────────────────────────────────────────
    console.log("[Midtrans] Looking for Pay button...");
    await delay(3000);
    await page.screenshot({ path: path.join(debugDir, "mt_pay_page.png"), fullPage: true });
    await clickButton(page, ["Pay now", "Bayar", "Pay", "Confirm", "Konfirmasi"]);
    await delay(3000);

    // ── Step 6: Second PIN ──────────────────────────────────────────
    console.log("[Midtrans] Looking for second PIN...");
    await delay(2000);
    await enterPIN(page, pin, debugDir, "mt_pin2");

    // ── Done ─────────────────────────────────────────────────────────
    await delay(5000);
    await page.screenshot({ path: path.join(debugDir, "mt_final.png"), fullPage: true });

    const finalUrl = page.url();
    console.log("[Midtrans] Final URL:", finalUrl);

    saveCapture(capturedAPIs);
    console.log("[Midtrans] ✅ Done! Captured", capturedAPIs.length, "API calls");

    return { success: true, finalUrl, capturedAPIs: capturedAPIs.length };

  } finally {
    await browser.close();
    console.log("[Midtrans] Browser closed.");
  }
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

async function findInput(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const visible = await el.isIntersectingViewport();
        if (visible) return el;
      }
    } catch {}
  }
  return null;
}

async function clickButton(page, labels) {
  for (const label of labels) {
    try {
      const btns = await page.$$("button, a, [role='button'], input[type='submit'], div[onclick], span[onclick]");
      for (const btn of btns) {
        const text = await page.evaluate(el => el.textContent?.trim() || el.value || "", btn);
        if (text.toLowerCase().includes(label.toLowerCase())) {
          const visible = await btn.isIntersectingViewport();
          if (visible) {
            await btn.click();
            console.log(`[Midtrans] Clicked: "${text}"`);
            return true;
          }
        }
      }
    } catch {}
  }
  console.log("[Midtrans] No button found for:", labels.join(", "));
  return false;
}

async function enterPIN(page, pin, debugDir, prefix) {
  const pinInputs = await page.$$("input[type='password'], input[type='tel'], input[type='number']");
  const visiblePins = [];
  for (const inp of pinInputs) {
    const visible = await inp.isIntersectingViewport().catch(() => false);
    if (visible) visiblePins.push(inp);
  }

  if (visiblePins.length >= 6) {
    for (let i = 0; i < 6 && i < pin.length; i++) {
      await visiblePins[i].type(pin[i], { delay: 100 });
    }
    console.log("[Midtrans] PIN entered (6 fields)");
  } else if (visiblePins.length >= 1) {
    await visiblePins[0].click({ clickCount: 3 });
    await delay(200);
    await visiblePins[0].type(pin, { delay: 80 });
    console.log("[Midtrans] PIN entered (1 field)");
  } else {
    console.log("[Midtrans] No PIN input found");
    await dumpInputs(page);
  }

  await delay(500);
  if (debugDir) await page.screenshot({ path: path.join(debugDir, `${prefix}.png`), fullPage: true });
  await delay(1000);
  await clickButton(page, ["Bayar", "Pay", "Confirm", "Konfirmasi", "Submit", "Lanjut"]);
}

async function dumpInputs(page) {
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("input, select, textarea")).map(el => ({
      tag: el.tagName, type: el.type, name: el.name, id: el.id,
      placeholder: el.placeholder, visible: el.offsetParent !== null,
    }));
  });
  console.log("[Midtrans] Inputs:", JSON.stringify(inputs, null, 2));
}

async function dumpButtons(page) {
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("button, a, [role='button'], input[type='submit'], div[onclick]")).map(el => ({
      tag: el.tagName, text: el.textContent?.trim()?.substring(0, 50),
      id: el.id, class: el.className?.substring?.(0, 50),
      visible: el.offsetParent !== null,
    }));
  });
  console.log("[Midtrans] Buttons:", JSON.stringify(buttons.filter(b => b.visible), null, 2));
}

function saveCapture(apis) {
  try {
    const data = { endpoints: {}, raw: apis, capturedAt: new Date().toISOString() };
    apis.forEach((api, i) => { data.endpoints[`step_${i + 1}`] = { method: api.method, url: api.url, body: api.body }; });
    fs.writeFileSync(CAPTURED_FILE, JSON.stringify(data, null, 2));
    console.log("[Midtrans] API capture saved to", CAPTURED_FILE);
  } catch (e) {
    console.log("[Midtrans] Save error:", e.message);
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { automateGoPay, linkGoPay };
