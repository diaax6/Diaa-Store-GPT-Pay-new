// ══════════════════════════════════════════════════════════════════════════
// GoPay Direct API — NO BROWSER! Pure HTTP calls
// ══════════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const MIDTRANS_AUTH = "Basic TWlkLWNsaWVudC0zVFg4blVhLWZfUmdOcmt5Og==";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

// Use curl instead of Node's fetch — Node 18 fetch gets 429 from Midtrans
function curlPost(url, headers, body) {
  const headerArgs = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(" ");
  const cmd = `curl -s -w "\\n__HTTP__%{http_code}" -X POST "${url}" ${headerArgs} -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
  try {
    const raw = execSync(cmd, { timeout: 30000, encoding: "utf-8" });
    const parts = raw.split("\n__HTTP__");
    const responseBody = parts[0];
    const statusCode = parseInt(parts[1]) || 0;
    return { text: responseBody, status: statusCode, json: () => JSON.parse(responseBody) };
  } catch (e) {
    return { text: "", status: 0, json: () => ({}) };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Full Direct API Automation — NO PUPPETEER
// ──────────────────────────────────────────────────────────────────────

async function automateGoPay(midtransUrl, phoneNumber, pin, waitForOTP) {
  console.log("\n[GoPay-API] ════════════════════════════════════════");
  console.log("[GoPay-API] Starting FULL Direct API automation");
  console.log("[GoPay-API] URL:", midtransUrl);
  console.log("[GoPay-API] Phone:", phoneNumber);
  console.log("[GoPay-API] ════════════════════════════════════════\n");

  // Extract snap token from URL
  const snapToken = midtransUrl.split("/redirection/")[1]?.split("?")[0]?.split("#")[0];
  if (!snapToken) {
    return { success: false, error: "Could not extract snap token from URL" };
  }

  // ── Step 1: Midtrans Linking ─────────────────────────────────────
  console.log("[GoPay-API] Step 1: Midtrans linking...");
  const linkRes = curlPost(`https://app.midtrans.com/snap/v3/accounts/${snapToken}/linking`, {
    "Content-Type": "application/json",
    "Authorization": MIDTRANS_AUTH,
  }, { type: "gopay", country_code: "62", phone_number: phoneNumber });

  console.log("[GoPay-API] Step 1 raw (status " + linkRes.status + "):", linkRes.text.substring(0, 300));

  let linkData;
  try {
    linkData = JSON.parse(linkRes.text);
  } catch (e) {
    return { success: false, error: "Step 1 not JSON (status: " + linkRes.status + ")", step: 1 };
  }
  console.log("[GoPay-API] Step 1 response:", JSON.stringify(linkData).substring(0, 200));

  if (linkData.status_code !== "201" || !linkData.activation_link_url) {
    return { success: false, error: "Linking failed: " + JSON.stringify(linkData), step: 1 };
  }

  // Extract reference_id from activation_link_url
  const activationUrl = new URL(linkData.activation_link_url);
  const referenceId = activationUrl.searchParams.get("reference");
  console.log("[GoPay-API] Step 1: ✅ reference_id:", referenceId);

  // ── Step 2: Validate Reference ───────────────────────────────────
  console.log("[GoPay-API] Step 2: Validate reference...");
  const validateRes = await fetch("https://gwa.gopayapi.com/v1/linking/validate-reference", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "User-Agent": UA,
      "Origin": "https://merchants-gws-app.gopayapi.com",
      "Referer": "https://merchants-gws-app.gopayapi.com/",
    },
    body: JSON.stringify({ reference_id: referenceId }),
  });

  const validateData = await validateRes.json();
  console.log("[GoPay-API] Step 2 response:", JSON.stringify(validateData).substring(0, 200));

  if (!validateData.success || validateData.data?.next_action !== "linking-user-consent") {
    return { success: false, error: "Validate failed: " + JSON.stringify(validateData), step: 2 };
  }
  console.log("[GoPay-API] Step 2: ✅ Validated — next: user-consent");

  // ── Step 3: User Consent (= clicking "Hubungkan") → triggers OTP ─
  console.log("[GoPay-API] Step 3: User consent (triggers OTP)...");
  const consentRes = await fetch("https://gwa.gopayapi.com/v1/linking/user-consent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "User-Agent": UA,
      "Origin": "https://merchants-gws-app.gopayapi.com",
      "Referer": "https://merchants-gws-app.gopayapi.com/",
      "x-user-locale": "en-US",
    },
    body: JSON.stringify({ reference_id: referenceId }),
  });

  const consentData = await consentRes.json();
  console.log("[GoPay-API] Step 3 response:", JSON.stringify(consentData).substring(0, 200));

  if (!consentData.success || consentData.data?.next_action !== "linking-validate-otp") {
    return { success: false, error: "Consent failed: " + JSON.stringify(consentData), step: 3 };
  }
  console.log("[GoPay-API] Step 3: ✅ OTP sent to WhatsApp!");

  // ── Step 4: Wait for OTP on WhatsApp ─────────────────────────────
  console.log("[GoPay-API] Step 4: Waiting for OTP on WhatsApp (60s)...");
  let otpCode;
  try {
    const otpResult = await waitForOTP(60000);
    otpCode = otpResult.code;
    console.log("[GoPay-API] Step 4: ✅ OTP received:", otpCode);
  } catch (e) {
    console.log("[GoPay-API] Step 4: ⏳ OTP not auto-received — waiting for manual input");
    return {
      success: false,
      waitingForOTP: true,
      referenceId,
      message: "OTP sent to WhatsApp — enter it manually",
      step: 4,
    };
  }

  // ── Step 5: Validate OTP ─────────────────────────────────────────
  console.log("[GoPay-API] Step 5: Validating OTP...");
  const otpRes = await fetch("https://gwa.gopayapi.com/v1/linking/validate-otp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "User-Agent": UA,
      "Origin": "https://merchants-gws-app.gopayapi.com",
      "Referer": "https://merchants-gws-app.gopayapi.com/",
      "x-user-locale": "en-US",
    },
    body: JSON.stringify({ reference_id: referenceId, otp: otpCode }),
  });

  const otpData = await otpRes.json();
  console.log("[GoPay-API] Step 5 response:", JSON.stringify(otpData).substring(0, 300));

  if (!otpData.success) {
    return { success: false, error: "OTP validation failed: " + JSON.stringify(otpData), step: 5 };
  }

  const nextAction = otpData.data?.next_action;
  console.log("[GoPay-API] Step 5: ✅ OTP validated — next:", nextAction);

  // ── Step 6: Enter PIN (if required) ──────────────────────────────
  if (nextAction === "linking-validate-pin" || nextAction === "linking-enter-pin") {
    console.log("[GoPay-API] Step 6: Entering PIN...");
    const pinRes = await fetch("https://gwa.gopayapi.com/v1/linking/validate-pin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": UA,
        "Origin": "https://merchants-gws-app.gopayapi.com",
        "Referer": "https://merchants-gws-app.gopayapi.com/",
        "x-user-locale": "en-US",
      },
      body: JSON.stringify({ reference_id: referenceId, pin: pin }),
    });

    const pinData = await pinRes.json();
    console.log("[GoPay-API] Step 6 response:", JSON.stringify(pinData).substring(0, 300));

    if (!pinData.success) {
      return { success: false, error: "PIN validation failed: " + JSON.stringify(pinData), step: 6 };
    }
    console.log("[GoPay-API] Step 6: ✅ PIN accepted!");
  }

  // ── Done! ──────────────────────────────────────────────────────────
  console.log("\n[GoPay-API] ════════════════════════════════════════");
  console.log("[GoPay-API] ✅ COMPLETE — GoPay linked successfully!");
  console.log("[GoPay-API] ════════════════════════════════════════\n");

  return {
    success: true,
    referenceId,
    message: "GoPay linked and payment authorized",
  };
}

// ──────────────────────────────────────────────────────────────────────
// Continue with manual OTP — called when auto-detect fails
// ──────────────────────────────────────────────────────────────────────

async function continueWithOTP(referenceId, otpCode, pin) {
  console.log("[GoPay-API] Continuing with manual OTP:", otpCode, "ref:", referenceId);

  // Step 5: Validate OTP
  console.log("[GoPay-API] Step 5: Validating OTP...");
  const otpRes = await fetch("https://gwa.gopayapi.com/v1/linking/validate-otp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "User-Agent": UA,
      "Origin": "https://merchants-gws-app.gopayapi.com",
      "Referer": "https://merchants-gws-app.gopayapi.com/",
      "x-user-locale": "en-US",
    },
    body: JSON.stringify({ reference_id: referenceId, otp: otpCode }),
  });

  const otpData = await otpRes.json();
  console.log("[GoPay-API] Step 5 response:", JSON.stringify(otpData).substring(0, 300));

  if (!otpData.success) {
    return { success: false, error: "OTP validation failed: " + JSON.stringify(otpData) };
  }

  const nextAction = otpData.data?.next_action;
  console.log("[GoPay-API] Step 5: ✅ OTP validated — next:", nextAction);

  // Step 6: Enter PIN
  if (nextAction && nextAction.includes("pin") && pin) {
    console.log("[GoPay-API] Step 6: Entering PIN...");
    const pinRes = await fetch("https://gwa.gopayapi.com/v1/linking/validate-pin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": UA,
        "Origin": "https://merchants-gws-app.gopayapi.com",
        "Referer": "https://merchants-gws-app.gopayapi.com/",
        "x-user-locale": "en-US",
      },
      body: JSON.stringify({ reference_id: referenceId, pin: pin }),
    });

    const pinData = await pinRes.json();
    console.log("[GoPay-API] Step 6 response:", JSON.stringify(pinData).substring(0, 300));

    if (!pinData.success) {
      return { success: false, error: "PIN failed: " + JSON.stringify(pinData) };
    }
    console.log("[GoPay-API] Step 6: ✅ PIN accepted!");
  }

  console.log("[GoPay-API] ✅ COMPLETE!");
  return { success: true, referenceId, message: "GoPay linked!" };
}

module.exports = { automateGoPay, continueWithOTP };
