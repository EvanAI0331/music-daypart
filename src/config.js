import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadConfig(configPath = process.env.MUSIC_WORKFLOW_CONFIG) {
  const resolved = configPath
    ? path.resolve(configPath)
    : path.join(projectRoot(), "config", "music-workflow.json");
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (process.env.MUSIC_NCM_CLI_BIN) {
    parsed.ncmCliBin = process.env.MUSIC_NCM_CLI_BIN;
  }
  validateConfig(parsed, resolved);
  return { ...parsed, __path: resolved };
}

export function saveConfig(config, configPath = process.env.MUSIC_WORKFLOW_CONFIG) {
  const current = loadConfig(configPath);
  const target = current.__path;
  const next = { ...config };
  delete next.__path;
  validateConfig(next, target);
  fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return loadConfig(target);
}

function validateConfig(config, source) {
  const required = ["timezone", "llm", "ncmCliBin", "slots"];
  for (const key of required) {
    if (!(key in config)) {
      throw new Error(`配置缺少 ${key}: ${source}`);
    }
  }
  if (!Array.isArray(config.slots) || config.slots.length === 0) {
    throw new Error(`配置 slots 必须是非空数组: ${source}`);
  }
  for (const slot of config.slots) {
    for (const key of ["id", "start", "end", "intent"]) {
      if (!(key in slot)) throw new Error(`slot ${slot.id || "(unknown)"} 缺少 ${key}`);
    }
    validateHHMM(slot.start, `slot ${slot.id} start`);
    validateHHMM(slot.end, `slot ${slot.id} end`);
    if (slot.enabled != null && typeof slot.enabled !== "boolean") {
      throw new Error(`slot ${slot.id} enabled 必须是布尔值`);
    }
    if (slot.keywords != null && !Array.isArray(slot.keywords)) {
      throw new Error(`slot ${slot.id} keywords 必须是数组`);
    }
  }
}

function validateHHMM(value, label) {
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error(`${label} 时间格式必须是 HH:MM: ${value}`);
  const [hour, minute] = value.split(":").map(Number);
  if (hour > 23 || minute > 59) throw new Error(`${label} 时间非法: ${value}`);
}
