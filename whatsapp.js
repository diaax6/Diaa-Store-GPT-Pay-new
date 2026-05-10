// ══════════════════════════════════════════════════════════════════════════
// WhatsApp Multi-Client OTP Manager
// Supports multiple WhatsApp accounts, each in its own session
// ══════════════════════════════════════════════════════════════════════════

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const EventEmitter = require("events");

class WhatsAppClient extends EventEmitter {
  constructor(id, phoneLabel) {
    super();
    this.id = id;                // Unique ID (e.g. "wa_0", "wa_1")
    this.phoneLabel = phoneLabel; // Display label (e.g. "895320598550")
    this.client = null;
    this.ready = false;
    this.qrCode = null;
    this.qrText = null;
    this.pairingCode = null;
    this.otpStore = [];
    this.OTP_EXPIRY = 5 * 60 * 1000;
  }

  async initialize() {
    console.log(`[WA:${this.id}] Initializing (${this.phoneLabel})...`);

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: `./whatsapp-session-${this.id}` }),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox", "--disable-setuid-sandbox",
          "--disable-dev-shm-usage", "--disable-gpu",
          "--single-process",
        ],
      },
    });

    this.client.on("qr", async (qr) => {
      console.log(`[WA:${this.id}] QR Code — scan or use pairing code:`);
      qrcode.generate(qr, { small: true });
      this.qrText = qr;
      try { this.qrCode = await QRCode.toDataURL(qr); } catch {}
      this.emit("qr", qr);
    });

    this.client.on("ready", () => {
      console.log(`[WA:${this.id}] ✅ Connected! (${this.phoneLabel})`);
      this.ready = true;
      this.qrCode = null;
      this.qrText = null;
      this.pairingCode = null;
      this.emit("ready");
    });

    this.client.on("authenticated", () => {
      console.log(`[WA:${this.id}] ✅ Authenticated`);
    });

    this.client.on("auth_failure", (msg) => {
      console.error(`[WA:${this.id}] ❌ Auth failure:`, msg);
      this.ready = false;
    });

    this.client.on("disconnected", (reason) => {
      console.log(`[WA:${this.id}] Disconnected:`, reason);
      this.ready = false;
    });

    // Message listener — ALL events
    const handleMessage = async (message) => {
      const text = message.body || "";
      const from = message.from || "";
      const isFromMe = message.fromMe || false;
      if (isFromMe || !text) return;

      console.log(`[WA:${this.id}] 📩 ${from}: ${text.substring(0, 80)}`);

      const otpMatch = text.match(/\b(\d{4,6})\b/);
      if (otpMatch) {
        const otp = {
          code: otpMatch[1], from,
          body: text.substring(0, 200),
          timestamp: Date.now(),
          clientId: this.id,
        };
        console.log(`[WA:${this.id}] 🔑 OTP: ${otp.code}`);
        this.otpStore.unshift(otp);
        if (this.otpStore.length > 20) this.otpStore.length = 20;
        this.emit("otp", otp);
      }
    };

    this.client.on("message", handleMessage);
    this.client.on("message_create", handleMessage);

    try {
      await this.client.initialize();
    } catch (err) {
      console.error(`[WA:${this.id}] Init error:`, err.message);
    }
  }

  // Request pairing code (alternative to QR)
  async requestPairing(phoneNumber) {
    try {
      // Format: international without + (e.g. "628953...")
      const code = await this.client.requestPairingCode(phoneNumber);
      this.pairingCode = code;
      console.log(`[WA:${this.id}] 🔗 Pairing code: ${code}`);
      return code;
    } catch (err) {
      console.error(`[WA:${this.id}] Pairing error:`, err.message);
      return null;
    }
  }

  // Poll GoPay chat for OTP
  async pollForOTP(startTime) {
    if (!this.client || !this.ready) return null;
    try {
      const chats = await this.client.getChats();
      const gopayChat = chats.find(c => {
        const name = (c.name || "").toLowerCase();
        return name.includes("gopay") || name.includes("go-pay");
      });
      if (!gopayChat) return null;

      const messages = await gopayChat.fetchMessages({ limit: 3 });
      for (const msg of messages) {
        if (msg.timestamp * 1000 >= startTime) {
          const otpMatch = (msg.body || "").match(/\b(\d{4,6})\b/);
          if (otpMatch) return otpMatch[1];
        }
      }
    } catch {}
    return null;
  }

  // Wait for OTP — hybrid: events + polling
  async waitForOTP(timeoutMs = 60000) {
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
      let resolved = false;
      const cleanup = () => {
        resolved = true;
        clearTimeout(timeout);
        clearInterval(poll);
        this.removeListener("otp", handler);
      };

      const timeout = setTimeout(() => {
        if (!resolved) { cleanup(); reject(new Error("OTP timeout")); }
      }, timeoutMs);

      const handler = (otp) => {
        if (!resolved) { cleanup(); resolve(otp); }
      };
      this.once("otp", handler);

      const poll = setInterval(async () => {
        if (resolved) return;
        const code = await this.pollForOTP(startTime);
        if (code && !resolved) {
          const otp = { code, from: "gopay-poll", timestamp: Date.now(), clientId: this.id };
          console.log(`[WA:${this.id}] 🔑 OTP via polling: ${code}`);
          cleanup();
          resolve(otp);
        }
      }, 5000);
    });
  }

  getStatus() {
    return {
      id: this.id,
      phone: this.phoneLabel,
      ready: this.ready,
      hasQR: !!this.qrCode,
      hasPairingCode: !!this.pairingCode,
      pairingCode: this.pairingCode,
      otpCount: this.otpStore.length,
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Multi-Client Manager
// ══════════════════════════════════════════════════════════════════════════

class WhatsAppManager extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map(); // id → WhatsAppClient
  }

  // Add and initialize a new client
  async addClient(id, phoneLabel) {
    if (this.clients.has(id)) {
      console.log(`[WAManager] Client ${id} already exists`);
      return this.clients.get(id);
    }

    const client = new WhatsAppClient(id, phoneLabel);

    // Forward OTP events
    client.on("otp", (otp) => this.emit("otp", otp));

    this.clients.set(id, client);
    await client.initialize();
    return client;
  }

  // Get client by ID
  getClient(id) {
    return this.clients.get(id);
  }

  // Get any ready client (fallback)
  getAnyReadyClient() {
    for (const [, client] of this.clients) {
      if (client.ready) return client;
    }
    return null;
  }

  // Wait for OTP on a specific client
  async waitForOTP(clientId, timeoutMs = 60000) {
    const client = this.clients.get(clientId);
    if (client && client.ready) {
      return client.waitForOTP(timeoutMs);
    }
    // Fallback: listen on ALL clients
    return this.waitForOTPAny(timeoutMs);
  }

  // Wait for OTP on ANY client
  async waitForOTPAny(timeoutMs = 60000) {
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

  // Get status of all clients
  getStatus() {
    const statuses = [];
    for (const [, client] of this.clients) {
      statuses.push(client.getStatus());
    }
    return {
      clientCount: this.clients.size,
      clients: statuses,
      anyReady: !!this.getAnyReadyClient(),
    };
  }

  // Get QR image for a specific client
  getQRImage(clientId) {
    const client = this.clients.get(clientId);
    return client?.qrCode || null;
  }
}

// Singleton
const manager = new WhatsAppManager();

// Backward compatibility — expose same interface
module.exports = {
  manager,
  // Legacy single-client interface
  initialize: () => manager.addClient("wa_0", "primary"),
  waitForOTP: (timeout) => manager.waitForOTPAny(timeout),
  getStatus: () => {
    const s = manager.getStatus();
    const primary = manager.getClient("wa_0");
    return {
      ready: s.anyReady,
      hasQR: primary?.qrCode ? true : false,
      otpCount: primary?.otpStore?.length || 0,
      latestOTP: primary?.otpStore?.[0] || null,
      ...s,
    };
  },
  getQRImage: () => manager.getQRImage("wa_0"),
  getClient: (id) => manager.getClient(id),
  addClient: (id, phone) => manager.addClient(id, phone),
};
