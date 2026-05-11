// ══════════════════════════════════════════════════════════════════════════
// GoPay Puppeteer — Browser-based payment automation
// Opens the Midtrans snap page and completes payment like a real user
// ══════════════════════════════════════════════════════════════════════════

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");

const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function screenshot(page, name) {
  const fp = path.join(SCREENSHOTS_DIR, `${name}_${Date.now()}.png`);
  try { await page.screenshot({ path: fp, fullPage: true }); } catch(e) {}
  console.log(`[Puppeteer] 📸 ${name}`);
  return fp;
}

// Helper: wait and retry clicking
async function clickByText(page, text, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const clicked = await page.evaluate((t) => {
      const els = [...document.querySelectorAll("button, a, div, span, li, label, input, td")];
      for (const el of els) {
        const txt = (el.textContent || "").trim();
        if (txt.toLowerCase().includes(t.toLowerCase())) {
          const target = el.closest("button, a, li, label, div[role='button'], tr, td") || el;
          target.click();
          return txt.substring(0, 60);
        }
      }
      const imgs = [...document.querySelectorAll("img")];
      for (const img of imgs) {
        if ((img.src || "").toLowerCase().includes(t.toLowerCase())) {
          const target = img.closest("button, a, li, div, label, tr") || img;
          target.click();
          return "img:" + img.src.substring(0, 60);
        }
      }
      return null;
    }, text);
    if (clicked) { console.log(`[Puppeteer] Clicked: "${clicked}"`); return true; }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// Helper: type into input found near label text
async function typeNearLabel(page, labelText, value) {
  return page.evaluate((label, val) => {
    const els = [...document.querySelectorAll("label, span, div, p")];
    for (const el of els) {
      if ((el.textContent || "").toLowerCase().includes(label.toLowerCase())) {
        const container = el.closest("div, form, section") || el.parentElement;
        if (container) {
          const input = container.querySelector("input:not([type='hidden']), input[type='tel'], input[type='text'], input[type='number']");
          if (input) { input.value = val; input.dispatchEvent(new Event("input", { bubbles: true })); return true; }
        }
      }
    }
    // Fallback: find tel/number inputs
    const telInputs = document.querySelectorAll("input[type='tel'], input[type='number'], input[inputmode='numeric']");
    if (telInputs.length > 0) { telInputs[0].value = val; telInputs[0].dispatchEvent(new Event("input", { bubbles: true })); return true; }
    return false;
  }, labelText, value);
}

// ══════════════════════════════════════════════════════════════════════════
// Main: Automate GoPay payment via Puppeteer
// ══════════════════════════════════════════════════════════════════════════
async function automateGoPayBrowser(midtransUrl, phone, pin, waitForOTP) {
  console.log("\n[Puppeteer] ════════════════════════════════════════");
  console.log("[Puppeteer] Starting GoPay Browser Automation");
  console.log("[Puppeteer] URL:", midtransUrl);
  console.log("[Puppeteer] Phone:", phone);
  console.log("[Puppeteer] ════════════════════════════════════════\n");

  let browser;
  const networkLog = [];
  const screenshots = [];

  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 412, height: 915, isMobile: true });
    await page.setUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");

    // Capture network for debugging
    page.on("response", async (res) => {
      const u = res.url();
      if (u.includes("midtrans") || u.includes("gopay") || u.includes("gojek")) {
        const entry = { url: u.substring(0, 200), status: res.status() };
        try {
          if (res.headers()["content-type"]?.includes("json")) {
            entry.body = (await res.text()).substring(0, 500);
          }
        } catch(e) {}
        networkLog.push(entry);
      }
    });

    // ── Step 1: Open Midtrans page ──────────────────────────────────
    console.log("[Puppeteer] Step 1: Opening Midtrans page...");
    await page.goto(midtransUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    screenshots.push(await screenshot(page, "step1_loaded"));

    // Save HTML for debugging
    const html = await page.content();
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, "page.html"), html);
    console.log("[Puppeteer] Step 1: Page loaded, title:", await page.title());

    // Log all visible text for debugging
    const pageTexts = await page.evaluate(() => {
      const texts = [];
      document.querySelectorAll("*").forEach(el => {
        const t = el.textContent?.trim();
        if (t && t.length < 80 && t.length > 1 && !texts.includes(t)) texts.push(t);
      });
      return texts.slice(0, 40);
    });
    console.log("[Puppeteer] Page texts:", JSON.stringify(pageTexts).substring(0, 500));

    // ── Step 2: Select GoPay ────────────────────────────────────────
    console.log("[Puppeteer] Step 2: Selecting GoPay...");
    let gopayFound = await clickByText(page, "gopay", 8000);
    if (!gopayFound) gopayFound = await clickByText(page, "GoPay", 3000);
    if (!gopayFound) {
      // Try clicking by CSS selectors
      gopayFound = await page.evaluate(() => {
        const sels = ['[data-payment="gopay"]', '[data-payment-type="gopay"]', '.gopay', '[class*="gopay"]', 'input[value="gopay"]'];
        for (const s of sels) { const el = document.querySelector(s); if (el) { el.click(); return true; } }
        return false;
      });
    }

    if (!gopayFound) {
      screenshots.push(await screenshot(page, "step2_gopay_not_found"));
      return { success: false, error: "GoPay option not found on page", screenshots, networkLog, pageTexts };
    }

    await new Promise(r => setTimeout(r, 2000));
    screenshots.push(await screenshot(page, "step2_gopay_selected"));
    console.log("[Puppeteer] Step 2: ✅ GoPay selected");

    // ── Step 3: Enter phone number ──────────────────────────────────
    console.log("[Puppeteer] Step 3: Entering phone number...");
    await new Promise(r => setTimeout(r, 1500));

    // Try to find and fill phone input
    const phoneEntered = await page.evaluate((ph) => {
      // Strategy 1: Find inputs with phone-related attributes
      const inputs = document.querySelectorAll("input[type='tel'], input[type='number'], input[inputmode='numeric'], input[placeholder*='phone'], input[placeholder*='nomor'], input[placeholder*='Phone'], input[name*='phone']");
      for (const input of inputs) {
        input.focus();
        input.value = ph;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return "direct:" + (input.placeholder || input.name || "input");
      }
      // Strategy 2: Any visible text input
      const allInputs = document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='checkbox'])");
      for (const input of allInputs) {
        if (input.offsetParent !== null) { // visible
          input.focus();
          input.value = ph;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return "fallback:" + (input.placeholder || input.type);
        }
      }
      return null;
    }, phone);

    console.log("[Puppeteer] Step 3: Phone input:", phoneEntered);
    if (!phoneEntered) {
      screenshots.push(await screenshot(page, "step3_no_phone_input"));
      // Maybe phone is not needed (already linked)
      console.log("[Puppeteer] Step 3: No phone input — may already be linked");
    } else {
      screenshots.push(await screenshot(page, "step3_phone_entered"));
    }

    // ── Step 4: Click submit/continue/link button ───────────────────
    console.log("[Puppeteer] Step 4: Clicking submit...");
    await new Promise(r => setTimeout(r, 1000));

    const submitClicked = await clickByText(page, "Hubungkan", 3000)
      || await clickByText(page, "Lanjutkan", 3000)
      || await clickByText(page, "Continue", 3000)
      || await clickByText(page, "Submit", 3000)
      || await clickByText(page, "Link", 3000)
      || await clickByText(page, "Bayar", 3000)
      || await clickByText(page, "Pay", 3000);

    if (!submitClicked) {
      // Try any primary button
      await page.evaluate(() => {
        const btns = document.querySelectorAll("button[type='submit'], .btn-primary, .btn-main, button.primary");
        if (btns.length > 0) btns[0].click();
      });
    }

    await new Promise(r => setTimeout(r, 3000));
    screenshots.push(await screenshot(page, "step4_submitted"));
    console.log("[Puppeteer] Step 4: Submitted");

    // ── Step 5: Wait for OTP ────────────────────────────────────────
    console.log("[Puppeteer] Step 5: Waiting for OTP...");

    // Check if page is asking for OTP
    const needsOTP = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes("otp") || text.includes("verifikasi") || text.includes("kode") || text.includes("verification");
    });

    let otpCode = null;
    if (needsOTP && waitForOTP) {
      console.log("[Puppeteer] Step 5: OTP needed — waiting...");
      try {
        otpCode = await waitForOTP(60000); // 60s timeout
        console.log("[Puppeteer] Step 5: Got OTP:", otpCode);
      } catch(e) {
        console.log("[Puppeteer] Step 5: OTP wait failed:", e.message);
      }
    }

    if (otpCode) {
      // Enter OTP
      const otpEntered = await page.evaluate((otp) => {
        // OTP might be separate inputs (one per digit)
        const otpInputs = document.querySelectorAll("input[maxlength='1']");
        if (otpInputs.length >= 4) {
          const digits = otp.split("");
          otpInputs.forEach((inp, i) => {
            if (digits[i]) { inp.value = digits[i]; inp.dispatchEvent(new Event("input", { bubbles: true })); }
          });
          return "split:" + otpInputs.length;
        }
        // Single OTP input
        const inputs = document.querySelectorAll("input[type='tel'], input[type='number'], input[inputmode='numeric'], input:not([type='hidden'])");
        for (const inp of inputs) {
          if (inp.offsetParent !== null) {
            inp.focus(); inp.value = otp;
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            return "single";
          }
        }
        return null;
      }, otpCode);
      console.log("[Puppeteer] Step 5: OTP entered:", otpEntered);

      // Click verify/submit
      await new Promise(r => setTimeout(r, 1000));
      await clickByText(page, "Verifikasi", 3000) || await clickByText(page, "Verify", 3000) || await clickByText(page, "Submit", 3000);
      await new Promise(r => setTimeout(r, 3000));
      screenshots.push(await screenshot(page, "step5_otp_submitted"));
    } else if (needsOTP) {
      // Return waiting for manual OTP
      screenshots.push(await screenshot(page, "step5_waiting_otp"));
      return {
        success: false,
        waitingForOTP: true,
        message: "OTP needed — enter manually",
        screenshots, networkLog,
      };
    }

    // ── Step 6: Enter PIN ───────────────────────────────────────────
    console.log("[Puppeteer] Step 6: Checking for PIN...");
    await new Promise(r => setTimeout(r, 2000));

    const needsPIN = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes("pin") || text.includes("security code");
    });

    if (needsPIN && pin) {
      console.log("[Puppeteer] Step 6: Entering PIN...");
      await page.evaluate((p) => {
        // PIN might be separate inputs
        const pinInputs = document.querySelectorAll("input[maxlength='1'][type='password'], input[maxlength='1'][type='tel'], input[maxlength='1']");
        if (pinInputs.length >= 4) {
          p.split("").forEach((d, i) => {
            if (pinInputs[i]) { pinInputs[i].value = d; pinInputs[i].dispatchEvent(new Event("input", { bubbles: true })); }
          });
          return;
        }
        // Single PIN input
        const inputs = document.querySelectorAll("input[type='password'], input[type='tel'], input[inputmode='numeric']");
        for (const inp of inputs) {
          if (inp.offsetParent !== null) {
            inp.focus(); inp.value = p; inp.dispatchEvent(new Event("input", { bubbles: true })); break;
          }
        }
      }, pin);

      await new Promise(r => setTimeout(r, 1000));
      await clickByText(page, "Konfirmasi", 3000) || await clickByText(page, "Confirm", 3000) || await clickByText(page, "Submit", 3000) || await clickByText(page, "Bayar", 3000);
      await new Promise(r => setTimeout(r, 3000));
      screenshots.push(await screenshot(page, "step6_pin_submitted"));
      console.log("[Puppeteer] Step 6: PIN submitted");
    }

    // ── Step 7: Wait for payment result ─────────────────────────────
    console.log("[Puppeteer] Step 7: Waiting for payment result...");
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const currentUrl = page.url();
      const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      console.log(`[Puppeteer] Poll #${i+1}: ${currentUrl.substring(0, 80)}`);

      if (pageText.toLowerCase().includes("success") || pageText.toLowerCase().includes("berhasil") || pageText.toLowerCase().includes("settlement")) {
        screenshots.push(await screenshot(page, "step7_success"));
        console.log("[Puppeteer] Step 7: ✅ PAYMENT SUCCESS!");
        return { success: true, message: "Payment completed!", screenshots, networkLog };
      }

      if (pageText.toLowerCase().includes("fail") || pageText.toLowerCase().includes("gagal") || pageText.toLowerCase().includes("expired")) {
        screenshots.push(await screenshot(page, "step7_failed"));
        return { success: false, error: "Payment failed: " + pageText.substring(0, 200), screenshots, networkLog };
      }
    }

    // Final screenshot
    screenshots.push(await screenshot(page, "step7_timeout"));
    const finalText = await page.evaluate(() => document.body.innerText.substring(0, 300));
    return { success: false, error: "Payment timed out", finalPageText: finalText, screenshots, networkLog };

  } catch (err) {
    console.error("[Puppeteer] ERROR:", err.message);
    return { success: false, error: err.message, screenshots, networkLog };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { automateGoPayBrowser };
