#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const backendPort = process.env.MUSIC_BACKEND_PORT || "8787";
const frontendPort = process.env.MUSIC_FRONTEND_PORT || "8788";
const children = [];
let runtimeEnv = null;
let quitting = false;

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function ensureRuntime() {
  if (runtimeEnv) return runtimeEnv;
  const secrets = readJsonIfExists(path.join(root, "config", "runtime-secrets.json"));
  const packagedCli = path.join(root, "bin", "ncm-cli");
  const packagedBin = path.join(root, "bin");
  runtimeEnv = {
    ...process.env,
    PATH: `${packagedBin}${path.delimiter}${process.env.PATH || ""}`,
    MUSIC_BACKEND_PORT: backendPort,
    MUSIC_FRONTEND_PORT: frontendPort,
    ...(fs.existsSync(packagedCli) ? { MUSIC_NCM_CLI_BIN: packagedCli } : {}),
    ...(secrets.dashscopeApiKey ? { DASHSCOPE_API_KEY: secrets.dashscopeApiKey } : {})
  };
  ensureNcmCliConfig(runtimeEnv, secrets);
  return runtimeEnv;
}

function ensureNcmCliConfig(env, secrets) {
  if (!env.MUSIC_NCM_CLI_BIN || !secrets.netease?.appId || !secrets.netease?.privateKey) return;
  for (const args of [
    ["config", "set", "appId", secrets.netease.appId],
    ["config", "set", "privateKey", secrets.netease.privateKey],
    ["config", "set", "player", "mpv"]
  ]) {
    spawnSync(env.MUSIC_NCM_CLI_BIN, args, { env, cwd: root, stdio: "ignore", timeout: 15000 });
  }
}

function killPortListener(port) {
  const result = spawnSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return;
  for (const pid of result.stdout.trim().split(/\s+/).filter(Boolean)) {
    if (pid !== String(process.pid)) spawnSync("kill", [pid], { stdio: "ignore" });
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

async function waitFor(url, timeoutMs = 15000) {
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

async function releaseOwnedPorts() {
  killPortListener(backendPort);
  killPortListener(frontendPort);
  await Promise.all([waitForPortClosed(backendPort), waitForPortClosed(frontendPort)]);
}

function start(script) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: ensureRuntime(),
    stdio: "inherit"
  });
  children.push(child);
  return child;
}

function matchingPids(pattern) {
  const result = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const ownPids = new Set([String(process.pid), String(process.ppid), ...children.map((child) => String(child.pid))]);
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
  for (const pattern of patterns) terminatePids(matchingPids(pattern), "TERM");
  for (const pattern of patterns) terminatePids(matchingPids(pattern), "KILL");
}

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

function cleanup() {
  stopPlaybackAndClearQueue();
  for (const child of children) child.kill("SIGTERM");
  killPortListener(backendPort);
  killPortListener(frontendPort);
}

function quit(code = 0) {
  if (quitting) return;
  quitting = true;
  cleanup();
  process.exit(code);
}

process.once("SIGINT", () => quit(0));
process.once("SIGTERM", () => quit(0));
process.once("exit", cleanup);

try {
  ensureRuntime();
  await releaseOwnedPorts();
  start("src/server.js");
  start("src/frontend-server.js");
  await waitFor(`http://127.0.0.1:${backendPort}/api/health`);
  await waitFor(`http://127.0.0.1:${frontendPort}`);
  const url = `http://127.0.0.1:${frontendPort}`;
  if (!process.argv.includes("--no-open")) {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  }
  console.log(`music web listening on ${url}`);
  console.log("保持这个终端窗口开启；按 Ctrl+C 会停止服务并清空播放队列。");
} catch (error) {
  console.error(error.stack || error.message);
  quit(1);
}
