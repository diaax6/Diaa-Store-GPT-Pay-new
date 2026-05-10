// ══════════════════════════════════════════════════════════════════════════
// WhatsApp OTP Listener — whatsapp-web.js
// ══════════════════════════════════════════════════════════════════════════

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const EventEmitter = require("events");

class WhatsAppOTP extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.ready = false;
    this.qrCode = null;       // Current QR code (base64 image)
    this.qrText = null;       // Current QR code (text for terminal)
    this.otpStore = [];        // { code, from, body, timestamp }
    this.OTP_EXPIRY = 5 * 60 * 1000; // 5 minutes
  }

  async initialize() {
    console.log("[WhatsApp] Initializing...");

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: "./whatsapp-session" }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--single-process",
        ],
      },
    });

    // QR Code event — for first-time authentication
    this.client.on("qr", async (qr) => {
      console.log("[WhatsApp] QR Code received — scan with your phone:");
      qrcode.generate(qr, { small: true });
      this.qrText = qr;

      // Generate base64 QR image for web display
      try {
        this.qrCode = await QRCode.toDataURL(qr);
      } catch (e) {
        console.log("[WhatsApp] QR image generation error:", e.message);
      }

      this.emit("qr", qr);
    });

    // Ready event
    this.client.on("ready", () => {
      console.log("[WhatsApp] ✅ Connected and ready!");
      this.ready = true;
      this.qrCode = null;
      this.qrText = null;
      this.emit("ready");
    });

    // Authenticated event
    this.client.on("authenticated", () => {
      console.log("[WhatsApp] ✅ Authenticated (session saved)");
    });

    // Auth failure
    this.client.on("auth_failure", (msg) => {
      console.error("[WhatsApp] ❌ Auth failure:", msg);
      this.ready = false;
      this.emit("auth_failure", msg);
    });

    // Disconnected
    this.client.on("disconnected", (reason) => {
      console.log("[WhatsApp] Disconnected:", reason);
      this.ready = false;
      this.emit("disconnected", reason);
    });

    // Message listener — extract OTP codes
    this.client.on("message", async (message) => {
      const text = message.body || "";
      const from = message.from || "";

      // Look for 4-6 digit OTP codes
      const otpMatch = text.match(/\b(\d{4,6})\b/);
      if (otpMatch) {
        const otp = {
          code: otpMatch[1],
          from,
          body: text.substring(0, 200),
          timestamp: Date.now(),
        };

        console.log(`[WhatsApp] 🔑 OTP received from ${from}: ${otp.code}`);
        this.otpStore.unshift(otp); // newest first

        // Keep only last 20 OTPs
        if (this.otpStore.length > 20) this.otpStore.length = 20;

        this.emit("otp", otp);
      }
    });

    // Start the client
    try {
      await this.client.initialize();
    } catch (err) {
      console.error("[WhatsApp] Init error:", err.message);
    }
  }

  // Get the latest OTP (not expired)
  getLatestOTP() {
    const now = Date.now();
    // Clean expired OTPs
    this.otpStore = this.otpStore.filter(o => now - o.timestamp < this.OTP_EXPIRY);
    return this.otpStore[0] || null;
  }

  // Wait for a new OTP (with timeout)
  async waitForOTP(timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener("otp", handler);
        reject(new Error("OTP timeout"));
      }, timeoutMs);

      const handler = (otp) => {
        clearTimeout(timeout);
        resolve(otp);
      };

      this.once("otp", handler);
    });
  }

  // Get status info
  getStatus() {
    return {
      ready: this.ready,
      hasQR: !!this.qrCode,
      otpCount: this.otpStore.length,
      latestOTP: this.getLatestOTP(),
    };
  }

  // Get QR code as base64 image
  getQRImage() {
    return this.qrCode;
  }
}

// Singleton instance
const whatsapp = new WhatsAppOTP();

module.exports = whatsapp;
