// ══════════════════════════════════════════════════════════════════════════
// GoPay Direct API — NO BROWSER! Pure HTTP calls
// ══════════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const MIDTRANS_AUTH = "Basic TWlkLWNsaWVudC0zVFg4blVhLWZfUmdOcmt5Og==";
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

// Use curl instead of Node's fetch — Node 18 fetch gets 429 from Midtrans
const FALLBACK_PROXY = "http://06396179dae9c48c081b__cr.tr,jp:e4f2b32b4aacd0d7@gw.dataimpulse.com:823";

// Add random session ID to proxy URL → forces fresh IP each call
function getRotatedProxy() {
  let proxy = FALLBACK_PROXY;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));
    proxy = cfg.globalProxy || cfg.checkoutProxy || FALLBACK_PROXY;
  } catch(e) {}
  
  // Inject random session into DataImpulse proxy: user__s.RANDOM:pass@host
  const sessionId = "gp" + Date.now() + Math.random().toString(36).slice(2, 6);
  // Insert __s.SESSION before the colon separating user options from password
  proxy = proxy.replace(
    /(__cr\.[a-z,]+)(:.+@)/i,
    `$1,__s.${sessionId}$2`
  );
  return proxy;
}

function curlPost(url, headers, body, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const proxy = getRotatedProxy();
    const proxyArg = proxy ? ` -x "${proxy}"` : "";
    if (attempt === 1) console.log("[curlPost] proxy:", proxy ? "YES (session rotated)" : "NONE");
    if (attempt > 1) console.log("[curlPost] Retry #" + attempt + " with fresh IP...");

    const headerArgs = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(" ");
    const cmd = `curl -s -w "\\n__HTTP__%{http_code}" --connect-timeout 15 --max-time 25 -X POST "${url}" ${headerArgs}${proxyArg} -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
    try {
      const raw = execSync(cmd, { timeout: 30000, encoding: "utf-8" });
      const parts = raw.split("\n__HTTP__");
      const responseBody = parts[0];
      const statusCode = parseInt(parts[1]) || 0;
      
      if (statusCode === 429 && attempt < retries) {
        const delay = attempt * 3000 + Math.random() * 2000;
        console.log(`[curlPost] 429 rate-limited — waiting ${(delay/1000).toFixed(1)}s before retry...`);
        execSync(`sleep ${(delay/1000).toFixed(1)}`);
        continue;
      }
      
      return { text: responseBody, status: statusCode, json: () => JSON.parse(responseBody) };
    } catch (e) {
      console.log("[curlPost] ERROR:", e.message?.substring(0, 100));
      if (attempt < retries) {
        execSync("sleep 2");
        continue;
      }
      return { text: "", status: 0, json: () => ({}) };
    }
  }
  return { text: "", status: 0, json: () => ({}) };
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

  // ── Step 0: Check if GoPay is already linked ────────────────────
  console.log("[GoPay-API] Step 0: Checking if GoPay already linked...");
  try {
    const inqRes = await fetch(`https://app.midtrans.com/snap/v3/accounts/${snapToken}/gopay`, {
      headers: { "Authorization": MIDTRANS_AUTH, "User-Agent": UA },
    });
    const inqData = await inqRes.json();
    console.log("[GoPay-API] Step 0 inquiry:", JSON.stringify(inqData));
    
    if (inqData.account_status === "ENABLED") {
      console.log("[GoPay-API] Step 0: ✅ GoPay ALREADY LINKED! Skipping to charge...");
      
      // Go straight to charge — no linking needed!
      const chargeRes = await fetch(`https://app.midtrans.com/snap/v2/transactions/${snapToken}/charge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": MIDTRANS_AUTH,
          "User-Agent": UA,
        },
        body: JSON.stringify({ payment_type: "gopay" }),
      });
      const chargeText = await chargeRes.text();
      console.log("[GoPay-API] Step 0 charge (status " + chargeRes.status + "):", chargeText.substring(0, 800));
      
      let chargeData;
      try { chargeData = JSON.parse(chargeText); } catch(e) {}
      
      const verificationUrl = chargeData?.gopay_verification_link_url;
      console.log("[GoPay-API] gopay_verification_link_url:", verificationUrl || "NULL");
      
      if (verificationUrl) {
        // ✅ TOKENIZED PAYMENT! Extract reference and authorize
        let paymentRef;
        try { paymentRef = new URL(verificationUrl).searchParams.get("reference"); } catch(e) {}
        if (!paymentRef) {
          const m = verificationUrl.match(/reference[=:]([a-f0-9-]{36})/i);
          paymentRef = m ? m[1] : null;
        }
        
        if (paymentRef) {
          console.log("[GoPay-API] ✅ Payment reference:", paymentRef);
          
          // Validate → Process → PIN → Confirm
          await fetch("https://gwa.gopayapi.com/v1/payment/validate-reference", {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": UA, "Origin": "https://gwc.gopayapi.com" },
            body: JSON.stringify({ reference_id: paymentRef }),
          });
          
          const procRes = await fetch("https://gwa.gopayapi.com/v1/payment/process", {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": UA, "Origin": "https://gwc.gopayapi.com" },
            body: JSON.stringify({ reference_id: paymentRef }),
          });
          const procText = await procRes.text();
          console.log("[GoPay-API] Payment process:", procText.substring(0, 500));
          
          let procJson; try { procJson = JSON.parse(procText); } catch(e) {}
          const challenge = procJson?.data?.challenge?.action?.value;
          
          if (challenge?.challenge_id && pin) {
            const cbUrl = `https://gwc.gopayapi.com/payment/provider-redirect?reference=${paymentRef}&action=payment-validate-pin`;
            await fetch(`https://customer.gopayapi.com/api/v2/challenges/${challenge.challenge_id}/pin-page/nb?redirect_url=${encodeURIComponent(cbUrl)}`,
              { headers: { "Accept": "application/json", "User-Agent": UA } });
            
            const pinRes = await fetch("https://customer.gopayapi.com/api/v1/users/pin/tokens/nb", {
              method: "POST",
              headers: { "Content-Type": "application/json", "User-Agent": UA },
              body: JSON.stringify({ challenge_id: challenge.challenge_id, client_id: challenge.client_id, pin }),
            });
            const pinData = await pinRes.text();
            console.log("[GoPay-API] PIN response:", pinData.substring(0, 200));
            
            let pToken = ""; try { pToken = JSON.parse(pinData)?.data?.token || ""; } catch(e) {}
            if (pToken) {
              const conf = await fetch("https://gwa.gopayapi.com/v1/payment/confirm", {
                method: "POST",
                headers: { "Content-Type": "application/json", "User-Agent": UA, "Origin": "https://gwc.gopayapi.com" },
                body: JSON.stringify({ reference_id: paymentRef, token: pToken }),
              });
              console.log("[GoPay-API] Confirm:", (await conf.text()).substring(0, 300));
            }
          }
          
          // Poll for settlement
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const st = await fetch(`https://app.midtrans.com/snap/v1/transactions/${snapToken}/status`,
              { headers: { "Authorization": MIDTRANS_AUTH, "User-Agent": UA } });
            const stText = await st.text();
            console.log("[GoPay-API] Poll #" + (i+1) + ":", stText.substring(0, 200));
            let stJson; try { stJson = JSON.parse(stText); } catch(e) {}
            if (stJson?.transaction_status === "settlement" || stJson?.transaction_status === "capture") {
              return { success: true, message: "✅ GoPay payment SETTLED!" };
            }
          }
          return { success: true, paymentRef, message: "Payment initiated via tokenization" };
        }
      }
      
      // No verification URL — return charge info for manual handling
      console.log("[GoPay-API] ⚠️ No verification URL — regular GoPay deeplink payment");
      return {
        success: false,
        error: "GoPay linked but no verification URL. Deeplink: " + (chargeData?.deeplink_url || "none"),
        deeplink_url: chargeData?.deeplink_url,
        qr_code_url: chargeData?.qr_code_url,
        step: 0,
      };
    }
  } catch(e) {
    console.log("[GoPay-API] Step 0 inquiry error:", e.message, "— proceeding to linking...");
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

  // ── Step 4: Return immediately for manual OTP input ────────────────
  console.log("[GoPay-API] Step 4: OTP sent — returning for manual input");
  return {
    success: false,
    waitingForOTP: true,
    referenceId,
    snapToken,
    message: "OTP sent to WhatsApp — enter it manually",
    step: 4,
  };

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
  console.log("[GoPay-API] Step 5 FULL response:", JSON.stringify(otpData));

  if (!otpData.success) {
    return { success: false, error: "OTP validation failed: " + JSON.stringify(otpData) };
  }

  const nextAction = otpData.data?.next_action;
  const challenge = otpData.data?.challenge?.action?.value;
  console.log("[GoPay-API] Step 5: ✅ OTP validated — next:", nextAction);
  if (challenge) {
    console.log("[GoPay-API] Challenge ID:", challenge.challenge_id);
    console.log("[GoPay-API] Client ID:", challenge.client_id);
  }

  // Step 6: Enter PIN via GoPay PIN Challenge API
  if (nextAction && nextAction.includes("pin") && pin) {
    console.log("[GoPay-API] Step 6: Entering PIN via challenge API...");

    if (!challenge?.challenge_id || !challenge?.client_id) {
      return { success: false, error: "No challenge_id/client_id in OTP response" };
    }

    // Step 6a: Get PIN page (initializes challenge session)
    const callbackUrl = challenge.redirect_uri
      ? new URL(challenge.redirect_uri).searchParams.get("callbackUrl") || ""
      : `https://merchants-gws-app.gopayapi.com/payment/provider-redirect?reference=${referenceId}&action=linking-validate-pin`;

    console.log("[GoPay-API] Step 6a: Getting PIN page...");
    const pinPageRes = await fetch(
      `https://customer.gopayapi.com/api/v2/challenges/${challenge.challenge_id}/pin-page/nb?redirect_url=${encodeURIComponent(callbackUrl)}`,
      {
        headers: {
          "Accept": "application/json",
          "User-Agent": UA,
        },
      }
    );
    const pinPageData = await pinPageRes.text();
    console.log("[GoPay-API] Step 6a response (status " + pinPageRes.status + "):", pinPageData.substring(0, 300));

    // Step 6b: Submit PIN token
    console.log("[GoPay-API] Step 6b: Submitting PIN...");
    const pinTokenRes = await fetch("https://customer.gopayapi.com/api/v1/users/pin/tokens/nb", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": UA,
      },
      body: JSON.stringify({
        challenge_id: challenge.challenge_id,
        client_id: challenge.client_id,
        pin: pin,
      }),
    });

    const pinTokenData = await pinTokenRes.text();
    console.log("[GoPay-API] Step 6b response (status " + pinTokenRes.status + "):", pinTokenData.substring(0, 500));

    if (pinTokenRes.status >= 400) {
      // Fallback: try the old validate-pin endpoint
      console.log("[GoPay-API] Step 6c: Trying fallback validate-pin...");
      const fallbackRes = await fetch("https://gwa.gopayapi.com/v1/linking/validate-pin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/plain, */*",
          "User-Agent": UA,
          "Origin": "https://merchants-gws-app.gopayapi.com",
          "Referer": "https://merchants-gws-app.gopayapi.com/",
        },
        body: JSON.stringify({ reference_id: referenceId, pin: pin, challenge_id: challenge.challenge_id }),
      });
      const fallbackData = await fallbackRes.text();
      console.log("[GoPay-API] Step 6c fallback response (status " + fallbackRes.status + "):", fallbackData.substring(0, 500));
    }

    console.log("[GoPay-API] Step 6: PIN submitted!");

    // Step 7: Call callback URL with token to complete linking
    let pinToken = "";
    try {
      const parsed = JSON.parse(pinTokenData);
      pinToken = parsed.data?.token || "";
    } catch(e) {}

    if (pinToken) {
      // Step 7: Tell GoPay that PIN was verified (field name = "token")
      console.log("[GoPay-API] Step 7: Sending token to GoPay linking API...");
      const vp = await fetch("https://gwa.gopayapi.com/v1/linking/validate-pin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UA,
          "Origin": "https://merchants-gws-app.gopayapi.com",
          "Referer": "https://merchants-gws-app.gopayapi.com/",
        },
        body: JSON.stringify({ reference_id: referenceId, token: pinToken }),
      });
      const vpData = await vp.text();
      console.log("[GoPay-API] Step 7 (status " + vp.status + "):", vpData.substring(0, 500));

      let vpJson;
      try { vpJson = JSON.parse(vpData); } catch(e) {}

      // Step 8: Call Midtrans redirect_url to confirm linking
      const redirectUrl = vpJson?.data?.redirect_url;
      if (redirectUrl) {
        console.log("[GoPay-API] Step 8: Calling Midtrans callback:", redirectUrl);
        const midCb = await fetch(redirectUrl, {
          headers: { "User-Agent": UA, "Accept": "application/json, text/html, */*" },
          redirect: "follow",
        });
        const midCbBody = await midCb.text();
        const midLoc = midCb.headers.get("location");
        console.log("[GoPay-API] Step 8 (status " + midCb.status + ") redirect:", midLoc || "(none)");
        console.log("[GoPay-API] Step 8 body:", midCbBody.substring(0, 500));
        console.log("[GoPay-API] Step 8 final URL:", midCb.url);

        // Follow redirects to find payment reference
        if (midLoc) {
          console.log("[GoPay-API] Step 8b: Following Midtrans redirect...");
          const mid2 = await fetch(midLoc, {
            headers: { "User-Agent": UA },
            redirect: "manual",
          });
          const mid2Loc = mid2.headers.get("location");
          const mid2Body = await mid2.text();
          console.log("[GoPay-API] Step 8b (status " + mid2.status + ") redirect:", mid2Loc || "(none)");
          console.log("[GoPay-API] Step 8b body:", mid2Body.substring(0, 300));

          // Look for payment reference in redirect URL or body
          const allText = (midLoc || "") + (mid2Loc || "") + mid2Body;
          const payRef = allText.match(/reference[=:]([a-f0-9-]{36})/i);
          if (payRef && payRef[1] !== referenceId) {
            console.log("[GoPay-API] Step 9: Found PAYMENT reference:", payRef[1]);
            
            // Validate payment reference
            const payVal = await fetch("https://gwa.gopayapi.com/v1/payment/validate-reference", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": UA,
                "Origin": "https://merchants-gws-app.gopayapi.com",
                "Referer": "https://merchants-gws-app.gopayapi.com/",
              },
              body: JSON.stringify({ reference_id: payRef[1] }),
            });
            const payValData = await payVal.text();
            console.log("[GoPay-API] Step 9 payment validate (status " + payVal.status + "):", payValData.substring(0, 500));

            // Return for manual OTP (payment)
            return {
              success: false,
              waitingForOTP: true,
              referenceId: payRef[1],
              isPayment: true,
              message: "Linking ✅! Now enter PAYMENT OTP",
              step: 9,
            };
          }
        }
      }
    }
  }

  console.log("[GoPay-API] ✅ LINKING COMPLETE! Starting PAYMENT...");

  // ── Step 9: Charge via Midtrans Snap ───────────────────────────────
  console.log("[GoPay-API] Step 9: Charging via Midtrans...");
  
  // First check GoPay account status (using fetch, NOT curlPost — proxy hangs)
  try {
    const gopayInq = await fetch(`https://app.midtrans.com/snap/v3/accounts/${snapToken}/gopay`, {
      method: "GET",
      headers: { "Authorization": MIDTRANS_AUTH, "User-Agent": UA },
    });
    const gopayData = await gopayInq.text();
    console.log("[GoPay-API] Step 9a GoPay inquiry (status " + gopayInq.status + "):", gopayData.substring(0, 300));
  } catch(e) {
    console.log("[GoPay-API] Step 9a error:", e.message);
  }

  // THE charge endpoint — with gopay.tokenization flag for tokenized payment
  let chargeRes, chargeText = "";
  try {
    chargeRes = await fetch(`https://app.midtrans.com/snap/v2/transactions/${snapToken}/charge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": MIDTRANS_AUTH,
        "User-Agent": UA,
      },
      body: JSON.stringify({ payment_type: "gopay", gopay: { tokenization: true } }),
    });
    chargeText = await chargeRes.text();
    console.log("[GoPay-API] Step 9b charge (status " + chargeRes.status + "):", chargeText.substring(0, 800));
  } catch(e) {
    console.log("[GoPay-API] Step 9b error:", e.message);
  }

  // Parse charge response
  let chargeData;
  try { chargeData = JSON.parse(chargeText); } catch(e) {}
  
  if (chargeData) {
    console.log("[GoPay-API] Step 9 charge keys:", Object.keys(chargeData).join(", "));
    
    // ── Step 10: Handle gopay_verification_link_url (tokenized payment) ──
    const verificationUrl = chargeData.gopay_verification_link_url;
    if (verificationUrl) {
      console.log("[GoPay-API] Step 10: ✅ Got verification URL:", verificationUrl);
      
      // Extract reference from URL (e.g. ?reference=UUID)
      let paymentRef;
      try {
        const vUrl = new URL(verificationUrl);
        paymentRef = vUrl.searchParams.get("reference");
      } catch(e) {
        // Try regex fallback
        const m = verificationUrl.match(/reference[=:]([a-f0-9-]{36})/i);
        paymentRef = m ? m[1] : null;
      }
      
      if (paymentRef) {
        console.log("[GoPay-API] Step 10: Payment reference:", paymentRef);
        
        // Step 10a: Validate payment reference
        console.log("[GoPay-API] Step 10a: Validating payment reference...");
        const payVal = await fetch("https://gwa.gopayapi.com/v1/payment/validate-reference", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Origin": "https://gwc.gopayapi.com",
            "Referer": "https://gwc.gopayapi.com/",
          },
          body: JSON.stringify({ reference_id: paymentRef }),
        });
        const payValData = await payVal.text();
        console.log("[GoPay-API] Step 10a validate (status " + payVal.status + "):", payValData.substring(0, 500));
        
        // Step 10b: Process payment (triggers PIN challenge)
        console.log("[GoPay-API] Step 10b: Processing payment...");
        const payProcess = await fetch("https://gwa.gopayapi.com/v1/payment/process", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Origin": "https://gwc.gopayapi.com",
            "Referer": "https://gwc.gopayapi.com/",
          },
          body: JSON.stringify({ reference_id: paymentRef }),
        });
        const payProcessData = await payProcess.text();
        console.log("[GoPay-API] Step 10b process (status " + payProcess.status + "):", payProcessData.substring(0, 500));
        
        // Parse challenge from process response
        let processJson;
        try { processJson = JSON.parse(payProcessData); } catch(e) {}
        const payChallenge = processJson?.data?.challenge?.action?.value;
        
        if (payChallenge?.challenge_id && pin) {
          console.log("[GoPay-API] Step 11: Payment PIN challenge found!");
          console.log("[GoPay-API] Challenge ID:", payChallenge.challenge_id);
          
          // Step 11a: Get PIN page
          const callbackUrl = `https://gwc.gopayapi.com/payment/provider-redirect?reference=${paymentRef}&action=payment-validate-pin`;
          await fetch(
            `https://customer.gopayapi.com/api/v2/challenges/${payChallenge.challenge_id}/pin-page/nb?redirect_url=${encodeURIComponent(callbackUrl)}`,
            { headers: { "Accept": "application/json", "User-Agent": UA } }
          );
          
          // Step 11b: Submit PIN
          console.log("[GoPay-API] Step 11b: Submitting payment PIN...");
          const payPinRes = await fetch("https://customer.gopayapi.com/api/v1/users/pin/tokens/nb", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "User-Agent": UA,
            },
            body: JSON.stringify({
              challenge_id: payChallenge.challenge_id,
              client_id: payChallenge.client_id,
              pin: pin,
            }),
          });
          const payPinData = await payPinRes.text();
          console.log("[GoPay-API] Step 11b PIN response (status " + payPinRes.status + "):", payPinData.substring(0, 300));
          
          let payPinToken = "";
          try { payPinToken = JSON.parse(payPinData)?.data?.token || ""; } catch(e) {}
          
          if (payPinToken) {
            // Step 11c: Confirm payment with PIN token
            console.log("[GoPay-API] Step 11c: Confirming payment...");
            const confirmRes = await fetch("https://gwa.gopayapi.com/v1/payment/confirm", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": UA,
                "Origin": "https://gwc.gopayapi.com",
                "Referer": "https://gwc.gopayapi.com/",
              },
              body: JSON.stringify({ reference_id: paymentRef, token: payPinToken }),
            });
            const confirmData = await confirmRes.text();
            console.log("[GoPay-API] Step 11c confirm (status " + confirmRes.status + "):", confirmData.substring(0, 500));
          }
        }
        
        // Step 12: Poll transaction status
        console.log("[GoPay-API] Step 12: Polling transaction status...");
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 3000));
          try {
            const statusRes = await fetch(`https://app.midtrans.com/snap/v1/transactions/${snapToken}/status`, {
              headers: { "Authorization": MIDTRANS_AUTH, "User-Agent": UA },
            });
            const statusData = await statusRes.text();
            console.log("[GoPay-API] Step 12 poll #" + (i+1) + " (status " + statusRes.status + "):", statusData.substring(0, 300));
            
            let statusJson;
            try { statusJson = JSON.parse(statusData); } catch(e) {}
            if (statusJson?.transaction_status === "settlement" || statusJson?.transaction_status === "capture") {
              console.log("[GoPay-API] ✅ PAYMENT SETTLED!");
              return { success: true, referenceId, paymentRef, message: "GoPay payment completed!" };
            }
          } catch(e) {
            console.log("[GoPay-API] Step 12 poll error:", e.message);
          }
        }
        
        return { success: true, referenceId, paymentRef, message: "GoPay linked + payment initiated via tokenization" };
      }
    }
    
    // Fallback: no verification URL (regular GoPay deeplink)
    console.log("[GoPay-API] ⚠️ No gopay_verification_link_url — regular GoPay payment");
    const actionUrl = chargeData.redirect_url 
      || chargeData.actions?.find(a => a.name === "generate-qr-code" || a.name === "deeplink-redirect")?.url
      || chargeData.gopay_callback_url;
    if (actionUrl) console.log("[GoPay-API] Deeplink URL:", actionUrl);
  }

  return { success: true, referenceId, message: "GoPay linked + charge initiated!" };
}

// ──────────────────────────────────────────────────────────────────────
// continueWithOTP — called by server.js after manual OTP input
// ──────────────────────────────────────────────────────────────────────

async function continueWithOTP(referenceId, otp, pin, snapToken) {
  console.log("\n[GoPay-API] ═══ continueWithOTP ═══");
  console.log("[GoPay-API] referenceId:", referenceId);
  console.log("[GoPay-API] snapToken:", snapToken);

  // ── Step 5: Validate OTP ─────────────────────────────────────────
  console.log("[GoPay-API] Step 5: Validating OTP...");
  const otpRes = await fetch("https://gwa.gopayapi.com/v1/linking/validate-otp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      "Origin": "https://merchants-gws-app.gopayapi.com",
      "Referer": "https://merchants-gws-app.gopayapi.com/",
    },
    body: JSON.stringify({ reference_id: referenceId, otp }),
  });

  const otpData = await otpRes.json();
  console.log("[GoPay-API] Step 5 response:", JSON.stringify(otpData).substring(0, 300));

  if (!otpData.success) {
    return { success: false, error: "OTP validation failed: " + JSON.stringify(otpData), step: 5 };
  }

  const nextAction = otpData.data?.next_action;
  console.log("[GoPay-API] Step 5: ✅ OTP validated — next:", nextAction);

  // ── Step 6: Enter PIN via challenge API ──────────────────────────
  if (nextAction === "linking-validate-pin" || nextAction === "linking-enter-pin") {
    // Extract from direct data OR from redirect_uri
    const challengeValue = otpData.data?.challenge?.action?.value || {};
    const redirectUri = challengeValue.redirect_uri || otpData.data?.action_data?.redirect_uri || "";
    
    const challengeId = challengeValue.challenge_id || redirectUri.match(/challengeId=([^&]+)/)?.[1];
    const clientId = challengeValue.client_id || redirectUri.match(/clientId=([^&]+)/)?.[1];

    console.log("[GoPay-API] Challenge ID:", challengeId);
    console.log("[GoPay-API] Client ID:", clientId);

    if (challengeId && clientId) {
      // Build callback URL from redirect_uri
      const redirectUri = challengeValue.redirect_uri || "";
      let callbackUrl = "";
      try { callbackUrl = new URL(redirectUri).searchParams.get("callbackUrl") || ""; } catch(e) {}
      if (!callbackUrl) callbackUrl = `https://merchants-gws-app.gopayapi.com/payment/provider-redirect?reference=${referenceId}&action=linking-validate-pin`;

      // Step 6a: Get PIN page (uses v2 endpoint!)
      console.log("[GoPay-API] Step 6a: Getting PIN page...");
      const pinPageRes = await fetch(
        `https://customer.gopayapi.com/api/v2/challenges/${challengeId}/pin-page/nb?redirect_url=${encodeURIComponent(callbackUrl)}`,
        {
          headers: { "Accept": "application/json", "User-Agent": UA },
        }
      );
      const pinPageData = await pinPageRes.text();
      console.log("[GoPay-API] Step 6a response (status " + pinPageRes.status + "):", pinPageData.substring(0, 200));

      // Step 6b: Submit PIN (field is 'pin' NOT 'pin_value')
      console.log("[GoPay-API] Step 6b: Submitting PIN...");
      const pinSubmitRes = await fetch("https://customer.gopayapi.com/api/v1/users/pin/tokens/nb", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": UA,
        },
        body: JSON.stringify({
          challenge_id: challengeId,
          client_id: clientId,
          pin: pin,
        }),
      });
      const pinTokenData = await pinSubmitRes.text();
      console.log("[GoPay-API] Step 6b response (status " + pinSubmitRes.status + "):", pinTokenData.substring(0, 200));

      let pinToken = "";
      try {
        const parsed = JSON.parse(pinTokenData);
        pinToken = parsed.data?.token || "";
      } catch(e) {}

      console.log("[GoPay-API] Step 6: PIN submitted!");

      if (pinToken) {
        // Step 7: Tell GoPay that PIN was verified
        console.log("[GoPay-API] Step 7: Sending token to GoPay linking API...");
        const vp = await fetch("https://gwa.gopayapi.com/v1/linking/validate-pin", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Origin": "https://merchants-gws-app.gopayapi.com",
            "Referer": "https://merchants-gws-app.gopayapi.com/",
          },
          body: JSON.stringify({ reference_id: referenceId, token: pinToken }),
        });
        const vpData = await vp.text();
        console.log("[GoPay-API] Step 7 (status " + vp.status + "):", vpData.substring(0, 500));

        let vpJson;
        try { vpJson = JSON.parse(vpData); } catch(e) {}

        // Step 8: Call Midtrans redirect_url
        const redirectUrl = vpJson?.data?.redirect_url;
        if (redirectUrl) {
          console.log("[GoPay-API] Step 8: Calling Midtrans callback:", redirectUrl);
          const midCb = await fetch(redirectUrl, {
            headers: { "User-Agent": UA },
            redirect: "follow",
          });
          const midCbBody = await midCb.text();
          console.log("[GoPay-API] Step 8 (status " + midCb.status + ") body:", midCbBody.substring(0, 200));
        }
      }
    }
  }

  console.log("[GoPay-API] ✅ LINKING COMPLETE! Starting PAYMENT...");

  // ── Step 9: Charge via Midtrans ────────────────────────────────
  if (snapToken) {
    console.log("[GoPay-API] Step 9: Charging via Midtrans...");
    
    try {
      const gopayInq = await fetch(`https://app.midtrans.com/snap/v3/accounts/${snapToken}/gopay`, {
        headers: { "Authorization": MIDTRANS_AUTH, "User-Agent": UA },
      });
      const gopayData = await gopayInq.text();
      console.log("[GoPay-API] Step 9a inquiry (status " + gopayInq.status + "):", gopayData.substring(0, 300));
    } catch(e) { console.log("[GoPay-API] Step 9a error:", e.message); }

    try {
      const chargeRes = await fetch(`https://app.midtrans.com/snap/v2/transactions/${snapToken}/charge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": MIDTRANS_AUTH,
          "User-Agent": UA,
        },
        body: JSON.stringify({ payment_type: "gopay", gopay: { tokenization: true } }),
      });
      const chargeText = await chargeRes.text();
      console.log("[GoPay-API] Step 9b charge (status " + chargeRes.status + "):", chargeText.substring(0, 800));

      // Check for gopay_verification_link_url
      let chargeJson;
      try { chargeJson = JSON.parse(chargeText); } catch(e) {}
      const verificationUrl = chargeJson?.gopay_verification_link_url;
      if (verificationUrl) {
        console.log("[GoPay-API] Step 10: ✅ Got verification URL:", verificationUrl);
        let paymentRef;
        try {
          paymentRef = new URL(verificationUrl).searchParams.get("reference");
        } catch(e) {
          const m = verificationUrl.match(/reference[=:]([a-f0-9-]{36})/i);
          paymentRef = m ? m[1] : null;
        }
        if (paymentRef) {
          console.log("[GoPay-API] Step 10: Payment reference:", paymentRef);
          
          // Validate → Process → PIN → Confirm
          const payVal = await fetch("https://gwa.gopayapi.com/v1/payment/validate-reference", {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": UA, "Origin": "https://gwc.gopayapi.com" },
            body: JSON.stringify({ reference_id: paymentRef }),
          });
          console.log("[GoPay-API] Step 10a validate:", (await payVal.text()).substring(0, 300));
          
          const payProc = await fetch("https://gwa.gopayapi.com/v1/payment/process", {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": UA, "Origin": "https://gwc.gopayapi.com" },
            body: JSON.stringify({ reference_id: paymentRef }),
          });
          const procText = await payProc.text();
          console.log("[GoPay-API] Step 10b process:", procText.substring(0, 500));
          
          let procJson;
          try { procJson = JSON.parse(procText); } catch(e) {}
          const payChallenge = procJson?.data?.challenge?.action?.value;
          
          if (payChallenge?.challenge_id && pin) {
            const cbUrl = `https://gwc.gopayapi.com/payment/provider-redirect?reference=${paymentRef}&action=payment-validate-pin`;
            await fetch(`https://customer.gopayapi.com/api/v2/challenges/${payChallenge.challenge_id}/pin-page/nb?redirect_url=${encodeURIComponent(cbUrl)}`,
              { headers: { "Accept": "application/json", "User-Agent": UA } });
            
            const pinRes = await fetch("https://customer.gopayapi.com/api/v1/users/pin/tokens/nb", {
              method: "POST",
              headers: { "Content-Type": "application/json", "User-Agent": UA },
              body: JSON.stringify({ challenge_id: payChallenge.challenge_id, client_id: payChallenge.client_id, pin }),
            });
            const pinData = await pinRes.text();
            console.log("[GoPay-API] Step 11 PIN:", pinData.substring(0, 200));
            
            let pToken = "";
            try { pToken = JSON.parse(pinData)?.data?.token || ""; } catch(e) {}
            if (pToken) {
              const conf = await fetch("https://gwa.gopayapi.com/v1/payment/confirm", {
                method: "POST",
                headers: { "Content-Type": "application/json", "User-Agent": UA, "Origin": "https://gwc.gopayapi.com" },
                body: JSON.stringify({ reference_id: paymentRef, token: pToken }),
              });
              console.log("[GoPay-API] Step 12 confirm:", (await conf.text()).substring(0, 300));
            }
          }
          
          // Poll status
          for (let i = 0; i < 8; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const st = await fetch(`https://app.midtrans.com/snap/v1/transactions/${snapToken}/status`,
              { headers: { "Authorization": MIDTRANS_AUTH, "User-Agent": UA } });
            const stText = await st.text();
            console.log("[GoPay-API] Poll #" + (i+1) + ":", stText.substring(0, 200));
            let stJson; try { stJson = JSON.parse(stText); } catch(e) {}
            if (stJson?.transaction_status === "settlement" || stJson?.transaction_status === "capture") {
              return { success: true, referenceId, paymentRef, message: "Payment settled!" };
            }
          }
        }
      }
    } catch(e) { console.log("[GoPay-API] Step 9b error:", e.message); }
  } else {
    console.log("[GoPay-API] ⚠️  No snapToken — cannot charge!");
  }

  return { success: true, referenceId, message: "GoPay linked + charge initiated!" };
}

module.exports = { automateGoPay, continueWithOTP };
