export type StoredFile = {
  id: string;
  roomId: string | null;
  name: string;
  objectKey?: string;
  contentType: string;
  size: number;
  status: "uploading" | "ready" | "deleted" | "failed" | "orphan";
  createdAt: number;
  uploadedAt: number | null;
  linkExpiresAt: number | null;
  expiresAt: number | null;
  downloadCount: number;
  maxDownloads: number | null;
  hasPassword: boolean;
  shareToken: string | null;
  lastDownloadedAt: number | null;
  canManage: boolean;
};

export type UploadOptions = {
  expirySeconds: number;
  linkExpirySeconds?: number;
  maxDownloads?: number | null;
  password?: string | null;
};

export type FilePatch = {
  expiresAt?: number;
  linkExpiresAt?: number;
  maxDownloads?: number | null;
  password?: string | null;
  revokeLink?: boolean;
  rotateShareToken?: boolean;
};

export type PublicShareInfo = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  uploadedAt: number;
  expiresAt: number;
  downloadCount: number;
  maxDownloads: number | null;
  requiresPassword: boolean;
  expired: boolean;
  limitReached: boolean;
};

type UploadInit = {
  fileId: string;
  uploadId: string;
  partSize: number;
  shareToken: string;
  expiresAt: number;
  linkExpiresAt: number;
  maxDownloads: number | null;
  hasPassword: boolean;
};

const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const MIN_TTL_SECONDS = 60;

export function fileApiBase(): string {
  return ((import.meta.env.VITE_FILE_API_URL as string) || "").trim().replace(/\/$/, "");
}

export function fileStorageConfigured(): boolean {
  return !!fileApiBase();
}

export function buildSharePageUrl(fileId: string, shareToken: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/?share=${encodeURIComponent(fileId)}&token=${encodeURIComponent(shareToken)}`;
}

export function buildDirectDownloadUrl(fileId: string, shareToken: string): string {
  return `${fileApiBase()}/files/${encodeURIComponent(fileId)}/content?token=${encodeURIComponent(shareToken)}`;
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${fileApiBase()}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error || `File service unavailable (${response.status})`);
  return body;
}

async function retry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

export async function uploadStoredFile(
  roomId: string,
  sessionToken: string,
  file: File,
  optionsOrHours: number | UploadOptions,
  onProgress: (progress: number) => void,
): Promise<{ file: StoredFile; shareToken: string; downloadUrl: string; sharePageUrl: string }> {
  const opts: UploadOptions = typeof optionsOrHours === "number"
    ? { expirySeconds: Math.round(optionsOrHours * 3600) }
    : optionsOrHours;
  const ttl = Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Math.round(opts.expirySeconds)));
  const linkTtl = Math.max(MIN_TTL_SECONDS, Math.min(ttl, Math.round(opts.linkExpirySeconds ?? ttl)));
  const created = await request<UploadInit>(`/rooms/${encodeURIComponent(roomId)}/uploads`, sessionToken, {
    method: "POST",
    body: JSON.stringify({
      name: file.name,
      size: file.size,
      contentType: file.type || "application/octet-stream",
      expiresInSeconds: ttl,
      linkExpiresInSeconds: linkTtl,
      maxDownloads: opts.maxDownloads ?? null,
      password: opts.password ?? null,
    }),
  });
  const parts: Array<{ partNumber: number; etag: string }> = [];
  const totalParts = Math.ceil(file.size / created.partSize);
  try {
    for (let index = 0; index < totalParts; index += 1) {
      const start = index * created.partSize;
      const end = Math.min(file.size, start + created.partSize);
      const partNumber = index + 1;
      const part = await retry(async () => {
        const response = await fetch(`${fileApiBase()}/uploads/${created.fileId}/parts/${partNumber}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/octet-stream" },
          body: file.slice(start, end),
        });
        const value = await response.json().catch(() => ({})) as { partNumber?: number; etag?: string; error?: string };
        if (!response.ok || !value.etag) throw new Error(value.error || `Part ${partNumber} failed`);
        return { partNumber: value.partNumber || partNumber, etag: value.etag };
      });
      parts.push(part);
      onProgress(Math.round((end / file.size) * 95));
    }
    const completed = await request<{ file: StoredFile }>(`/uploads/${created.fileId}/complete`, sessionToken, {
      method: "POST",
      body: JSON.stringify({ parts }),
    });
    onProgress(100);
    const downloadUrl = buildDirectDownloadUrl(created.fileId, created.shareToken);
    const sharePageUrl = buildSharePageUrl(created.fileId, created.shareToken);
    return { file: completed.file, shareToken: created.shareToken, downloadUrl, sharePageUrl };
  } catch (error) {
    await request(`/uploads/${created.fileId}`, sessionToken, { method: "DELETE" }).catch(() => undefined);
    throw error;
  }
}

export async function listRoomFiles(roomId: string, sessionToken: string): Promise<StoredFile[]> {
  return (await request<{ files: StoredFile[] }>(`/rooms/${encodeURIComponent(roomId)}/files`, sessionToken)).files;
}

export async function updateStoredFile(
  id: string,
  sessionToken: string,
  patchOrExpiresAt: number | FilePatch,
  linkExpiresAt?: number
): Promise<StoredFile> {
  const payload: FilePatch = typeof patchOrExpiresAt === "number"
    ? { expiresAt: patchOrExpiresAt, linkExpiresAt }
    : patchOrExpiresAt;
  return (await request<{ file: StoredFile }>(`/files/${encodeURIComponent(id)}`, sessionToken, {
    method: "PATCH",
    body: JSON.stringify(payload),
  })).file;
}

export async function deleteStoredFile(id: string, sessionToken: string): Promise<void> {
  await request(`/files/${encodeURIComponent(id)}`, sessionToken, { method: "DELETE" });
}

export async function createDownloadUrl(id: string, sessionToken: string): Promise<string> {
  return (await request<{ url: string }>(`/files/${encodeURIComponent(id)}/download-link`, sessionToken, { method: "POST" })).url;
}

export async function getPublicShareInfo(fileId: string, token: string): Promise<PublicShareInfo> {
  return (await request<{ file: PublicShareInfo }>(
    `/public/files/${encodeURIComponent(fileId)}?token=${encodeURIComponent(token)}`,
    ""
  )).file;
}

export async function requestPublicDownloadUrl(
  fileId: string,
  token: string,
  password?: string
): Promise<{ url: string; expiresAt: number }> {
  return request<{ url: string; expiresAt: number }>(
    `/public/files/${encodeURIComponent(fileId)}/access`,
    "",
    {
      method: "POST",
      body: JSON.stringify({ token, password }),
    }
  );
}

export async function adminLogin(password: string): Promise<{ token: string; expiresAt: number }> {
  return request("/admin/login", "", { method: "POST", body: JSON.stringify({ password }) });
}

export async function listAdminFiles(token: string): Promise<{ files: StoredFile[]; truncated: boolean }> {
  return request("/admin/files", token);
}

export async function deleteAdminFile(file: StoredFile, token: string): Promise<void> {
  if (file.status === "orphan" && file.objectKey) {
    await request(`/admin/objects?key=${encodeURIComponent(file.objectKey)}`, token, { method: "DELETE" });
    return;
  }
  await request(`/admin/files/${encodeURIComponent(file.id)}`, token, { method: "DELETE" });
}

export async function updateAdminFile(
  id: string,
  token: string,
  patchOrExpiresAt: number | FilePatch,
  linkExpiresAt?: number
): Promise<StoredFile> {
  const payload: FilePatch = typeof patchOrExpiresAt === "number"
    ? { expiresAt: patchOrExpiresAt, linkExpiresAt }
    : patchOrExpiresAt;
  return (await request<{ file: StoredFile }>(`/admin/files/${encodeURIComponent(id)}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload),
  })).file;
}

