/** Local browser fault injection only. Never use a real Key with this server. */
import http from "node:http";
import { pathToFileURL } from "node:url";

export function createMockTranslationServer({ allowedOrigin = "http://127.0.0.1:5173" } = {}) {
  return http.createServer(async (request, response) => {
    const blocked = request.url?.startsWith("/cors-blocked/");
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", ...(blocked ? {} : { "Access-Control-Allow-Origin": allowedOrigin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", Vary: "Origin" }) };
    if (request.method === "OPTIONS") { response.writeHead(204, headers); response.end(); return; }
    const send = (status, body) => { if (!response.destroyed) { response.writeHead(status, headers); response.end(JSON.stringify(body)); } };
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) { send(404, { error: { code: "not_found" } }); return; }
    let size = 0, body = "";
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 128 * 1024) { send(413, { error: { code: "too_large" } }); return; }
        body += chunk;
      }
      const payload = JSON.parse(body);
      // Only this well-known fake credential is accepted; don't log requests/headers/body.
      if (request.headers.authorization !== "Bearer mock-key-not-real") { send(401, { error: { code: "invalid_api_key" } }); return; }
      const fault = {
        "mock-model-missing": [404, "model_not_found"], "mock-balance": [402, "insufficient_balance"],
        "mock-rate-limit": [429, "rate_limit"], "mock-forbidden": [403, "forbidden"], "mock-server-error": [503, "unavailable"],
      }[payload.model];
      if (fault) { send(fault[0], { error: { code: fault[1] } }); return; }
      if (payload.model === "mock-bad-format") { send(200, { wrong: true }); return; }
      const completion = () => send(200, { choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
      if (payload.model === "mock-slow") {
        const timer = setTimeout(completion, 15000);
        response.on("close", () => clearTimeout(timer));
      } else completion();
    } catch { send(400, { error: { code: "bad_request" } }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_TRANSLATION_PORT || 19877);
  const server = createMockTranslationServer({ allowedOrigin: process.env.MOCK_TRANSLATION_ORIGIN || "http://127.0.0.1:5173" });
  server.listen(port, "127.0.0.1", () => process.stdout.write(`Mock translation server: http://127.0.0.1:${port}/v1 (fake credentials only)\n`));
}
