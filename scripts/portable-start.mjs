#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronNode = path.join(packageRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const backendPort = process.env.MUSIC_BACKEND_PORT || "8787";
const frontendPort = process.env.MUSIC_FRONTEND_PORT || "8788";
const userDataDir = path.join(packageRoot, "user-data");
const configDir = path.join(userDataDir, "config");
const configPath = path.join(configDir, "music-workflow.json");
const ncmCli = path.join(packageRoot, "bin", "ncm-cli");
const secretsPath = path.join(packageRoot, "config", "runtime-secrets.json");
const logPath = path.join(packageRoot, "启动日志.txt");
const children = [];

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.appendFileSync(logPath, `${line}\n`, "utf8");
  console.log(message);
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function ensureConfig() {
  fs.mkdirSync(configDir, { recursive: true });
  if (fs.existsSync(configPath)) return;
  const defaults = readJsonIfExists(path.join(packageRoot, "config", "music-workflow.json"));
  if (defaults.playback) delete defaults.playback.outputDeviceName;
  fs.writeFileSync(configPath, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
}

function runtimeEnv() {
  const secrets = readJsonIfExists(secretsPath);
  return {
    ...process.env,
    PATH: `${path.join(packageRoot, "bin")}${path.delimiter}${process.env.PATH || ""}`,
    ELECTRON_RUN_AS_NODE: "1",
    MUSIC_WORKFLOW_CONFIG: configPath,
    MUSIC_BACKEND_PORT: backendPort,
    MUSIC_FRONTEND_PORT: frontendPort,
    MUSIC_NCM_CLI_BIN: ncmCli,
    ...(secrets.dashscopeApiKey ? { DASHSCOPE_API_KEY: secrets.dashscopeApiKey } : {})
  };
}

function configureNcm(env) {
  const secrets = readJsonIfExists(secretsPath);
  if (!secrets.netease?.appId || !secrets.netease?.privateKey) return;
  for (const args of [
    ["config", "set", "appId", secrets.netease.appId],
    ["config", "set", "privateKey", secrets.netease.privateKey],
    ["config", "set", "player", "mpv"]
  ]) {
    spawnSync(ncmCli, args, { cwd: packageRoot, env, stdio: "ignore", timeout: 15000 });
  }
}

async function waitFor(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`服务启动超时: ${url}`);
}

function start(script, env) {
  const child = spawn(electronNode, [script], {
    cwd: packageRoot,
    env,
    stdio: "inherit"
  });
  child.on("exit", (code, signal) => {
    logLine(`${script} 已退出 code=${code ?? ""} signal=${signal ?? ""}`);
  });
  children.push(child);
  return child;
}

function shutdown() {
  for (const child of children) child.kill("SIGTERM");
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

try {
  fs.writeFileSync(logPath, "", "utf8");
  logLine(`包目录: ${packageRoot}`);
  logLine(`系统架构: ${process.arch}`);
  if (!fs.existsSync(electronNode)) throw new Error(`缺少 Electron Node: ${electronNode}`);
  if (!fs.existsSync(ncmCli)) throw new Error(`缺少 ncm-cli: ${ncmCli}`);
  ensureConfig();
  const env = runtimeEnv();
  configureNcm(env);
  start("src/server.js", env);
  start("src/frontend-server.js", env);
  await waitFor(`http://127.0.0.1:${backendPort}/api/health`);
  await waitFor(`http://127.0.0.1:${frontendPort}`);
  spawn("open", [`http://127.0.0.1:${frontendPort}`], { stdio: "ignore", detached: true }).unref();
  logLine(`已启动: http://127.0.0.1:${frontendPort}`);
  logLine("保持这个终端窗口开启；按 Ctrl+C 可停止服务。");
} catch (error) {
  logLine(`启动失败: ${error.stack || error.message}`);
  shutdown();
  process.exit(1);
}
