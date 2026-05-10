// ══════════════════════════════════════════════════════════════════════════
// WhatsApp Multi-Client using Baileys — Primary Device Support
// No Puppeteer needed! Direct WhatsApp protocol
// ══════════════════════════════════════════════════════════════════════════

// Polyfill crypto for older Node.js (baileys needs it)
if (!globalThis.crypto) {
  globalThis.crypto = require("crypto").webcrypto;
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const EventEmitter = require("events");
const path = require("path");
const fs = require("fs");

const logger = pino({ level: "silent" }); // Suppress baileys logs

// ══════════════════════════════════════════════════════════════════════════
// Single WhatsApp Client (Baileys)
// ══════════════════════════════════════════════════════════════════════════

class WhatsAppClient extends EventEmitter {
  constructor(id, phoneLabel) {
    super();
    this.id = id;
    this.phoneLabel = phoneLabel;
    this.sock = null;
    this.ready = false;
    this.qrCode = null;
    this.pairingCode = null;
    this.otpStore = [];
    this.OTP_EXPIRY = 5 * 60 * 1000;
    this.authDir = path.join(process.cwd(), `baileys-auth-${id}`);
    this.reconnectAttempts = 0;
    this.maxReconnects = 5;
  }

  async initialize(usePairingCode = false, pairingPhone = null) {
    console.log(`[WA:${this.id}] Initializing (${this.phoneLabel})...`);

    // Ensure auth directory exists
    if (!fs.existsSync(this.authDir)) fs.mkdirSync(this.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this._isRegistered = !!state.creds.registered;
    this._usePairingCode = usePairingCode;
    this._pairingPhone = pairingPhone;

    console.log(`[WA:${this.id}] Registered: ${this._isRegistered}, PairingCode: ${usePairingCode}`);

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: ["Diaa-GPT-Pay", "Chrome", "1.0.0"],
      generateHighQualityLinkPreview: false,
    });

    // Register ALL event listeners FIRST
    this.sock.ev.on("creds.update", saveCreds);

    // Connection updates
    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // When QR appears → socket is ready for auth
      if (qr && this._usePairingCode && this._pairingPhone && !this._isRegistered && !this.pairingCode) {
        // Request pairing code INSTEAD of QR scan
        console.log(`[WA:${this.id}] QR received — requesting pairing code instead...`);
        try {
          const code = await this.sock.requestPairingCode(this._pairingPhone);
          this.pairingCode = code;
          console.log(`[WA:${this.id}] 🔗 PAIRING CODE: ${code}`);
          console.log(`[WA:${this.id}] Enter on WhatsApp → Linked Devices → Link with phone number`);
          this.emit("pairing_code", code);
        } catch (err) {
          console.error(`[WA:${this.id}] ❌ Pairing error:`, err.message);
        }
      } else if (qr && !this._usePairingCode) {
        this.qrCode = qr;
        console.log(`[WA:${this.id}] QR Code available — scan it`);
        this.emit("qr", qr);
      }

      if (connection === "open") {
        this.ready = true;
        this.qrCode = null;
        this.pairingCode = null;
        this.reconnectAttempts = 0;
        this._isRegistered = true;
        console.log(`[WA:${this.id}] ✅ Connected! (${this.phoneLabel})`);
        this.emit("ready");
      }

      if (connection === "close") {
        this.ready = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `[WA:${this.id}] Disconnected (code: ${statusCode})`,
          shouldReconnect ? "— will reconnect" : "— logged out"
        );

        if (shouldReconnect && this._isRegistered && this.reconnectAttempts < this.maxReconnects) {
          this.reconnectAttempts++;
          console.log(`[WA:${this.id}] Reconnecting in 5s... (attempt ${this.reconnectAttempts})`);
          setTimeout(() => this.initialize(false), 5000);
        } else if (!this._isRegistered) {
          console.log(`[WA:${this.id}] Fresh session — waiting for pairing/QR. No auto-reconnect.`);
        }
      }
    });

    // ── MESSAGE LISTENER — catches ALL messages including business ──
    this.sock.ev.on("messages.upsert", ({ messages, type }) => {
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const text = this._extractText(msg);
        const from = msg.key.remoteJid || "";

        if (text) {
          console.log(`[WA:${this.id}] 📩 ${from}: ${text.substring(0, 80)}`);

          const otpMatch = text.match(/\b(\d{4,6})\b/);
          if (otpMatch) {
            const otp = {
              code: otpMatch[1], from,
              body: text.substring(0, 200),
              timestamp: Date.now(), clientId: this.id,
            };
            console.log(`[WA:${this.id}] 🔑 OTP: ${otp.code}`);
            this.otpStore.unshift(otp);
            if (this.otpStore.length > 20) this.otpStore.length = 20;
            this.emit("otp", otp);
          }
        }
      }
    });
  }

  // Extract text from ANY message type (regular, template, button, etc.)
  _extractText(msg) {
    const m = msg.message;
    if (!m) return "";

    // Regular text
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;

    // Template messages (business accounts like GoPay)
    if (m.templateMessage?.hydratedTemplate?.hydratedContentText) {
      return m.templateMessage.hydratedTemplate.hydratedContentText;
    }
    if (m.templateMessage?.hydratedFourRowTemplate?.hydratedContentText) {
      return m.templateMessage.hydratedFourRowTemplate.hydratedContentText;
    }

    // Button messages
    if (m.buttonsResponseMessage?.selectedDisplayText) {
      return m.buttonsResponseMessage.selectedDisplayText;
    }
    if (m.templateButtonReplyMessage?.selectedDisplayText) {
      return m.templateButtonReplyMessage.selectedDisplayText;
    }

    // High structured message (newer templates)
    if (m.highlyStructuredMessage?.hydratedHsm?.hydratedTemplate?.hydratedContentText) {
      return m.highlyStructuredMessage.hydratedHsm.hydratedTemplate.hydratedContentText;
    }

    // Interactive messages
    if (m.interactiveMessage?.body?.text) return m.interactiveMessage.body.text;

    // Document / media with caption
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    if (m.documentMessage?.caption) return m.documentMessage.caption;

    // List messages
    if (m.listMessage?.description) return m.listMessage.description;

    // Fallback: try to stringify and find OTP pattern
    try {
      const raw = JSON.stringify(m);
      const otpInRaw = raw.match(/(\d{4,6}) is your verification/i);
      if (otpInRaw) return otpInRaw[0];
    } catch {}

    return "";
  }

  // Wait for OTP with timeout
  async waitForOTP(timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const cleanup = () => {
        resolved = true;
        clearTimeout(timeout);
        this.removeListener("otp", handler);
      };

      const timeout = setTimeout(() => {
        if (!resolved) { cleanup(); reject(new Error("OTP timeout")); }
      }, timeoutMs);

      const handler = (otp) => {
        if (!resolved) { cleanup(); resolve(otp); }
      };
      this.once("otp", handler);
    });
  }

  getStatus() {
    return {
      id: this.id,
      phone: this.phoneLabel,
      ready: this.ready,
      hasQR: !!this.qrCode,
      pairingCode: this.pairingCode,
      otpCount: this.otpStore.length,
      latestOTP: this.otpStore[0] || null,
    };
  }

  async logout() {
    try {
      if (this.sock) await this.sock.logout();
      this.ready = false;
    } catch {}
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Multi-Client Manager
// ══════════════════════════════════════════════════════════════════════════

class WhatsAppManager extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map();
  }

  async addClient(id, phoneLabel, usePairingCode = false, pairingPhone = null) {
    if (this.clients.has(id)) {
      const existing = this.clients.get(id);
      if (existing.ready) {
        console.log(`[WAManager] Client ${id} already connected`);
        return existing;
      }
    }

    const client = new WhatsAppClient(id, phoneLabel);
    client.on("otp", (otp) => this.emit("otp", otp));
    this.clients.set(id, client);

    await client.initialize(usePairingCode, pairingPhone);
    return client;
  }

  getClient(id) {
    return this.clients.get(id);
  }

  getAnyReadyClient() {
    for (const [, client] of this.clients) {
      if (client.ready) return client;
    }
    return null;
  }

  async waitForOTP(clientId, timeoutMs = 60000) {
    const client = this.clients.get(clientId);
    if (client?.ready) return client.waitForOTP(timeoutMs);
    return this.waitForOTPAny(timeoutMs);
  }

  async waitForOTPAny(timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener("otp", handler);
        reject(new Error("OTP timeout"));
      }, timeoutMs);
      const handler = (otp) => { clearTimeout(timeout); resolve(otp); };
      this.once("otp", handler);
    });
  }

  getStatus() {
    const statuses = [];
    for (const [, client] of this.clients) statuses.push(client.getStatus());
    return {
      clientCount: this.clients.size,
      clients: statuses,
      anyReady: !!this.getAnyReadyClient(),
    };
  }

  getQRImage(clientId) {
    return this.clients.get(clientId)?.qrCode || null;
  }
}

// ── Singleton + backward compatibility ──────────────────────────────────

const manager = new WhatsAppManager();

module.exports = {
  manager,
  initialize: () => manager.addClient("wa_0", "primary"),
  waitForOTP: (timeout) => manager.waitForOTPAny(timeout),
  getStatus: () => {
    const s = manager.getStatus();
    return { ready: s.anyReady, ...s };
  },
  getQRImage: (id) => manager.getQRImage(id || "wa_0"),
  getClient: (id) => manager.getClient(id),
  addClient: (id, phone, usePairing, pairingPhone) =>
    manager.addClient(id, phone, usePairing, pairingPhone),
};
