"use strict";
/**
 * AI STV VM Bot (Zalo) — Config loader
 * Doc tu bot_config.json + bien moi truong (env override file).
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname.startsWith("") ? path.resolve(__dirname, "..") : process.cwd();
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(ROOT, "bot_config.json");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "vm_bot_data");

function readConfigFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch (err) {
    console.warn("[config] Khong doc duoc bot_config.json:", err.message);
  }
  return {};
}

const file = readConfigFile();

function env(name, fallback = "") {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : fallback;
}

/**
 * Zca-js nhan cookie la mang cac object cookie (dang J2TEAM/Cookie-Editor export).
 * Ho tro luon dang object phang { zi: "...", zpsid: "..." } de tien loi:
 * quy doi tu dong sang mang cookie voi domain .zalo.me.
 */
function normalizeZaloCookie(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      return normalizeZaloCookie(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  if (typeof raw === "object") {
    return Object.entries(raw).map(([name, value]) => ({
      name,
      key: name,
      value: String(value),
      domain: "zalo.me",
      path: "/",
      hostOnly: false,
      secure: true,
      httpOnly: false,
      session: true,
      sameSite: "no_restriction",
    }));
  }
  return [];
}

const zaloCookie = env("ZALO_COOKIE") || file.zalo_cookie || file.zalo_cookies || null;
const zaloImei = env("ZALO_IMEI", String(file.zalo_imei || ""));
const zaloUserAgent = env("ZALO_USER_AGENT", String(file.zalo_user_agent || ""));

const config = {
  // Zalo credentials (bat buoc)
  zalo: {
    imei: zaloImei,
    cookie: normalizeZaloCookie(zaloCookie),
    cookieRaw: zaloCookie,
    userAgent: zaloUserAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  // GitHub admin (token tap trung, nguoi dung khong can nhap gi)
  adminGithubToken: env("ADMIN_GITHUB_TOKEN", String(file.admin_github_token || "")),
  workflowRepo: env("GITHUB_REPO", String(file.github_repo || "aistv-vm-worker")),
  workflowOwner: env("GITHUB_OWNER", String(file.github_owner || "")),
  adminTailscaleKey: env("ADMIN_TAILSCALE_KEY", String(file.admin_tailscale_key || "")),
  // Webhook nhan creds tu GitHub Actions
  botWebhookUrl: env("BOT_WEBHOOK_URL", String(file.bot_webhook_url || "")),
  botWebhookSecret: env("BOT_WEBHOOK_SECRET", String(file.bot_webhook_secret || "")),
  port: parseInt(env("PORT", "8080"), 10) || 8080,
  // Admin Zalo (duy tri tuong thuat du lieu cu: admin_ids dung chung cho Discord/Zalo)
  adminZaloIds: (Array.isArray(file.admin_zalo_ids) && file.admin_zalo_ids.length
    ? file.admin_zalo_ids
    : (file.admin_ids || [])
  ).map((x) => String(x)),
  ownerZaloId: String(file.owner_zalo_id || file.owner_id || ""),
  // Gioi han tao VM
  defaultDuration: parseInt(env("DEFAULT_DURATION", String(file.default_duration || "60")), 10) || 60,
  maxDuration: parseInt(env("MAX_DURATION", String(file.max_duration || "355")), 10) || 355,
  maxMachines: parseInt(env("MAX_MACHINES", String(file.max_machines || "5")), 10) || 5,
};

config.adminZaloIds = Array.from(new Set([config.ownerZaloId, ...config.adminZaloIds].filter(Boolean)));

function isConfigValid() {
  return Boolean(config.zalo.imei && config.zalo.cookie.length && config.zalo.userAgent);
}

module.exports = {
  ROOT,
  CONFIG_FILE,
  DATA_DIR,
  config,
  isConfigValid,
  normalizeZaloCookie,
};
