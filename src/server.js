#!/usr/bin/env node
import http from "node:http";
import { loadConfig, saveConfig } from "./config.js";
import { doctor, extractJson, getMpvPlaybackStatus, getMpvVolume, queueState, runCli } from "./ncmCli.js";
import { currentSlot, millisecondsUntilNextSchedule, rawCurrentSlot } from "./timeSlots.js";
import { pause, runOnce, state, stop } from "./workflow.js";

const port = Number(process.env.MUSIC_BACKEND_PORT || 8787);
const logs = [];
let playbackTimer = null;
let playbackNext = null;
let queueMonitor = null;
let refillRunning = false;
let manualStopUntilNextSchedule = false;
let playbackStuckChecks = 0;
let playbackSample = null;

function log(event, detail = {}) {
  const entry = { ts: new Date().toISOString(), event, detail };
  logs.unshift(entry);
  logs.splice(200);
  return entry;
}

function send(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function health() {
  const config = loadConfig();
  const healthResult = await doctor(config);
  const rawSlot = rawCurrentSlot(config);
  let slotResult;
  let slotError = null;
  try {
    slotResult = currentSlot(config);
  } catch (error) {
    slotError = error.message;
    slotResult = { slot: null, local: rawSlot.local };
  }
  let nextResult;
  let nextError = null;
  try {
    nextResult = millisecondsUntilNextSchedule(config);
  } catch (error) {
    nextError = error.message;
    nextResult = null;
  }
  const currentOutput = await currentOutputDevice();
  const outputDevices = await listOutputDevices();
  const speakers = await runCli("blueutil", ["--paired", "--format", "json"]).then((r) => {
    const devices = JSON.parse(r.stdout);
    return devices
      .filter((device) => /Sound Pro|2872|2615/.test(device.name || ""))
      .map((device) => ({ name: device.name, address: device.address, connected: device.connected === true }));
  }).catch((error) => [{ name: "Bluetooth status", connected: false, error: error.message }]);
  const playerState = await state(config).catch((error) => ({ status: "failed", error: error.message }));
  const queue = await queueState(config).catch(() => null);
  const nowPlaying = playerState.data?.state?.title || "";
  const nextTrack = nextQueueTrack(queue);
  const actualVolume = await getMpvVolume(config).catch((error) => null);
  const mpv = await getMpvPlaybackStatus(config).catch((error) => ({ available: false, error: error.message }));
  return {
    ok: healthResult.ok,
    checks: healthResult.checks,
    slot: {
      id: slotResult.slot?.id || rawSlot.slot.id,
      intent: slotResult.slot?.intent || rawSlot.slot.intent,
      enabled: Boolean(slotResult.slot),
      error: slotError,
      time: slotResult.local.isoLocal
    },
    rawSlot: { id: rawSlot.slot.id, enabled: rawSlot.slot.enabled !== false },
    next: nextResult
      ? { slot: nextResult.slot.id, time: nextResult.hhmm, delayMs: nextResult.delayMs }
      : { slot: null, time: null, delayMs: null, error: nextError },
    llm: {
      configured: Boolean(config.llm.model && config.llm.baseUrl && process.env[config.llm.apiKeyEnv]),
      apiKeyEnv: config.llm.apiKeyEnv,
      apiKeyPresent: Boolean(process.env[config.llm.apiKeyEnv])
    },
    audio: {
      outputDeviceName: config.playback?.outputDeviceName || "",
      currentOutput,
      outputDevices,
      speakers,
      volume: {
        configured: config.playback?.volume ?? null,
        actual: actualVolume
      }
    },
    daemon: {
      running: Boolean(playbackTimer),
      pid: process.pid,
      next: playbackNext
    },
    playerState,
    mpv,
    nowPlaying,
    nextTrack,
    queue,
    logs
  };
}

function nextQueueTrack(queue) {
  if (!Array.isArray(queue?.queue)) return "";
  const currentIndex = queue.queue.findIndex((item) => item.current === true);
  const nextItem = queue.queue[currentIndex >= 0 ? currentIndex + 1 : 0];
  return nextItem?.label || "";
}

async function listOutputDevices() {
  try {
    const result = await runCli("SwitchAudioSource", ["-a", "-t", "output"], { timeoutMs: 10000 });
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function currentOutputDevice() {
  try {
    const result = await runCli("SwitchAudioSource", ["-c", "-t", "output"], { timeoutMs: 10000 });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

function scheduleAutomaticPlayback(reason = "schedule") {
  if (playbackTimer) clearTimeout(playbackTimer);
  playbackTimer = null;
  const config = loadConfig();
  const next = millisecondsUntilNextSchedule(config);
  playbackNext = { slot: next.slot.id, time: next.hhmm, delayMs: next.delayMs };
  log("autoplay.schedule", { reason, ...playbackNext });
  playbackTimer = setTimeout(async () => {
    playbackTimer = null;
    manualStopUntilNextSchedule = false;
    try {
      const result = await runOnce(loadConfig());
      log("autoplay.played", result);
    } catch (error) {
      log("autoplay.failed", { message: error.message });
    } finally {
      try {
        scheduleAutomaticPlayback("after_play");
      } catch (error) {
        playbackNext = { slot: null, time: null, delayMs: null, error: error.message };
        log("autoplay.schedule_failed", { message: error.message });
      }
    }
  }, next.delayMs);
  startQueueMonitor();
  return { status: "scheduled", ...playbackNext };
}

function startQueueMonitor() {
  if (queueMonitor) return;
  queueMonitor = setInterval(async () => {
    if (!playbackTimer || refillRunning || manualStopUntilNextSchedule) return;
    const config = loadConfig();
    const next = millisecondsUntilNextSchedule(config);
    if (next.delayMs <= 60_000) return;
    const playerState = await state(config).catch(() => null);
    const status = playerState?.data?.state?.status;
    if (status === "playing") {
      const recovered = await recoverStuckPlayback(config, playerState);
      if (!recovered) return;
    } else if (status !== "stopped") {
      playbackStuckChecks = 0;
      return;
    }
    refillRunning = true;
    try {
      const result = await runOnce(loadConfig());
      log("queue.refilled", { beforeNext: next.hhmm, result });
    } catch (error) {
      log("queue.refill_failed", { message: error.message });
    } finally {
      refillRunning = false;
    }
  }, 30_000);
}

async function recoverStuckPlayback(config, playerState) {
  const current = playbackSnapshot(playerState);
  if (!current) {
    playbackStuckChecks = 0;
    playbackSample = null;
    return false;
  }
  if (!playbackSample || playbackSample.trackKey !== current.trackKey) {
    playbackStuckChecks = 0;
    playbackSample = current;
    return false;
  }
  if (current.position > playbackSample.position + 2) {
    playbackStuckChecks = 0;
    playbackSample = current;
    return false;
  }
  playbackSample = current;
  const mpv = await getMpvPlaybackStatus(config).catch((error) => ({ available: false, error: error.message }));
  if (mpv.active) {
    playbackStuckChecks = 0;
    return false;
  }
  playbackStuckChecks += 1;
  log("playback.stuck_check", {
    count: playbackStuckChecks,
    title: current.title,
    position: current.position,
    mpv
  });
  if (playbackStuckChecks < 2) return false;
  playbackStuckChecks = 0;
  const queue = await queueState(config).catch(() => null);
  if (Array.isArray(queue?.queue) && queue.queue.length > 1) {
    const result = await runCli(config.ncmCliBin, ["next", "--output", "json"], { timeoutMs: 15000 });
    log("playback.recovered_next", { stdout: result.stdout.trim() });
    return false;
  }
  return true;
}

function playbackSnapshot(playerState) {
  const stateData = playerState?.data?.state;
  const title = typeof stateData?.title === "string" ? stateData.title : "";
  const position = typeof stateData?.position === "number" ? stateData.position : null;
  const index = Number.isInteger(stateData?.currentIndex) ? stateData.currentIndex : null;
  if (!title || position == null) return null;
  return {
    trackKey: `${index ?? "?"}:${title}`,
    title,
    position
  };
}

async function runAction(action) {
  const config = loadConfig();
  log("action.start", { action });
  if (action === "doctor") return await doctor(config);
  if (action === "login") {
    const current = await runCli(config.ncmCliBin, ["login", "--check", "--output", "json"], { timeoutMs: 15000 });
    const loginState = extractJson(current.stdout);
    if (loginState.success === true) {
      return { status: "already_logged_in", stdout: current.stdout.trim(), stderr: current.stderr.trim() };
    }
    const result = await runCli(config.ncmCliBin, ["login", "--background", "--output", "json"], { timeoutMs: 15000 });
    return { status: "login_started", stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }
  if (action === "run-once") {
    manualStopUntilNextSchedule = false;
    return await runOnce(config);
  }
  if (action === "pause") {
    manualStopUntilNextSchedule = true;
    return await pause(config);
  }
  if (action === "stop") {
    manualStopUntilNextSchedule = true;
    return await stop(config);
  }
  if (action === "state") return await state(config);
  if (action === "audio-setup") {
    const result = await runCli("npm", ["run", "audio:setup"], { timeoutMs: 60000 });
    return { status: "audio_setup_done", stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }
  throw new Error(`Unsupported action: ${action}`);
}

async function setVolume(level) {
  const config = loadConfig();
  const volume = Number(level);
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
    throw new Error(`音量必须是 0-100 的整数: ${level}`);
  }
  const result = await runCli(config.ncmCliBin, ["volume", String(volume), "--output", "json"], { timeoutMs: 10000 });
  const actualVolume = await getMpvVolume(config).catch(() => null);
  const nextConfig = {
    ...config,
    playback: {
      ...(config.playback || {}),
      volume: actualVolume ?? volume
    }
  };
  const saved = saveConfig(nextConfig, config.__path);
  log("volume.set", { volume });
  return { status: "volume_set", requestedVolume: volume, volume: saved.playback.volume, actualVolume, stdout: result.stdout.trim() };
}

async function setOutputDevice(name) {
  const config = loadConfig();
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("输出设备名称不能为空");
  }
  const deviceName = name.trim();
  const devices = await listOutputDevices();
  if (!devices.includes(deviceName)) {
    throw new Error(`未找到输出设备: ${deviceName}`);
  }
  await runCli("SwitchAudioSource", ["-s", deviceName, "-t", "output"], { timeoutMs: 10000 });
  const saved = saveConfig({
    ...config,
    playback: {
      ...(config.playback || {}),
      outputDeviceName: deviceName
    }
  }, config.__path);
  log("audio.output.set", { outputDeviceName: deviceName });
  return { status: "output_set", outputDeviceName: saved.playback.outputDeviceName };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, await health());
    if (req.method === "GET" && url.pathname === "/api/config") {
      const config = loadConfig();
      delete config.__path;
      return send(res, 200, { config });
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readJson(req);
      const saved = saveConfig(body.config);
      delete saved.__path;
      log("config.save", { slots: saved.slots.length });
      scheduleAutomaticPlayback("config_save");
      return send(res, 200, { ok: true, config: saved });
    }
    if (req.method === "GET" && url.pathname === "/api/logs") return send(res, 200, { logs });
    if (req.method === "POST" && url.pathname === "/api/action") {
      const body = await readJson(req);
      const result = await runAction(body.action);
      log("action.done", { action: body.action, result });
      return send(res, 200, { ok: true, result });
    }
    if (req.method === "POST" && url.pathname === "/api/volume") {
      const body = await readJson(req);
      const result = await setVolume(body.volume);
      return send(res, 200, { ok: true, result });
    }
    if (req.method === "POST" && url.pathname === "/api/output-device") {
      const body = await readJson(req);
      const result = await setOutputDevice(body.name);
      return send(res, 200, { ok: true, result });
    }
    return send(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    log("error", { message: error.message });
    return send(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, () => {
  log("backend.listen", { port });
  try {
    scheduleAutomaticPlayback("backend_listen");
  } catch (error) {
    playbackNext = { slot: null, time: null, delayMs: null, error: error.message };
    log("autoplay.schedule_failed", { message: error.message });
  }
  console.log(`music backend listening on http://127.0.0.1:${port}`);
});
