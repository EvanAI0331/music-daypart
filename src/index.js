#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { doctor } from "./ncmCli.js";
import { pause, runDaemon, runOnce, state, stop } from "./workflow.js";

const command = process.argv[2] || "help";

try {
  const config = loadConfig();
  if (command === "doctor") {
    console.log(JSON.stringify(await doctor(config), null, 2));
  } else if (command === "run-once") {
    console.log(JSON.stringify(await runOnce(config), null, 2));
  } else if (command === "daemon") {
    await runDaemon(config);
  } else if (command === "stop") {
    console.log(JSON.stringify(await stop(config), null, 2));
  } else if (command === "pause") {
    console.log(JSON.stringify(await pause(config), null, 2));
  } else if (command === "state") {
    console.log(JSON.stringify(await state(config), null, 2));
  } else {
    console.log("用法: npm run doctor | npm run run-once | npm run daemon | npm run pause | npm run stop | npm run state");
  }
} catch (error) {
  console.error(JSON.stringify({ status: "failed", error: error.message }, null, 2));
  process.exit(1);
}
