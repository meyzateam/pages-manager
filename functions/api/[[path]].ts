import { ensureProjectRegistry } from "../_lib/project-registry";

interface Env {
  CF_OAUTH_CLIENT_ID?: string;
  CF_OAUTH_CLIENT_SECRET?: string;
  CF_OAUTH_REDIRECT_URL?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URL?: string;
  SESSION_SECRET?: string;
  // Optional compatibility for sites deployed before the OAuth upgrade.
  ADMIN_PASSWORD?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  LEGACY_CLOUDFLARE_ACCOUNT_ID?: string;
  DB: D1Database;
}

type Ctx = { request: Request; env: Env; waitUntil?: (promise: Promise<unknown>) => void };
type CloudflareResult<T = any> = { result: T; result_info?: { page?: number; per_page?: number; total_count?: number; total_pages?: number }; success?: boolean; errors?: Array<{ message?: string }> };
type AnalyticsPayload = {
  site?: string;
  type?: string;
  visitor_id?: string;
  session_id?: string;
  path?: string;
  title?: string;
  referrer?: string;
  target_url?: string;
  ip?: string;
  user_agent?: string;
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
  colo?: string;
};

const API = "https://api.cloudflare.com/client/v4";
const OAUTH_AUTHORIZATION_URL = "https://dash.cloudflare.com/oauth2/auth";
const OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const OAUTH_REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
const SESSION_COOKIE = "pm_session_v2";
const OAUTH_STATE_COOKIE = "pm_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const INVENTORY_CACHE_TTL_SECONDS = 300;
const INVENTORY_FORCE_COOLDOWN_SECONDS = 60;
const PROJECT_INVENTORY_MAX_PAGES = 100;
const HEALTH_BATCH_LIMIT = 10;
const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const BRANCH_RE = /^[a-z0-9][a-z0-9-]{0,50}$/;
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(data, { status, headers });

class HttpError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

function validProjectName(value: string) {
  return PROJECT_RE.test(value);
}

function safeText(value: unknown, max = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  const size = Math.max(a.length, b.length);
  for (let i = 0; i < size; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function requireSessionSecret(env: Env) {
  const secret = String(env.SESSION_SECRET || "");
  if (secret.length < 32) throw new HttpError("SESSION_SECRET belum dikonfigurasi atau kurang dari 32 karakter.", 503);
  return secret;
}

function randomHex(bytes = 32) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacHex(secret: string, value: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return [...signed].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function createSessionCookie(env: Env, request: Request, sessionId: string, expiresAt: number) {
  const signature = await hmacHex(requireSessionSecret(env), `pages-manager-session-v2:${sessionId}:${expiresAt}`);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${sessionId}.${expiresAt}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

function clearSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
}

function clearOAuthStateCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${OAUTH_STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/api/auth/callback; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
}

function readCookie(request: Request, name: string) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const prefix = `${name}=`;
  const entry = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : "";
}

async function encryptionKey(env: Env) {
  const secret = requireSessionSecret(env);
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:pages-manager-oauth-token-encryption-v1`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptToken(env: Env, value: string) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await encryptionKey(env);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(cipher))}`;
}

async function decryptToken(env: Env, value: string) {
  const [ivText, cipherText, extra] = String(value || "").split(".");
  if (!ivText || !cipherText || extra !== undefined) throw new HttpError("Token Cloudflare tersimpan dalam format tidak valid. Silakan login ulang.", 401);
  try {
    const key = await encryptionKey(env);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlDecode(ivText) }, key, base64UrlDecode(cipherText));
    return new TextDecoder().decode(plain);
  } catch {
    throw new HttpError("Token Cloudflare tidak dapat dibuka. Periksa SESSION_SECRET dan login ulang.", 401);
  }
}

type CloudflareAccount = { id: string; name: string };
type DashboardSession = {
  sessionIdHash: string;
  userId: string;
  email: string;
  accessToken: string;
  accountId: string;
  accountName: string;
  accounts: CloudflareAccount[];
};

async function getDashboardSession(env: Env, request: Request): Promise<DashboardSession | null> {
  if (!env.DB) return null;
  const cookie = readCookie(request, SESSION_COOKIE);
  const [sessionId, expiresAtText, suppliedSignature, extra] = cookie.split(".");
  if (!sessionId || !expiresAtText || !suppliedSignature || extra !== undefined) return null;
  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return null;
  const expectedSignature = await hmacHex(requireSessionSecret(env), `pages-manager-session-v2:${sessionId}:${expiresAt}`);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) return null;

  const sessionIdHash = await sha256(sessionId);
  const row = await env.DB.prepare(`SELECT session_id_hash, user_id, user_email,
    access_token_ciphertext, refresh_token_ciphertext, token_expires_at, accounts_json,
    selected_account_id, selected_account_name, expires_at
    FROM oauth_sessions WHERE session_id_hash=? AND expires_at>?`).bind(sessionIdHash, Math.floor(Date.now() / 1000)).first<any>();
  if (!row) return null;

  let accessToken = await decryptToken(env, String(row.access_token_ciphertext || ""));
  let tokenExpiresAt = Number(row.token_expires_at || 0);
  if (tokenExpiresAt <= Math.floor(Date.now() / 1000) + 90) {
    if (!row.refresh_token_ciphertext) throw new HttpError("Sesi Cloudflare sudah kedaluwarsa. Silakan login ulang.", 401);
    const refreshToken = await decryptToken(env, String(row.refresh_token_ciphertext));
    const refreshed = await exchangeOAuthToken(env, {
      grant_type: "refresh_token",
      refresh_token: refreshToken
    });
    accessToken = String(refreshed.access_token || "");
    if (!accessToken) throw new HttpError("Cloudflare tidak mengembalikan access token baru. Silakan login ulang.", 401);
    tokenExpiresAt = Math.floor(Date.now() / 1000) + Number(refreshed.expires_in || 3600);
    const nextRefreshToken = String(refreshed.refresh_token || refreshToken);
    await env.DB.prepare(`UPDATE oauth_sessions SET access_token_ciphertext=?, refresh_token_ciphertext=?,
      token_expires_at=?, updated_at=CURRENT_TIMESTAMP WHERE session_id_hash=?`)
      .bind(await encryptToken(env, accessToken), await encryptToken(env, nextRefreshToken), tokenExpiresAt, sessionIdHash).run();
  }

  let accounts: CloudflareAccount[] = [];
  try {
    const parsed = JSON.parse(String(row.accounts_json || "[]"));
    if (Array.isArray(parsed)) accounts = parsed.filter((account) => /^[a-f0-9]{32}$/i.test(String(account?.id || "")) && String(account?.name || "").trim()).map((account) => ({ id: String(account.id), name: String(account.name) }));
  } catch { accounts = []; }

  return {
    sessionIdHash,
    userId: String(row.user_id),
    email: String(row.user_email || ""),
    accessToken,
    accountId: String(row.selected_account_id || ""),
    accountName: String(row.selected_account_name || ""),
    accounts
  };
}

async function exchangeOAuthToken(env: Env, values: Record<string, string>) {
  if (!env.CF_OAUTH_CLIENT_ID || !env.CF_OAUTH_CLIENT_SECRET) throw new HttpError("CF_OAUTH_CLIENT_ID dan CF_OAUTH_CLIENT_SECRET belum dikonfigurasi.", 503);
  const body = new URLSearchParams({
    client_id: env.CF_OAUTH_CLIENT_ID,
    client_secret: env.CF_OAUTH_CLIENT_SECRET,
    ...values
  });
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body
  });
  const raw = await response.text();
  let result: any = {};
  try { result = raw ? JSON.parse(raw) : {}; } catch { /* handled below */ }
  if (!response.ok || result.error || !result.access_token) {
    const description = safeText(result.error_description || result.error || `HTTP ${response.status}`, 240);
    throw new HttpError(`OAuth Cloudflare gagal: ${description}`, response.status >= 400 && response.status < 500 ? 401 : 502);
  }
  return result;
}

const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/webmasters",
  "https://www.googleapis.com/auth/siteverification"
].join(" ");

async function exchangeGoogleToken(env: Env, values: Record<string, string>) {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new HttpError("Google OAuth belum dikonfigurasi. Atur GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, dan GOOGLE_OAUTH_REDIRECT_URL.", 503);
  }
  const body = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    ...values
  });
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body
  });
  const raw = await response.text();
  let result: any = {};
  try { result = raw ? JSON.parse(raw) : {}; } catch { /* Report safe status below. */ }
  if (!response.ok || result.error || !result.access_token) {
    const message = safeText(result.error_description || result.error || `HTTP ${response.status}`, 220);
    throw new HttpError(`Google OAuth gagal: ${message}`, response.status >= 400 && response.status < 500 ? 401 : 502);
  }
  return result;
}

async function selectedGoogleEmail(env: Env, userId: string) {
  const row = await env.DB.prepare(`SELECT selected_google_email FROM google_account_preferences WHERE user_id=?`)
    .bind(userId).first<{ selected_google_email: string }>();
  return String(row?.selected_google_email || "").toLowerCase();
}

async function googleAccessToken(env: Env, userId: string) {
  const email = await selectedGoogleEmail(env, userId);
  if (!email) throw new HttpError("Pilih atau hubungkan akun Google terlebih dahulu melalui Settings.", 409);
  const row = await env.DB.prepare(`SELECT access_token_ciphertext, refresh_token_ciphertext, token_expires_at
    FROM google_accounts WHERE user_id=? AND google_email=?`).bind(userId, email).first<{
      access_token_ciphertext: string; refresh_token_ciphertext: string; token_expires_at: number
    }>();
  if (!row) throw new HttpError("Akun Google terpilih tidak ditemukan. Pilih ulang akun Google di Settings.", 409);
  let accessToken = await decryptToken(env, row.access_token_ciphertext);
  if (Number(row.token_expires_at || 0) <= Math.floor(Date.now() / 1000) + 90) {
    const refreshToken = await decryptToken(env, row.refresh_token_ciphertext);
    const refreshed = await exchangeGoogleToken(env, { grant_type: "refresh_token", refresh_token: refreshToken });
    accessToken = String(refreshed.access_token || "");
    if (!accessToken) throw new HttpError("Google tidak mengembalikan access token baru. Hubungkan ulang akun Google.", 401);
    const nextRefreshToken = String(refreshed.refresh_token || refreshToken);
    const expiresAt = Math.floor(Date.now() / 1000) + Number(refreshed.expires_in || 3600);
    await env.DB.prepare(`UPDATE google_accounts SET access_token_ciphertext=?, refresh_token_ciphertext=?,
      token_expires_at=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND google_email=?`)
      .bind(await encryptToken(env, accessToken), await encryptToken(env, nextRefreshToken), expiresAt, userId, email).run();
  }
  return accessToken;
}

async function googleApi(env: Env, userId: string, url: string, init: RequestInit = {}) {
  const accessToken = await googleAccessToken(env, userId);
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const raw = await response.text();
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { /* Safe HTTP failure below. */ }
  if (!response.ok) {
    const apiMessage = safeText(data.error?.message || data.error_description || data.error || `HTTP ${response.status}`, 320);
    const status = response.status === 401 ? 401 : response.status === 403 ? 403 : response.status === 404 ? 404 : response.status >= 500 ? 503 : 400;
    throw new HttpError(`Google API: ${apiMessage}`, status);
  }
  return data;
}

function validateGscSiteUrl(value: unknown, project: string) {
  const raw = safeText(value, 500);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new HttpError("URL property harus URL HTTPS yang valid.", 400); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new HttpError("Property URL harus origin HTTPS tanpa path, query, atau fragment.", 400);
  }
  const host = parsed.hostname.toLowerCase();
  const allowedPagesHost = `${project}.pages.dev`;
  if (host !== allowedPagesHost) {
    throw new HttpError(`Versi otomatis saat ini hanya memverifikasi property production https://${allowedPagesHost}/. Untuk custom domain, gunakan verifikasi DNS atau URL-prefix manual di Search Console.`, 400);
  }
  return `https://${host}/`;
}

async function serviceToken(env: Env, accountId: string, project: string) {
  // Per-account capability. The raw token is embedded only in the deployed
  // Pages Worker and its hash is stored in D1 for tenant-safe verification.
  return sha256(`${requireSessionSecret(env)}:pages-manager-worker-v2:${accountId}:${project}`);
}

function retryDelay(response: Response | null, attempt: number) {
  const retryAfter = response?.headers.get("retry-after") || "";
  const retrySeconds = Number(retryAfter);
  const requested = Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds * 1000 : 650 * (2 ** attempt);
  return Math.min(2600, requested) + Math.floor(Math.random() * 180);
}

function isRetryableCloudflareStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function cf<T = any>(
  env: Env,
  path: string,
  init: RequestInit = {},
  bearerToken = env.CLOUDFLARE_API_TOKEN,
  options: { stage?: string; maxAttempts?: number } = {}
): Promise<CloudflareResult<T>> {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${bearerToken}`);
  headers.set("Accept", "application/json");
  if (!(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const method = String(init.method || "GET").toUpperCase();
  // Asset requests are content-addressed and safe to repeat. Deployment creation
  // is intentionally not retried because a timeout could otherwise create duplicates.
  const idempotent = ["GET", "HEAD"].includes(method) || (method === "POST" && path.startsWith("/pages/assets/"));
  const maxAttempts = Math.max(1, Math.min(2, options.maxAttempts ?? (idempotent ? 2 : 1)));
  const stage = options.stage || path;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, { ...init, headers });
    } catch (error) {
      if (attempt + 1 < maxAttempts && !init.signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 650 * (2 ** attempt)));
        continue;
      }
      const detail = error instanceof Error ? safeText(error.message, 180) : "network error";
      throw new HttpError(`Tahap ${stage}: koneksi ke Cloudflare API gagal (${detail}). Coba kembali setelah koneksi stabil.`, 503);
    }

    const raw = await response.text();
    let body: CloudflareResult<T>;
    try {
      body = raw ? JSON.parse(raw) as CloudflareResult<T> : { result: null as T };
    } catch {
      if (isRetryableCloudflareStatus(response.status) && attempt + 1 < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
        continue;
      }
      const ray = response.headers.get("cf-ray");
      throw new HttpError(
        `Tahap ${stage}: Cloudflare API mengirim respons non-JSON (HTTP ${response.status}).${ray ? ` Ray ID ${ray}.` : ""} ${response.status >= 500 ? "Layanan Cloudflare kemungkinan sedang sibuk atau mengalami gangguan sementara; coba ulangi deploy." : "Periksa endpoint dan permission API Token."}`,
        response.status === 429 ? 429 : response.status >= 500 ? 503 : 502
      );
    }

    if (!response.ok || body.success === false) {
      const message = body.errors?.map((item) => item.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
      if (isRetryableCloudflareStatus(response.status) && attempt + 1 < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
        continue;
      }
      const ray = response.headers.get("cf-ray");
      throw new HttpError(`Tahap ${stage}: ${safeText(message, 300)}${ray ? ` (Ray ID ${ray})` : ""}`, response.status === 429 ? 429 : response.status >= 500 ? 503 : response.status);
    }
    return body;
  }

  throw new HttpError(`Tahap ${stage}: Cloudflare API belum pulih setelah percobaan ulang. Tunggu sebentar lalu coba deploy kembali.`, 503);
}

async function log(env: Env, accountId: string, action: string, project: string | null, detail: string) {
  await env.DB.prepare(
    "INSERT INTO activity_logs(action, project_name, detail, account_id) VALUES(?,?,?,?)"
  ).bind(action, project, detail.slice(0, 1000), accountId).run();
}

async function syncManagedProject(env: Env, accountId: string, project: string, token?: string) {
  const siteToken = token || await serviceToken(env, accountId, project);
  await env.DB.prepare(`INSERT INTO managed_projects_v2(account_id, project_name, site_token_hash, updated_at)
    VALUES(?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(account_id, project_name) DO UPDATE SET site_token_hash=excluded.site_token_hash, updated_at=CURRENT_TIMESTAMP`)
    .bind(accountId, project, await sha256(siteToken)).run();
}

// A Pages project that already received a successful Pages Manager deployment
// intentionally uses Advanced Mode (_worker.js). Scope this marker by account.
async function hasPagesManagerWorker(env: Env, accountId: string, project: string) {
  const row = await env.DB.prepare(
    "SELECT id FROM activity_logs WHERE account_id=? AND project_name=? AND action='deployment.create' AND detail LIKE '%Pages Worker enabled%' ORDER BY id DESC LIMIT 1"
  ).bind(accountId, project).first<{ id: number }>();
  if (row) return true;
  const legacyAccountId = String(env.LEGACY_CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "");
  if (legacyAccountId && accountId === legacyAccountId) {
    const legacy = await env.DB.prepare(
      "SELECT id FROM activity_logs WHERE account_id='' AND project_name=? AND action='deployment.create' AND detail LIKE '%Pages Worker enabled%' ORDER BY id DESC LIMIT 1"
    ).bind(project).first<{ id: number }>();
    return Boolean(legacy);
  }
  return false;
}

async function projectNameExists(env: Env, project: string, signal?: AbortSignal) {
  try {
    await cf(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${encodeURIComponent(project)}`, { signal });
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return false;
    throw error;
  }
}

async function verifyWorkerRequest(env: Env, project: string, request: Request): Promise<{ accountId: string } | null> {
  if (!validProjectName(project)) return null;
  const supplied = request.headers.get("x-pm-site-token") || "";
  if (!supplied) return null;
  const tokenHash = await sha256(supplied);
  const row = await env.DB.prepare("SELECT account_id FROM managed_projects_v2 WHERE project_name=? AND site_token_hash=?")
    .bind(project, tokenHash).first<{ account_id: string }>();
  if (row?.account_id) return { accountId: String(row.account_id) };

  // Keep previously deployed sites alive until the owner redeploys them with
  // the account-specific v2 Worker capability.
  const legacyAccountId = String(env.LEGACY_CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "");
  if (legacyAccountId && env.ADMIN_PASSWORD) {
    const legacyRow = await env.DB.prepare("SELECT project_name FROM managed_projects WHERE project_name=?")
      .bind(project).first<{ project_name: string }>();
    const legacyToken = await sha256(`${env.ADMIN_PASSWORD}:pages-manager-worker-v1:${project}`);
    if (legacyRow && constantTimeEqual(supplied, legacyToken)) return { accountId: legacyAccountId };
  }
  return null;
}

function parseUserAgent(userAgent: string) {
  const ua = userAgent.toLowerCase();
  const device = /ipad|tablet|kindle|silk/.test(ua)
    ? "Tablet"
    : /mobile|iphone|ipod|android/.test(ua)
      ? "Mobile"
      : "Desktop";
  const browser = /edg\//.test(ua) ? "Edge"
    : /opr\//.test(ua) || /opera/.test(ua) ? "Opera"
      : /firefox\//.test(ua) ? "Firefox"
        : /chrome\//.test(ua) && !/chromium/.test(ua) ? "Chrome"
          : /safari\//.test(ua) && !/chrome\//.test(ua) ? "Safari"
            : "Other";
  const os = /windows/.test(ua) ? "Windows"
    : /android/.test(ua) ? "Android"
      : /iphone|ipad|ipod/.test(ua) ? "iOS"
        : /mac os|macintosh/.test(ua) ? "macOS"
          : /linux/.test(ua) ? "Linux"
            : "Other";
  return { device, browser, os };
}

function normalizeOriginUrl(value: unknown) {
  const raw = safeText(value, 500);
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError("URL tujuan custom tidak valid.", 400);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new HttpError("URL tujuan custom harus berupa origin HTTPS, tanpa path, query, atau fragment.", 400);
  }
  return parsed.origin;
}

function normalizeDestinationUrl(value: unknown) {
  const raw = safeText(value, 2000);
  if (!raw) return "";
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new HttpError("URL tujuan rotator tidak valid.", 400); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new HttpError("URL tujuan rotator harus HTTPS dan tidak boleh memuat username/password.", 400);
  }
  return parsed.toString();
}

function buildPagesWorker(project: string, managerOrigin: string, token: string) {
  const settings = JSON.stringify({
    project,
    managerOrigin,
    token,
    productionHost: `${project}.pages.dev`,
  });

  // Pages Advanced Mode Worker: analytics, AMP-safe tracking and technical SEO.
  return `const PM = ${settings};

const CLIENT_SCRIPT = String.raw\`(() => {
  try {
    const makeId = () => (globalThis.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
    const safeStorage = (name) => {
      try { return globalThis[name]; } catch (_) { return null; }
    };
    const storageId = (storage, key) => {
      let value = "";
      try { value = storage ? storage.getItem(key) || "" : ""; } catch (_) {}
      if (!value) {
        value = makeId();
        try { if (storage) storage.setItem(key, value); } catch (_) {}
      }
      return value;
    };
    const visitorId = storageId(safeStorage("localStorage"), "pm_visitor_id");
    const sessionId = storageId(safeStorage("sessionStorage"), "pm_session_id");
    const cleanUrl = (value) => {
      try { const u = new URL(value, location.href); return u.origin + u.pathname; }
      catch (_) { return ""; }
    };
    const referrer = cleanUrl(document.referrer);
    const send = (type, targetUrl) => {
      const payload = JSON.stringify({
        type,
        visitor_id: visitorId,
        session_id: sessionId,
        path: location.pathname.slice(0, 1500),
        title: (document.title || "").slice(0, 300),
        referrer,
        target_url: targetUrl ? cleanUrl(targetUrl) : ""
      });
      try {
        const blob = new Blob([payload], { type: "application/json" });
        if (navigator.sendBeacon && navigator.sendBeacon("/__pm/track", blob)) return;
      } catch (_) {}
      fetch("/__pm/track", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: payload, keepalive: true, credentials: "same-origin"
      }).catch(() => {});
    };
    send("pageview", "");
    document.addEventListener("click", (event) => {
      const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (link) send("click", link.href);
    }, true);
  } catch (_) {}
})();\`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function isPreviewHost(hostname) {
  return hostname !== PM.productionHost && hostname.endsWith("." + PM.productionHost);
}

function publicOrigin(url) {
  return isPreviewHost(url.hostname) ? "https://" + PM.productionHost : url.origin;
}

function withNoIndex(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function textResponse(body, contentType = "text/plain; charset=utf-8", status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" }
  });
}

function insertIntoHead(html, fragment) {
  if (/<\\/head\\s*>/i.test(html)) return html.replace(/<\\/head\\s*>/i, fragment + "</head>");
  const opening = /<head\\b[^>]*>/i.exec(html);
  if (opening && typeof opening.index === "number") {
    const end = opening.index + opening[0].length;
    return html.slice(0, end) + fragment + html.slice(end);
  }
  const htmlTag = /<html\\b[^>]*>/i.exec(html);
  if (htmlTag && typeof htmlTag.index === "number") {
    const end = htmlTag.index + htmlTag[0].length;
    return html.slice(0, end) + "<head>" + fragment + "</head>" + html.slice(end);
  }
  return "<head>" + fragment + "</head>" + html;
}

function insertIntoBody(html, fragment) {
  if (/<\\/body\\s*>/i.test(html)) return html.replace(/<\\/body\\s*>/i, fragment + "</body>");
  return html + fragment;
}

function hasLinkRel(html, wanted) {
  const tags = html.match(/<link\\b[^>]*>/gi) || [];
  return tags.some((tag) => {
    const match = tag.match(/\\brel\\s*=\\s*["']([^"']+)["']/i);
    return Boolean(match && match[1].toLowerCase().split(/\\s+/).includes(wanted));
  });
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

let cachedSeoIndex = null;
async function readSeoIndex(env, url) {
  if (cachedSeoIndex) return cachedSeoIndex;
  try {
    const internalUrl = new URL("/__pm-seo-index.json", url.origin);
    const response = await env.ASSETS.fetch(new Request(internalUrl.toString()));
    if (!response.ok) return { routes: [], ampRoutes: [] };
    const data = await response.json();
    cachedSeoIndex = {
      routes: Array.isArray(data.routes) ? data.routes.filter((x) => typeof x === "string") : [],
      ampRoutes: Array.isArray(data.ampRoutes) ? data.ampRoutes.filter((x) => typeof x === "string") : []
    };
    return cachedSeoIndex;
  } catch (_) {
    return { routes: [], ampRoutes: [] };
  }
}

function hasRoute(routes, pathname) {
  const normalized = pathname || "/";
  const withoutSlash = normalized.length > 1 ? normalized.replace(/\\/$/, "") : normalized;
  const withSlash = normalized.endsWith("/") ? normalized : normalized + "/";
  return routes.includes(normalized) || routes.includes(withoutSlash) || routes.includes(withSlash);
}

async function generatedRobots(url, preview) {
  if (preview) return textResponse("User-agent: *\\nAllow: /\\n");
  const origin = publicOrigin(url);
  const body = "User-agent: *\\nAllow: /\\nDisallow: /__pm/\\nDisallow: /__pm-seo-index.json\\n\\nSitemap: " + origin + "/sitemap.xml\\n";
  return textResponse(body);
}

async function generatedSitemap(env, url) {
  const index = await readSeoIndex(env, url);
  const origin = publicOrigin(url);
  const routes = [...new Set(index.routes)].slice(0, 50000);
  const urls = routes.map((route) => {
    // File names may contain spaces or non-ASCII characters. Encode each path
    // segment while keeping slash separators, then XML-escape the absolute URL.
    const safePath = String(route || "/");
    const absoluteUrl = new URL(safePath.startsWith("/") ? safePath : "/" + safePath, origin).toString();
    return "  <url><loc>" + escapeXml(absoluteUrl) + "</loc></url>";
  }).join("\\n");
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\\n' + urls + '\\n</urlset>\\n';
  return textResponse(xml, "application/xml; charset=utf-8");
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function addAmpClickTargets(html, pageUrl) {
  return html.replace(/<a\\b[^>]*>/gi, (tag) => {
    if (/\\bdata-vars-target-url\\s*=/i.test(tag)) return tag;
    const match = tag.match(/\\bhref\\s*=\\s*(["'])(.*?)\\1/i);
    if (!match || /\\$\\{/.test(match[2])) return tag;
    let target;
    try {
      const parsed = new URL(match[2].replace(/&amp;/g, "&"), pageUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return tag;
      target = parsed.origin + parsed.pathname;
    } catch (_) { return tag; }
    const ending = tag.endsWith("/>") ? "/>" : ">";
    return tag.slice(0, -ending.length) + ' data-vars-target-url="' + escapeAttribute(target) + '"' + ending;
  });
}

function buildAmpAnalyticsMarkup(requestOrigin) {
  const macro = (name) => "$" + "{" + name + "}";
  const base = "/__pm/track-amp?url=" + macro("canonicalUrl") +
    "&visitor_id=" + macro("clientId(pm-visitor)") +
    "&title=" + macro("title") +
    "&referrer=" + macro("documentReferrer");
  const config = {
    // Keep analytics on the actual page origin even when the publisher has
    // intentionally configured a different canonical URL.
    requestOrigin,
    requests: {
      pageview: { baseUrl: base + "&type=pageview" },
      click: { baseUrl: base + "&target_url=" + macro("targetUrl") + "&type=click" }
    },
    triggers: {
      pmPageview: { on: "visible", request: "pageview" },
      pmAnchorClicks: { on: "click", selector: "a[href]", request: "click" }
    },
    transport: { beacon: false, xhrpost: false, image: true }
  };
  return '<amp-analytics id="pm-pages-manager-analytics"><script type="application/json">' +
    JSON.stringify(config) + '</script></amp-analytics>';
}

async function forwardEvent(request, ctx, suppliedPayload) {
  let payload = suppliedPayload;
  if (!payload) {
    try { payload = await request.json(); }
    catch (_) { return new Response("Bad Request", { status: 400 }); }
  }
  const type = payload && payload.type === "click" ? "click" : "pageview";
  const cf = request.cf || {};
  const event = {
    site: PM.project,
    type,
    visitor_id: String(payload.visitor_id || "").slice(0, 100),
    session_id: String(payload.session_id || "").slice(0, 100),
    path: String(payload.path || "/").slice(0, 1500),
    title: String(payload.title || "").slice(0, 300),
    referrer: String(payload.referrer || "").slice(0, 1000),
    target_url: String(payload.target_url || "").slice(0, 1000),
    ip: request.headers.get("CF-Connecting-IP") || "",
    user_agent: request.headers.get("User-Agent") || "",
    country: String(cf.country || "").slice(0, 10),
    region: String(cf.region || "").slice(0, 100),
    city: String(cf.city || "").slice(0, 100),
    timezone: String(cf.timezone || "").slice(0, 100),
    colo: String(cf.colo || "").slice(0, 20)
  };
  ctx.waitUntil(fetch(PM.managerOrigin + "/api/collect", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-pm-site-token": PM.token },
    body: JSON.stringify(event)
  }).catch(() => null));
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const preview = isPreviewHost(url.hostname);

    if (request.method === "GET" && /^\\/google[a-z0-9]+\\.html$/i.test(url.pathname)) {
      // Google ownership verification is fetched only when Google's verifier
      // requests the exact one-time file. Normal page loads incur no extra call.
      try {
        const verification = await fetch(PM.managerOrigin + "/api/public/google-verification?site=" +
          encodeURIComponent(PM.project) + "&file=" + encodeURIComponent(url.pathname.slice(1)) +
          "&origin=" + encodeURIComponent(url.origin), {
            headers: { "x-pm-site-token": PM.token, "Accept": "text/plain" },
            cf: { cacheTtl: 0 }
          });
        if (verification.ok) return verification;
        // Do not silently fall back to the static asset handler for a Google
        // verification filename. Surface the relay failure so the response
        // can be diagnosed instead of looking like a missing file.
        console.warn("Pages Manager Google verification relay returned", verification.status);
        return new Response("Google verification relay failed (HTTP " + verification.status + ").", {
          status: 502,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
        });
      } catch (error) {
        console.warn("Pages Manager Google verification relay could not be reached", error);
        return new Response("Google verification relay is temporarily unavailable.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
        });
      }
    }

    if (url.pathname === "/__pm-seo-index.json") {
      return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/__pm/client.js" && request.method === "GET") {
      const response = new Response(CLIENT_SCRIPT, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff"
        }
      });
      return preview ? withNoIndex(response) : response;
    }

    if (url.pathname === "/__pm/track" && request.method === "POST") {
      return forwardEvent(request, ctx);
    }

    if (url.pathname === "/__pm/track-amp" && request.method === "GET") {
      const query = url.searchParams;
      let pageUrl;
      try { pageUrl = new URL(query.get("url") || url.origin + "/"); } catch (_) { pageUrl = new URL(url.origin + "/"); }
      const payload = {
        type: query.get("type") === "click" ? "click" : "pageview",
        visitor_id: query.get("visitor_id") || "",
        session_id: "",
        path: pageUrl.pathname || "/",
        title: query.get("title") || "",
        referrer: query.get("referrer") || "",
        target_url: query.get("target_url") || ""
      };
      await forwardEvent(request, ctx, payload);
      const pixel = Uint8Array.from(atob("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="), (value) => value.charCodeAt(0));
      return new Response(pixel, { status: 200, headers: { "Content-Type": "image/gif", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }

    if (url.pathname === "/robots.txt" && request.method === "GET") {
      const asset = await env.ASSETS.fetch(request);
      const contentType = asset.headers.get("Content-Type") || "";
      if (asset.ok && !contentType.includes("text/html")) return preview ? withNoIndex(asset) : asset;
      const response = await generatedRobots(url, preview);
      return preview ? withNoIndex(response) : response;
    }

    if (url.pathname === "/sitemap.xml" && request.method === "GET") {
      const asset = await env.ASSETS.fetch(request);
      const contentType = asset.headers.get("Content-Type") || "";
      if (asset.ok && !contentType.includes("text/html")) return preview ? withNoIndex(asset) : asset;
      const response = await generatedSitemap(env, url);
      return preview ? withNoIndex(response) : response;
    }

    // Only rotate top-level production page requests. Branch aliases remain stable.
    const accept = request.headers.get("Accept") || "";
    if (!preview && (request.method === "GET" || request.method === "HEAD") &&
        url.hostname === PM.productionHost && accept.includes("text/html")) {
      try {
        const response = await fetch(PM.managerOrigin + "/api/rotator/resolve?site=" + encodeURIComponent(PM.project), {
          headers: { "x-pm-site-token": PM.token, "Accept": "application/json" },
          cf: { cacheTtl: 0 }
        });
        if (response.ok) {
          const result = await response.json();
          if (result && result.target) {
            const target = new URL(result.target);
            target.pathname = url.pathname;
            target.search = url.search;
            const redirect = Response.redirect(target.toString(), 302);
            const headers = new Headers(redirect.headers);
            headers.set("Cache-Control", "no-store, max-age=0");
            headers.set("Pragma", "no-cache");
            return new Response(null, { status: 302, headers });
          }
        }
      } catch (_) {
        // Fail open: serve the production deployment if the manager is down.
      }
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get("Content-Type") || "";
    if (request.method === "GET" && assetResponse.ok && contentType.includes("text/html")) {
      let html = await assetResponse.text();
      const index = await readSeoIndex(env, url);
      const canonicalBase = publicOrigin(url);
      const normalizedPath = url.pathname || "/";
      const isAmp = /<html\\b[^>]*(?:\\samp(?:\\s|=|>)|⚡)/i.test(html);
      const isAmpEmail = /<html\\b[^>]*amp4email/i.test(html);
      const headParts = [];
      const canonicalTagPresent = hasLinkRel(html, "canonical");
      const ampTagPresent = hasLinkRel(html, "amphtml");

      if (preview) {
        // Preview/branch deployments must never become competing indexable copies.
      }

      if (!isAmpEmail && !canonicalTagPresent) {
        let canonicalPath = normalizedPath;
        if (isAmp && !isAmpEmail) {
          const pairedPath = normalizedPath.replace(/^\\/amp(?=\\/|$)/i, "") || "/";
          if (hasRoute(index.routes, pairedPath)) canonicalPath = pairedPath;
        }
        headParts.push('<link rel="canonical" href="' + escapeXml(canonicalBase + canonicalPath) + '">');
      }

      if (!isAmpEmail && !isAmp && !ampTagPresent) {
        const candidateAmpPath = "/amp" + (normalizedPath.startsWith("/") ? normalizedPath : "/" + normalizedPath);
        if (hasRoute(index.ampRoutes, candidateAmpPath)) {
          headParts.push('<link rel="amphtml" href="' + escapeXml(canonicalBase + candidateAmpPath) + '">');
        }
      }

      if (isAmp && !isAmpEmail) {
        html = addAmpClickTargets(html, url.toString());
        if (!/<script\\b[^>]*custom-element=["']amp-analytics["']/i.test(html)) {
          headParts.push('<script async custom-element="amp-analytics" src="https://cdn.ampproject.org/v0/amp-analytics-0.1.js"></script>');
        }
        if (!/<script\\b[^>]*src=["']https:\\/\\/cdn\\.ampproject\\.org\\/v0\\.js["']/i.test(html)) {
          headParts.push('<script async src="https://cdn.ampproject.org/v0.js"></script>');
        }
        if (!/id=["']pm-pages-manager-analytics["']/i.test(html)) {
          html = insertIntoBody(html, buildAmpAnalyticsMarkup(url.origin));
        }
      } else if (!isAmpEmail && !html.includes("/__pm/client.js")) {
        const script = '<script defer src="/__pm/client.js"></script>';
        html = /<\\/body\\s*>/i.test(html)
          ? html.replace(/<\\/body\\s*>/i, script + "</body>")
          : html + script;
      }

      if (headParts.length) html = insertIntoHead(html, headParts.join(""));
      const headers = new Headers(assetResponse.headers);
      headers.delete("Content-Length");
      headers.delete("Content-Encoding");
      headers.set("Cache-Control", headers.get("Cache-Control") || "public, max-age=0, must-revalidate");
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      if (preview) headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
      return new Response(html, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
    }

    if (preview) return withNoIndex(assetResponse);
    return assetResponse;
  }
};
`;
}

async function collectAnalytics(env: Env, request: Request) {
  let body: AnalyticsPayload;
  try {
    body = await request.json() as AnalyticsPayload;
  } catch {
    return json({ error: "Invalid analytics payload." }, 400);
  }

  const project = safeText(body.site, 64).toLowerCase();
  const worker = await verifyWorkerRequest(env, project, request);
  if (!worker) return json({ error: "Unauthorized tracker." }, 401);

  const type = body.type === "click" ? "click" : body.type === "pageview" ? "pageview" : "";
  const visitorId = safeText(body.visitor_id, 100);
  let sessionId = safeText(body.session_id, 100);
  if (!type || !visitorId) return json({ error: "Incomplete analytics event." }, 400);
  // AMP uses the official AMP Client ID and cannot access sessionStorage. Reuse
  // the visitor's most recent session while activity is within the 30-minute window.
  if (!sessionId) {
    const recent = await env.DB.prepare(`
      SELECT session_id FROM analytics_events
      WHERE project_name=? AND account_id=? AND visitor_id=?
        AND datetime(created_at) >= datetime('now', '-30 minutes')
      ORDER BY id DESC LIMIT 1
    `).bind(project, worker.accountId, visitorId).first<{ session_id?: string }>();
    sessionId = safeText(recent?.session_id, 100) || randomHex(16);
  }

  const userAgent = safeText(body.user_agent, 1000);
  const parsed = parseUserAgent(userAgent);
  const ip = safeText(body.ip, 64);
  await env.DB.prepare(`
    INSERT INTO analytics_events (
      project_name, event_type, visitor_id, session_id, path, page_title,
      referrer, target_url, ip_address, country, region, city, timezone,
      colo, device_type, browser, operating_system, user_agent, account_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    project,
    type,
    visitorId,
    sessionId,
    safeText(body.path || "/", 1500),
    safeText(body.title, 300),
    safeText(body.referrer, 1000),
    safeText(body.target_url, 1000),
    ip,
    safeText(body.country, 10),
    safeText(body.region, 100),
    safeText(body.city, 100),
    safeText(body.timezone, 100),
    safeText(body.colo, 20),
    parsed.device,
    parsed.browser,
    parsed.os,
    userAgent,
    worker.accountId
  ).run();
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

async function resolveRotator(env: Env, request: Request, project: string) {
  const worker = await verifyWorkerRequest(env, project, request);
  if (!worker) return json({ error: "Unauthorized rotator." }, 401);
  const accountId = worker.accountId;
  let row = await env.DB.prepare(
    "SELECT enabled, mode, targets_json FROM rotator_configs_v2 WHERE account_id=? AND project_name=?"
  ).bind(accountId, project).first<{ enabled: number; mode: string; targets_json: string }>();
  const legacyAccountId = String(env.LEGACY_CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "");
  let usingLegacyConfig = false;
  if (!row && legacyAccountId && accountId === legacyAccountId) {
    row = await env.DB.prepare(
      "SELECT enabled, mode, targets_json FROM rotator_configs WHERE project_name=?"
    ).bind(project).first<{ enabled: number; mode: string; targets_json: string }>();
    usingLegacyConfig = Boolean(row);
  }
  if (!row?.enabled) return json({ target: null }, 200, { "Cache-Control": "no-store" });

  let configured: Array<{ branch: string; weight?: number; enabled?: boolean; url?: string }>;
  try { configured = JSON.parse(row.targets_json) as typeof configured; }
  catch { configured = []; }
  const targets = configured.filter((target) => {
    if (!target.enabled) return false;
    if (target.url) {
      try { const parsed = new URL(target.url); return parsed.protocol === "https:" && !parsed.username && !parsed.password; }
      catch { return false; }
    }
    return BRANCH_RE.test(target.branch);
  });
  if (!targets.length) return json({ target: null }, 200, { "Cache-Control": "no-store" });

  let selected: typeof targets[number] | undefined;
  if (row.mode === "round-robin") {
    const cursor = usingLegacyConfig
      ? await env.DB.prepare("UPDATE rotator_configs SET next_index=next_index+1 WHERE project_name=? RETURNING next_index")
        .bind(project).first<{ next_index: number }>()
      : await env.DB.prepare("UPDATE rotator_configs_v2 SET next_index=next_index+1 WHERE account_id=? AND project_name=? RETURNING next_index")
        .bind(accountId, project).first<{ next_index: number }>();
    const index = Math.max(0, (Number(cursor?.next_index || 1) - 1) % targets.length);
    selected = targets[index];
  } else if (row.mode === "weighted") {
    const weighted = targets.map((target) => ({ target, weight: Math.max(0, Number(target.weight || 0)) })).filter((item) => item.weight > 0);
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    if (total > 0) {
      let pick = Math.random() * total;
      selected = weighted[weighted.length - 1].target;
      for (const item of weighted) {
        pick -= item.weight;
        if (pick < 0) { selected = item.target; break; }
      }
    }
  } else {
    selected = targets[Math.floor(Math.random() * targets.length)];
  }
  if (!selected) return json({ target: null }, 200, { "Cache-Control": "no-store" });

  const destination = selected.url || `https://${selected.branch}.${project}.pages.dev`;
  return json({ target: destination }, 200, { "Cache-Control": "no-store" });
}

export const onRequest: PagesFunction<Env> = async ({ request, env }: Ctx) => {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/?/, "");
    const parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    const method = request.method;

    if (!env.DB) return json({ error: "D1 binding DB belum dikonfigurasi." }, 503);

    // Manual per-user Cloudflare API Token login. The token is validated server-side,
    // encrypted at rest in D1, and never returned to the browser.
    if (parts[0] === "auth" && parts[1] === "token-login" && method === "POST") {
      requireSessionSecret(env);
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const apiToken = String(body.api_token || "").trim();
      if (apiToken.length < 20 || apiToken.length > 512 || /\s/.test(apiToken)) {
        throw new HttpError("API Token tidak valid. Tempel token Cloudflare lengkap tanpa spasi.", 400);
      }
      const tokenEnv: Env = { ...env, CLOUDFLARE_API_TOKEN: apiToken };
      let user: any;
      let accountRows: any[] = [];
      try {
        const [userResult, firstAccounts] = await Promise.all([
          cf<any>(tokenEnv, "/user"),
          cf<any[]>(tokenEnv, "/accounts?page=1&per_page=20")
        ]);
        user = userResult.result || {};
        accountRows = Array.isArray(firstAccounts.result) ? [...firstAccounts.result] : [];
        const totalPages = Math.min(20, Math.max(1, Number(firstAccounts.result_info?.total_pages || 1)));
        for (let page = 2; page <= totalPages; page += 1) {
          const batch = await cf<any[]>(tokenEnv, `/accounts?page=${page}&per_page=20`);
          if (Array.isArray(batch.result)) accountRows.push(...batch.result);
        }
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) {
          throw new HttpError("Token diterima tetapi izinnya belum cukup. Aktifkan User Details Read, User Memberships Read, Account Settings Read, serta Cloudflare Pages Read dan Edit.", 403);
        }
        throw error;
      }
      const userId = safeText(user?.id, 100);
      const email = safeText(user?.email || "", 254).toLowerCase();
      const accounts: CloudflareAccount[] = [...new Map(accountRows
        .filter((account: any) => /^[a-f0-9]{32}$/i.test(String(account?.id || "")))
        .map((account: any) => [String(account.id), { id: String(account.id), name: safeText(account.name || "Cloudflare account", 120) }])).values()];
      if (!userId || !accounts.length) throw new HttpError("Token tidak memiliki akses untuk membaca profil dan akun Cloudflare. Periksa permission token.", 403);

      const sessionId = randomHex(32);
      const sessionIdHash = await sha256(sessionId);
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = now + SESSION_TTL_SECONDS;
      const selected = accounts.length === 1 ? accounts[0] : null;
      await env.DB.prepare(`INSERT INTO oauth_sessions(
        session_id_hash, user_id, user_email, access_token_ciphertext, refresh_token_ciphertext,
        token_expires_at, accounts_json, selected_account_id, selected_account_name, expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
        sessionIdHash, userId, email, await encryptToken(env, apiToken), null,
        expiresAt + 3600, JSON.stringify(accounts), selected?.id || null, selected?.name || null, expiresAt
      ).run();
      const response = json({ ok: true, user: { id: userId, email }, accounts, selected_account_id: selected?.id || "", selected_account_name: selected?.name || "" }, 200, { "Cache-Control": "no-store" });
      response.headers.append("Set-Cookie", await createSessionCookie(env, request, sessionId, expiresAt));
      return response;
    }

    if (parts[0] === "auth" && parts[1] === "start" && method === "GET") {
      try {
        requireSessionSecret(env);
        if (!env.CF_OAUTH_CLIENT_ID || !env.CF_OAUTH_CLIENT_SECRET || !env.CF_OAUTH_REDIRECT_URL) {
          throw new HttpError("OAuth Cloudflare belum dikonfigurasi. Atur CF_OAUTH_CLIENT_ID, CF_OAUTH_CLIENT_SECRET, dan CF_OAUTH_REDIRECT_URL.", 503);
        }
        const redirectUri = new URL(env.CF_OAUTH_REDIRECT_URL);
        if (redirectUri.origin !== url.origin || redirectUri.pathname !== "/api/auth/callback") {
          throw new HttpError("CF_OAUTH_REDIRECT_URL harus sama origin dan path dengan /api/auth/callback pada dashboard ini.", 503);
        }
        const state = randomHex(24);
        const authorize = new URL(OAUTH_AUTHORIZATION_URL);
        authorize.searchParams.set("client_id", env.CF_OAUTH_CLIENT_ID);
        authorize.searchParams.set("redirect_uri", env.CF_OAUTH_REDIRECT_URL);
        authorize.searchParams.set("response_type", "code");
        authorize.searchParams.set("scope", "openid offline_access account.read user-details.read pages.read pages.write");
        authorize.searchParams.set("state", state);
        const secure = url.protocol === "https:" ? "; Secure" : "";
        return new Response(null, { status: 302, headers: {
          Location: authorize.toString(),
          "Set-Cookie": `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/api/auth/callback; Max-Age=600${secure}`,
          "Cache-Control": "no-store"
        } });
      } catch (error) {
        const message = error instanceof Error ? error.message : "OAuth setup failed.";
        return Response.redirect(`${url.origin}/?oauth_error=${encodeURIComponent(message)}`, 302);
      }
    }

    if (parts[0] === "auth" && parts[1] === "callback" && method === "GET") {
      const stateCookie = readCookie(request, OAUTH_STATE_COOKIE);
      const state = url.searchParams.get("state") || "";
      const code = url.searchParams.get("code") || "";
      const oauthError = url.searchParams.get("error_description") || url.searchParams.get("error") || "";
      const fail = (message: string) => {
        const response = new Response(null, { status: 302, headers: { Location: `${url.origin}/?oauth_error=${encodeURIComponent(safeText(message, 300))}` } });
        response.headers.append("Set-Cookie", clearOAuthStateCookie(request));
        response.headers.set("Cache-Control", "no-store");
        return response;
      };
      if (oauthError) return fail(`Login Cloudflare dibatalkan: ${safeText(oauthError, 220)}`);
      if (!state || !stateCookie || !constantTimeEqual(state, stateCookie)) return fail("OAuth state tidak cocok. Silakan mulai login kembali.");
      if (!code) return fail("Cloudflare tidak mengembalikan authorization code.");

      try {
        requireSessionSecret(env);
        if (!env.CF_OAUTH_CLIENT_ID || !env.CF_OAUTH_CLIENT_SECRET || !env.CF_OAUTH_REDIRECT_URL) {
          throw new HttpError("OAuth Cloudflare belum dikonfigurasi di server.", 503);
        }
        const tokenResult = await exchangeOAuthToken(env, {
          grant_type: "authorization_code",
          code,
          redirect_uri: env.CF_OAUTH_REDIRECT_URL
        });
        const accessToken = String(tokenResult.access_token || "");
        const oauthEnv: Env = { ...env, CLOUDFLARE_API_TOKEN: accessToken };
        const [userResult, firstAccounts] = await Promise.all([
          cf<any>(oauthEnv, "/user"),
          cf<any[]>(oauthEnv, "/accounts?page=1&per_page=20")
        ]);
        const user = userResult.result || {};
        const userId = safeText(user.id, 64);
        const email = safeText(user.email, 254).toLowerCase();
        if (!userId || !email || !email.includes("@")) throw new HttpError("Profil Cloudflare tidak mengembalikan ID dan email yang valid. Pastikan scope user-details.read diberikan.", 403);

        const accountRows = Array.isArray(firstAccounts.result) ? [...firstAccounts.result] : [];
        const totalPages = Math.min(20, Math.max(1, Number(firstAccounts.result_info?.total_pages || 1)));
        if (totalPages > 1) {
          for (let page = 2; page <= totalPages; page += 1) {
            const batch = await cf<any[]>(oauthEnv, `/accounts?page=${page}&per_page=20`);
            if (Array.isArray(batch.result)) accountRows.push(...batch.result);
          }
        }
        const accounts: CloudflareAccount[] = [...new Map(accountRows
          .filter((account: any) => /^[a-f0-9]{32}$/i.test(String(account?.id || "")))
          .map((account: any) => [String(account.id), { id: String(account.id), name: safeText(account.name || "Cloudflare account", 120) }])).values()];
        if (!accounts.length) throw new HttpError("Tidak ada akun Cloudflare yang dapat diakses. Pastikan Anda memiliki keanggotaan akun dan memberikan scope account.read.", 403);

        const sessionId = randomHex(32);
        const sessionIdHash = await sha256(sessionId);
        const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
        const tokenExpiresAt = Math.floor(Date.now() / 1000) + Number(tokenResult.expires_in || 3600);
        const refreshToken = String(tokenResult.refresh_token || "");
        const selected = accounts.length === 1 ? accounts[0] : null;
        await env.DB.prepare(`INSERT INTO oauth_sessions(
          session_id_hash, user_id, user_email, access_token_ciphertext, refresh_token_ciphertext,
          token_expires_at, accounts_json, selected_account_id, selected_account_name, expires_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
          sessionIdHash,
          userId,
          email,
          await encryptToken(env, accessToken),
          refreshToken ? await encryptToken(env, refreshToken) : null,
          tokenExpiresAt,
          JSON.stringify(accounts),
          selected?.id || null,
          selected?.name || null,
          expiresAt
        ).run();

        const response = new Response(null, { status: 302, headers: { Location: url.origin } });
        response.headers.append("Set-Cookie", await createSessionCookie(env, request, sessionId, expiresAt));
        response.headers.append("Set-Cookie", clearOAuthStateCookie(request));
        response.headers.set("Cache-Control", "no-store");
        return response;
      } catch (error) {
        return fail(error instanceof Error ? error.message : "Gagal menyelesaikan login Cloudflare.");
      }
    }

    if (parts[0] === "google" && parts[1] === "connect" && method === "GET") {
      const requestedReturnPath = url.searchParams.get("return_to") || "/app/overview";
      let safeReturnPath = "/app/overview";
      try {
        const candidate = new URL(requestedReturnPath, url.origin);
        if (candidate.origin === url.origin && candidate.pathname.startsWith("/app/")) safeReturnPath = candidate.pathname.slice(0, 500);
      } catch { /* Fall back to Overview for malformed return paths. */ }
      const redirectError = (message: string) => {
        const target = new URL(safeReturnPath, url.origin);
        target.searchParams.set("google_oauth_error", safeText(message, 300));
        return Response.redirect(target.toString(), 302);
      };
      try {
        const session = await getDashboardSession(env, request);
        if (!session) throw new HttpError("Hubungkan Cloudflare terlebih dahulu.", 401);
        requireSessionSecret(env);
        if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OAUTH_REDIRECT_URL) {
          throw new HttpError("Google OAuth belum dikonfigurasi. Atur GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, dan GOOGLE_OAUTH_REDIRECT_URL di Cloudflare Pages secrets.", 503);
        }
        const redirectUri = new URL(env.GOOGLE_OAUTH_REDIRECT_URL);
        if (redirectUri.origin !== url.origin || redirectUri.pathname !== "/api/google/callback") {
          throw new HttpError("GOOGLE_OAUTH_REDIRECT_URL harus sama origin dan path dengan /api/google/callback pada dashboard ini.", 503);
        }
        await env.DB.prepare("DELETE FROM google_oauth_states WHERE expires_at<?").bind(Math.floor(Date.now() / 1000)).run();
        const state = randomHex(24);
        await env.DB.prepare("INSERT INTO google_oauth_states(state_hash, session_id_hash, expires_at, return_path) VALUES(?,?,?,?)")
          .bind(await sha256(state), session.sessionIdHash, Math.floor(Date.now() / 1000) + 600, safeReturnPath).run();
        const authorize = new URL(GOOGLE_OAUTH_AUTH_URL);
        authorize.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID);
        authorize.searchParams.set("redirect_uri", env.GOOGLE_OAUTH_REDIRECT_URL);
        authorize.searchParams.set("response_type", "code");
        authorize.searchParams.set("scope", GOOGLE_SCOPES);
        authorize.searchParams.set("access_type", "offline");
        authorize.searchParams.set("prompt", "select_account consent");
        authorize.searchParams.set("include_granted_scopes", "true");
        authorize.searchParams.set("state", state);
        return new Response(null, { status: 302, headers: { Location: authorize.toString(), "Cache-Control": "no-store" } });
      } catch (error) {
        return redirectError(error instanceof Error ? error.message : "Google OAuth setup failed.");
      }
    }

    if (parts[0] === "google" && parts[1] === "callback" && method === "GET") {
      const state = url.searchParams.get("state") || "";
      const stateHash = state ? await sha256(state) : "";
      const stateRow = state ? await env.DB.prepare(`SELECT session_id_hash, return_path FROM google_oauth_states
        WHERE state_hash=? AND expires_at>?`).bind(stateHash, Math.floor(Date.now() / 1000))
        .first<{ session_id_hash: string; return_path?: string }>() : null;
      const requestedPath = String(stateRow?.return_path || "/app/overview");
      let returnPath = "/app/overview";
      try {
        const candidate = new URL(requestedPath, url.origin);
        if (candidate.origin === url.origin && candidate.pathname.startsWith("/app/")) returnPath = candidate.pathname.slice(0, 500);
      } catch { /* Use Overview if the stored path is malformed. */ }
      const fail = (message: string) => {
        const target = new URL(returnPath, url.origin);
        target.searchParams.set("google_oauth_error", safeText(message, 300));
        return Response.redirect(target.toString(), 302);
      };
      const oauthError = url.searchParams.get("error_description") || url.searchParams.get("error") || "";
      if (state) await env.DB.prepare("DELETE FROM google_oauth_states WHERE state_hash=?").bind(stateHash).run();
      if (oauthError) return fail(`Akses Google dibatalkan: ${safeText(oauthError, 220)}`);
      const code = url.searchParams.get("code") || "";
      if (!state || !code) return fail("Google tidak mengembalikan state atau authorization code yang valid.");
      const session = await getDashboardSession(env, request);
      if (!session) return fail("Sesi Pages Manager berakhir selama proses Google OAuth. Login kembali lalu ulangi.");
      if (!stateRow || !constantTimeEqual(stateRow.session_id_hash, session.sessionIdHash)) return fail("Google OAuth state tidak cocok atau sudah kedaluwarsa. Silakan hubungkan ulang.");
      try {
        if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OAUTH_REDIRECT_URL) throw new HttpError("Google OAuth secrets belum lengkap.", 503);
        const tokenResult = await exchangeGoogleToken(env, {
          grant_type: "authorization_code", code, redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URL
        });
        const accessToken = String(tokenResult.access_token || "");
        const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
        const profile = await profileResponse.json().catch(() => ({})) as any;
        const email = safeText(profile.email, 254).toLowerCase();
        if (!profileResponse.ok || !email.includes("@")) throw new HttpError("Profil akun Google tidak dapat dibaca.", 502);
        const old = await env.DB.prepare("SELECT refresh_token_ciphertext FROM google_accounts WHERE user_id=? AND google_email=?")
          .bind(session.userId, email).first<{ refresh_token_ciphertext?: string }>();
        let refreshToken = String(tokenResult.refresh_token || "");
        if (!refreshToken && old?.refresh_token_ciphertext) refreshToken = await decryptToken(env, old.refresh_token_ciphertext);
        if (!refreshToken) throw new HttpError("Google tidak mengirim refresh token. Cabut akses Pages Manager pada Google Account → Security → Third-party connections, lalu hubungkan kembali.", 400);
        const expiresAt = Math.floor(Date.now() / 1000) + Number(tokenResult.expires_in || 3600);
        await env.DB.prepare(`INSERT INTO google_accounts(user_id, google_email, access_token_ciphertext, refresh_token_ciphertext, token_expires_at, scope_text, updated_at)
          VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(user_id, google_email) DO UPDATE SET
          access_token_ciphertext=excluded.access_token_ciphertext,
          refresh_token_ciphertext=excluded.refresh_token_ciphertext,
          token_expires_at=excluded.token_expires_at, scope_text=excluded.scope_text, updated_at=CURRENT_TIMESTAMP`)
          .bind(session.userId, email, await encryptToken(env, accessToken), await encryptToken(env, refreshToken), expiresAt, String(tokenResult.scope || GOOGLE_SCOPES)).run();
        await env.DB.prepare(`INSERT INTO google_account_preferences(user_id, selected_google_email, updated_at)
          VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET selected_google_email=excluded.selected_google_email, updated_at=CURRENT_TIMESTAMP`)
          .bind(session.userId, email).run();
        const returnTarget = new URL(returnPath, url.origin);
        returnTarget.searchParams.set("google_oauth", "connected");
        return Response.redirect(returnTarget.toString(), 302);
      } catch (error) {
        return fail(error instanceof Error ? error.message : "Gagal menyelesaikan Google OAuth.");
      }
    }

    // The managed site Worker calls this endpoint only for Google's one-time
    // verification file URL; normal visitor requests never call this route.
    if (parts[0] === "public" && parts[1] === "google-verification" && method === "GET") {
      const project = safeText(url.searchParams.get("site"), 32).toLowerCase();
      const file = safeText(url.searchParams.get("file"), 120);
      const origin = safeText(url.searchParams.get("origin"), 300);
      if (!PROJECT_RE.test(project) || !/^google[a-z0-9]+\.html$/i.test(file)) return new Response("Not Found", { status: 404 });
      const worker = await verifyWorkerRequest(env, project, request);
      if (!worker) return new Response("Not Found", { status: 404 });
      let requestOrigin: URL;
      try { requestOrigin = new URL(origin); } catch { return new Response("Not Found", { status: 404 }); }
      const property = await env.DB.prepare(`SELECT p.verification_file, p.site_url FROM gsc_properties p
        WHERE p.account_id=? AND p.project_name=? AND p.verification_file=? AND p.verification_status IN ('pending','verified') LIMIT 1`)
        .bind(worker.accountId, project, file).first<{ verification_file: string; site_url: string }>();
      if (!property) return new Response("Not Found", { status: 404 });
      const site = new URL(property.site_url);
      if (site.origin !== requestOrigin.origin || site.protocol !== "https:") return new Response("Not Found", { status: 404 });
      return new Response(`google-site-verification: ${file}`, { status: 200, headers: {
        "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff"
      } });
    }

    if (parts[0] === "auth" && parts[1] === "check" && method === "GET") {
      const session = await getDashboardSession(env, request);
      if (!session) return json({ error: "Sesi tidak aktif. Silakan hubungkan API Token Cloudflare." }, 401, { "Cache-Control": "no-store" });
      return json({
        ok: true,
        user: { id: session.userId, email: session.email },
        accounts: session.accounts,
        selected_account_id: session.accountId,
        selected_account_name: session.accountName
      }, 200, { "Cache-Control": "no-store" });
    }

    if (parts[0] === "auth" && parts[1] === "select-account" && method === "POST") {
      const session = await getDashboardSession(env, request);
      if (!session) return json({ error: "Sesi tidak aktif. Silakan login ulang." }, 401);
      let body: any = {};
      try { body = await request.json(); } catch { return json({ error: "Payload pemilihan akun tidak valid." }, 400); }
      const accountId = safeText(body.account_id, 32);
      const account = session.accounts.find((item) => item.id === accountId);
      if (!account) return json({ error: "Akun tersebut tidak termasuk dalam cakupan API Token Cloudflare Anda." }, 403);
      await env.DB.prepare(`UPDATE oauth_sessions SET selected_account_id=?, selected_account_name=?, updated_at=CURRENT_TIMESTAMP WHERE session_id_hash=?`)
        .bind(account.id, account.name, session.sessionIdHash).run();
      return json({ selected_account_id: account.id, selected_account_name: account.name }, 200, { "Cache-Control": "no-store" });
    }

    if (parts[0] === "auth" && parts[1] === "logout" && method === "POST") {
      const session = await getDashboardSession(env, request).catch(() => null);
      if (session) {
        const row = await env.DB.prepare("SELECT refresh_token_ciphertext FROM oauth_sessions WHERE session_id_hash=?")
          .bind(session.sessionIdHash).first<{ refresh_token_ciphertext?: string }>();
        const refreshCiphertext = row?.refresh_token_ciphertext;
        if (refreshCiphertext && env.CF_OAUTH_CLIENT_ID && env.CF_OAUTH_CLIENT_SECRET) {
          try {
            const refreshToken = await decryptToken(env, refreshCiphertext);
            const revokeBody = new URLSearchParams({ client_id: env.CF_OAUTH_CLIENT_ID, client_secret: env.CF_OAUTH_CLIENT_SECRET, token: refreshToken, token_type_hint: "refresh_token" });
            await fetch(OAUTH_REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: revokeBody });
          } catch { /* Local session revocation must still complete. */ }
        }
        await env.DB.prepare("DELETE FROM oauth_sessions WHERE session_id_hash=?").bind(session.sessionIdHash).run();
      }
      const response = json({ ok: true }, 200, { "Cache-Control": "no-store" });
      response.headers.append("Set-Cookie", clearSessionCookie(request));
      response.headers.append("Set-Cookie", clearOAuthStateCookie(request));
      return response;
    }

    // Public server-to-server endpoints are authenticated by a per-account
    // project capability token embedded in each managed Pages Worker.
    if (parts[0] === "collect" && method === "POST") return collectAnalytics(env, request);
    if (parts[0] === "rotator" && parts[1] === "resolve" && method === "GET") {
      const project = safeText(url.searchParams.get("site"), 64).toLowerCase();
      if (!validProjectName(project)) return json({ error: "Invalid project." }, 400);
      return resolveRotator(env, request, project);
    }

    const session = await getDashboardSession(env, request);
    if (!session) return json({ error: "Unauthorized. Silakan login menggunakan Cloudflare." }, 401, { "Cache-Control": "no-store" });
    if (!session.accountId) return json({ error: "Pilih akun Cloudflare terlebih dahulu." }, 409, { "Cache-Control": "no-store" });
    const accountId = session.accountId;
    const apiEnv: Env = { ...env, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: session.accessToken };

    if (parts[0] === "google" && parts[1] === "accounts" && method === "GET") {
      const rows = await env.DB.prepare(`SELECT google_email, token_expires_at, scope_text, created_at, updated_at
        FROM google_accounts WHERE user_id=? ORDER BY updated_at DESC`).bind(session.userId).all<any>();
      const selected = await selectedGoogleEmail(env, session.userId);
      const accounts = (rows.results || []).map((row: any) => ({
        google_email: String(row.google_email || ""),
        token_expires_at: Number(row.token_expires_at || 0),
        scope_text: String(row.scope_text || ""),
        created_at: row.created_at || "",
        updated_at: row.updated_at || ""
      }));
      return json({ accounts, selected_google_email: selected, connected: accounts.length > 0 }, 200, { "Cache-Control": "no-store" });
    }

    if (parts[0] === "google" && parts[1] === "select-account" && method === "POST") {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const email = safeText(body.google_email, 254).toLowerCase();
      if (!email.includes("@")) throw new HttpError("Pilih akun Google yang valid.", 400);
      const exists = await env.DB.prepare("SELECT google_email FROM google_accounts WHERE user_id=? AND google_email=?")
        .bind(session.userId, email).first<{ google_email: string }>();
      if (!exists) throw new HttpError("Akun Google tidak terhubung ke pengguna ini.", 403);
      await env.DB.prepare(`INSERT INTO google_account_preferences(user_id, selected_google_email, updated_at)
        VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET selected_google_email=excluded.selected_google_email, updated_at=CURRENT_TIMESTAMP`)
        .bind(session.userId, email).run();
      return json({ selected_google_email: email, selected: true }, 200, { "Cache-Control": "no-store" });
    }

    if (parts[0] === "google" && parts[1] === "disconnect" && method === "POST") {
      const email = await selectedGoogleEmail(env, session.userId);
      if (!email) return json({ disconnected: true, remaining_accounts: 0, property_records_retained: true });
      const connection = await env.DB.prepare("SELECT refresh_token_ciphertext FROM google_accounts WHERE user_id=? AND google_email=?")
        .bind(session.userId, email).first<{ refresh_token_ciphertext: string }>();
      if (connection?.refresh_token_ciphertext) {
        try {
          const refreshToken = await decryptToken(env, connection.refresh_token_ciphertext);
          await fetch("https://oauth2.googleapis.com/revoke", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: refreshToken })
          });
        } catch { /* Local disconnection must complete even if revocation is unavailable. */ }
      }
      await env.DB.prepare("DELETE FROM google_accounts WHERE user_id=? AND google_email=?").bind(session.userId, email).run();
      const next = await env.DB.prepare("SELECT google_email FROM google_accounts WHERE user_id=? ORDER BY updated_at DESC LIMIT 1")
        .bind(session.userId).first<{ google_email: string }>();
      if (next?.google_email) {
        await env.DB.prepare(`INSERT INTO google_account_preferences(user_id, selected_google_email, updated_at)
          VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET selected_google_email=excluded.selected_google_email, updated_at=CURRENT_TIMESTAMP`)
          .bind(session.userId, next.google_email).run();
      } else {
        await env.DB.prepare("DELETE FROM google_account_preferences WHERE user_id=?").bind(session.userId).run();
      }
      const remaining = await env.DB.prepare("SELECT COUNT(*) AS total FROM google_accounts WHERE user_id=?")
        .bind(session.userId).first<{ total: number }>();
      return json({ disconnected: true, selected_google_email: next?.google_email || "", remaining_accounts: Number(remaining?.total || 0), property_records_retained: true }, 200, { "Cache-Control": "no-store" });
    }

    if (parts[0] === "google" && parts[1] === "status" && method === "GET") {
      const project = safeText(url.searchParams.get("project"), 32).toLowerCase();
      if (!PROJECT_RE.test(project)) throw new HttpError("Project tidak valid.", 400);
      const googleEmail = await selectedGoogleEmail(env, session.userId);
      const property = googleEmail ? await env.DB.prepare(`SELECT site_url, verification_file, verification_status, search_console_status, search_console_added_at, verified_at,
        sitemap_url, sitemap_status, sitemap_submitted_at, updated_at FROM gsc_properties
        WHERE account_id=? AND project_name=? AND user_id=? AND google_email=? ORDER BY updated_at DESC LIMIT 1`)
        .bind(accountId, project, session.userId, googleEmail).first<any>() : null;
      return json({ connected: Boolean(googleEmail), google_email: googleEmail, property: property || null });
    }

    if (parts[0] === "google" && parts[1] === "properties" && method === "GET") {
      const googleEmail = await selectedGoogleEmail(env, session.userId);
      if (!googleEmail) return json({ connected: false, google_email: "", properties: [], total: 0 });
      const remote = await googleApi(env, session.userId, "https://www.googleapis.com/webmasters/v3/sites");
      const local = await env.DB.prepare(`SELECT project_name, site_url, verification_status, search_console_status,
        sitemap_url, sitemap_status, updated_at FROM gsc_properties WHERE user_id=? AND google_email=? AND account_id=?
        ORDER BY updated_at DESC`).bind(session.userId, googleEmail, accountId).all<any>();
      const localByUrl = new Map((local.results || []).map((row: any) => [String(row.site_url), row]));
      const properties = (Array.isArray(remote.siteEntry) ? remote.siteEntry : []).map((site: any) => {
        const siteUrl = String(site.siteUrl || "");
        const localRow: any = localByUrl.get(siteUrl) || null;
        let projectName = localRow?.project_name || "";
        if (!projectName) {
          try {
            const parsed = new URL(siteUrl);
            if (parsed.hostname.endsWith(".pages.dev")) projectName = parsed.hostname.slice(0, -".pages.dev".length);
          } catch { /* Domain properties do not have a URL hostname. */ }
        }
        return {
          site_url: siteUrl,
          permission_level: String(site.permissionLevel || "siteUnverifiedUser"),
          property_type: siteUrl.startsWith("sc-domain:") ? "domain" : "url-prefix",
          linked_project: projectName,
          verification_status: localRow?.verification_status || (String(site.permissionLevel || "") === "siteOwner" ? "verified" : "unknown"),
          search_console_status: localRow?.search_console_status || "listed",
          sitemap_url: localRow?.sitemap_url || "",
          sitemap_status: localRow?.sitemap_status || "unknown",
          updated_at: localRow?.updated_at || ""
        };
      }).sort((a: any, b: any) => a.site_url.localeCompare(b.site_url));
      return json({ connected: true, google_email: googleEmail, properties, total: properties.length,
        owner_count: properties.filter((item: any) => item.permission_level === "siteOwner").length,
        full_user_count: properties.filter((item: any) => item.permission_level === "siteFullUser").length,
        restricted_count: properties.filter((item: any) => item.permission_level === "siteRestrictedUser").length }, 200, { "Cache-Control": "no-store" });
    }

    if (parts[0] === "google" && parts[1] === "prepare" && method === "POST") {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const project = safeText(body.project_name, 32).toLowerCase();
      if (!PROJECT_RE.test(project)) throw new HttpError("Project tidak valid.", 400);
      const siteUrl = validateGscSiteUrl(body.site_url || `https://${project}.pages.dev/`, project);
      const googleEmail = await selectedGoogleEmail(env, session.userId);
      if (!googleEmail) throw new HttpError("Hubungkan atau pilih akun Google terlebih dahulu melalui Settings.", 409);

      // Avoid a second verification cycle when this Google account already has
      // owner/full-user access to the exact URL-prefix property.
      const siteList = await googleApi(env, session.userId, "https://www.googleapis.com/webmasters/v3/sites");
      const existingSite = (Array.isArray(siteList.siteEntry) ? siteList.siteEntry : [])
        .find((item: any) => String(item.siteUrl || "") === siteUrl);
      if (existingSite) {
        if (!["siteOwner", "siteFullUser"].includes(String(existingSite.permissionLevel || ""))) {
          throw new HttpError("Property sudah terdaftar, tetapi akun Google ini bukan owner/full user. Hubungkan akun pemilik atau minta akses penuh di Search Console.", 403);
        }
        const sitemapUrl = new URL("/sitemap.xml", siteUrl).toString();
        await env.DB.prepare(`INSERT INTO gsc_properties(account_id, project_name, user_id, google_email, site_url, verification_file,
          verification_status, search_console_status, search_console_added_at, sitemap_url, sitemap_status, updated_at)
          VALUES(?,?,?,?,?,?,'verified','added',CURRENT_TIMESTAMP,?,'not_submitted',CURRENT_TIMESTAMP)
          ON CONFLICT(account_id, project_name, user_id, site_url) DO UPDATE SET google_email=excluded.google_email,
          verification_file='', verification_status='verified', search_console_status='added',
          search_console_added_at=COALESCE(gsc_properties.search_console_added_at, CURRENT_TIMESTAMP),
          sitemap_url=excluded.sitemap_url, updated_at=CURRENT_TIMESTAMP`)
          .bind(accountId, project, session.userId, googleEmail, siteUrl, "", sitemapUrl).run();
        return json({ prepared: true, already_registered: true, sitemap_submitted: false, property_url: siteUrl, sitemap_url: sitemapUrl, google_email: googleEmail });
      }

      const tokenResult = await googleApi(env, session.userId, "https://www.googleapis.com/siteVerification/v1/token", {
        method: "POST", body: JSON.stringify({ verificationMethod: "FILE", site: { identifier: siteUrl, type: "SITE" } })
      });
      const verificationFile = safeText(tokenResult.token, 120);
      if (!/^google[a-z0-9]+\.html$/i.test(verificationFile)) throw new HttpError("Google mengembalikan nama file verifikasi dengan format tidak dikenal.", 502);
      const sitemapUrl = new URL("/sitemap.xml", siteUrl).toString();
      await env.DB.prepare(`INSERT INTO gsc_properties(account_id, project_name, user_id, google_email, site_url, verification_file,
        verification_status, search_console_status, sitemap_url, sitemap_status, updated_at) VALUES(?,?,?,?,?,?,'pending','not_added',?,'not_submitted',CURRENT_TIMESTAMP)
        ON CONFLICT(account_id, project_name, user_id, site_url) DO UPDATE SET google_email=excluded.google_email,
        verification_file=CASE WHEN gsc_properties.verification_status='verified' THEN gsc_properties.verification_file ELSE excluded.verification_file END,
        verification_status=CASE WHEN gsc_properties.verification_status='verified' THEN 'verified' ELSE 'pending' END,
        search_console_status=COALESCE(gsc_properties.search_console_status,'not_added'),
        sitemap_url=excluded.sitemap_url, updated_at=CURRENT_TIMESTAMP`)
        .bind(accountId, project, session.userId, googleEmail, siteUrl, verificationFile, sitemapUrl).run();
      return json({ prepared: true, property_url: siteUrl, verification_file: verificationFile, verification_url: new URL(verificationFile, siteUrl).toString(), sitemap_url: sitemapUrl, google_email: googleEmail });
    }

    if (parts[0] === "google" && parts[1] === "verify" && method === "POST") {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const project = safeText(body.project_name, 32).toLowerCase();
      if (!PROJECT_RE.test(project)) throw new HttpError("Project tidak valid.", 400);
      const property = await env.DB.prepare(`SELECT site_url, verification_file, verification_status, search_console_status, sitemap_url
        FROM gsc_properties WHERE account_id=? AND project_name=? AND user_id=? AND google_email=(SELECT selected_google_email FROM google_account_preferences WHERE user_id=?) ORDER BY updated_at DESC LIMIT 1`)
        .bind(accountId, project, session.userId, session.userId).first<any>();
      if (!property) throw new HttpError("Siapkan property Google terlebih dahulu.", 409);

      // Verification and Search Console registration are persisted separately.
      // A transient failure in a later step can then be retried without redoing
      // a successful ownership verification.
      if (property.verification_status !== "verified") {
        if (!property.verification_file) throw new HttpError("Token verifikasi Google belum tersedia. Siapkan property kembali.", 409);
        const verifiedResources = await googleApi(env, session.userId, "https://www.googleapis.com/siteVerification/v1/webResource");
        const alreadyVerified = (Array.isArray(verifiedResources.items) ? verifiedResources.items : [])
          .some((item: any) => item?.site?.type === "SITE" && String(item.site.identifier || "").replace(/\/$/, "") === String(property.site_url).replace(/\/$/, ""));
        if (!alreadyVerified) {
          const site = { identifier: property.site_url, type: "SITE" };
          await googleApi(env, session.userId, "https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=FILE", {
            method: "POST", body: JSON.stringify({ site })
          });
        }
        await env.DB.prepare(`UPDATE gsc_properties SET verification_status='verified', verified_at=COALESCE(verified_at,CURRENT_TIMESTAMP),
          updated_at=CURRENT_TIMESTAMP WHERE account_id=? AND project_name=? AND user_id=? AND site_url=?`)
          .bind(accountId, project, session.userId, property.site_url).run();
      }

      let propertyWarning = "";
      let propertyAdded = property.search_console_status === "added";
      if (!propertyAdded) {
        try {
          await googleApi(env, session.userId, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property.site_url)}`, { method: "PUT" });
          propertyAdded = true;
          await env.DB.prepare(`UPDATE gsc_properties SET search_console_status='added', search_console_added_at=CURRENT_TIMESTAMP,
            updated_at=CURRENT_TIMESTAMP WHERE account_id=? AND project_name=? AND user_id=? AND site_url=?`)
            .bind(accountId, project, session.userId, property.site_url).run();
        } catch (error) {
          propertyWarning = safeText(error instanceof Error ? error.message : "Pendaftaran property Search Console gagal.", 260);
        }
      }

      let sitemapWarning = "";
      if (propertyAdded) {
        try {
          await googleApi(env, session.userId, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property.site_url)}/sitemaps/${encodeURIComponent(property.sitemap_url)}`, { method: "PUT" });
          await env.DB.prepare(`UPDATE gsc_properties SET sitemap_status='submitted', sitemap_submitted_at=CURRENT_TIMESTAMP,
            updated_at=CURRENT_TIMESTAMP WHERE account_id=? AND project_name=? AND user_id=? AND site_url=?`)
            .bind(accountId, project, session.userId, property.site_url).run();
        } catch (error) {
          sitemapWarning = safeText(error instanceof Error ? error.message : "Pengiriman sitemap gagal.", 260);
        }
      }
      return json({ verified: true, property_added: propertyAdded, property_warning: propertyWarning,
        property_url: property.site_url, sitemap_url: property.sitemap_url,
        sitemap_submitted: propertyAdded && !sitemapWarning, sitemap_warning: sitemapWarning });
    }

    if (parts[0] === "google" && parts[1] === "sitemap" && method === "POST") {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const project = safeText(body.project_name, 32).toLowerCase();
      if (!PROJECT_RE.test(project)) throw new HttpError("Project tidak valid.", 400);
      const property = await env.DB.prepare(`SELECT site_url, sitemap_url, verification_status, search_console_status FROM gsc_properties
        WHERE account_id=? AND project_name=? AND user_id=? AND google_email=(SELECT selected_google_email FROM google_account_preferences WHERE user_id=?) AND verification_status='verified' AND search_console_status='added' ORDER BY updated_at DESC LIMIT 1`)
        .bind(accountId, project, session.userId, session.userId).first<any>();
      if (!property) throw new HttpError("Property belum diverifikasi.", 409);
      await googleApi(env, session.userId, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property.site_url)}/sitemaps/${encodeURIComponent(property.sitemap_url)}`, { method: "PUT" });
      const list = await googleApi(env, session.userId, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property.site_url)}/sitemaps`);
      await env.DB.prepare(`UPDATE gsc_properties SET sitemap_status='submitted', sitemap_submitted_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE account_id=? AND project_name=? AND user_id=? AND site_url=?`)
        .bind(accountId, project, session.userId, property.site_url).run();
      return json({ submitted: true, sitemap_url: property.sitemap_url, sitemaps: list.sitemap || [] });
    }

    if (parts[0] === "google" && parts[1] === "performance" && method === "GET") {
      const project = safeText(url.searchParams.get("project"), 32).toLowerCase();
      const days = Math.min(90, Math.max(7, Number(url.searchParams.get("days") || 28)));
      if (!PROJECT_RE.test(project)) throw new HttpError("Project tidak valid.", 400);
      const property = await env.DB.prepare(`SELECT site_url FROM gsc_properties WHERE account_id=? AND project_name=?
        AND user_id=? AND google_email=(SELECT selected_google_email FROM google_account_preferences WHERE user_id=?) AND verification_status='verified' AND search_console_status='added' ORDER BY updated_at DESC LIMIT 1`)
        .bind(accountId, project, session.userId, session.userId).first<{ site_url: string }>();
      if (!property) throw new HttpError("Property Search Console belum diverifikasi.", 409);
      const end = new Date(Date.now() - 3 * 86400000);
      const start = new Date(end.getTime() - (days - 1) * 86400000);
      const isoDate = (date: Date) => date.toISOString().slice(0, 10);
      const baseUrl = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property.site_url)}/searchAnalytics/query`;
      const [summary, queries, pages] = await Promise.all([
        googleApi(env, session.userId, baseUrl, { method: "POST", body: JSON.stringify({ startDate: isoDate(start), endDate: isoDate(end), rowLimit: 1 }) }),
        googleApi(env, session.userId, baseUrl, { method: "POST", body: JSON.stringify({ startDate: isoDate(start), endDate: isoDate(end), dimensions: ["query"], rowLimit: 15 }) }),
        googleApi(env, session.userId, baseUrl, { method: "POST", body: JSON.stringify({ startDate: isoDate(start), endDate: isoDate(end), dimensions: ["page"], rowLimit: 15 }) })
      ]);
      const totals = Array.isArray(summary.rows) ? summary.rows[0] || {} : {};
      return json({ days, start_date: isoDate(start), end_date: isoDate(end), totals, queries: queries.rows || [], pages: pages.rows || [] });
    }

    if (parts[0] === "google" && parts[1] === "inspect" && method === "POST") {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const project = safeText(body.project_name, 32).toLowerCase();
      const inspectionUrl = safeText(body.url, 2000);
      if (!PROJECT_RE.test(project)) throw new HttpError("Project tidak valid.", 400);
      const property = await env.DB.prepare(`SELECT site_url FROM gsc_properties WHERE account_id=? AND project_name=?
        AND user_id=? AND google_email=(SELECT selected_google_email FROM google_account_preferences WHERE user_id=?) AND verification_status='verified' AND search_console_status='added' ORDER BY updated_at DESC LIMIT 1`)
        .bind(accountId, project, session.userId, session.userId).first<{ site_url: string }>();
      if (!property) throw new HttpError("Property Search Console belum diverifikasi.", 409);
      let target: URL;
      try { target = new URL(inspectionUrl); } catch { throw new HttpError("Masukkan URL lengkap halaman yang akan diperiksa.", 400); }
      if (target.origin !== new URL(property.site_url).origin || target.protocol !== "https:") throw new HttpError("URL yang diperiksa harus berasal dari property website yang terhubung.", 400);
      const result = await googleApi(env, session.userId, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
        method: "POST", body: JSON.stringify({ inspectionUrl: target.toString(), siteUrl: property.site_url, languageCode: "id-ID" })
      });
      return json({ inspection: result.inspectionResult || result });
    }
    if (parts[0] === "projects" && parts[1] === "health" && method === "POST") {
      // Retired intentionally: probing *.pages.dev invokes the deployed Pages
      // Worker on every target site and can exhaust Workers request quotas.
      return json({ error: "Live domain probing dinonaktifkan. Status sekarang memakai metadata deployment Cloudflare Pages dari inventaris." }, 410, { "Cache-Control": "no-store" });
    }

    if (parts[0] === "project-name-check" && method === "GET") {
      const name = safeText(url.searchParams.get("name"), 32).toLowerCase();
      if (!validProjectName(name)) {
        return json({ available: false, valid: false, name, message: "Nama harus 1–32 karakter, dimulai huruf/angka, dan hanya memakai huruf kecil, angka, atau tanda hubung." }, 200);
      }
      const cached = await env.DB.prepare(`SELECT project_exists,
        CASE WHEN datetime(checked_at)>=datetime('now', '-60 seconds') THEN 1 ELSE 0 END AS fresh
        FROM project_name_check_cache WHERE account_id=? AND project_name=?`)
        .bind(accountId, name).first<{ project_exists: number; fresh: number }>();
      let exists: boolean;
      if (cached?.fresh) {
        exists = Boolean(cached.project_exists);
      } else {
        exists = await projectNameExists(apiEnv, name, request.signal);
        await env.DB.prepare(`INSERT INTO project_name_check_cache(account_id, project_name, project_exists, checked_at)
          VALUES(?,?,?,?) ON CONFLICT(account_id, project_name) DO UPDATE SET
          project_exists=excluded.project_exists, checked_at=excluded.checked_at`)
          .bind(accountId, name, exists ? 1 : 0, new Date().toISOString()).run();
      }
      return json({ available: !exists, valid: true, exists, name, cached: Boolean(cached?.fresh), message: exists ? "Nama project sudah digunakan di akun Cloudflare ini." : "Nama belum ditemukan pada akun ini. Cloudflare juga akan memvalidasi reservasi nama global saat project dibuat." });
    }

    if (parts[0] === "projects" && parts.length === 1 && method === "GET") {
      // Inventory is cached per Cloudflare account for five minutes. A manual
      // refresh may bypass the cache, but only once per 60 seconds per account.
      const forceRefresh = url.searchParams.get("force") === "1";
      const cached = await env.DB.prepare(`SELECT response_json,
          CASE WHEN datetime(checked_at)>=datetime('now', '-${INVENTORY_CACHE_TTL_SECONDS} seconds') THEN 1 ELSE 0 END AS fresh,
          CASE WHEN datetime(checked_at)>=datetime('now', '-${INVENTORY_FORCE_COOLDOWN_SECONDS} seconds') THEN 1 ELSE 0 END AS cooling
        FROM project_inventory_cache WHERE account_id=?`)
        .bind(accountId).first<{ response_json: string; fresh: number; cooling: number }>();
      if (cached?.response_json && ((!forceRefresh && cached.fresh) || (forceRefresh && cached.cooling))) {
        try {
          const cachedData = JSON.parse(cached.response_json);
          const names = Array.isArray(cachedData.projects) ? cachedData.projects.map((item: any) => String(item?.name || "")) : [];
          const uidByName = await ensureProjectRegistry(env.DB, accountId, names);
          for (const item of cachedData.projects || []) item.project_uid = uidByName[String(item?.name || "")] || "";
          return json(cachedData, 200, { "Cache-Control": "private, max-age=30" });
        } catch { /* Replace malformed cache with a fresh Cloudflare inventory. */ }
      }
      const projects: any[] = [];
      const perPage = 20;
      const maxPages = PROJECT_INVENTORY_MAX_PAGES;
      let loadedAll = true;
      let cloudflareTotalCount: number | undefined;
      const fetchProjectPage = async (page: number) => {
        // Cloudflare Pages list endpoint validates list options differently
        // from generic account endpoints. Omit per_page entirely and use the
        // API default (20); only send page for subsequent pages.
        const query = page > 1 ? `?page=${page}` : "";
        const result = await cf<any[]>(apiEnv,
          `/accounts/${accountId}/pages/projects${query}`
        );
        return {
          rows: Array.isArray(result.result) ? result.result : [],
          totalPages: result.result_info?.total_pages,
          totalCount: result.result_info?.total_count
        };
      };

      const firstPage = await fetchProjectPage(1);
      projects.push(...firstPage.rows);
      if (typeof firstPage.totalCount === "number") cloudflareTotalCount = firstPage.totalCount;
      const reportedPages = Number(firstPage.totalPages || 0);
      if (reportedPages > 0) {
        const pageLimit = Math.min(reportedPages, maxPages);
        // Fetch additional inventory pages in small parallel batches instead
        // of awaiting every Cloudflare API request sequentially.
        for (let start = 2; start <= pageLimit; start += 5) {
          const pageNumbers = Array.from({ length: Math.min(5, pageLimit - start + 1) }, (_, index) => start + index);
          const batches = await Promise.all(pageNumbers.map(fetchProjectPage));
          for (const batch of batches) projects.push(...batch.rows);
        }
        if (reportedPages > maxPages) loadedAll = false;
      } else {
        for (let page = 2; page <= maxPages; page += 1) {
          const batch = await fetchProjectPage(page);
          projects.push(...batch.rows);
          if (typeof batch.totalCount === "number") cloudflareTotalCount = batch.totalCount;
          if (batch.rows.length < perPage) break;
          if (page === maxPages) loadedAll = false;
        }
      }

      const managed = projects
        .map((project) => String(project?.name || ""))
        .filter((name) => validProjectName(name));
      const legacyAccountId = String(env.LEGACY_CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "");
      const includeLegacy = legacyAccountId && accountId === legacyAccountId ? 1 : 0;
      const workerLogRows = await env.DB.prepare(
        "SELECT project_name, detail FROM activity_logs WHERE (account_id=? OR (account_id='' AND ?=1)) AND action='deployment.create' AND detail LIKE '%Pages Worker enabled%' ORDER BY id DESC LIMIT 5000"
      ).bind(accountId, includeLegacy).all<any>();
      const managerWorkerVersions = new Map<string, string>();
      for (const row of workerLogRows.results || []) {
        const name = String(row.project_name || "");
        if (!managerWorkerVersions.has(name)) {
          const match = String(row.detail || "").match(/Pages Worker version ([0-9.]+)/i);
          managerWorkerVersions.set(name, match?.[1] || "legacy");
        }
      }
      for (const project of projects) {
        const version = managerWorkerVersions.get(String(project?.name || "")) || "";
        project.manager_worker_installed = Boolean(version);
        project.manager_worker_version = version;
      }
      if (managed.length) {
        // Store a tenant-scoped Worker capability for each project. Batch D1
        // writes to avoid one database round-trip per project.
        const statements = await Promise.all(managed.map(async (name) => {
          const token = await serviceToken(env, accountId, name);
          return env.DB.prepare(`INSERT INTO managed_projects_v2(account_id, project_name, site_token_hash, updated_at)
            VALUES(?,?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(account_id, project_name) DO UPDATE SET site_token_hash=excluded.site_token_hash, updated_at=CURRENT_TIMESTAMP`)
            .bind(accountId, name, await sha256(token));
        }));
        if (env.DB.batch) {
          for (let start = 0; start < statements.length; start += 100) await env.DB.batch(statements.slice(start, start + 100));
        } else {
          await Promise.all(statements.map((statement) => statement.run()));
        }
      }
      const uidByName = await ensureProjectRegistry(env.DB, accountId, managed);
      for (const project of projects) project.project_uid = uidByName[String(project?.name || "")] || "";
      const responseData = {
        projects,
        pagination: {
          total_count: cloudflareTotalCount ?? projects.length,
          returned_count: projects.length,
          loaded_all: loadedAll && projects.length >= (cloudflareTotalCount ?? projects.length)
        }
      };
      await env.DB.prepare(`INSERT INTO project_inventory_cache(account_id, response_json, checked_at)
        VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET
        response_json=excluded.response_json, checked_at=excluded.checked_at`)
        .bind(accountId, JSON.stringify(responseData), new Date().toISOString()).run();
      return json(responseData, 200, { "Cache-Control": "private, max-age=15" });
    }

    if (parts[0] === "projects" && parts.length === 1 && method === "POST") {
      const body = await request.json() as { name?: unknown };
      const name = safeText(body.name, 32).toLowerCase();
      if (!validProjectName(name)) {
        return json({ error: "Nama project harus 1–32 karakter, diawali huruf/angka, dan hanya berisi huruf kecil, angka, atau tanda hubung." }, 400);
      }
      if (await projectNameExists(apiEnv, name, request.signal)) {
        return json({ error: `Project name "${name}" sudah digunakan. Pilih nama lain.` }, 409);
      }
      let result: CloudflareResult<any>;
      try {
        result = await cf(apiEnv, `/accounts/${accountId}/pages/projects`, {
        method: "POST",
        body: JSON.stringify({
          name,
          production_branch: "main",
          deployment_configs: {
            preview: { compatibility_date: "2026-11-08" },
            production: { compatibility_date: "2026-11-08" }
          }
        })
        });
      } catch (error) {
        if (error instanceof HttpError && (error.status === 409 || /already exists|already in use|project.*exist|name.*taken/i.test(error.message))) {
          return json({ error: `Project name "${name}" sudah digunakan. Pilih nama lain.` }, 409);
        }
        throw error;
      }
      await syncManagedProject(env, accountId, name);
      await ensureProjectRegistry(env.DB, accountId, [name]);
      await env.DB.prepare("DELETE FROM project_name_check_cache WHERE account_id=? AND project_name=?").bind(accountId, name).run();
      await env.DB.prepare("DELETE FROM project_inventory_cache WHERE account_id=?").bind(accountId).run();
      await log(env, accountId, "project.create", name, "Created Direct Upload Pages project");
      return json({ project: result.result }, 201);
    }

    const project = parts[1] || "";
    if (parts[0] === "projects" && project && !validProjectName(project)) return json({ error: "Invalid project name." }, 400);

    if (parts[0] === "projects" && project && parts.length === 2 && method === "DELETE") {
      await cf(apiEnv, `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}`, { method: "DELETE" });
      await env.DB.prepare("DELETE FROM rotator_configs_v2 WHERE account_id=? AND project_name=?").bind(accountId, project).run();
      await env.DB.prepare("DELETE FROM managed_projects_v2 WHERE account_id=? AND project_name=?").bind(accountId, project).run();
      await env.DB.prepare("DELETE FROM project_registry WHERE account_id=? AND project_name=?").bind(accountId, project).run();
      await env.DB.prepare("DELETE FROM project_name_check_cache WHERE account_id=? AND project_name=?").bind(accountId, project).run();
      await env.DB.prepare("DELETE FROM project_inventory_cache WHERE account_id=?").bind(accountId).run();
      await log(env, accountId, "project.delete", project, "Cloudflare Pages project deleted");
      return json({ ok: true });
    }

    if (parts[0] === "projects" && project && parts[2] === "deployments" && parts[3] && method === "GET") {
      const deploymentId = parts[3];
      if (!/^[0-9a-f-]{16,64}$/i.test(deploymentId)) return json({ error: "Deployment ID tidak valid." }, 400);
      const result = await cf(apiEnv,
        `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(deploymentId)}`
      );
      const deployStage = Array.isArray(result.result?.stages) ? result.result.stages.find((stage: any) => String(stage?.name || "").toLowerCase() === "deploy") : null;
      const deploymentStatus = String(result.result?.latest_stage?.status || deployStage?.status || "").toLowerCase();
      if (deploymentStatus === "success") {
        try { await env.DB.prepare("DELETE FROM project_inventory_cache WHERE account_id=?").bind(accountId).run(); }
        catch (error) { console.warn("Could not invalidate project inventory after successful deployment", error); }
      }
      return json({ deployment: result.result });
    }

    if (parts[0] === "projects" && project && parts[2] === "deployments" && method === "GET") {
      const deployments: any[] = [];
      // The project panel needs recent history, not an unbounded archive scan.
      const perPage = 20;
      for (let page = 1; page <= 2; page += 1) {
        const query = page > 1 ? `?page=${page}` : "";
        const result = await cf<any[]>(apiEnv,
          `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/deployments${query}`
        );
        const batch = Array.isArray(result.result) ? result.result : [];
        deployments.push(...batch);
        if (typeof result.result_info?.total_pages === "number") {
          if (page >= result.result_info.total_pages) break;
        } else if (batch.length < perPage) {
          break;
        }
      }
      return json({ deployments });
    }

    if (parts[0] === "projects" && project && parts[2] === "deploy" && method === "POST") {
      const form = await request.formData();
      const branch = safeText(form.get("branch") || "main", 51).toLowerCase();
      if (!BRANCH_RE.test(branch)) return json({ error: "Branch harus berupa huruf kecil, angka, atau tanda hubung (maksimal 51 karakter)." }, 400);

      const projectInfo = await cf<any>(apiEnv, `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}`);
      const managerWorkerInstalled = await hasPagesManagerWorker(env, accountId, project);
      if (projectInfo.result?.uses_functions && !managerWorkerInstalled && form.get("replace_functions") !== "true") {
        return json({
          error: "Project ini memiliki Pages Functions yang belum dikelola Pages Manager. Advanced mode _worker.js akan mengambil alih routing dan mengabaikan folder /functions. Centang persetujuan penggantian hanya bila Anda memang ingin memigrasikan fungsi tersebut ke Worker Pages Manager."
        }, 409);
      }

      const entries = [...form.entries()].filter(([key, value]) => key === "files" && value instanceof File) as [string, File][];
      if (!entries.length) return json({ error: "Pilih minimal satu file website terlebih dahulu." }, 400);
      if (entries.length > 20000) return json({ error: "Cloudflare Pages membatasi manifest maksimal 20.000 file per deployment." }, 413);

      // File checksums are computed in a browser Web Worker. Re-hashing all
      // website bytes in this Pages Function can exceed a Free Worker CPU budget.
      const hashManifestRaw = form.get("_pm_hash_manifest");
      if (typeof hashManifestRaw !== "string" || hashManifestRaw.length > 8 * 1024 * 1024) {
        return json({ error: "Manifest checksum file tidak ditemukan atau terlalu besar. Muat ulang dashboard versi terbaru lalu pilih file kembali." }, 400);
      }
      let hashRows: Array<{ path: string; hash: string }>;
      try { hashRows = JSON.parse(hashManifestRaw); }
      catch { return json({ error: "Manifest checksum file tidak valid. Pilih ulang file website." }, 400); }
      if (!Array.isArray(hashRows) || hashRows.length !== entries.length) {
        return json({ error: "Jumlah checksum tidak cocok dengan jumlah file yang diterima. Pilih ulang file website." }, 400);
      }
      const hashByPath = new Map<string, string>();
      for (const item of hashRows) {
        const itemPath = safeText(item?.path, 1500).replace(/\\/g, "/").replace(/^\/+/, "");
        const itemHash = String(item?.hash || "").toLowerCase();
        if (!itemPath || !/^[a-f0-9]{32}$/.test(itemHash) || hashByPath.has(itemPath)) {
          return json({ error: "Manifest berisi path atau checksum yang tidak valid." }, 400);
        }
        hashByPath.set(itemPath, itemHash);
      }

      const manifest: Record<string, string> = {};
      const uploadFiles: Array<{ hash: string; file: File; path: string; contentType: string }> = [];
      const seen = new Set<string>();
      let totalBytes = 0;

      for (const [, file] of entries) {
        const path = file.name.replace(/\\/g, "/").replace(/^\/+/, "");
        const segments = path.split("/");
        if (!path || path.length > 1500 || segments.some((segment) => !segment || segment === "." || segment === "..") || path.includes("\u0000")) {
          return json({ error: `Path file tidak aman: ${file.name}` }, 400);
        }
        if (seen.has(path)) return json({ error: `Path file duplikat: ${path}` }, 400);
        seen.add(path);
        if (path === "_worker.js" || path === "_worker.bundle") return json({ error: "Nama _worker.js dan _worker.bundle dikelola otomatis oleh Pages Manager." }, 400);
        if (path.toLowerCase().startsWith("__pm/") || (path.toLowerCase() === "__pm-seo-index.json" && file.type !== "application/json")) {
          return json({ error: `Path ${path} dicadangkan untuk sistem analytics dan SEO Pages Manager.` }, 400);
        }

        totalBytes += file.size;
        if (file.size > 25 * 1024 * 1024 || totalBytes > 90 * 1024 * 1024) {
          return json({ error: "Batas upload saat ini 25 MiB per file dan 90 MiB total per deployment (ada ruang untuk overhead multipart)." }, 413);
        }

        const hash = hashByPath.get(path);
        if (!hash) return json({ error: `Checksum untuk file ${path} tidak ditemukan. Pilih ulang file website.` }, 400);
        const contentType = file.type || inferContentType(path);
        manifest[`/${path}`] = hash;
        uploadFiles.push({ hash, file, path, contentType });
      }
      if (hashByPath.size !== seen.size) return json({ error: "Manifest checksum memuat file yang tidak cocok dengan upload." }, 400);

      if (!seen.has("index.html")) {
        return json({ error: "File index.html tidak ditemukan di root website. Pilih folder hasil build yang langsung berisi index.html (contoh: dist/index.html), bukan folder source project." }, 400);
      }
      if (!seen.has("__pm-seo-index.json")) {
        return json({ error: "Indeks SEO internal tidak ditemukan. Muat ulang Pages Manager versi terbaru, lalu pilih ulang folder website." }, 400);
      }

      // Cloudflare Pages Direct Upload is a two-stage process: store the actual
      // asset bytes first, then create a deployment that references their hashes.
      const accountPath = `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}`;
      const uploadTokenResponse = await cf<{ jwt?: string }>(apiEnv, `${accountPath}/upload-token`, {}, undefined, { stage: "meminta upload token" });
      const uploadJwt = uploadTokenResponse.result?.jwt;
      if (!uploadJwt) throw new HttpError("Cloudflare tidak mengembalikan upload JWT untuk Pages Assets.", 502);

      // Deduplicate by content hash: identical files can appear at multiple
      // paths in the manifest but only need one object in the Pages asset store.
      const filesByHash = new Map<string, typeof uploadFiles[number]>();
      for (const item of uploadFiles) {
        if (!filesByHash.has(item.hash)) filesByHash.set(item.hash, item);
      }
      const uniqueUploadFiles = [...filesByHash.values()];
      const allHashes = uniqueUploadFiles.map((item) => item.hash);
      const missingResponse = await cf<string[]>(apiEnv, "/pages/assets/check-missing", {
        method: "POST",
        body: JSON.stringify({ hashes: allHashes })
      }, uploadJwt, { stage: "memeriksa aset yang belum tersimpan" });
      const missingHashes = new Set(Array.isArray(missingResponse.result) ? missingResponse.result : []);
      const missingFiles = uniqueUploadFiles.filter((item) => missingHashes.has(item.hash));

      // Keep each JSON upload request bounded by both byte size and Wrangler's
      // asset bucket file-count limit. A single file can still be up to 25 MiB.
      const uploadBatches: typeof missingFiles[] = [];
      let currentBatch: typeof missingFiles = [];
      let currentBatchBytes = 0;
      // Smaller requests reduce per-invocation JSON/base64 CPU and memory pressure.
      // With the 90 MiB deployment cap this stays below the Pages Function subrequest budget,
      // even when every batch needs one safe retry.
      const maxBatchBytes = 5 * 1024 * 1024;
      const maxBatchFiles = 1000;
      for (const item of missingFiles) {
        if (currentBatch.length && (currentBatch.length >= maxBatchFiles || currentBatchBytes + item.file.size > maxBatchBytes)) {
          uploadBatches.push(currentBatch);
          currentBatch = [];
          currentBatchBytes = 0;
        }
        currentBatch.push(item);
        currentBatchBytes += item.file.size;
      }
      if (currentBatch.length) uploadBatches.push(currentBatch);

      for (const batch of uploadBatches) {
        const payload: Array<{ base64: boolean; key: string; metadata: { contentType: string }; value: string }> = [];
        for (const item of batch) {
          const bytes = await item.file.arrayBuffer();
          payload.push({
            base64: true,
            key: item.hash,
            metadata: { contentType: item.contentType },
            value: bytesToBase64(new Uint8Array(bytes))
          });
        }
        await cf(apiEnv, "/pages/assets/upload", {
          method: "POST",
          body: JSON.stringify(payload)
        }, uploadJwt, { stage: `mengunggah batch aset ${uploadBatches.indexOf(batch) + 1}/${uploadBatches.length}` });
      }

      // Register every hash in the manifest, including assets already present
      // in the shared Pages asset store, as Wrangler does after uploading.
      await cf(apiEnv, "/pages/assets/upsert-hashes", {
        method: "POST",
        body: JSON.stringify({ hashes: allHashes })
      }, uploadJwt, { stage: "mendaftarkan checksum aset" });

      // Pages Advanced Mode deployment expects the Worker as a nested multipart
      // `_worker.bundle` payload, not as an ordinary public `_worker.js` asset.
      const managerOrigin = url.origin;
      const token = await serviceToken(env, accountId, project);
      const workerScript = buildPagesWorker(project, managerOrigin, token);
      const workerBundle = await buildPagesWorkerBundle(workerScript);

      const deploymentForm = new FormData();
      deploymentForm.set("manifest", JSON.stringify(manifest));
      deploymentForm.set("branch", branch);
      deploymentForm.set("commit_message", safeText(form.get("message") || "Deploy from Pages Manager", 384));
      deploymentForm.set("_worker.bundle", workerBundle);

      const result = await cf(apiEnv,
        `${accountPath}/deployments`,
        { method: "POST", body: deploymentForm },
        undefined,
        { stage: "membuat deployment Pages", maxAttempts: 1 }
      );
      const warnings: string[] = [];
      // A newly accepted deployment invalidates the account inventory snapshot.
      // The UI polls this exact deployment and then reloads the inventory once;
      // this avoids showing a stale "No deployment" status after a successful upload.
      try { await env.DB.prepare("DELETE FROM project_inventory_cache WHERE account_id=?").bind(accountId).run(); }
      catch (error) { warnings.push(`Deployment sudah diterima Cloudflare, tetapi cache inventory belum dapat dibersihkan: ${safeText(error instanceof Error ? error.message : error, 160)}.`); }
      try { await syncManagedProject(env, accountId, project); }
      catch (error) { warnings.push(`Deployment sudah diterima Cloudflare, tetapi sinkronisasi metadata Worker gagal: ${safeText(error instanceof Error ? error.message : error, 220)}.`); }
      try { await log(env, accountId, "deployment.create", project, `Branch ${branch}; ${entries.length} files; ${missingFiles.length} assets uploaded; Pages Worker enabled; Pages Worker version 2.8.3`); }
      catch (error) { warnings.push(`Deployment sudah diterima Cloudflare, tetapi activity log gagal disimpan: ${safeText(error instanceof Error ? error.message : error, 180)}.`); }
      return json({
        deployment: result.result,
        worker_enabled: true,
        assets_total: uniqueUploadFiles.length,
        assets_uploaded: missingFiles.length,
        warnings
      }, 201);
    }

    if (parts[0] === "projects" && project && parts[2] === "rotator" && method === "GET") {
      let row = await env.DB.prepare("SELECT * FROM rotator_configs_v2 WHERE account_id=? AND project_name=?")
        .bind(accountId, project).first<any>();
      const legacyAccountId = String(env.LEGACY_CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "");
      if (!row && legacyAccountId && accountId === legacyAccountId) {
        row = await env.DB.prepare("SELECT * FROM rotator_configs WHERE project_name=?").bind(project).first<any>();
      }
      let targets = [];
      try { targets = row ? JSON.parse(row.targets_json) : []; } catch { targets = []; }
      return json({ config: row
        ? { enabled: !!row.enabled, mode: row.mode, targets }
        : { enabled: false, mode: "random", targets: [] }
      });
    }

    if (parts[0] === "projects" && project && parts[2] === "rotator" && method === "PUT") {
      const body = await request.json() as any;
      const mode = String(body.mode || "random");
      if (!["random", "weighted", "round-robin"].includes(mode)) return json({ error: "Mode rotator tidak valid." }, 400);
      if (!Array.isArray(body.targets) || body.targets.length > 100) return json({ error: "Target rotator harus berupa array maksimal 100 item." }, 400);

      const targetKeys = new Set<string>();
      const targets: Array<{ label: string; branch: string; weight: number; enabled: boolean; url: string; kind: "branch" | "url" }> = body.targets.map((target: any) => {
        const url = normalizeDestinationUrl(target.url);
        const kind: "branch" | "url" = url ? "url" : "branch";
        const branch = safeText(target.branch, 51).toLowerCase();
        if (kind === "branch" && !BRANCH_RE.test(branch)) throw new HttpError(`Nama branch tidak valid: ${branch || "(kosong)"}`, 400);
        const key = kind === "url" ? url : `branch:${branch}`;
        if (targetKeys.has(key)) throw new HttpError(`Target ${key} ditambahkan lebih dari sekali.`, 400);
        targetKeys.add(key);
        const weight = Number(target.weight ?? 100);
        if (!Number.isFinite(weight) || weight < 0 || weight > 1000) throw new HttpError(`Bobot untuk ${safeText(target.label || branch || url, 80)} harus 0–1000.`, 400);
        if (url && new URL(url).hostname.toLowerCase() === `${project}.pages.dev`) {
          throw new HttpError("Target rotator tidak boleh kembali ke hostname production project yang sama.", 400);
        }
        return { label: safeText(target.label || branch || new URL(url).hostname, 80), branch, weight, enabled: target.enabled !== false, url, kind };
      });
      if (body.enabled && !targets.some((target: any) => target.enabled)) return json({ error: "Aktifkan minimal satu target rotator." }, 400);
      if (body.enabled && mode === "weighted" && !targets.some((target: any) => target.enabled && target.weight > 0)) {
        return json({ error: "Mode weighted membutuhkan minimal satu target aktif dengan bobot di atas 0." }, 400);
      }

      if (body.enabled) {
        const projectInfo = await cf<any>(apiEnv, `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}`);
        const productionBranch = String(projectInfo.result?.production_branch || "main").toLowerCase();
        const requiredBranches = targets
          .filter((target: any) => target.enabled && target.kind !== "url" && !target.url && (mode !== "weighted" || target.weight > 0))
          .map((target: any) => target.branch);
        const productionTargets = requiredBranches.filter((branch: string) => branch === productionBranch);
        if (productionTargets.length) {
          throw new HttpError(`Branch ${productionBranch} adalah production branch. Pilih branch preview lain untuk target rotator.`, 400);
        }
        if (requiredBranches.length) {
          const ready = new Set<string>();
          const requiredBranchSet = new Set(requiredBranches);
          // Inspect up to 1,000 recent deployments in 20 pages, not 100
          // sequential 10-item calls.
          for (let page = 1; page <= 20; page += 1) {
            const query = page > 1 ? `?page=${page}` : "";
            const deployments = await cf<any[]>(apiEnv,
              `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/deployments${query}`
            );
            const rows = Array.isArray(deployments.result) ? deployments.result : [];
            for (const deployment of rows) {
              const status = String(deployment.latest_stage?.status || "").toLowerCase();
              const deployStageOk = Array.isArray(deployment.stages) && deployment.stages.some((stage: any) => stage.name === "deploy" && stage.status === "success");
              if (status !== "success" && !deployStageOk) continue;
              // A successful branch deployment is not enough: the actual
              // branch.pages.dev alias must be present in Cloudflare's response.
              // This prevents saving a rotator destination that would still 404.
              for (const alias of (Array.isArray(deployment.aliases) ? deployment.aliases : [])) {
                let host = "";
                try {
                  host = new URL(String(alias).startsWith("http") ? String(alias) : `https://${alias}`).hostname.toLowerCase();
                } catch { /* Ignore malformed aliases returned by the API. */ }
                const suffix = `.${project}.pages.dev`;
                if (host.endsWith(suffix)) {
                  const aliasBranch = host.slice(0, -suffix.length);
                  if (requiredBranchSet.has(aliasBranch)) ready.add(aliasBranch);
                }
              }
            }
            if (typeof deployments.result_info?.total_pages === "number" && page >= deployments.result_info.total_pages) break;
            if (rows.length < 50) break;
          }
          const missing = [...new Set(requiredBranches)].filter((branch: string) => !ready.has(branch));
          if (missing.length) {
            throw new HttpError(`Branch belum memiliki deployment sukses dan alias aktif: ${missing.join(", ")}. Deploy edge melalui tab Traffic rotator sampai alias branch tersedia, lalu ulangi penyimpanan konfigurasi.`, 409);
          }
        }
      }

      await env.DB.prepare(`
        INSERT INTO rotator_configs_v2(account_id, project_name, enabled, mode, targets_json, next_index, updated_at)
        VALUES(?,?,?,?,?,0,CURRENT_TIMESTAMP)
        ON CONFLICT(account_id, project_name) DO UPDATE SET
          enabled=excluded.enabled,
          mode=excluded.mode,
          targets_json=excluded.targets_json,
          next_index=0,
          updated_at=CURRENT_TIMESTAMP
      `).bind(accountId, project, body.enabled ? 1 : 0, mode, JSON.stringify(targets)).run();
      await syncManagedProject(env, accountId, project);
      await log(env, accountId, "rotator.update", project, `Saved ${targets.length} targets (${mode}); mixed branch/direct URL routing configuration`);
      return json({ ok: true, edge_ready: true });
    }

    if (parts[0] === "projects" && project && parts[2] === "analytics" && method === "GET") {
      const daysRaw = Number(url.searchParams.get("days") || 30);
      const days = [7, 30, 90].includes(daysRaw) ? daysRaw : 30;
      const window = `-${days} days`;
      const legacyAccountId = String(env.LEGACY_CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "");
      const includeLegacy = legacyAccountId && accountId === legacyAccountId ? 1 : 0;
      const tenantFilter = "(account_id=? OR (account_id='' AND ?=1))";
      const [totals, daily, devices, countries, referrers, recent] = await Promise.all([
        env.DB.prepare(`SELECT
          SUM(CASE WHEN event_type='pageview' THEN 1 ELSE 0 END) AS views,
          COUNT(DISTINCT CASE WHEN event_type='pageview' THEN visitor_id END) AS visitors,
          SUM(CASE WHEN event_type='click' THEN 1 ELSE 0 END) AS clicks,
          COUNT(DISTINCT CASE WHEN event_type='pageview' THEN session_id END) AS sessions
          FROM analytics_events WHERE project_name=? AND ${tenantFilter} AND datetime(created_at)>=datetime('now', ?)`)
          .bind(project, accountId, includeLegacy, window).first<any>(),
        env.DB.prepare(`SELECT date(created_at) AS day,
          SUM(CASE WHEN event_type='pageview' THEN 1 ELSE 0 END) AS views,
          COUNT(DISTINCT CASE WHEN event_type='pageview' THEN visitor_id END) AS visitors,
          SUM(CASE WHEN event_type='click' THEN 1 ELSE 0 END) AS clicks
          FROM analytics_events WHERE project_name=? AND ${tenantFilter} AND datetime(created_at)>=datetime('now', ?)
          GROUP BY date(created_at) ORDER BY day ASC`)
          .bind(project, accountId, includeLegacy, window).all<any>(),
        env.DB.prepare(`SELECT device_type AS label, COUNT(*) AS count FROM analytics_events
          WHERE project_name=? AND ${tenantFilter} AND event_type='pageview' AND datetime(created_at)>=datetime('now', ?)
          GROUP BY device_type ORDER BY count DESC LIMIT 8`)
          .bind(project, accountId, includeLegacy, window).all<any>(),
        env.DB.prepare(`SELECT CASE WHEN city<>'' THEN city || ', ' || country ELSE country END AS label,
          COUNT(*) AS count FROM analytics_events WHERE project_name=? AND ${tenantFilter} AND event_type='pageview'
          AND datetime(created_at)>=datetime('now', ?) GROUP BY country, region, city ORDER BY count DESC LIMIT 8`)
          .bind(project, accountId, includeLegacy, window).all<any>(),
        env.DB.prepare(`SELECT CASE WHEN referrer='' THEN 'Direct / None' ELSE referrer END AS label,
          COUNT(*) AS count FROM analytics_events WHERE project_name=? AND ${tenantFilter} AND event_type='pageview'
          AND datetime(created_at)>=datetime('now', ?) GROUP BY referrer ORDER BY count DESC LIMIT 8`)
          .bind(project, accountId, includeLegacy, window).all<any>(),
        env.DB.prepare(`SELECT id, event_type, visitor_id, path, page_title, referrer, target_url,
          ip_address, country, region, city, timezone, device_type, browser, operating_system,
          user_agent, created_at FROM analytics_events WHERE project_name=? AND ${tenantFilter}
          AND datetime(created_at)>=datetime('now', ?)
          ORDER BY id DESC LIMIT 100`)
          .bind(project, accountId, includeLegacy, window).all<any>()
      ]);
      return json({
        days,
        summary: {
          views: Number(totals?.views || 0),
          visitors: Number(totals?.visitors || 0),
          clicks: Number(totals?.clicks || 0),
          sessions: Number(totals?.sessions || 0)
        },
        daily: daily.results || [],
        devices: devices.results || [],
        countries: countries.results || [],
        referrers: referrers.results || [],
        recent: recent.results || []
      });
    }

    if (parts[0] === "activity" && method === "GET") {
      const legacyAccountId = String(env.LEGACY_CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "");
      const includeLegacy = legacyAccountId && accountId === legacyAccountId ? 1 : 0;
      const rows = await env.DB.prepare("SELECT * FROM activity_logs WHERE account_id=? OR (account_id='' AND ?=1) ORDER BY id DESC LIMIT 100")
        .bind(accountId, includeLegacy).all<any>();
      return json({ activity: rows.results || [] });
    }

    return json({ error: "Endpoint not found." }, 404);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Internal server error.";
    return json({ error: message }, status);
  }
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function fileExtension(path: string) {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? basename.slice(dot + 1) : "";
}

function inferContentType(path: string) {
  const extension = fileExtension(path).toLowerCase();
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    cjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    map: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    eot: "application/vnd.ms-fontobject",
    txt: "text/plain; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    pdf: "application/pdf",
    wasm: "application/wasm",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg"
  };
  return types[extension] || "application/octet-stream";
}

async function buildPagesWorkerBundle(workerScript: string) {
  // Wrangler sends `_worker.bundle` as a nested multipart body containing
  // Worker metadata and the main ESM module.
  const bundleForm = new FormData();
  bundleForm.set("metadata", JSON.stringify({
    main_module: "worker.js",
    compatibility_date: "2026-11-08"
  }));
  bundleForm.set("worker.js", new File([workerScript], "worker.js", {
    type: "application/javascript+module"
  }));
  const bundleBody = await new Response(bundleForm).arrayBuffer();
  return new File([bundleBody], "_worker.bundle", { type: "application/octet-stream" });
}
