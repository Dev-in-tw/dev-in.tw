/**
 * 啟動 mock API。
 *
 *   node mock/server.ts                         # 只有 API（:3001），給 `next dev` 的 /api rewrite 用
 *   MOCK_GATEWAY=http://localhost:3100 \
 *   PORT=3101 node mock/server.ts               # gateway 模式：/api 由 mock 處理，其餘轉給 Next
 *
 * gateway 模式模擬正式環境的 Traefik（`PathPrefix(/api)` 給 api、其餘給 web），e2e 用它搭配
 * `next start`，這樣 cookie、CSP 與同源行為都和正式環境一致。
 */
import { createServer, request } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createMockApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3001);
const gateway = process.env.MOCK_GATEWAY ? new URL(process.env.MOCK_GATEWAY) : null;
const api = getRequestListener(createMockApp().fetch);

const server = createServer((req, res) => {
  if (!gateway || req.url?.startsWith("/api/") || req.url === "/api") {
    void api(req, res);
    return;
  }
  const upstream = request(
    {
      host: gateway.hostname,
      port: gateway.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, "x-forwarded-proto": "http" },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("web upstream unavailable");
  });
  req.pipe(upstream);
});

server.listen(port, () => {
  const mode = gateway ? `gateway → ${gateway.origin}` : "api only";
  console.log(`[mock] Dev-in.tw mock API on http://localhost:${port} (${mode})`);
});
