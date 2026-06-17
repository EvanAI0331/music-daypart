#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { packager } = require("@electron/packager");

const root = path.resolve(new URL("..", import.meta.url).pathname);
const releaseDir = process.env.MUSIC_RELEASE_DIR
  ? path.resolve(process.env.MUSIC_RELEASE_DIR)
  : path.join(root, "release");
const appPath = path.join(releaseDir, "Music Daypart-darwin-arm64", "Music Daypart.app");
const resourcesApp = path.join(appPath, "Contents", "Resources", "app");
const vendorNcmCli = process.env.MUSIC_VENDOR_NCM_CLI || "/opt/homebrew/lib/node_modules/@music163/ncm-cli";
const vendorMpv = process.env.MUSIC_VENDOR_MPV || "/opt/homebrew/bin/mpv";

if (!fs.existsSync(vendorNcmCli)) throw new Error(`ncm-cli vendor not found: ${vendorNcmCli}`);
if (!fs.existsSync(vendorMpv)) throw new Error(`mpv not found: ${vendorMpv}`);

preparePackagedResources();
fs.rmSync(path.join(releaseDir, "Music Daypart-darwin-arm64"), { recursive: true, force: true });
await packager({
  dir: root,
  out: releaseDir,
  name: "Music Daypart",
  platform: "darwin",
  arch: "arm64",
  overwrite: true,
  icon: path.join(root, "assets", "icons", "music-ipod.icns"),
  appBundleId: "com.musicdaypart.player",
  appCategoryType: "public.app-category.music",
  asar: false,
  ignore: [
    /^\/release($|\/)/,
    /^\/\.playwright-mcp($|\/)/,
    /^\/node_modules\/electron($|\/)/,
    /^\/node_modules\/@electron($|\/)/
  ],
  prune: false,
  quiet: true
});
bundleMpv();
adHocSign();
createZip();

console.log(JSON.stringify({
  app: appPath,
  zip: path.join(releaseDir, "Music-Daypart-mac.zip")
}, null, 2));

function preparePackagedResources() {
  fs.mkdirSync(path.join(root, "vendor", "@music163"), { recursive: true });
  fs.rmSync(path.join(root, "vendor", "@music163", "ncm-cli"), { recursive: true, force: true });
  fs.cpSync(vendorNcmCli, path.join(root, "vendor", "@music163", "ncm-cli"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "ncm-cli"), ncmWrapper(), "utf8");
  fs.chmodSync(path.join(root, "bin", "ncm-cli"), 0o755);
  writeRuntimeSecrets(path.join(root, "config", "runtime-secrets.json"));
}

function bundleMpv() {
  const appBinDir = path.join(resourcesApp, "bin");
  const libDir = path.join(resourcesApp, "lib", "mpv");
  fs.mkdirSync(appBinDir, { recursive: true });
  fs.mkdirSync(libDir, { recursive: true });
  const mpvTarget = path.join(appBinDir, "mpv");
  fs.copyFileSync(realPath(vendorMpv), mpvTarget);
  fs.chmodSync(mpvTarget, 0o755);

  const copied = new Map();
  const aliases = new Map();
  const queue = dependenciesOf(mpvTarget);
  while (queue.length > 0) {
    const original = queue.shift();
    if (isSystemLibrary(original) || aliases.has(original)) continue;
    const target = path.join(libDir, path.basename(original));
    fs.copyFileSync(realPath(original), target);
    fs.chmodSync(target, 0o644);
    copied.set(original, target);
    aliases.set(original, target);
    aliases.set(realPath(original), target);
    for (const dep of dependenciesOf(target)) {
      if (!isSystemLibrary(dep) && !aliases.has(dep)) queue.push(dep);
    }
  }

  run("install_name_tool", ["-add_rpath", "@executable_path/../lib/mpv", mpvTarget], { allowFailure: true });
  rewriteBinary(mpvTarget, aliases);
  for (const [original, target] of copied) {
    run("install_name_tool", ["-id", rpathFor(path.basename(original)), target]);
    rewriteBinary(target, aliases);
  }
}

function dependenciesOf(file) {
  const result = spawnSync("otool", ["-L", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`otool failed for ${file}: ${result.stderr}`);
  return result.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter((item) => item && item !== file && !item.startsWith("@"));
}

function rewriteBinary(file, copied) {
  for (const [original] of copied) {
    run("install_name_tool", ["-change", original, rpathFor(path.basename(original)), file]);
  }
}

function rpathFor(name) {
  return `@rpath/${name}`;
}

function isSystemLibrary(file) {
  return file.startsWith("/System/") || file.startsWith("/usr/lib/");
}

function realPath(file) {
  return fs.realpathSync(file);
}

function ncmWrapper() {
  return `#!/bin/sh
APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -x "$APP_ROOT/../../MacOS/Music Daypart" ]; then
  APP_BIN="$APP_ROOT/../../MacOS/Music Daypart"
else
  APP_BIN="$(command -v electron || command -v node)"
fi
export ELECTRON_RUN_AS_NODE=1
exec "$APP_BIN" "$APP_ROOT/vendor/@music163/ncm-cli/dist/index.js" "$@"
`;
}

function writeRuntimeSecrets(target) {
  const llmApiKey = process.env.MUSIC_LLM_API_KEY || "";
  const appId = process.env.MUSIC_NCM_APP_ID || "";
  const privateKey = process.env.MUSIC_NCM_PRIVATE_KEY || "";
  const appSecret = process.env.MUSIC_NCM_APP_SECRET || "";
  const missing = [];
  if (!llmApiKey) missing.push("MUSIC_LLM_API_KEY");
  if (!appId) missing.push("MUSIC_NCM_APP_ID");
  if (!privateKey) missing.push("MUSIC_NCM_PRIVATE_KEY");
  if (missing.length > 0) throw new Error(`Missing package secrets: ${missing.join(", ")}`);
  fs.writeFileSync(target, `${JSON.stringify({
    llmApiKey,
    netease: { appId, privateKey, ...(appSecret ? { appSecret } : {}) }
  }, null, 2)}\n`, "utf8");
}

function createZip() {
  const zip = path.join(releaseDir, "Music-Daypart-mac.zip");
  fs.rmSync(zip, { force: true });
  const result = spawnSync("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    "Music Daypart.app",
    zip
  ], {
    cwd: path.dirname(appPath),
    stdio: "inherit"
  });
  if (result.status !== 0) throw new Error("ditto zip failed");
}

function adHocSign() {
  const mpvTarget = path.join(resourcesApp, "bin", "mpv");
  const mpvLibDir = path.join(resourcesApp, "lib", "mpv");
  if (fs.existsSync(mpvTarget)) run("codesign", ["--force", "--sign", "-", mpvTarget]);
  if (fs.existsSync(mpvLibDir)) {
    for (const name of fs.readdirSync(mpvLibDir)) {
      run("codesign", ["--force", "--sign", "-", path.join(mpvLibDir, name)]);
    }
  }
  run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "pipe", encoding: "utf8" });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
}
