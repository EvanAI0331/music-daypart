#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ncmCli = path.join(packageRoot, "bin", "ncm-cli");
const configPath = path.join(packageRoot, "user-data", "config", "music-workflow.json");
const secretsPath = path.join(packageRoot, "config", "runtime-secrets.json");
const secrets = fs.existsSync(secretsPath) ? JSON.parse(fs.readFileSync(secretsPath, "utf8")) : {};

const env = {
  ...process.env,
  PATH: `${path.join(packageRoot, "bin")}${path.delimiter}${process.env.PATH || ""}`,
  MUSIC_WORKFLOW_CONFIG: configPath,
  MUSIC_NCM_CLI_BIN: ncmCli,
  ...(secrets.dashscopeApiKey ? { DASHSCOPE_API_KEY: secrets.dashscopeApiKey } : {})
};

const child = spawn(ncmCli, process.argv.slice(2), {
  cwd: packageRoot,
  env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
