// ══════════════════════════════════════════════════════════════════════════
// Midtrans GoPay Automation — Puppeteer + Network Capture
// First run captures API endpoints → future runs use Direct API
// ══════════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const CAPTURED_FILE = path.join(__dirname, "midtrans_api.json");

// Check if we already have captured API endpoints
function hasCapturedAPI() {
  try {
    const data = JSON.parse(fs.readFileSync(CAPTURED_FILE, "utf8"));
    return data && data.endpoints && Object.keys(data.endpoints).length > 0;
  } catch { return false; }
}

// ──────────────────────────────────────────────────────────────────────
// Main automation function
// ──────────────────────────────────────────────────────────────────────

async function automateGoPay(midtransUrl, phoneNumber, pin, waitForOTP) {
  console.log("[Midtrans] Starting automation...");
  console.log("[Midtrans] URL:", midtransUrl);
  console.log("[Midtrans] Phone:", phoneNumber);

  // Capture ALL API requests for future Direct API migration
  const capturedAPIs = [];

  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const debugDir = path.join(__dirname, "public", "debug");
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 430, height: 932 });
    await page.setUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");

    // ── Network Interception ────────────────────────────────────────────
    page.on("request", (req) => {
      if (req.method() !== "GET" && req.url().includes("midtrans.com")) {
        capturedAPIs.push({
          step: capturedAPIs.length + 1,
          method: req.method(),
          url: req.url(),
          headers: req.headers(),
          body: req.postData()?.substring(0, 2000) || null,
          timestamp: Date.now(),
        });
        console.log(`[Midtrans] [API] ${req.method()} → ${req.url()}`);
        if (req.postData()) console.log(`[Midtrans] [API] Body: ${req.postData()?.substring(0, 300)}`);
      }
    });

    page.on("response", async (res) => {
      const url = res.url();
      if (res.request().method() !== "GET" && url.includes("midtrans.com")) {
        try {
          const body = await res.text();
          const api = capturedAPIs.find(a => a.url === url && !a.response);
          if (api) {
            api.response = { status: res.status(), body: body.substring(0, 1000) };
            console.log(`[Midtrans] [API] Response ${res.status()} from ${url}`);
            console.log(`[Midtrans] [API] Body: ${body.substring(0, 300)}`);
          }
        } catch {}
      }
    });

    // ── Step 1: Load page ────────────────────────────────────────────────
    console.log("[Midtrans] Loading page...");
    await page.goto(midtransUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await delay(3000);
    await page.screenshot({ path: path.join(debugDir, "mt_01_loaded.png"), fullPage: true });
    console.log("[Midtrans] Page loaded!");

    // ── Step 2: Enter phone number ──────────────────────────────────────
    console.log("[Midtrans] Looking for phone input...");

    // Try to find phone input field
    const phoneInput = await findInput(page, [
      "input[name='phone']",
      "input[type='tel']",
      "input[placeholder*='phone']",
      "input[placeholder*='nomor']",
      "input[placeholder*='handphone']",
      "input[placeholder*='08']",
      "input[autocomplete='tel']",
    ]);

    if (phoneInput) {
      await phoneInput.click({ clickCount: 3 });
      await delay(300);
      await phoneInput.type(phoneNumber, { delay: 80 });
      console.log("[Midtrans] Phone: OK");
      await delay(500);
      await page.screenshot({ path: path.join(debugDir, "mt_02_phone.png"), fullPage: true });

      // Click submit/continue button — try many labels
      const clicked = await clickButton(page, [
        "Lanjutkan", "Lanjut", "Continue", "Next", "Submit",
        "Konfirmasi", "Verify", "Kirim", "Link", "Hubungkan",
        "Sambungkan", "Connect", "Proceed", "OK",
      ]);

      // If no button found, try pressing Enter
      if (!clicked) {
        console.log("[Midtrans] No button found — trying Enter key...");
        await dumpButtons(page);
        await page.keyboard.press("Enter");
        console.log("[Midtrans] Pressed Enter");
      }

      await delay(3000);
      await page.screenshot({ path: path.join(debugDir, "mt_03_after_phone.png"), fullPage: true });
    } else {
      console.log("[Midtrans] Phone input not found — dumping inputs...");
      await dumpInputs(page);
      await page.screenshot({ path: path.join(debugDir, "mt_02_no_phone.png"), fullPage: true });
    }

    // ── Step 3: Wait for OTP ────────────────────────────────────────────
    console.log("[Midtrans] Waiting for OTP (up to 120s)...");
    let otpCode = null;
    try {
      const otpResult = await waitForOTP(120000);
      otpCode = otpResult.code;
      console.log("[Midtrans] OTP received:", otpCode);
    } catch (e) {
      console.log("[Midtrans] OTP timeout:", e.message);
      saveCapture(capturedAPIs);
      return { success: false, error: "OTP timeout", capturedAPIs: capturedAPIs.length };
    }

    // Find OTP input and fill
    await delay(2000);
    const otpInput = await findInput(page, [
      "input[name='otp']",
      "input[type='number']",
      "input[placeholder*='OTP']",
      "input[placeholder*='kode']",
      "input[placeholder*='verif']",
      "input[maxlength='6']",
      "input[maxlength='4']",
    ]);

    if (otpInput) {
      await otpInput.click({ clickCount: 3 });
      await delay(300);
      await otpInput.type(otpCode, { delay: 80 });
      console.log("[Midtrans] OTP: OK");
      await delay(500);
      await page.screenshot({ path: path.join(debugDir, "mt_04_otp.png"), fullPage: true });

      await clickButton(page, ["Konfirmasi", "Verify", "Submit", "Lanjut", "Continue"]);
      await delay(3000);
      await page.screenshot({ path: path.join(debugDir, "mt_05_after_otp.png"), fullPage: true });
    } else {
      console.log("[Midtrans] OTP input not found — dumping inputs...");
      await dumpInputs(page);
    }

    // ── Step 4: Enter PIN (first time) ──────────────────────────────────
    console.log("[Midtrans] Looking for PIN input...");
    await delay(2000);
    await enterPIN(page, pin, debugDir, "mt_06_pin1");

    // ── Step 5: Click "Pay now" / "Bayar" ───────────────────────────────
    console.log("[Midtrans] Looking for Pay button...");
    await delay(3000);
    await page.screenshot({ path: path.join(debugDir, "mt_07_pay_page.png"), fullPage: true });
    await clickButton(page, ["Pay now", "Bayar", "Pay", "Confirm", "Konfirmasi"]);
    await delay(3000);
    await page.screenshot({ path: path.join(debugDir, "mt_08_after_pay.png"), fullPage: true });

    // ── Step 6: Enter PIN (second time) ─────────────────────────────────
    console.log("[Midtrans] Looking for second PIN input...");
    await delay(2000);
    await enterPIN(page, pin, debugDir, "mt_09_pin2");

    // ── Step 7: Wait for completion ─────────────────────────────────────
    console.log("[Midtrans] Waiting for completion...");
    await delay(5000);
    await page.screenshot({ path: path.join(debugDir, "mt_10_final.png"), fullPage: true });

    const finalUrl = page.url();
    console.log("[Midtrans] Final URL:", finalUrl);

    // Save captured APIs
    saveCapture(capturedAPIs);

    console.log("[Midtrans] Done! Captured", capturedAPIs.length, "API calls");

    return {
      success: true,
      finalUrl,
      capturedAPIs: capturedAPIs.length,
    };

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
      // Try button with text
      const btns = await page.$$("button, a, [role='button'], input[type='submit']");
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
  // PIN inputs are often 6 separate inputs or one input
  const pinInputs = await page.$$("input[type='password'], input[type='tel'], input[type='number']");
  const visiblePins = [];

  for (const inp of pinInputs) {
    const visible = await inp.isIntersectingViewport().catch(() => false);
    if (visible) visiblePins.push(inp);
  }

  if (visiblePins.length >= 6) {
    // 6 separate PIN inputs
    for (let i = 0; i < 6 && i < pin.length; i++) {
      await visiblePins[i].type(pin[i], { delay: 100 });
    }
    console.log("[Midtrans] PIN entered (6 fields)");
  } else if (visiblePins.length >= 1) {
    // Single PIN input
    await visiblePins[0].click({ clickCount: 3 });
    await delay(200);
    await visiblePins[0].type(pin, { delay: 80 });
    console.log("[Midtrans] PIN entered (1 field)");
  } else {
    console.log("[Midtrans] No PIN input found");
    await dumpInputs(page);
  }

  await delay(500);
  if (debugDir) {
    await page.screenshot({ path: path.join(debugDir, `${prefix}.png`), fullPage: true });
  }

  // Auto-submit after PIN (some forms auto-submit on 6 digits)
  await delay(1000);
  await clickButton(page, ["Bayar", "Pay", "Confirm", "Konfirmasi", "Submit", "Lanjut"]);
}

async function dumpInputs(page) {
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("input, select, textarea")).map(el => ({
      tag: el.tagName, type: el.type, name: el.name, id: el.id,
      placeholder: el.placeholder, autocomplete: el.autocomplete,
      visible: el.offsetParent !== null,
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
      href: el.href || null,
    }));
  });
  console.log("[Midtrans] Buttons:", JSON.stringify(buttons.filter(b => b.visible), null, 2));
}

function saveCapture(apis) {
  try {
    const data = { endpoints: {}, raw: apis, capturedAt: new Date().toISOString() };
    // Organize by step
    apis.forEach((api, i) => { data.endpoints[`step_${i + 1}`] = { method: api.method, url: api.url, body: api.body }; });
    fs.writeFileSync(CAPTURED_FILE, JSON.stringify(data, null, 2));
    console.log("[Midtrans] API capture saved to", CAPTURED_FILE);
  } catch (e) {
    console.log("[Midtrans] Save error:", e.message);
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { automateGoPay, hasCapturedAPI };
