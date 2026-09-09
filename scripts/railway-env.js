"use strict";
/**
 * In cac bien moi truong can paste vao Railway (lay tu bot_config.json local).
 * Dung: node scripts/railway-env.js
 * Chi chay o may local — KHONG commit output len GitHub.
 */
const fs = require("fs");
const path = require("path");

const cfgPath = path.join(__dirname, "..", "bot_config.json");
if (!fs.existsSync(cfgPath)) {
  console.error("Khong tim thay bot_config.json o goc du an.");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));

const vars = {
  ZALO_IMEI: cfg.zalo_imei || "",
  ZALO_COOKIE: JSON.stringify(cfg.zalo_cookie || {}),
  ZALO_USER_AGENT: cfg.zalo_user_agent || "",
  ADMIN_GITHUB_TOKEN: cfg.admin_github_token || "",
  ADMIN_TAILSCALE_KEY: cfg.admin_tailscale_key || "",
};

console.log("=== Copy cac bien sau vao Railway > Variables ===\n");
for (const [k, v] of Object.entries(vars)) {
  if (!v) {
    console.log(`# ${k}: (thieu trong bot_config.json!)`);
  } else {
    console.log(`${k}=${v}`);
  }
}
console.log("\n=== Luu y ===");
console.log("# BOT_WEBHOOK_URL khong can dat — bot tu lay tu RAILWAY_PUBLIC_DOMAIN.");
console.log("# ZALO_COOKIE phai la mot dong JSON duy nhat (da duoc escape san o tren).");
