"use strict";
/**
 * AI STV VM Bot (Zalo) — JSON storage (users, vms, blacklist, meta)
 * Giong tham mat data cua bot Discord cu (users.json / vms.json / blacklist.json / meta.json).
 */
const fs = require("fs");
const path = require("path");

class JsonStore {
  constructor(filePath, defaultValue) {
    this.path = filePath;
    this.defaultValue = defaultValue;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) this.writeSync(defaultValue);
  }

  readSync() {
    try {
      return JSON.parse(fs.readFileSync(this.path, "utf-8"));
    } catch {
      return JSON.parse(JSON.stringify(this.defaultValue));
    }
  }

  writeSync(data) {
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, this.path);
  }

  load() {
    return this.readSync();
  }

  save(data) {
    this.writeSync(data);
  }
}

class Store {
  constructor(dataDir) {
    const dir = dataDir || path.join(__dirname, "..", "vm_bot_data");
    this.users = new JsonStore(path.join(dir, "users.json"), {});
    this.vms = new JsonStore(path.join(dir, "vms.json"), {});
    this.blacklist = new JsonStore(path.join(dir, "blacklist.json"), []);
    this.meta = new JsonStore(path.join(dir, "meta.json"), {});
  }

  getVM(userId) {
    const data = this.vms.load();
    return data[String(userId)] || null;
  }

  setVM(rec) {
    const data = this.vms.load();
    data[String(rec.userId)] = rec;
    this.vms.save(data);
  }

  deleteVM(userId) {
    const data = this.vms.load();
    delete data[String(userId)];
    this.vms.save(data);
  }

  allVMs() {
    const data = this.vms.load();
    return Object.values(data).filter((v) => v && typeof v === "object");
  }

  getMeta() {
    return this.meta.load() || {};
  }

  setMeta(patch) {
    const data = this.meta.load() || {};
    const merged = { ...data, ...patch };
    this.meta.save(merged);
    return merged;
  }
}

module.exports = { Store, JsonStore };
