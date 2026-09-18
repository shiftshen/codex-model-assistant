import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 官方 ChatGPT 登录的凭据由 Codex 维护；这里只读取，必要时按同样的方式续期。
export const authPath = path.join(os.homedir(), ".codex", "auth.json");
export const chatgptBaseURL = "https://chatgpt.com/backend-api/codex";
export const chatgptClientID = "app_EMoamEEZ73f0CkXaXp7hrann";
const tokenURL = "https://auth.openai.com/oauth/token";

export async function readAuth(file = authPath) {
  const auth = JSON.parse(await fs.readFile(file, "utf8"));
  if (auth.auth_mode !== "chatgpt" || !auth.tokens?.access_token) throw new Error("请先在 Codex 里登录 ChatGPT，再使用官方模型");
  return auth;
}

export function tokenExpiry(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString()).exp * 1000; }
  catch { return 0; }
}

export async function officialTokens({ file = authPath, now = Date.now() } = {}) {
  const auth = await readAuth(file);
  if (tokenExpiry(auth.tokens.access_token) - now > 120000) return auth.tokens;
  const response = await fetch(tokenURL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: chatgptClientID, grant_type: "refresh_token", refresh_token: auth.tokens.refresh_token, scope: "openid profile email" }),
  });
  if (!response.ok) throw new Error("ChatGPT 登录已过期，请在 Codex 里重新登录一次");
  const tokens = await response.json();
  const merged = { ...auth, tokens: { ...auth.tokens, ...tokens }, last_refresh: new Date(now).toISOString() };
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
  return merged.tokens;
}

export function officialHeaders(tokens, sessionID) {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${tokens.access_token}`,
    "chatgpt-account-id": tokens.account_id,
    originator: "codex_cli_rs",
    session_id: sessionID,
    "user-agent": "codex_cli_rs/0.155.0-alpha.2.6 (Mac OS; arm64) terminal",
  };
}

// 官方后端不接受 max_output_tokens 等服务端自己管理的参数。
export function officialPayload(payload, model) {
  const body = structuredClone(payload);
  delete body.max_output_tokens;
  delete body.service_tier;
  body.model = model;
  body.store = false;
  return body;
}
