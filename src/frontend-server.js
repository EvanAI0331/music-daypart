#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "./config.js";

const port = Number(process.env.MUSIC_FRONTEND_PORT || 8788);
const root = path.join(projectRoot(), "public");
const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".icns", "image/icns"]
]);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = path.normalize(path.join(root, pathname));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": types.get(path.extname(file)) || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`music frontend listening on http://127.0.0.1:${port}`);
});
