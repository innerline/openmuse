#!/usr/bin/env node
// Static web host + same-origin /api reverse proxy for the OpenMuse web UI.
//
// Why a proxy: the API server enforces a strict Origin allowlist (loopback
// :8081 only by default), so a browser page served on another port cannot
// call it cross-origin. Serving the UI and proxying /api from the same
// origin sidesteps CORS entirely and leaves the API lane untouched. The
// Origin header is dropped on proxy so the API's origin check is a no-op
// (it only rejects requests that carry a disallowed Origin).
//
// Configuration (environment):
//   OM_WEB_ROOT        directory of the exported web build (default: sibling dist/web)
//   OM_API_UPSTREAM    API origin to proxy /api/* to (default: http://127.0.0.1:8787)
//   OM_GATEWAY_UPSTREAM  origin of the CopilotKit realtime gateway WebSocket,
//                        proxied same-origin at /gateway/* (default: ws://127.0.0.1:51412)
//   OM_PORT            listen port (default: 8082)
//   OM_HOST            bind address (default: 0.0.0.0)

import http from "node:http";
import { createReadStream } from "node:fs";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(
  process.env.OM_WEB_ROOT ?? path.join(here, "..", "apps", "mobile", "dist", "web"),
);
const API_UPSTREAM = process.env.OM_API_UPSTREAM ?? "http://127.0.0.1:8787";
const PORT = Number(process.env.OM_PORT ?? 8082);
const HOST = process.env.OM_HOST ?? "0.0.0.0";

const upstream = new URL(API_UPSTREAM);
// Realtime gateway (cpki-realtime-gateway in the local k3d cluster) binds loopback
// only. The browser cannot reach ws://127.0.0.1:51412 directly, so the runtime
// advertises this host's same-origin /gateway/* path instead and this proxy
// tunnels the WebSocket upgrade to the loopback gateway (2026-10-26 fix).
const GATEWAY_UPSTREAM = new URL(process.env.OM_GATEWAY_UPSTREAM ?? "ws://127.0.0.1:51412");
const GATEWAY_PREFIX = "/gateway/";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
};

function log(level, event, detail = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...detail });
  if (level === "error") console.error(line);
  else console.log(line);
}

function serveFile(res, filePath, status = 200) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  const { size } = statSync(filePath);
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": size,
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
  });
  createReadStream(filePath).pipe(res);
}

function serveStatic(req, res, pathname) {
  let relative = decodeURIComponent(pathname);
  if (relative.endsWith("/")) relative += "index.html";
  const candidate = path.join(WEB_ROOT, relative);
  if (!candidate.startsWith(WEB_ROOT + path.sep) && candidate !== WEB_ROOT) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }
  let file = candidate;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback: unknown paths render the app shell.
    file = path.join(WEB_ROOT, "index.html");
  }
  if (!existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found (web build missing)");
    return;
  }
  serveFile(res, file);
}

function proxyApi(req, res) {
  const headers = { ...req.headers };
  delete headers.origin; // API rejects disallowed origins; same-origin callers need none
  delete headers.host;
  delete headers.connection;
  delete headers["keep-alive"];
  delete headers["transfer-encoding"];
  delete headers["upgrade"];
  headers.host = upstream.host;

  const proxied = http.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: req.url,
      headers,
    },
    (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers };
      delete outHeaders["transfer-encoding"]; // node sets framing on its own
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
      // Pipe straight through so SSE streams flush per event, unbuffered.
      upstreamRes.pipe(res);
    },
  );
  proxied.on("error", (err) => {
    log("error", "api_proxy_error", { message: err.message, url: req.url });
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "OpenMuse API is unreachable" }));
    } else {
      res.end();
    }
  });
  req.pipe(proxied);
}

// Tunnel a WebSocket upgrade through to the loopback realtime gateway.
// The /gateway/ prefix is stripped (ws://host:8082/gateway/client?... →
// ws://127.0.0.1:51412/client?...); bytes flow untouched after the handshake,
// so the Phoenix protocol the app speaks passes through unmodified.
function proxyGatewayUpgrade(req, socket, head) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const targetPath = (url.pathname.slice(GATEWAY_PREFIX.length - 1) || "/") + (url.search || "");
  const headers = { ...req.headers, host: `${GATEWAY_UPSTREAM.hostname}:${GATEWAY_UPSTREAM.port}` };
  delete headers.origin; // the gateway is same-origin from its own perspective
  const proxied = http.request(
    {
      protocol: "http:",
      hostname: GATEWAY_UPSTREAM.hostname,
      port: GATEWAY_UPSTREAM.port || 80,
      method: "GET",
      path: targetPath,
      headers,
    },
    (gatewayRes) => {
      // A normal response means the gateway refused the upgrade; pass the verdict back.
      log("warn", "gateway_upgrade_refused", { status: gatewayRes.statusCode, url: req.url });
      socket.write(
        `HTTP/1.1 ${gatewayRes.statusCode} ${gatewayRes.statusMessage || ""}\r\n` +
          Object.entries(gatewayRes.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n",
      );
      gatewayRes.pipe(socket);
    },
  );
  proxied.on("upgrade", (gatewayRes, gatewaySocket, gatewayHead) => {
    socket.write(
      `HTTP/1.1 ${gatewayRes.statusCode} ${gatewayRes.statusMessage || "Switching Protocols"}\r\n` +
        Object.entries(gatewayRes.headers)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (gatewayHead?.length) socket.write(gatewayHead);
    if (head?.length) gatewaySocket.write(head);
    gatewaySocket.pipe(socket);
    socket.pipe(gatewaySocket);
    const drop = () => {
      socket.destroy();
      gatewaySocket.destroy();
    };
    socket.on("error", drop);
    gatewaySocket.on("error", drop);
    socket.on("close", () => gatewaySocket.destroy());
    gatewaySocket.on("close", () => socket.destroy());
  });
  proxied.on("error", (err) => {
    log("error", "gateway_proxy_error", { message: err.message, url: req.url });
    socket.destroy();
  });
  proxied.end();
}

if (!existsSync(path.join(WEB_ROOT, "index.html"))) {
  log("error", "web_root_missing", { webRoot: WEB_ROOT, hint: "Run: expo export --platform web --output-dir apps/mobile/dist/web" });
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/api/" || pathname.startsWith("/api/")) {
    proxyApi(req, res);
    return;
  }
  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "openmuse-web", upstream: API_UPSTREAM }));
    return;
  }
  serveStatic(req, res, pathname);
});

// Realtime gateway upgrades tunnel through /gateway/*; anything else is
// refused loudly rather than hanging the client.
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname.startsWith(GATEWAY_PREFIX)) {
    proxyGatewayUpgrade(req, socket, head);
    return;
  }
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  log("info", "listening", { host: HOST, port: PORT, webRoot: WEB_ROOT, upstream: API_UPSTREAM });
});
