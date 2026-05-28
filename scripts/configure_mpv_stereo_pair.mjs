#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configDir = path.join(os.homedir(), ".config", "mpv");
const configPath = path.join(configDir, "mpv.conf");
const start = "# BEGIN Music Daypart stereo pair";
const end = "# END Music Daypart stereo pair";
const block = `${start}
# Do not pin audio-device here. The web UI controls output routing.
# Keep avfoundation so mpv follows macOS audio devices reliably.
ao=avfoundation
audio-channels=stereo
volume=50
# mpv only accepts volume-max >= 100; the app/API enforce the project limit of 60.
volume-max=100
replaygain=track
replaygain-preamp=0
replaygain-clip=yes
${end}`;

fs.mkdirSync(configDir, { recursive: true });
const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, "m");
const next = pattern.test(current)
  ? current.replace(pattern, block)
  : `${current.replace(/\s+$/, "")}${current.trim() ? "\n\n" : ""}${block}\n`;
fs.writeFileSync(configPath, next, "utf8");
console.log(`configured mpv stereo pair: ${configPath}`);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
