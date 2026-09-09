"use strict";
/**
 * AI STV VM Bot — Zalo (tai khoan ca nhan, dang nhap bang IMEI + cookie)
 *
 * Chuc nang:
 *  - tvm [so_phut] [so_may] : tao Windows VM tam thoi qua GitHub Actions,
 *    khi may san sang -> gui thong tin dang nhap vao dung nhom da go lenh.
 *  - idnhom  : lay ID nhom hien tai.
 *  - myid    : lay ID Zalo cua ban.
 *  - huongdan: huong dan su dung.
 *
 * Bot khong hoat dong trong nhom khong co ID nhom (moi lenh deu gan threadId).
 */
const http = require("http");
const { Zalo, ThreadType } = require("zca-js");
const { config, isConfigValid, DATA_DIR } = require("./src/config");
const { Store } = require("./src/store");
const {
  GitHubClient,
  ensureWorkerRepo,
  WORKFLOW_FILENAME,
  BRAND_NAME,
} = require("./src/github");

const store = new Store(DATA_DIR);

// ── Helpers ──────────────────────────────────────────────────────────

const VN_OFFSET_MIN = 7 * 60;

function toVnDate(d) {
  return new Date(d.getTime() + VN_OFFSET_MIN * 60 * 1000);
}

function fmtVn(d) {
  const x = toVnDate(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(x.getDate())}/${p(x.getMonth() + 1)}/${x.getFullYear()} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

function fmtDuration(mins) {
  if (mins < 60) return `${mins} phút`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} giờ${m ? ` ${m}p` : ""}`;
}

function fmtRemaining(expiresAt) {
  const delta = new Date(expiresAt).getTime() - Date.now();
  if (delta <= 0) return "Đã hết hạn";
  const mins = Math.floor(delta / 60000);
  const secs = Math.floor((delta % 60000) / 1000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m còn lại`;
  if (mins > 0) return `${mins}m ${secs}s còn lại`;
  return `${secs}s còn lại`;
}

function maskSecret(value, visible = 3) {
  if (!value) return "(empty)";
  if (value.length <= visible * 2) return "***";
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

function safeErrorText(err) {
  let text = err && err.message ? err.message : String(err);
  const patterns = [
    /ghp_[A-Za-z0-9_]{20,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /tskey-[A-Za-z0-9_-]+/g,
    /Bearer\s+[A-Za-z0-9._-]+/g,
  ];
  for (const pat of patterns) text = text.replace(pat, "***REDACTED***");
  return text.slice(-1200);
}

function isActive(status) {
  return ["starting", "running", "stopping"].includes(status);
}

function isBlacklisted(userId) {
  const bl = store.blacklist.load();
  const list = Array.isArray(bl) ? bl : Object.keys(bl || {});
  const entry = list.find((e) => {
    if (typeof e === "string") return e === String(userId);
    if (e && typeof e === "object") return String(e.id || e.user_id) === String(userId);
    return false;
  });
  if (!entry) return false;
  if (typeof entry === "object" && entry.until) {
    if (new Date(entry.until).getTime() <= Date.now()) return false; // het han -> bo qua
  }
  return true;
}

// ── VM records ───────────────────────────────────────────────────────

function newVMRecord({ userId, senderName, threadId, threadType, duration, machineCount, runId }) {
  const now = new Date();
  return {
    userId: String(userId),
    senderName,
    threadId: String(threadId),
    threadType: Number(threadType),
    kind: "windows",
    runId,
    repo: config.workflowRepo,
    status: "starting",
    durationMinutes: duration,
    machineCount,
    instances: Array.from({ length: machineCount }, (_, i) => ({
      instanceId: String(i + 1),
      runId,
      status: "starting",
      ip: "",
      hostname: "",
      username: "",
      password: "",
    })),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + duration * 60000).toISOString(),
    notifiedMilestones: [],
    expired: false,
  };
}

function vmHasAllCreds(vm) {
  return (vm.instances || []).every((i) => (i.password || "").trim());
}

function vmFirstReady(vm) {
  return (vm.instances || []).find((i) => (i.password || "").trim());
}

// ── Zalo messaging ───────────────────────────────────────────────────

let zaloApi = null;

async function zaloSend(threadId, threadType, text) {
  if (!zaloApi) return;
  try {
    await zaloApi.sendMessage(text, String(threadId), Number(threadType));
  } catch (err) {
    console.error(`[zalo] Gui tin that bai thread=${threadId}:`, safeErrorText(err));
  }
}

// ── VM creation flow ─────────────────────────────────────────────────

const creatingSet = new Set();
let gh = null;
let ghOwner = "";

async function resolveGhOwner() {
  if (config.workflowOwner) {
    ghOwner = config.workflowOwner;
  } else {
    const meta = store.getMeta();
    if (meta.adminLogin) {
      ghOwner = meta.adminLogin;
    } else {
      const me = await gh.getAuthenticatedUser();
      ghOwner = me.login;
      store.setMeta({ adminLogin: ghOwner });
    }
  }
  gh.owner = ghOwner; // dong bo vao client de ensureWorkerRepo su dung
  return ghOwner;
}

async function waitForNewRunId(workflowFile, dispatchTime, timeoutSec = 300) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const knownUsed = new Set(store.allVMs().map((v) => String(v.runId)));
    const runs = await gh.listRuns(ghOwner, config.workflowRepo, workflowFile);
    for (const r of runs) {
      if (knownUsed.has(String(r.id))) continue;
      const created = r.created_at ? new Date(r.created_at).getTime() : 0;
      if (created && created >= dispatchTime.getTime() - 15000) return r.id;
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  return null;
}

async function createVM({ userId, senderName, threadId, threadType, duration, machineCount }) {
  const lockKey = String(userId);
  if (creatingSet.has(lockKey)) {
    await zaloSend(threadId, threadType, "⏳ Bạn đang có lệnh tạo máy đang xử lý, vui lòng đợi xong rồi thử lại.");
    return;
  }
  creatingSet.add(lockKey);
  try {
    const existing = store.getVM(userId);
    if (existing && isActive(existing.status) && !existing.expired) {
      await zaloSend(
        threadId,
        threadType,
        `⚠️ Bạn còn phiên máy đang chạy (run \`${existing.runId}\`, ${fmtRemaining(existing.expiresAt)}).\nHãy chờ hết hạn hoặc dùng máy hiện tại trước khi tạo mới.`
      );
      return;
    }

    await zaloSend(
      threadId,
      threadType,
      `🔧 ${BRAND_NAME} — đang khởi tạo **${machineCount}** máy Windows trong **${fmtDuration(duration)}**...\nVui lòng đợi 3–8 phút để máy được cấu hình.`
    );

    if (!ghOwner) ghOwner = await resolveGhOwner();
    await ensureWorkerRepo(gh, store, {
      get: (k) => store.getMeta()[k],
      set: (patch) => store.setMeta(patch),
    });

    const matrix = Array.from({ length: machineCount }, (_, i) => ({
      instance_id: i + 1,
      runner: "windows-latest",
    }));
    const dispatchTime = new Date();
    await gh.dispatchRepositoryEvent(ghOwner, config.workflowRepo, "start-vm", {
      matrix,
      duration,
      session: String(userId),
    });

    const runId = await waitForNewRunId(WORKFLOW_FILENAME, dispatchTime);
    if (!runId) {
      await zaloSend(threadId, threadType, "❌ Quá thời gian chờ — không khởi động được máy. Vui lòng thử lại sau.");
      return;
    }

    const vm = newVMRecord({ userId, senderName, threadId, threadType, duration, machineCount, runId });
    store.setVM(vm);

    const expiresTxt = fmtVn(new Date(vm.expiresAt));
    await zaloSend(
      threadId,
      threadType,
      `✅ Đã gửi lệnh tạo máy!\n`
        + `🆔 Phiên: \`${runId}\`\n`
        + `🖥 Số máy: **${machineCount}**\n`
        + `⏱ Thời hạn: **${fmtDuration(duration)}** (hết lúc ${expiresTxt})\n\n`
        + `ℹ️ Thông tin đăng nhập sẽ được gửi ngay vào nhóm này khi máy sẵn sàng.`
    );
    console.log(`[vm] Da tao phien run=${runId} user=${userId} group=${threadId} duration=${duration}p`);
  } catch (err) {
    console.error("[vm] Loi tao may:", safeErrorText(err));
    await zaloSend(threadId, threadType, `❌ Lỗi khi tạo máy: ${safeErrorText(err)}`);
  } finally {
    creatingSet.delete(lockKey);
  }
}

// ── Webhook: nhan creds tu GitHub Actions ────────────────────────────

function applyCreds(vm, inst, data) {
  inst.status = "running";
  if (data.ip) inst.ip = String(data.ip);
  if (data.hostname) inst.hostname = String(data.hostname);
  if (data.username) inst.username = String(data.username);
  if (data.password) inst.password = String(data.password);

  if (vmHasAllCreds(vm)) vm.status = "running";
  // Bat dong ho het han tu luc may that su san sang
  if (!vm.credsReadyAt) {
    vm.credsReadyAt = new Date().toISOString();
    vm.expiresAt = new Date(Date.now() + vm.durationMinutes * 60000).toISOString();
  }
}

async function deliverReadyIfNeeded(vm, inst) {
  if (!vm.readyNotified) {
    vm.readyNotified = true;
    store.setVM(vm);
    await notifyVmReady(vm, inst);
    return true;
  }
  return false;
}

async function handleVmReady(data) {
  const userId = String(data.discord_id || data.user_id || "").trim();
  const runIdStr = String(data.run_id || "").trim();
  const instanceId = String(data.instance_id || "1").trim();
  const vm = store.getVM(userId);
  if (!vm || !vm.runId) return false;
  if (runIdStr && String(vm.runId) !== runIdStr) return false;

  const inst = (vm.instances || []).find((i) => String(i.instanceId) === instanceId)
    || (vm.instances || [])[0];
  if (!inst) return false;

  applyCreds(vm, inst, data);
  store.setVM(vm);
  await deliverReadyIfNeeded(vm, inst);
  console.log(`[webhook] vm-ready user=${userId} instance=${instanceId} run=${vm.runId}`);
  return true;
}

/**
 * Fallback khi BOT_WEBHOOK_URL chua cau hinh (bot chay local):
 * poll artifact vm-creds.json cua run tren GitHub.
 */
async function pollArtifactsForVm(vm) {
  if (!vm.runId) return false;
  if (vmHasAllCreds(vm)) return false;
  const age = Date.now() - new Date(vm.createdAt).getTime();
  if (age < 2 * 60000 || age > 30 * 60000) return false; // doi 2 phut, bo qua qua 30 phut
  const lastCheck = vm.lastArtifactCheck ? new Date(vm.lastArtifactCheck).getTime() : 0;
  if (Date.now() - lastCheck < 30000) return false; // toi da 1 lan/30 giay
  vm.lastArtifactCheck = new Date().toISOString();
  store.setVM(vm);
  try {
    const artifacts = await gh.listRunArtifacts(ghOwner, config.workflowRepo, vm.runId);
    for (const art of artifacts) {
      if (!String(art.name || "").startsWith("aistv-creds-")) continue;
      const creds = await gh.downloadArtifactJson(ghOwner, config.workflowRepo, art.id);
      if (!creds) continue;
      const instanceId = String(creds.instance_id || "1");
      const inst = (vm.instances || []).find((i) => String(i.instanceId) === instanceId)
        || (vm.instances || [])[0];
      if (!inst) continue;
      if ((inst.password || "").trim()) continue;
      applyCreds(vm, inst, creds);
      store.setVM(vm);
      await deliverReadyIfNeeded(vm, inst);
      console.log(`[artifact] Lay creds cho user=${vm.userId} instance=${instanceId} run=${vm.runId}`);
      return true;
    }
  } catch (err) {
    console.warn("[artifact] Poll loi:", safeErrorText(err));
  }
  return false;
}

async function notifyVmReady(vm, inst) {
  const lines = [
    `🟢 ${BRAND_NAME} — MÁY CỦA BẠN ĐÃ SẴN SÀNG!`,
    ``,
    `🌐 IP (Tailscale): \`${inst.ip || "pending"}\``,
    `🖥 Hostname: \`${inst.hostname || "—"}\``,
    `👤 Username: \`${inst.username || "AISTV"}\``,
    `🔑 Password: \`${inst.password || "—"}\``,
    ``,
    `📡 Kết nối Remote Desktop (mstsc) với IP trên.`,
    `🆔 Phiên: \`${vm.runId}\``,
    `⌛ Hết hạn: ${fmtVn(new Date(vm.expiresAt))} (${fmtRemaining(vm.expiresAt)})`,
    `🗑 Tạo máy mới: \`tvm\``,
  ];
  await zaloSend(vm.threadId, vm.threadType, lines.join("\n"));
}

// ── Monitor: warning + expiry ────────────────────────────────────────

const MILESTONES = [30, 15, 5];

async function monitorLoop() {
  const vms = store.allVMs();
  for (const vm of vms) {
    if (!isActive(vm.status) || vm.expired) continue;
    const remainingMs = new Date(vm.expiresAt).getTime() - Date.now();
    if (remainingMs <= 0) {
      await expireVM(vm);
      continue;
    }
    await pollArtifactsForVm(vm).catch(() => {});
    const minsLeft = Math.floor(remainingMs / 60000);
    for (const m of MILESTONES) {
      if (minsLeft <= m && !(vm.notifiedMilestones || []).includes(m)) {
        vm.notifiedMilestones = [...(vm.notifiedMilestones || []), m];
        store.setVM(vm);
        const icon = m < 10 ? "⚠️" : "⏰";
        await zaloSend(
          vm.threadId,
          vm.threadType,
          `${icon} Máy (phiên \`${vm.runId}\`) sẽ hết hạn sau **${m} phút**.\nHãy lưu lại dữ liệu cần thiết!`
        );
        break;
      }
    }
  }
}

async function expireVM(vm) {
  vm.status = "offline";
  vm.expired = true;
  store.setVM(vm);
  if (ghOwner) {
    try {
      await gh.cancelRun(ghOwner, config.workflowRepo, vm.runId);
    } catch (err) {
      console.warn("[monitor] cancelRun:", safeErrorText(err));
    }
  }
  for (const inst of vm.instances || []) inst.status = "offline";
  store.setVM(vm);
  await zaloSend(
    vm.threadId,
    vm.threadType,
    `⌛ Phiên máy \`${vm.runId}\` đã kết thúc (${fmtDuration(vm.durationMinutes)}).\nMáy đã được gỡ khỏi hệ thống. Dùng lệnh \`tvm\` để tạo phiên mới nếu cần.`
  );
  console.log(`[monitor] Phien het han run=${vm.runId} user=${vm.userId}`);
}

// ── Command handling ─────────────────────────────────────────────────

const HELP_TEXT = [
  `🤖 ${BRAND_NAME} VM Bot — Lệnh hỗ trợ:`,
  ``,
  `• \`tvm [số_phút] [số_máy]\` — Tạo Windows VM tạm thời`,
  `   VD: \`tvm\` (60 phút, 1 máy) · \`tvm 120\` · \`tvm 120 2\``,
  `   Thời hạn: 15–355 phút · Tối đa ${config.maxMachines} máy`,
  `• \`idnhom\` — Lấy ID nhóm hiện tại`,
  `• \`myid\` — Lấy ID Zalo của bạn`,
  `• \`huongdan\` — Xem hướng dẫn này`,
].join("\n");

const RULES_TEXT = [
  `📜 LƯẬT MÁY ẢO — ${BRAND_NAME}`,
  ``,
  `1. CẤM: đào coin, DDOS/quét cổng, spam, phát tán mã độc → ban vĩnh viễn.`,
  `2. Mỗi người chỉ được **1 máy** tại một thời điểm.`,
  `3. Tối đa **355 phút/phiên**.`,
  `4. Không stop/xóa máy của người khác.`,
].join("\n");

function parseTvmArgs(text) {
  const tokens = text.trim().split(/\s+/);
  const nums = [];
  // Ho tro "tvm120" viet lien — lay so duoi lenh
  const first = (tokens[0] || "").toLowerCase();
  const inline = first.match(/^tvm(\d+)$/);
  if (inline) nums.push(parseInt(inline[1], 10));
  for (const p of tokens.slice(1)) {
    const n = parseInt(p, 10);
    if (!Number.isNaN(n)) nums.push(n);
  }
  let duration = config.defaultDuration;
  let machines = 1;
  for (const n of nums) {
    if (n > config.maxMachines) duration = n; // >5 coi la so phut
    else if (machines === 1 && duration !== config.defaultDuration) machines = n; // da co thoi gian -> so may
    else if (n >= 15) duration = n; // >=15 phut -> thoi gian
    else if (n >= 2) machines = n;  // 2..5 -> so may
  }
  duration = Math.min(Math.max(duration, 15), config.maxDuration);
  machines = Math.min(Math.max(machines, 1), config.maxMachines);
  return { duration, machines };
}

async function handleMessage(msg) {
  try {
    if (msg.isSelf) return;
    const content = msg.data && msg.data.content;
    if (typeof content !== "string") return;
    const text = content.trim();
    if (!text || !text.toLowerCase().startsWith("tvm") && !["idnhom", "myid", "huongdan", "help", "luat"].includes(text.toLowerCase())) {
      return;
    }

    const threadId = msg.threadId;
    const threadType = msg.type;
    // zca-js: khong co msg.senderID — nguoi gui nam o data.uidFrom (da duoc thay "0" = chinh minh)
    const senderId = (msg.data && msg.data.uidFrom) || "";
    const senderName = (msg.data && msg.data.dName) || String(senderId);

    if (!threadId) {
      console.warn("[cmd] Tin nhan khong co threadId — bo qua (bot khong hoat dong o day)");
      return;
    }

    const lower = text.toLowerCase();

    if (isBlacklisted(senderId)) {
      await zaloSend(threadId, threadType, "⛔ Bạn đã bị cấm sử dụng bot. Liên hệ admin nếu nghĩ đây là nhầm lẫn.");
      return;
    }

    if (lower === "idnhom" || lower === "id nhóm") {
      const label = threadType === ThreadType.Group ? "ID nhóm" : "ID cuộc trò chuyện";
      await zaloSend(threadId, threadType, `🆔 ${label}: \`${threadId}\``);
      return;
    }

    if (lower === "myid") {
      await zaloSend(threadId, threadType, `🆔 ID Zalo của bạn: \`${senderId}\``);
      return;
    }

    if (lower === "huongdan" || lower === "help") {
      await zaloSend(threadId, threadType, HELP_TEXT);
      return;
    }

    if (lower === "luat") {
      await zaloSend(threadId, threadType, RULES_TEXT);
      return;
    }

    if (lower === "tvm" || /^tvm[\s\d]/.test(lower)) {
      const { duration, machines } = parseTvmArgs(text);
      await createVM({ userId: senderId, senderName, threadId, threadType, duration, machines });
      return;
    }
  } catch (err) {
    console.error("[cmd] Loi xu ly tin nhan:", safeErrorText(err));
  }
}

// ── Webhook server ───────────────────────────────────────────────────

function startWebhookServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    if (req.method === "POST" && req.url === "/api/vm-ready") {
      if (config.botWebhookSecret && req.headers["x-bot-secret"] !== config.botWebhookSecret) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("forbidden");
        return;
      }
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 1e6) req.destroy();
      });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body || "{}");
          if (!data.password && !data.sshx_url) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ignored");
            return;
          }
          await handleVmReady(data);
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("ok");
        } catch (err) {
          console.error("[webhook] Loi xu ly:", safeErrorText(err));
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("error");
        }
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  server.listen(config.port, () => {
    console.log(`[http] Health/webhook server chay o cong ${config.port} (POST /api/vm-ready)`);
  });
  return server;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${BRAND_NAME}] Bot Zalo dang khoi dong...`);

  if (!isConfigValid()) {
    console.error(
      "[config] Thieu thong tin dang nhap Zalo!\n"
      + "  Can co: zalo_imei, zalo_cookie (mang cookie hoac object phang), zalo_user_agent trong bot_config.json\n"
      + "  Hoac bien moi truong: ZALO_IMEI, ZALO_COOKIE, ZALO_USER_AGENT"
    );
    process.exit(1);
  }
  if (!config.adminGithubToken) {
    console.error("[config] Thieu admin_github_token (ADMIN_GITHUB_TOKEN)!");
    process.exit(1);
  }

  gh = new GitHubClient(config.adminGithubToken, config.workflowRepo, config.workflowOwner);
  try {
    ghOwner = await resolveGhOwner();
    console.log(`[github] Admin: ${ghOwner} · Repo worker: ${ghOwner}/${config.workflowRepo}`);
  } catch (err) {
    // Khong thoat — bot van chay, se thu lai khi co lenh tao may
    console.warn("[github] Chua xac dinh duoc GitHub owner (se thu lai khi tao may):", safeErrorText(err));
  }

  // Dam bao repo worker san sang truoc khi lang su kien
  try {
    await ensureWorkerRepo(gh, store, {
      get: (k) => store.getMeta()[k],
      set: (patch) => store.setMeta(patch),
    });
    console.log("[github] Repo worker san sang (workflow + scripts + secrets)");
  } catch (err) {
    console.warn("[github] Setup repo worker that bai (se thu lai khi tao may):", safeErrorText(err));
  }

  // Dang nhap Zalo bang IMEI + cookie
  const zalo = new Zalo({ selfListen: false, logging: true, checkUpdate: false });
  try {
    zaloApi = await zalo.login({
      cookie: config.zalo.cookie,
      imei: config.zalo.imei,
      userAgent: config.zalo.userAgent,
    });
  } catch (err) {
    console.error("[zalo] Dang nhap that bai:", safeErrorText(err));
    console.error("[zalo] Cookie/IMEI co the da het han. Hay lay lai tu Zalo Web (F12) va cap nhat bot_config.json.");
    process.exit(1);
  }

  // zca-js: getOwnId() tra ve chuoi dong bo — Promise.resolve de an toan voi ca hai kieu
  const ownId = await Promise.resolve(zaloApi.getOwnId()).catch(() => "?");
  const profile = await zaloApi.fetchAccountInfo().catch(() => null);
  const displayName = profile && profile.profile ? profile.profile.displayName || profile.profile.name : "?";
  console.log(`[zalo] Da dang nhap: ${displayName} (ID: ${ownId})`);

  // Lang su kien tin nhan
  zaloApi.listener.on("message", handleMessage);
  zaloApi.listener.on("error", (err) => {
    console.error("[zalo] Listener error:", err && err.message ? err.message : err);
  });
  zaloApi.listener.start();
  console.log("[zalo] Listener da bat dau — bot san sang nhan lenh (tvm, idnhom, myid, huongdan)");

  // Webhook + monitor
  startWebhookServer();
  setInterval(() => {
    monitorLoop().catch((err) => console.error("[monitor] Loi:", safeErrorText(err)));
  }, 30000);

  console.log(`[${BRAND_NAME}] Bot Zalo khoi dong hoan tat. 🎉`);
}

process.on("SIGINT", () => {
  console.log("\n[shutdown] Dang tat bot...");
  process.exit(0);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? safeErrorText(reason) : reason);
});

main().catch((err) => {
  console.error("[main] Loi nghiem trong:", err);
  process.exit(1);
});
