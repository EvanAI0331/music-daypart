#!/usr/bin/env node
import { app, BrowserWindow, nativeImage } from "electron";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const backendPort = process.env.MUSIC_BACKEND_PORT || "8787";
const frontendPort = process.env.MUSIC_FRONTEND_PORT || "8788";
const dockIconPath = path.join(root, "assets", "icons", "music-ipod.png");
const windowIconPath = path.join(root, "assets", "icons", "music-ipod.icns");
const children = [];
let runtimeEnv = null;
let quitting = false;
let cleanupStarted = false;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function ensureRuntime() {
  if (runtimeEnv) return runtimeEnv;
  const userConfigDir = path.join(app.getPath("userData"), "config");
  fs.mkdirSync(userConfigDir, { recursive: true });
  const userConfigPath = path.join(userConfigDir, "music-workflow.json");
  if (!fs.existsSync(userConfigPath)) {
    const defaults = readJsonIfExists(path.join(root, "config", "music-workflow.json"));
    if (defaults.playback) delete defaults.playback.outputDeviceName;
    fs.writeFileSync(userConfigPath, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
  }
  const secrets = readJsonIfExists(path.join(root, "config", "runtime-secrets.json"));
  const packagedCli = path.join(root, "bin", "ncm-cli");
  const packagedBin = path.join(root, "bin");
  runtimeEnv = {
    ...process.env,
    PATH: `${packagedBin}${path.delimiter}${process.env.PATH || ""}`,
    MUSIC_WORKFLOW_CONFIG: userConfigPath,
    MUSIC_BACKEND_PORT: backendPort,
    MUSIC_FRONTEND_PORT: frontendPort,
    ...(fs.existsSync(packagedCli) ? { MUSIC_NCM_CLI_BIN: packagedCli } : {}),
    ...(secrets.llmApiKey ? { MUSIC_LLM_API_KEY: secrets.llmApiKey } : {})
  };
  ensureNcmCliConfig(runtimeEnv, secrets);
  return runtimeEnv;
}

function ensureNcmCliConfig(env, secrets) {
  if (!env.MUSIC_NCM_CLI_BIN || !secrets.netease?.appId || !secrets.netease?.privateKey) return;
  const commands = [
    ["config", "set", "appId", secrets.netease.appId],
    ["config", "set", "privateKey", secrets.netease.privateKey],
    ["config", "set", "player", "mpv"]
  ];
  for (const args of commands) {
    spawnSync(env.MUSIC_NCM_CLI_BIN, args, { env, cwd: root, stdio: "ignore", timeout: 15000 });
  }
}

function killPortListener(port) {
  const result = spawnSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return;
  for (const pid of result.stdout.trim().split(/\s+/).filter(Boolean)) {
    if (pid !== String(process.pid)) {
      spawnSync("kill", [pid], { stdio: "ignore" });
    }
  }
}

async function waitForPortClosed(port, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const closed = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: Number(port) });
      socket.on("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("error", () => resolve(true));
    });
    if (closed) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function releaseOwnedPorts() {
  killPortListener(backendPort);
  killPortListener(frontendPort);
  await Promise.all([waitForPortClosed(backendPort), waitForPortClosed(frontendPort)]);
}

async function ensureService(script, env, url) {
  const serviceEnv = { ...ensureRuntime(), ...env };
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...serviceEnv, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit"
  });
  children.push(child);
  await waitFor(url);
}

async function waitFor(url, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`服务启动超时: ${url}`);
}

async function createWindow() {
  ensureRuntime();
  if (process.platform === "darwin" && app.dock && fs.existsSync(dockIconPath)) {
    app.dock.setIcon(nativeImage.createFromPath(dockIconPath));
  }
  await releaseOwnedPorts();
  await ensureService("src/server.js", {}, `http://127.0.0.1:${backendPort}/api/health`);
  await ensureService("src/frontend-server.js", {}, `http://127.0.0.1:${frontendPort}`);

  const win = new BrowserWindow({
    width: 440,
    height: 760,
    minWidth: 420,
    minHeight: 720,
    resizable: true,
    frame: false,
    transparent: true,
    title: "时段音乐播放器",
    backgroundColor: "#00000000",
    icon: windowIconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.on("close", () => {
    cleanupRuntime();
  });

  await win.loadURL(`http://127.0.0.1:${frontendPort}`);
}

app.whenReady().then(() => {
  createWindow().catch((error) => {
    console.error(error);
    app.quit();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

function stopPlaybackAndClearQueue() {
  const env = ensureRuntime();
  const cli = env.MUSIC_NCM_CLI_BIN || "ncm-cli";
  for (const args of [
    ["stop", "--output", "json"],
    ["queue", "clear", "--output", "json"],
    ["stop", "--output", "json"]
  ]) {
    spawnSync(cli, args, { cwd: root, env, stdio: "ignore", timeout: 10000 });
  }
  terminatePlayerProcesses();
}

function matchingPids(pattern) {
  const result = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const ownPids = new Set([String(process.pid), String(process.ppid)]);
  return result.stdout.trim().split(/\s+/).filter((pid) => pid && !ownPids.has(pid));
}

function terminatePids(pids, signal) {
  for (const pid of pids) spawnSync("kill", [`-${signal}`, pid], { stdio: "ignore" });
}

function terminatePlayerProcesses() {
  const patterns = [
    "vendor/@music163/ncm-cli/dist/index\\.js",
    "ncm-cli/dist/index\\.js play",
    "mpv .*\\.config/ncm-cli/mpv\\.sock"
  ];
  for (const pattern of patterns) {
    const pids = matchingPids(pattern);
    terminatePids(pids, "TERM");
  }
  for (const pattern of patterns) {
    const pids = matchingPids(pattern);
    terminatePids(pids, "KILL");
  }
}

function cleanupChildren() {
  for (const child of children) child.kill("SIGTERM");
  killPortListener(backendPort);
  killPortListener(frontendPort);
}

function cleanupRuntime() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  stopPlaybackAndClearQueue();
  cleanupChildren();
}

function quitAfterCleanup() {
  if (quitting) return;
  quitting = true;
  cleanupRuntime();
  app.exit(0);
}

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitAfterCleanup();
});

app.on("will-quit", () => {
  cleanupRuntime();
});

process.once("SIGINT", quitAfterCleanup);
process.once("SIGTERM", quitAfterCleanup);
process.once("exit", () => {
  cleanupRuntime();
});
