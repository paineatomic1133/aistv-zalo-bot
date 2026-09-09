"use strict";
/**
 * AI STV VM Bot (Zalo) — GitHub API client
 * Quan ly repo worker co dinh: tao repo, day workflow + script + secret,
 * dispatch repository_dispatch de bat dau phien VM, poll/cancel runs.
 */
const https = require("https");
const { config } = require("./config");

const WORKFLOW_FILENAME = "rdp.yml";
const WORKFLOW_PATH = ".github/workflows/rdp.yml";
const WORKFLOW_VERSION = 5;
const GITHUB_RETRY_MAX = 4;
const GITHUB_RETRY_BASE_SEC = 1.5;
const USER_AGENT = "AISTV-VM-Bot/1.0";

const WORKFLOW_NAME = "AI STV Windows VM";
const BRAND_NAME = "AI STV";
const VM_WINDOWS_USER = "AISTV";
const TAILSCALE_HOSTNAME = "STV-VM";

function ghRequest(method, pathOrUrl, token, body = null) {
  let hostname = "api.github.com";
  let reqPath = pathOrUrl;
  if (pathOrUrl.startsWith("http")) {
    const u = new URL(pathOrUrl);
    hostname = u.hostname;
    reqPath = `${u.pathname}${u.search}`;
  } else if (!pathOrUrl.startsWith("/")) {
    reqPath = `/${pathOrUrl}`;
  }
  return new Promise((resolve, reject) => https.request(
    {
      hostname,
      path: reqPath,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Length": body ? Buffer.byteLength(JSON.stringify(body)) : 0,
      },
    },
    (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        res.buffer = buffer; // giu binary cho artifact zip
        const text = buffer.toString("utf-8");
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = { raw: text };
        }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    }
  ).on("error", reject));
}

class GitHubClient {
  constructor(token, repo, owner = "") {
    this.token = token;
    this.repo = repo;
    this.owner = owner;
  }

  async _req(method, path, body = null) {
    let lastErr = null;
    for (let attempt = 1; attempt <= GITHUB_RETRY_MAX; attempt += 1) {
      try {
        const res = await ghRequest(method, path, this.token, body);
        if (res.status >= 200 && res.status < 300) return res.data;
        // 422 "already exists" coi nhu thanh cong (idempotent)
        if (res.status === 422 && JSON.stringify(res.data).toLowerCase().includes("already exists")) {
          return { exists: true };
        }
        const err = new Error(`GitHub API ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
        err.status = res.status;
        err.data = res.data;
        // Retry 5xx + 403 SecondaryRateLimit; 401/404 khong retry
        if (res.status >= 500 || (res.status === 403 && JSON.stringify(res.data).toLowerCase().includes("secondary"))) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, GITHUB_RETRY_BASE_SEC * 2 ** (attempt - 1) * 1000));
          continue;
        }
        throw err;
      } catch (err) {
        if (err.status) throw err;
        lastErr = err;
        await new Promise((r) => setTimeout(r, GITHUB_RETRY_BASE_SEC * 2 ** (attempt - 1) * 1000));
      }
    }
    throw lastErr || new Error("GitHub API unknown error");
  }

  async getAuthenticatedUser() {
    return this._req("GET", "/user");
  }

  async repoExists(owner, repo) {
    try {
      await this._req("GET", `/repos/${owner}/${repo}`);
      return true;
    } catch (err) {
      if (err.status === 404) return false;
      throw err;
    }
  }

  async createRepo(owner, repo) {
    return this._req("POST", "/user/repos", { name: repo, private: false, auto_init: true });
  }

  async enableActions(owner, repo) {
    try {
      return await this._req("PUT", `/repos/${owner}/${repo}/actions/permissions`, { enabled: true, allowed_actions: "all" });
    } catch (err) {
      console.warn("[github] enableActions:", err.message);
      return null;
    }
  }

  async putFile(owner, repo, pathInRepo, content, message) {
    const encoded = Buffer.from(content, "utf-8").toString("base64");
    let sha = null;
    try {
      const existing = await this._req("GET", `/repos/${owner}/${repo}/contents/${pathInRepo}`);
      sha = existing.sha;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const body = { message, content: encoded };
    if (sha) body.sha = sha;
    return this._req("PUT", `/repos/${owner}/${repo}/contents/${pathInRepo}`, body);
  }

  async upsertSecret(owner, repo, name, value) {
    const keyData = await this._req("GET", `/repos/${owner}/${repo}/actions/secrets/public-key`);
    const crypto = require("crypto");
    const publicKey = crypto.createPublicKey({ key: keyData.key, format: "pem" });
    const encrypted = crypto.publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(value, "utf-8")
    ).toString("base64");
    return this._req("PUT", `/repos/${owner}/${repo}/actions/secrets/${name}`, {
      encrypted_value: encrypted,
      key_id: keyData.key_id,
    });
  }

  async dispatchRepositoryEvent(owner, repo, eventType, payload) {
    return this._req("POST", `/repos/${owner}/${repo}/dispatches`, {
      event_type: eventType,
      client_payload: payload,
    });
  }

  async listRuns(owner, repo, workflowFile) {
    try {
      const data = await this._req("GET", `/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=10`);
      return data.workflow_runs || [];
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  }

  async cancelRun(owner, repo, runId) {
    try {
      await this._req("POST", `/repos/${owner}/${repo}/actions/runs/${runId}/cancel`);
      return true;
    } catch (err) {
      console.warn("[github] cancelRun:", err.message);
      return false;
    }
  }

  async deleteArtifact(owner, repo, artifactId) {
    try {
      await this._req("DELETE", `/repos/${owner}/${repo}/actions/artifacts/${artifactId}`);
      return true;
    } catch {
      return false;
    }
  }

  async listRunArtifacts(owner, repo, runId) {
    try {
      const data = await this._req("GET", `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=50`);
      return data.artifacts || [];
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  }

  /** Tai artifact zip (vm-creds.json) va tra ve JSON ben trong. */
  async downloadArtifactJson(owner, repo, artifactId) {
    const res = await ghRequest(
      "GET",
      `/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`,
      this.token
    );
    if (res.status !== 200 || !res.buffer) return null;
    const AdmZip = require("adm-zip");
    const zip = new AdmZip(res.buffer);
    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.entryName.endsWith("vm-creds.json")) {
        try {
          return JSON.parse(entry.getData().toString("utf-8"));
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}

function readTemplate(relPath) {
  const fs = require("fs");
  const path = require("path");
  return fs.readFileSync(path.join(__dirname, "..", "worker_templates", relPath), "utf-8");
}

/**
 * Dam bao repo worker co dinh san sang: tao repo neu chua co, day workflow +
 * scripts + secrets + README. Idempotent — chi day lai khi version doi.
 */
async function ensureWorkerRepo(gh, store, meta) {
  if (!gh.token) throw new Error("ADMIN_GITHUB_TOKEN chua cau hinh");
  if (meta.get("repoReady") === gh.repo && meta.get("repoOwner") === gh.owner && meta.get("repoVersion") === WORKFLOW_VERSION) {
    return;
  }
  if (!(await gh.repoExists(gh.owner, gh.repo))) {
    await gh.createRepo(gh.owner, gh.repo);
    await new Promise((r) => setTimeout(r, 2000));
  }
  await gh.enableActions(gh.owner, gh.repo);

  await gh.putFile(gh.owner, gh.repo, WORKFLOW_PATH, readTemplate("rdp.yml"), "Add Windows VM workflow");
  await gh.putFile(gh.owner, gh.repo, "scripts/provision.ps1", readTemplate("scripts/provision.ps1"), "Add provision script");
  await gh.putFile(gh.owner, gh.repo, "scripts/keepalive.ps1", readTemplate("scripts/keepalive.ps1"), "Add keep-alive script");

  if (config.adminTailscaleKey) {
    await gh.upsertSecret(gh.owner, gh.repo, "TAILSCALE_AUTH_KEY", config.adminTailscaleKey.trim());
  }
  if (config.botWebhookUrl) {
    await gh.upsertSecret(gh.owner, gh.repo, "BOT_WEBHOOK_URL", config.botWebhookUrl.trim());
  }
  if (config.botWebhookSecret) {
    await gh.upsertSecret(gh.owner, gh.repo, "BOT_WEBHOOK_SECRET", config.botWebhookSecret.trim());
  }

  await gh.putFile(
    gh.owner,
    gh.repo,
    "README.md",
    `# ${BRAND_NAME} VM Worker (Zalo)\n\nGitHub Actions workers for temporary Windows VM sessions.\nTriggered via repository_dispatch "start-vm" with a matrix + duration client payload.\nAll setup scripts are plain-text and live in scripts/.\n`,
    "Add README.md"
  );

  meta.set({ repoReady: gh.repo, repoOwner: gh.owner, repoVersion: WORKFLOW_VERSION });
}

module.exports = {
  GitHubClient,
  ensureWorkerRepo,
  readTemplate,
  WORKFLOW_FILENAME,
  WORKFLOW_PATH,
  WORKFLOW_VERSION,
  WORKFLOW_NAME,
  BRAND_NAME,
  VM_WINDOWS_USER,
  TAILSCALE_HOSTNAME,
};
