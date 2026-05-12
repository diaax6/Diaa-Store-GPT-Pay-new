// ══════════════════════════════════════════════════════════════════════════
// GoPay Puppeteer — Full browser automation with SMS OTP from 5sim
// Opens Midtrans snap page → enters phone → OTP via SMS → PIN → Payment
// ══════════════════════════════════════════════════════════════════════════

const puppeteer = require("puppeteer");
const path = require("path");
const fs = require("fs");
const sms = require("./sms-provider");

const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

function log(...args) { console.log("[Puppeteer]", ...args); }

async function shot(page, name) {
  const fp = path.join(SCREENSHOTS_DIR, `${name}_${Date.now()}.png`);
  try { await page.screenshot({ path: fp, fullPage: true }); } catch (e) {}
  log(`📸 ${name}`);
  return fp;
}

// Save page HTML for debugging
async function saveHTML(page, name) {
  const fp = path.join(SCREENSHOTS_DIR, `${name}_${Date.now()}.html`);
  try { fs.writeFileSync(fp, await page.content()); } catch (e) {}
}

// ══════════════════════════════════════════════════════════════════════════
// Main: Full automated GoPay payment with SMS OTP
// ══════════════════════════════════════════════════════════════════════════
async function automateGoPayBrowser(midtransUrl, phone, pin, waitForOTP) {
  log("════════════════════════════════════════");
  log("Starting GoPay Browser + SMS Automation");
  log("URL:", midtransUrl);
  log("Phone:", phone);
  log("════════════════════════════════════════\n");

  let browser;
  const screenshots = [];
  const networkLog = [];

  try {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: "/usr/bin/chromium-browser",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-web-security",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 900, isMobile: true });
    await page.setUserAgent(
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36"
    );

    // Track network
    page.on("response", async (res) => {
      const u = res.url();
      if (u.includes("midtrans") || u.includes("gopay") || u.includes("gojek")) {
        networkLog.push({ url: u.substring(0, 200), status: res.status() });
      }
    });

    // ── Step 1: Open Midtrans snap page ─────────────────────────────
    log("Step 1: Opening Midtrans snap page...");
    await page.goto(midtransUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForFunction(() => document.body.innerText.length > 50, { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 2000));
    screenshots.push(await shot(page, "01_page_loaded"));
    await saveHTML(page, "01_page");

    const pageTitle = await page.title();
    log("Step 1: Page loaded —", pageTitle);

    // ── Step 2: Find phone input and enter number ────────────────────
    log("Step 2: Looking for phone input...");

    // The phone number from config includes country code (e.g. "81234567890")
    // The page has a country code selector (+62) and a phone input
    // We need to enter just the local part (without 62 prefix)
    let localPhone = phone;
    if (localPhone.startsWith("+62")) localPhone = localPhone.substring(3);
    if (localPhone.startsWith("62")) localPhone = localPhone.substring(2);
    if (localPhone.startsWith("0")) localPhone = localPhone.substring(1);

    // Try to find and clear any existing phone input, then type
    const phoneTyped = await page.evaluate(() => {
      const inputs = document.querySelectorAll("input[type='tel'], input[type='text'], input[type='number'], input[inputmode='numeric']");
      for (const inp of inputs) {
        if (inp.offsetParent !== null && !inp.readOnly) {
          inp.focus();
          inp.value = "";
          return { found: true, id: inp.id, name: inp.name, placeholder: inp.placeholder };
        }
      }
      return { found: false };
    });

    if (!phoneTyped.found) {
      screenshots.push(await shot(page, "02_no_phone_input"));
      return { success: false, error: "Phone input not found on page", screenshots, networkLog };
    }

    log("Step 2: Found phone input:", JSON.stringify(phoneTyped));

    // Use page.type() for proper React/Vue event triggering
    const inputSelector = phoneTyped.id
      ? `#${phoneTyped.id}`
      : phoneTyped.name
        ? `input[name="${phoneTyped.name}"]`
        : "input[type='tel'], input[type='text'], input[inputmode='numeric']";

    await page.click(inputSelector);
    await page.evaluate((sel) => { document.querySelector(sel).value = ""; }, inputSelector);
    await page.type(inputSelector, localPhone, { delay: 50 });
    await new Promise((r) => setTimeout(r, 1000));
    screenshots.push(await shot(page, "02_phone_entered"));
    log("Step 2: ✅ Phone entered:", localPhone);

    // ── Step 3: Click submit/link button ──────────────────────────────
    log("Step 3: Looking for submit button...");
    await new Promise((r) => setTimeout(r, 500));

    // Strategy: Find buttons that are NOT the country selector
    const btnClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button, input[type='submit'], a.btn, [role='button']");
      for (const btn of buttons) {
        const text = (btn.textContent || "").trim().toLowerCase();
        const isVisible = btn.offsetParent !== null;
        const isNotDropdown = !btn.closest("select") && !text.includes("indonesia") && !text.includes("+62");

        // Look for submit-type buttons
        if (isVisible && isNotDropdown && (
          btn.type === "submit" ||
          text.includes("link") ||
          text.includes("hubungkan") ||
          text.includes("lanjutkan") ||
          text.includes("continue") ||
          text.includes("connect") ||
          text.includes("proceed")
        )) {
          btn.click();
          return { clicked: true, text: text.substring(0, 50), tag: btn.tagName };
        }
      }

      // Fallback: click any primary-looking button
      const primary = document.querySelector("button.primary, button.btn-primary, .button-primary, button[class*='primary'], button[class*='submit']");
      if (primary && primary.offsetParent !== null) {
        primary.click();
        return { clicked: true, text: (primary.textContent || "").trim().substring(0, 50), tag: "primary-class" };
      }

      // Last resort: click the last visible button (usually submit at bottom)
      const allBtns = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
      if (allBtns.length > 0) {
        const last = allBtns[allBtns.length - 1];
        last.click();
        return { clicked: true, text: (last.textContent || "").trim().substring(0, 50), tag: "last-button" };
      }

      return { clicked: false };
    });

    log("Step 3:", JSON.stringify(btnClicked));
    await new Promise((r) => setTimeout(r, 3000));
    screenshots.push(await shot(page, "03_submitted"));
    await saveHTML(page, "03_after_submit");

    // ── Step 4: Wait for OTP ──────────────────────────────────────────
    log("Step 4: Waiting for OTP page...");
    await new Promise((r) => setTimeout(r, 2000));

    // Check page state
    const pageState = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return {
        hasOTP: text.includes("otp") || text.includes("verifikasi") || text.includes("verification") || text.includes("kode"),
        hasPIN: text.includes("pin") || text.includes("security code"),
        hasError: text.includes("error") || text.includes("invalid") || text.includes("gagal"),
        hasSuccess: text.includes("success") || text.includes("berhasil"),
        sample: document.body.innerText.substring(0, 300),
      };
    });

    log("Step 4: Page state:", JSON.stringify({ hasOTP: pageState.hasOTP, hasPIN: pageState.hasPIN }));
    log("Step 4: Page text:", pageState.sample.substring(0, 200));

    // Get OTP from the callback (either WhatsApp listener or 5sim SMS)
    if (pageState.hasOTP && waitForOTP) {
      log("Step 4: OTP required — calling OTP provider...");

      let otpCode;
      try {
        otpCode = await waitForOTP(120000); // 2 min timeout
      } catch (e) {
        log("Step 4: OTP timeout:", e.message);
        screenshots.push(await shot(page, "04_otp_timeout"));
        return { success: false, error: "OTP timeout: " + e.message, waitingForOTP: true, screenshots, networkLog };
      }

      if (otpCode) {
        log("Step 4: Got OTP:", otpCode);

        // Enter OTP — try split inputs first, then single
        const otpEntered = await page.evaluate((code) => {
          // Split inputs (one digit each)
          const splitInputs = document.querySelectorAll("input[maxlength='1']");
          if (splitInputs.length >= 4) {
            const digits = code.toString().split("");
            splitInputs.forEach((inp, i) => {
              if (digits[i]) {
                inp.focus();
                inp.value = digits[i];
                inp.dispatchEvent(new Event("input", { bubbles: true }));
                inp.dispatchEvent(new Event("change", { bubbles: true }));
              }
            });
            return "split:" + splitInputs.length;
          }

          // Single input
          const inputs = document.querySelectorAll("input[type='tel'], input[type='number'], input[type='text'], input[inputmode='numeric']");
          for (const inp of inputs) {
            if (inp.offsetParent !== null && !inp.readOnly) {
              inp.focus();
              inp.value = code;
              inp.dispatchEvent(new Event("input", { bubbles: true }));
              inp.dispatchEvent(new Event("change", { bubbles: true }));
              return "single";
            }
          }
          return null;
        }, otpCode);

        log("Step 4: OTP entered:", otpEntered);

        // Click verify/submit
        await new Promise((r) => setTimeout(r, 1000));
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
          for (const btn of btns) {
            const t = (btn.textContent || "").toLowerCase();
            if (t.includes("verif") || t.includes("submit") || t.includes("confirm") || t.includes("lanjut")) {
              btn.click();
              return;
            }
          }
          // Click last visible button as fallback
          if (btns.length > 0) btns[btns.length - 1].click();
        });

        await new Promise((r) => setTimeout(r, 3000));
        screenshots.push(await shot(page, "04_otp_submitted"));
      }
    }

    // ── Step 5: Enter PIN ──────────────────────────────────────────────
    log("Step 5: Checking for PIN page...");
    await new Promise((r) => setTimeout(r, 2000));

    const pinState = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return {
        hasPIN: text.includes("pin") || text.includes("security"),
        hasPayment: text.includes("payment") || text.includes("bayar") || text.includes("pay"),
        sample: document.body.innerText.substring(0, 300),
      };
    });

    if (pinState.hasPIN && pin) {
      log("Step 5: Entering PIN...");

      // PIN is typically split inputs
      await page.evaluate((p) => {
        const pinInputs = document.querySelectorAll("input[maxlength='1'], input[type='password']");
        if (pinInputs.length >= 4) {
          p.split("").forEach((d, i) => {
            if (pinInputs[i]) {
              pinInputs[i].focus();
              pinInputs[i].value = d;
              pinInputs[i].dispatchEvent(new Event("input", { bubbles: true }));
              pinInputs[i].dispatchEvent(new Event("change", { bubbles: true }));
            }
          });
          return;
        }
        // Single PIN input
        const inputs = document.querySelectorAll("input[type='password'], input[type='tel']");
        for (const inp of inputs) {
          if (inp.offsetParent !== null) {
            inp.focus();
            inp.value = p;
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            break;
          }
        }
      }, pin);

      await new Promise((r) => setTimeout(r, 1000));

      // Click confirm
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
        for (const btn of btns) {
          const t = (btn.textContent || "").toLowerCase();
          if (t.includes("konfirmasi") || t.includes("confirm") || t.includes("submit") || t.includes("bayar") || t.includes("pay")) {
            btn.click();
            return;
          }
        }
        if (btns.length > 0) btns[btns.length - 1].click();
      });

      await new Promise((r) => setTimeout(r, 5000));
      screenshots.push(await shot(page, "05_pin_submitted"));
      log("Step 5: PIN submitted");
    }

    // ── Step 6: Wait for payment OTP (60 second delay) ──────────────
    log("Step 6: Checking if payment OTP needed...");
    await new Promise((r) => setTimeout(r, 3000));

    const afterPinState = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return {
        hasOTP: text.includes("otp") || text.includes("verifikasi") || text.includes("kode"),
        hasSuccess: text.includes("success") || text.includes("berhasil") || text.includes("settlement"),
        hasPending: text.includes("pending") || text.includes("waiting") || text.includes("menunggu"),
        sample: document.body.innerText.substring(0, 300),
      };
    });

    log("Step 6: State:", JSON.stringify({ hasOTP: afterPinState.hasOTP, hasSuccess: afterPinState.hasSuccess }));

    if (afterPinState.hasSuccess) {
      screenshots.push(await shot(page, "06_success"));
      log("✅ PAYMENT SUCCESS!");
      return { success: true, message: "Payment completed!", screenshots, networkLog };
    }

    // If page shows OTP again (payment verification), wait and enter
    if (afterPinState.hasOTP && waitForOTP) {
      log("Step 6: Payment OTP required — waiting 60 seconds for SMS...");
      screenshots.push(await shot(page, "06_payment_otp_needed"));

      let paymentOTP;
      try {
        paymentOTP = await waitForOTP(180000); // 3 min timeout for payment OTP
      } catch (e) {
        log("Step 6: Payment OTP timeout:", e.message);
        return { success: false, error: "Payment OTP timeout", screenshots, networkLog };
      }

      if (paymentOTP) {
        log("Step 6: Got payment OTP:", paymentOTP);

        await page.evaluate((code) => {
          const splitInputs = document.querySelectorAll("input[maxlength='1']");
          if (splitInputs.length >= 4) {
            code.toString().split("").forEach((d, i) => {
              if (splitInputs[i]) {
                splitInputs[i].focus();
                splitInputs[i].value = d;
                splitInputs[i].dispatchEvent(new Event("input", { bubbles: true }));
              }
            });
            return;
          }
          const inputs = document.querySelectorAll("input[type='tel'], input[type='number'], input[inputmode='numeric']");
          for (const inp of inputs) {
            if (inp.offsetParent !== null) { inp.value = code; inp.dispatchEvent(new Event("input", { bubbles: true })); break; }
          }
        }, paymentOTP);

        await new Promise((r) => setTimeout(r, 1000));
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
          if (btns.length > 0) btns[btns.length - 1].click();
        });

        await new Promise((r) => setTimeout(r, 5000));
        screenshots.push(await shot(page, "06_payment_otp_submitted"));
      }
    }

    // ── Step 7: Poll for result ──────────────────────────────────────
    log("Step 7: Waiting for payment result...");
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const result = await page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return {
          success: text.includes("success") || text.includes("berhasil") || text.includes("settlement") || text.includes("thank"),
          failed: text.includes("fail") || text.includes("gagal") || text.includes("expired") || text.includes("declined"),
          text: document.body.innerText.substring(0, 200),
        };
      });

      if (result.success) {
        screenshots.push(await shot(page, "07_success"));
        log("✅ PAYMENT SUCCESS!");
        return { success: true, message: "Payment completed!", screenshots, networkLog };
      }
      if (result.failed) {
        screenshots.push(await shot(page, "07_failed"));
        return { success: false, error: "Payment failed: " + result.text.substring(0, 150), screenshots, networkLog };
      }

      log(`Poll #${i + 1}: waiting... URL: ${page.url().substring(0, 80)}`);
    }

    screenshots.push(await shot(page, "07_timeout"));
    return { success: false, error: "Payment result timeout", screenshots, networkLog };

  } catch (err) {
    log("ERROR:", err.message);
    return { success: false, error: err.message, screenshots, networkLog };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { automateGoPayBrowser };
