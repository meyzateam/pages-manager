interface Env { SESSION_SECRET?: string }

const encoder = new TextEncoder();
const SESSION_COOKIE = "pm_session_v2";

async function sessionSignature(secret: string, sessionId: string, expiresAt: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const data = encoder.encode(`pages-manager-session-v2:${sessionId}:${expiresAt}`);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return [...signature].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string) {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let diff = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

function readSessionCookie(request: Request) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const entry = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return entry ? entry.slice(SESSION_COOKIE.length + 1) : "";
}

async function verifySession(request: Request, secret: string) {
  const value = readSessionCookie(request);
  const [sessionId, expiresAt, suppliedSignature, extra] = value.split(".");
  if (!/^[a-f0-9]{64}$/i.test(sessionId || "") || !expiresAt || !suppliedSignature || extra !== undefined) return false;
  const expiry = Number(expiresAt);
  if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) return false;
  try { return constantTimeEqual(suppliedSignature, await sessionSignature(secret, sessionId, expiresAt)); }
  catch { return false; }
}

export const onRequest: PagesFunction<Env> = async ({ request, env, next }) => {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/")) return next();
  if ((path === "/api/auth/start" && request.method === "GET") || (path === "/api/auth/callback" && request.method === "GET") || (path === "/api/auth/token-login" && request.method === "POST")) return next();
  // This endpoint is called server-to-server by each managed site Worker.
  // It must not require the dashboard's HttpOnly session cookie: the route
  // authenticates the request with the per-project x-pm-site-token instead.
  // Keep the exception restricted to the exact read-only verification route.
  if (path === "/api/collect" || path === "/api/rotator/resolve" ||
      (path === "/api/public/google-verification" && request.method === "GET")) return next();

  const secret = String(env.SESSION_SECRET || "");
  if (secret.length < 32) return Response.json({ error: "SESSION_SECRET belum dikonfigurasi atau kurang dari 32 karakter." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  if (!(await verifySession(request, secret))) return Response.json({ error: "Unauthorized. Silakan hubungkan API Token Cloudflare Anda." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return next();
};
