#!/usr/bin/env node
import { spawn } from "node:child_process";

const children = [
  spawn(process.execPath, ["src/server.js"], { stdio: "inherit", env: process.env }),
  spawn(process.execPath, ["src/frontend-server.js"], { stdio: "inherit", env: process.env })
];

function shutdown() {
  for (const child of children) child.kill("SIGTERM");
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
