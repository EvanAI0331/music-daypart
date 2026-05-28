import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export async function runCli(bin, args, options = {}) {
  const { timeoutMs = 30000 } = options;
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${bin} ${args.join(" ")} 超时`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = { code, stdout, stderr };
      if (code === 0) resolve(result);
      else reject(new Error(formatFailure(bin, args, result)));
    });
  });
}

export async function getMpvVolume(config = {}) {
  const socketPath = config.playback?.mpvSocketPath
    || process.env.NCM_MPV_SOCKET
    || path.join(os.homedir(), ".config", "ncm-cli", "mpv.sock");
  const response = await mpvCommand(socketPath, ["get_property", "volume"]);
  if (typeof response.data !== "number") {
    throw new Error(`mpv volume 返回无效: ${JSON.stringify(response)}`);
  }
  return Math.round(response.data);
}

export async function getMpvPlaybackStatus(config = {}) {
  const socketPath = config.playback?.mpvSocketPath
    || process.env.NCM_MPV_SOCKET
    || path.join(os.homedir(), ".config", "ncm-cli", "mpv.sock");
  const [idle, pathValue, timePosition] = await Promise.all([
    mpvProperty(socketPath, "idle-active"),
    mpvProperty(socketPath, "path"),
    mpvProperty(socketPath, "time-pos")
  ]);
  return {
    available: true,
    idle: idle.data === true,
    path: typeof pathValue.data === "string" ? pathValue.data : "",
    timePosition: typeof timePosition.data === "number" ? timePosition.data : null,
    active: idle.data === false && typeof pathValue.data === "string" && typeof timePosition.data === "number"
  };
}

export async function setMpvAudioDevice(config = {}, device) {
  const socketPath = config.playback?.mpvSocketPath
    || process.env.NCM_MPV_SOCKET
    || path.join(os.homedir(), ".config", "ncm-cli", "mpv.sock");
  return await mpvCommand(socketPath, ["set_property", "audio-device", device]);
}

export async function setMpvVolumePolicy(config = {}, requestedVolume = 50, options = {}) {
  const volume = normalizeVolume(requestedVolume);
  const socketPath = config.playback?.mpvSocketPath
    || process.env.NCM_MPV_SOCKET
    || path.join(os.homedir(), ".config", "ncm-cli", "mpv.sock");
  if (!fs.existsSync(socketPath)) {
    if (options.required) await waitForMpvSocket(socketPath, options.timeoutMs ?? 8000);
  }
  if (!fs.existsSync(socketPath)) {
    if (options.required) throw new Error(`mpv IPC 不存在: ${socketPath}`);
    return { applied: false, reason: "mpv_socket_missing", volume };
  }
  const applied = [];
  for (const [property, value] of [
    ["volume-max", 100],
    ["replaygain", "track"],
    ["replaygain-preamp", 0],
    ["replaygain-clip", true],
    ["volume", volume]
  ]) {
    try {
      await mpvCommand(socketPath, ["set_property", property, value]);
      applied.push(property);
    } catch (error) {
      if (property === "volume") throw error;
    }
  }
  try {
    await mpvCommand(socketPath, ["set_property", "ao-volume", volume]);
    applied.push("ao-volume");
  } catch {
    // Some mpv audio outputs expose ao-volume as read-only; main volume is still clamped above.
  }
  return { applied: true, volume, properties: applied };
}

async function waitForMpvSocket(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function normalizeVolume(value) {
  const volume = Number(value);
  if (!Number.isInteger(volume) || volume < 0 || volume > 60) {
    throw new Error(`音量必须是 0-60 的整数: ${value}`);
  }
  return volume;
}

async function mpvProperty(socketPath, property) {
  try {
    return await mpvCommand(socketPath, ["get_property", property]);
  } catch (error) {
    return { error: error.message };
  }
}

async function mpvCommand(socketPath, command) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`mpv IPC 超时: ${socketPath}`));
    }, 3000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ command })}\n`);
    });
    socket.on("data", (chunk) => {
      data += chunk.toString();
      const line = data.split("\n").find((item) => item.trim().startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      socket.end();
      const parsed = JSON.parse(line);
      if (parsed.error && parsed.error !== "success") reject(new Error(`mpv IPC 失败: ${parsed.error}`));
      else resolve(parsed);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function extractJson(text) {
  const start = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const first = [start, arrayStart].filter((item) => item >= 0).sort((a, b) => a - b)[0];
  if (first == null) throw new Error(`输出中没有 JSON: ${text.slice(0, 500)}`);
  return JSON.parse(text.slice(first));
}

export async function doctor(config) {
  const checks = [];
  checks.push(await checkCommand(config.ncmCliBin, ["--version"], "本机播放组件"));
  checks.push(await checkCommand(config.ncmCliBin, ["login", "--check", "--output", "json"], "网易云登录"));
  checks.push(await checkSearchCommand(config.ncmCliBin));
  if (config.playback?.outputDeviceName) {
    checks.push(await checkOutputDevice(config.playback.outputDeviceName));
  }
  checks.push(await checkCommand(config.ncmCliBin, ["state", "--output", "json"], "播放器状态"));
  const failed = checks.filter((check) => !check.ok);
  return { ok: failed.length === 0, checks };
}

async function checkCommand(bin, args, name) {
  try {
    const result = await runCli(bin, args, { timeoutMs: 15000 });
    if (name === "网易云登录") {
      const parsed = extractJson(result.stdout);
      if (parsed.success !== true) {
        return { name, ok: false, detail: "未登录，请点击登录，用普通网易云账号完成授权" };
      }
      return { name, ok: parsed.success === true, detail: parsed.message || "已登录" };
    }
    if (name === "播放器状态") {
      const parsed = extractJson(result.stdout);
      return { name, ok: parsed.success === true, detail: parsed.state?.status || "unknown" };
    }
    return { name, ok: true, detail: result.stdout.trim().split("\n").at(-1) || "ok" };
  } catch (error) {
    if (name === "网易云登录") {
      return { name, ok: false, detail: "未登录，请点击登录，用普通网易云账号完成授权" };
    }
    return { name, ok: false, detail: error.message };
  }
}

async function checkSearchCommand(bin) {
  try {
    const result = await runCli(bin, ["commands"], { timeoutMs: 15000 });
    const hasSearch = /^\s*search\s+/m.test(result.stdout);
    return {
      name: "歌曲搜索能力",
      ok: hasSearch,
      detail: hasSearch ? "正常" : "当前播放组件缺少搜索能力"
    };
  } catch (error) {
    return { name: "歌曲搜索能力", ok: false, detail: error.message };
  }
}

async function checkOutputDevice(name) {
  try {
    const result = await runCli("SwitchAudioSource", ["-a", "-t", "output"], { timeoutMs: 10000 });
    const devices = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    return {
      name: "项目音频输出",
      ok: devices.includes(name),
      detail: devices.includes(name) ? name : `未找到 ${name}`
    };
  } catch (error) {
    return { name: "项目音频输出", ok: false, detail: error.message };
  }
}

export async function searchSongs(config, keyword) {
  const result = await runCli(config.ncmCliBin, [
    "search",
    "song",
    "--keyword",
    keyword,
    "--userInput",
    `按当前时段自动搜索歌曲：${keyword}`,
    "--output",
    "json"
  ], { timeoutMs: 45000 });
  const parsed = extractJson(result.stdout);
  const songs = collectSongs(parsed);
  if (songs.length === 0) throw new Error(`搜索没有返回可播放歌曲: ${keyword}`);
  return songs;
}

export async function playSongQueue(config, songs) {
  if (!Array.isArray(songs) || songs.length === 0) {
    throw new Error("没有可播放歌曲可加入队列");
  }
  const queue = shuffleSongs(songs);
  const [first, ...rest] = queue;
  if (config.playback?.outputDeviceName) {
    await runCli("SwitchAudioSource", ["-s", config.playback.outputDeviceName, "-t", "output"], { timeoutMs: 10000 });
  }
  if (config.playback?.stopBeforePlay) {
    await runCli(config.ncmCliBin, ["queue", "clear", "--output", "json"], { timeoutMs: 10000 });
  }
  if (typeof config.playback?.volume === "number") {
    await runCli(config.ncmCliBin, ["volume", String(config.playback.volume), "--output", "json"], { timeoutMs: 10000 });
  }
  const playResult = await runCli(config.ncmCliBin, [
    "play",
    "--song",
    "--encrypted-id", first.encryptedId,
    "--original-id", first.originalId,
    "--output",
    "json"
  ], { timeoutMs: 45000 });
  if (typeof config.playback?.volume === "number") {
    await setMpvVolumePolicy(config, config.playback.volume, { required: true });
  }
  const added = [];
  for (const song of rest) {
    await runCli(config.ncmCliBin, [
      "queue",
      "add",
      "--encrypted-id", song.encryptedId,
      "--original-id", song.originalId,
      "--output", "json"
    ], { timeoutMs: 15000 });
    added.push(song);
  }
  return { playResult, first, added, queue };
}

export async function playSong(config, song) {
  return await playSongQueue(config, [song]);
}

export async function queueState(config) {
  const result = await runCli(config.ncmCliBin, ["queue", "--output", "json"], { timeoutMs: 10000 });
  return JSON.parse(result.stdout.trim());
}

function shuffleSongs(songs) {
  const copy = songs.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function collectSongs(value) {
  const found = [];
  walk(value, (node) => {
    const isSongNode = typeof node.duration === "number"
      && Array.isArray(node.artists)
      && (typeof node.jumpUrl !== "string" || node.jumpUrl.startsWith("orpheus://song/"));
    if (!isSongNode) return;
    if (node.visible === false || node.playFlag === false) return;
    const encryptedId = node.encryptedId ?? node.encrypted_id ?? node.encryptedID ?? node.id;
    const originalId = node.originalId ?? node.original_id ?? node.id ?? node.songId;
    if (typeof encryptedId === "string" && /^[a-fA-F0-9]{32}$/.test(encryptedId) && originalId != null) {
      found.push({
        encryptedId,
        originalId: String(originalId),
        name: node.name ?? node.songName ?? "",
        artist: node.artistName ?? node.artist ?? formatArtists(node.artists) ?? ""
      });
    }
  });
  return found;
}

function formatArtists(artists) {
  if (!Array.isArray(artists)) return null;
  return artists.map((artist) => artist?.name).filter(Boolean).join(", ");
}

function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) visit(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") walk(child, visit);
  }
}

function formatFailure(bin, args, result) {
  return [
    `命令失败: ${bin} ${args.join(" ")}`,
    `exit=${result.code}`,
    result.stderr.trim(),
    result.stdout.trim()
  ].filter(Boolean).join("\n");
}
