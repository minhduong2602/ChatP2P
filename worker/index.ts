import type { D1Database, Env, ExecutionContextLike, R2UploadedPart } from "./types";

const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MIN_TTL_SECONDS = 60;
const PART_SIZE = 8 * 1024 * 1024;
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;
const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

type RoomSession = {
  session_id: string;
  token_hash: string;
  room_id: string;
  is_owner: number;
  active: number;
  expires_at: number;
};

type FileRow = {
  id: string;
  room_id: string;
  object_key: string;
  original_name: string;
  content_type: string;
  size: number;
  uploader_session_id: string;
  upload_id: string | null;
  status: string;
  share_token: string | null;
  share_token_hash: string;
  password_hash: string | null;
  max_downloads: number | null;
  created_at: number;
  uploaded_at: number | null;
  link_expires_at: number;
  expires_at: number;
  download_count: number;
  last_downloaded_at: number | null;
  deleted_at: number | null;
};

function baseHeaders(origin: string | null): HeadersInit {
  return {
    "Cache-Control": "no-store",
    ...(origin ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Internal-Secret",
      "Access-Control-Expose-Headers": "ETag, Content-Range, Accept-Ranges",
      Vary: "Origin",
    } : {}),
  };
}

function json(value: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...baseHeaders(origin) },
  });
}

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const configured = env.APP_URL?.trim();
  try {
    if (configured && origin === new URL(configured).origin) return origin;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  } catch {
    return null;
  }
  return null;
}

function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value, (part) => part.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
}

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signGrant(fileId: string, expiresAt: number, secret: string): Promise<string> {
  const payload = base64Url(JSON.stringify({ fileId, expiresAt }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function verifyGrant(grant: string, fileId: string, secret: string): Promise<boolean> {
  const [payload, signature] = grant.split(".");
  if (!payload || !signature) return false;
  try {
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - payload.length % 4) % 4))) as { fileId?: string; expiresAt?: number };
    if (decoded.fileId !== fileId || !decoded.expiresAt || decoded.expiresAt <= Date.now()) return false;
    return safeEqual(await signGrant(fileId, decoded.expiresAt, secret), grant);
  } catch {
    return false;
  }
}

function safeEqual(left: string, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function bearer(request: Request): string {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

async function roomSession(request: Request, env: Env, roomId?: string): Promise<RoomSession | null> {
  const token = bearer(request);
  if (!token) return null;
  const hash = await sha256(token);
  const now = Date.now();
  const session = await env.DB.prepare(
    "SELECT session_id, token_hash, room_id, is_owner, active, expires_at FROM room_sessions WHERE token_hash = ? AND active = 1 AND expires_at > ?"
  ).bind(hash, now).first<RoomSession>();
  if (!session || (roomId && session.room_id !== roomId)) return null;
  return session;
}

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const token = bearer(request);
  if (!token) return false;
  const hash = await sha256(token);
  const row = await env.DB.prepare("SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(hash, Date.now()).first<{ token_hash: string }>();
  return !!row;
}

function validName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 240);
  return normalized || null;
}

function clampTtl(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, parsed));
}

function clampMaxDownloads(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === 0) return null;
  const parsed = typeof value === "number" ? Math.floor(value) : typeof value === "string" ? Math.floor(Number(value)) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(100000, Math.max(1, parsed));
}

function normalizePassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 128);
  return trimmed.length > 0 ? trimmed : null;
}

async function fileById(db: D1Database, id: string): Promise<FileRow | null> {
  return db.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRow>();
}

function canManage(file: FileRow, session: RoomSession): boolean {
  return file.room_id === session.room_id && (session.is_owner === 1 || file.uploader_session_id === session.session_id);
}

function publicFile(file: FileRow, session?: RoomSession | null, includeShareToken = true) {
  return {
    id: file.id,
    roomId: file.room_id,
    name: file.original_name,
    contentType: file.content_type,
    size: file.size,
    status: file.status,
    createdAt: file.created_at,
    uploadedAt: file.uploaded_at,
    linkExpiresAt: file.link_expires_at,
    expiresAt: file.expires_at,
    downloadCount: file.download_count,
    maxDownloads: file.max_downloads ?? null,
    hasPassword: !!file.password_hash,
    shareToken: includeShareToken ? (file.share_token ?? null) : null,
    lastDownloadedAt: file.last_downloaded_at,
    canManage: session ? canManage(file, session) : false,
  };
}

async function deleteFile(env: Env, file: FileRow, actor: string): Promise<void> {
  if (file.status === "deleted") return;
  if (file.upload_id && file.status === "uploading") {
    try { await env.FILES.resumeMultipartUpload(file.object_key, file.upload_id).abort(); } catch { /* already gone */ }
  }
  try { await env.FILES.delete(file.object_key); } catch { /* metadata still records deletion */ }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE files SET status = 'deleted', deleted_at = ?, upload_id = NULL WHERE id = ?").bind(now, file.id),
    env.DB.prepare("INSERT INTO audit_logs (id, actor, action, file_id, object_key, created_at) VALUES (?, ?, 'delete', ?, ?, ?)")
      .bind(crypto.randomUUID(), actor, file.id, file.object_key, now),
  ]);
}

async function applyFilePatch(
  env: Env,
  file: FileRow,
  body: {
    expiresAt?: number;
    linkExpiresAt?: number;
    maxDownloads?: number | null;
    password?: string | null;
    revokeLink?: boolean;
    rotateShareToken?: boolean;
  }
): Promise<FileRow> {
  const absoluteMax = (file.uploaded_at || file.created_at) + MAX_TTL_SECONDS * 1000;
  const expiresAt = Math.min(absoluteMax, Math.max(Date.now(), Number(body.expiresAt) || file.expires_at));
  let linkExpiresAt = Math.min(expiresAt, Math.max(0, body.linkExpiresAt !== undefined ? Number(body.linkExpiresAt) : file.link_expires_at));
  if (body.revokeLink) {
    linkExpiresAt = Date.now();
  }
  let shareToken = file.share_token;
  let shareTokenHash = file.share_token_hash;
  if (body.rotateShareToken) {
    shareToken = randomToken();
    shareTokenHash = await sha256(shareToken);
    if (linkExpiresAt <= Date.now()) linkExpiresAt = expiresAt;
  }
  const maxDownloads = "maxDownloads" in body ? clampMaxDownloads(body.maxDownloads) : (file.max_downloads ?? null);
  let passwordHash = file.password_hash ?? null;
  if ("password" in body) {
    const normalized = normalizePassword(body.password);
    passwordHash = normalized ? await sha256(normalized) : null;
  }
  await env.DB.prepare(
    "UPDATE files SET expires_at = ?, link_expires_at = ?, max_downloads = ?, password_hash = ?, share_token = ?, share_token_hash = ? WHERE id = ?"
  ).bind(expiresAt, linkExpiresAt, maxDownloads, passwordHash, shareToken, shareTokenHash, file.id).run();

  return {
    ...file,
    expires_at: expiresAt,
    link_expires_at: linkExpiresAt,
    max_downloads: maxDownloads,
    password_hash: passwordHash,
    share_token: shareToken,
    share_token_hash: shareTokenHash,
  };
}

async function handleInternal(request: Request, env: Env, pathname: string, origin: string | null): Promise<Response> {
  if (!safeEqual(request.headers.get("X-Internal-Secret") || "", env.FILE_API_SECRET || "")) {
    return json({ error: "Unauthorized" }, 401, origin);
  }
  if (pathname === "/internal/sessions" && request.method === "POST") {
    const body = await request.json() as Partial<{ sessionId: string; tokenHash: string; roomId: string; owner: boolean; expiresAt: number }>;
    if (!body.sessionId || !body.tokenHash || !body.roomId || !body.expiresAt) return json({ error: "Invalid session" }, 400, origin);
    await env.DB.prepare(
      "INSERT INTO room_sessions (session_id, token_hash, room_id, is_owner, active, expires_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(session_id) DO UPDATE SET token_hash = excluded.token_hash, room_id = excluded.room_id, is_owner = excluded.is_owner, active = 1, expires_at = excluded.expires_at, updated_at = excluded.updated_at"
    ).bind(body.sessionId, body.tokenHash, body.roomId, body.owner ? 1 : 0, body.expiresAt, Date.now()).run();
    return json({ ok: true }, 200, origin);
  }
  const revoke = pathname.match(/^\/internal\/sessions\/([^/]+)$/);
  if (revoke && request.method === "DELETE") {
    await env.DB.prepare("UPDATE room_sessions SET active = 0, updated_at = ? WHERE session_id = ?")
      .bind(Date.now(), decodeURIComponent(revoke[1])).run();
    return json({ ok: true }, 200, origin);
  }
  return json({ error: "Not found" }, 404, origin);
}

async function handleAdmin(request: Request, env: Env, pathname: string, origin: string | null): Promise<Response> {
  if (pathname === "/admin/login" && request.method === "POST") {
    const body = await request.json() as { password?: string };
    if (!env.ADMIN_PASSWORD || !safeEqual(body.password || "", env.ADMIN_PASSWORD)) return json({ error: "Invalid password" }, 401, origin);
    const token = randomToken();
    const expiresAt = Date.now() + ADMIN_SESSION_SECONDS * 1000;
    await env.DB.prepare("INSERT INTO admin_sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)")
      .bind(await sha256(token), expiresAt, Date.now()).run();
    return json({ token, expiresAt }, 200, origin);
  }
  if (!(await isAdmin(request, env))) return json({ error: "Unauthorized" }, 401, origin);

  if (pathname === "/admin/files" && request.method === "GET") {
    const rows = (await env.DB.prepare("SELECT * FROM files WHERE status != 'deleted' ORDER BY created_at DESC LIMIT 1000").all<FileRow>()).results || [];
    const listed = await env.FILES.list({ limit: 1000 });
    const byKey = new Map(rows.map((file) => [file.object_key, file]));
    const orphans = listed.objects.filter((object) => !byKey.has(object.key)).map((object) => ({
      id: `orphan:${encodeURIComponent(object.key)}`,
      roomId: null,
      name: object.key.split("/").at(-1) || object.key,
      objectKey: object.key,
      contentType: "application/octet-stream",
      size: object.size,
      status: "orphan",
      createdAt: object.uploaded.getTime(),
      uploadedAt: object.uploaded.getTime(),
      linkExpiresAt: null,
      expiresAt: null,
      downloadCount: 0,
      maxDownloads: null,
      hasPassword: false,
      shareToken: null,
      lastDownloadedAt: null,
      canManage: true,
    }));
    return json({ files: [...rows.map((row) => ({ ...publicFile(row), objectKey: row.object_key, canManage: true })), ...orphans], truncated: listed.truncated }, 200, origin);
  }

  const fileMatch = pathname.match(/^\/admin\/files\/([^/]+)$/);
  if (fileMatch && request.method === "DELETE") {
    const id = decodeURIComponent(fileMatch[1]);
    const file = await fileById(env.DB, id);
    if (!file) return json({ error: "File not found" }, 404, origin);
    await deleteFile(env, file, "admin");
    return json({ ok: true }, 200, origin);
  }
  if (pathname === "/admin/objects" && request.method === "DELETE") {
    const key = new URL(request.url).searchParams.get("key");
    if (!key) return json({ error: "Missing key" }, 400, origin);
    await env.FILES.delete(key);
    await env.DB.prepare("INSERT INTO audit_logs (id, actor, action, file_id, object_key, created_at) VALUES (?, 'admin', 'delete-orphan', NULL, ?, ?)")
      .bind(crypto.randomUUID(), key, Date.now()).run();
    return json({ ok: true }, 200, origin);
  }
  if (fileMatch && request.method === "PATCH") {
    const file = await fileById(env.DB, decodeURIComponent(fileMatch[1]));
    if (!file) return json({ error: "File not found" }, 404, origin);
    const body = await request.json() as {
      expiresAt?: number;
      linkExpiresAt?: number;
      maxDownloads?: number | null;
      password?: string | null;
      revokeLink?: boolean;
      rotateShareToken?: boolean;
    };
    const updated = await applyFilePatch(env, file, body);
    return json({ file: { ...publicFile(updated), canManage: true } }, 200, origin);
  }
  return json({ error: "Not found" }, 404, origin);
}

async function handlePublicShare(request: Request, env: Env, pathname: string, origin: string | null): Promise<Response> {
  const infoMatch = pathname.match(/^\/public\/files\/([^/]+)$/);
  if (infoMatch && request.method === "GET") {
    const id = decodeURIComponent(infoMatch[1]);
    const token = new URL(request.url).searchParams.get("token") || "";
    const file = await fileById(env.DB, id);
    if (!file || file.status !== "ready" || file.deleted_at) {
      return json({ error: "File not found or deleted" }, 404, origin);
    }
    if (!token || !safeEqual(await sha256(token), file.share_token_hash)) {
      return json({ error: "Invalid share token" }, 403, origin);
    }
    const now = Date.now();
    const expired = file.expires_at <= now || file.link_expires_at <= now;
    const limitReached = file.max_downloads !== null && file.max_downloads !== undefined && file.download_count >= file.max_downloads;
    return json({
      file: {
        id: file.id,
        name: file.original_name,
        contentType: file.content_type,
        size: file.size,
        uploadedAt: file.uploaded_at || file.created_at,
        expiresAt: Math.min(file.expires_at, file.link_expires_at),
        downloadCount: file.download_count,
        maxDownloads: file.max_downloads ?? null,
        requiresPassword: !!file.password_hash,
        expired,
        limitReached,
      },
    }, 200, origin);
  }

  const accessMatch = pathname.match(/^\/public\/files\/([^/]+)\/access$/);
  if (accessMatch && request.method === "POST") {
    const id = decodeURIComponent(accessMatch[1]);
    const file = await fileById(env.DB, id);
    if (!file || file.status !== "ready" || file.deleted_at) {
      return json({ error: "File not found or deleted" }, 404, origin);
    }
    const body = await request.json().catch(() => ({})) as { token?: string; password?: string };
    const token = (body.token || new URL(request.url).searchParams.get("token") || "").trim();
    if (!token || !safeEqual(await sha256(token), file.share_token_hash)) {
      return json({ error: "Invalid share link" }, 403, origin);
    }
    const now = Date.now();
    if (file.expires_at <= now || file.link_expires_at <= now) {
      return json({ error: "Share link has expired" }, 410, origin);
    }
    if (file.max_downloads !== null && file.max_downloads !== undefined && file.download_count >= file.max_downloads) {
      return json({ error: "Download limit reached" }, 410, origin);
    }
    if (file.password_hash) {
      const supplied = normalizePassword(body.password);
      if (!supplied || !safeEqual(await sha256(supplied), file.password_hash)) {
        return json({ error: "Password required or incorrect", requiresPassword: true }, 401, origin);
      }
    }
    const grantExpiry = Math.min(file.expires_at, file.link_expires_at, now + 10 * 60 * 1000);
    const access = await signGrant(file.id, grantExpiry, env.FILE_API_SECRET);
    return json({
      url: `${new URL(request.url).origin}/files/${file.id}/content?access=${encodeURIComponent(access)}`,
      expiresAt: grantExpiry,
    }, 200, origin);
  }

  return json({ error: "Not found" }, 404, origin);
}

async function handleRoom(request: Request, env: Env, pathname: string, origin: string | null): Promise<Response> {
  const roomFiles = pathname.match(/^\/rooms\/([^/]+)\/files$/);
  if (roomFiles && request.method === "GET") {
    const roomId = decodeURIComponent(roomFiles[1]);
    const session = await roomSession(request, env, roomId);
    if (!session) return json({ error: "Room session expired" }, 401, origin);
    const rows = (await env.DB.prepare("SELECT * FROM files WHERE room_id = ? AND status != 'deleted' ORDER BY created_at DESC")
      .bind(roomId).all<FileRow>()).results || [];
    return json({ files: rows.map((file) => publicFile(file, session, true)) }, 200, origin);
  }

  const createUpload = pathname.match(/^\/rooms\/([^/]+)\/uploads$/);
  if (createUpload && request.method === "POST") {
    const roomId = decodeURIComponent(createUpload[1]);
    const session = await roomSession(request, env, roomId);
    if (!session) return json({ error: "Room session expired" }, 401, origin);
    const body = await request.json() as {
      name?: unknown;
      size?: unknown;
      contentType?: unknown;
      expiresInSeconds?: unknown;
      linkExpiresInSeconds?: unknown;
      maxDownloads?: unknown;
      password?: unknown;
    };
    const name = validName(body.name);
    const size = Number(body.size);
    if (!name || !Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_SIZE) return json({ error: "Invalid file" }, 400, origin);
    const contentType = typeof body.contentType === "string" ? body.contentType.slice(0, 120) : "application/octet-stream";
    const ttl = clampTtl(body.expiresInSeconds, DEFAULT_TTL_SECONDS);
    const linkTtl = Math.min(ttl, clampTtl(body.linkExpiresInSeconds, ttl));
    const maxDownloads = clampMaxDownloads(body.maxDownloads);
    const normalizedPwd = normalizePassword(body.password);
    const passwordHash = normalizedPwd ? await sha256(normalizedPwd) : null;
    const now = Date.now();
    const id = crypto.randomUUID();
    const objectKey = `${roomId}/${id}/${encodeURIComponent(name)}`;
    const shareToken = randomToken();
    const shareTokenHash = await sha256(shareToken);
    const multipart = await env.FILES.createMultipartUpload(objectKey, {
      httpMetadata: { contentType },
      customMetadata: { fileId: id, roomId },
    });
    await env.DB.prepare(
      "INSERT INTO files (id, room_id, object_key, original_name, content_type, size, uploader_session_id, upload_id, status, share_token, share_token_hash, password_hash, max_downloads, created_at, uploaded_at, link_expires_at, expires_at, download_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?, ?, NULL, ?, ?, 0)"
    ).bind(id, roomId, objectKey, name, contentType, size, session.session_id, multipart.uploadId, shareToken, shareTokenHash, passwordHash, maxDownloads, now, now + linkTtl * 1000, now + ttl * 1000).run();
    return json({
      fileId: id,
      uploadId: multipart.uploadId,
      partSize: PART_SIZE,
      shareToken,
      expiresAt: now + ttl * 1000,
      linkExpiresAt: now + linkTtl * 1000,
      maxDownloads,
      hasPassword: !!passwordHash,
    }, 201, origin);
  }

  const partMatch = pathname.match(/^\/uploads\/([^/]+)\/parts\/(\d+)$/);
  if (partMatch && request.method === "PUT") {
    const file = await fileById(env.DB, decodeURIComponent(partMatch[1]));
    const session = file ? await roomSession(request, env, file.room_id) : null;
    if (!file || !session || !canManage(file, session) || file.status !== "uploading" || !file.upload_id || !request.body) return json({ error: "Upload unavailable" }, 403, origin);
    const partNumber = Number(partMatch[2]);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) return json({ error: "Invalid part" }, 400, origin);
    const part = await env.FILES.resumeMultipartUpload(file.object_key, file.upload_id).uploadPart(partNumber, request.body);
    return json(part, 200, origin);
  }

  const completeMatch = pathname.match(/^\/uploads\/([^/]+)\/complete$/);
  if (completeMatch && request.method === "POST") {
    const file = await fileById(env.DB, decodeURIComponent(completeMatch[1]));
    const session = file ? await roomSession(request, env, file.room_id) : null;
    if (!file || !session || !canManage(file, session) || file.status !== "uploading" || !file.upload_id) return json({ error: "Upload unavailable" }, 403, origin);
    const body = await request.json() as { parts?: R2UploadedPart[] };
    const parts = Array.isArray(body.parts) ? body.parts.filter((part) => Number.isInteger(part.partNumber) && typeof part.etag === "string") : [];
    if (!parts.length) return json({ error: "Missing parts" }, 400, origin);
    await env.FILES.resumeMultipartUpload(file.object_key, file.upload_id).complete(parts.sort((a, b) => a.partNumber - b.partNumber));
    const uploadedAt = Date.now();
    const hardExpiry = uploadedAt + MAX_TTL_SECONDS * 1000;
    const expiresAt = Math.min(file.expires_at, hardExpiry);
    const linkExpiresAt = Math.min(file.link_expires_at, expiresAt);
    await env.DB.prepare("UPDATE files SET status = 'ready', uploaded_at = ?, upload_id = NULL, expires_at = ?, link_expires_at = ? WHERE id = ?")
      .bind(uploadedAt, expiresAt, linkExpiresAt, file.id).run();
    return json({ file: publicFile({ ...file, status: "ready", uploaded_at: uploadedAt, upload_id: null, expires_at: expiresAt, link_expires_at: linkExpiresAt }, session, true) }, 200, origin);
  }

  const abortMatch = pathname.match(/^\/uploads\/([^/]+)$/);
  if (abortMatch && request.method === "DELETE") {
    const file = await fileById(env.DB, decodeURIComponent(abortMatch[1]));
    const session = file ? await roomSession(request, env, file.room_id) : null;
    if (!file || !session || !canManage(file, session)) return json({ error: "Forbidden" }, 403, origin);
    await deleteFile(env, file, `room:${session.session_id}`);
    return json({ ok: true }, 200, origin);
  }

  const fileMatch = pathname.match(/^\/files\/([^/]+)$/);
  if (fileMatch && (request.method === "PATCH" || request.method === "DELETE")) {
    const file = await fileById(env.DB, decodeURIComponent(fileMatch[1]));
    const session = file ? await roomSession(request, env, file.room_id) : null;
    if (!file || !session || !canManage(file, session)) return json({ error: "Forbidden" }, 403, origin);
    if (request.method === "DELETE") {
      await deleteFile(env, file, `room:${session.session_id}`);
      return json({ ok: true }, 200, origin);
    }
    const body = await request.json() as {
      expiresAt?: number;
      linkExpiresAt?: number;
      maxDownloads?: number | null;
      password?: string | null;
      revokeLink?: boolean;
      rotateShareToken?: boolean;
    };
    const updated = await applyFilePatch(env, file, body);
    return json({ file: publicFile(updated, session, true) }, 200, origin);
  }

  const downloadLinkMatch = pathname.match(/^\/files\/([^/]+)\/download-link$/);
  if (downloadLinkMatch && request.method === "POST") {
    const file = await fileById(env.DB, decodeURIComponent(downloadLinkMatch[1]));
    const session = file ? await roomSession(request, env, file.room_id) : null;
    if (!file || !session || file.status !== "ready" || file.expires_at <= Date.now()) return json({ error: "File unavailable" }, 404, origin);
    if (file.max_downloads !== null && file.max_downloads !== undefined && file.download_count >= file.max_downloads) {
      return json({ error: "Download limit reached" }, 403, origin);
    }
    const expiresAt = Math.min(file.expires_at, Date.now() + 10 * 60 * 1000);
    const access = await signGrant(file.id, expiresAt, env.FILE_API_SECRET);
    return json({ url: `${new URL(request.url).origin}/files/${file.id}/content?access=${encodeURIComponent(access)}`, expiresAt }, 200, origin);
  }
  return json({ error: "Not found" }, 404, origin);
}

async function handleDownload(request: Request, env: Env, id: string, origin: string | null): Promise<Response> {
  const file = await fileById(env.DB, id);
  if (!file || file.status !== "ready" || file.deleted_at || file.expires_at <= Date.now()) return json({ error: "File unavailable" }, 404, origin);
  if (file.max_downloads !== null && file.max_downloads !== undefined && file.download_count >= file.max_downloads) {
    return json({ error: "Download limit reached" }, 403, origin);
  }
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  const access = url.searchParams.get("access") || "";
  const password = url.searchParams.get("password") || "";
  const session = await roomSession(request, env, file.room_id);
  const tokenValid = token && file.link_expires_at > Date.now() && safeEqual(await sha256(token), file.share_token_hash);
  const passwordOk = !file.password_hash || (Boolean(password) && safeEqual(await sha256(password), file.password_hash));
  const shared = tokenValid && passwordOk;
  const granted = access && await verifyGrant(access, file.id, env.FILE_API_SECRET);
  if (!session && !shared && !granted) {
    if (tokenValid && file.password_hash && !passwordOk) {
      return json({ error: "Password required to download this file", requiresPassword: true }, 401, origin);
    }
    return json({ error: "Link expired or access denied" }, 403, origin);
  }
  const isRangeRequest = request.headers.has("Range");
  if (!isRangeRequest) {
    const updateResult = await env.DB.prepare(
      "UPDATE files SET download_count = download_count + 1, last_downloaded_at = ? WHERE id = ? AND (max_downloads IS NULL OR download_count < max_downloads)"
    ).bind(Date.now(), file.id).run();
    const changes = (updateResult as { meta?: { changes?: number } }).meta?.changes;
    if (changes === 0 && file.max_downloads !== null) {
      return json({ error: "Download limit reached" }, 403, origin);
    }
  }
  const object = await env.FILES.get(file.object_key, { range: request.headers });
  if (!object) return json({ error: "File unavailable" }, 404, origin);
  const headers = new Headers({
    ...baseHeaders(origin),
    "Accept-Ranges": "bytes",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
  });
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  if (isRangeRequest && object.range && "offset" in object.range) {
    headers.set("Content-Range", `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${file.size}`);
    headers.set("Content-Length", String(object.range.length));
  } else {
    headers.set("Content-Length", String(file.size));
  }
  return new Response(object.body, { status: isRangeRequest ? 206 : 200, headers });
}

async function cleanup(env: Env): Promise<void> {
  const now = Date.now();
  const rows = (await env.DB.prepare(
    "SELECT * FROM files WHERE status != 'deleted' AND (expires_at <= ? OR (max_downloads IS NOT NULL AND download_count >= max_downloads) OR (status = 'uploading' AND created_at <= ?)) LIMIT 100"
  ).bind(now, now - 3 * 60 * 60 * 1000).all<FileRow>()).results || [];
  await Promise.all(rows.map((file) => deleteFile(env, file, "cron")));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM room_sessions WHERE expires_at <= ? OR (active = 0 AND updated_at <= ?)").bind(now, now - DEFAULT_TTL_SECONDS * 1000),
  ]);
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);
    if (request.method === "OPTIONS") return origin ? new Response(null, { status: 204, headers: baseHeaders(origin) }) : new Response("Forbidden", { status: 403 });
    if (request.headers.has("Origin") && !origin) return json({ error: "Forbidden origin" }, 403);
    try {
      if (url.pathname.startsWith("/internal/")) return await handleInternal(request, env, url.pathname, origin);
      if (url.pathname.startsWith("/admin/")) return await handleAdmin(request, env, url.pathname, origin);
      if (url.pathname.startsWith("/public/")) return await handlePublicShare(request, env, url.pathname, origin);
      const download = url.pathname.match(/^\/files\/([^/]+)\/content$/);
      if (download && request.method === "GET") return await handleDownload(request, env, decodeURIComponent(download[1]), origin);
      return await handleRoom(request, env, url.pathname, origin);
    } catch (error) {
      console.error("file-api", error);
      context.waitUntil(Promise.resolve());
      return json({ error: error instanceof Error ? error.message : "Internal error" }, 500, origin);
    }
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await cleanup(env);
  },
};

