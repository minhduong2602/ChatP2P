import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const base = process.env.FILE_API_TEST_URL || "http://127.0.0.1:8787";
const internalSecret = process.env.FILE_API_TEST_SECRET || "local-file-secret";
const adminPassword = process.env.FILE_API_TEST_ADMIN_PASSWORD || "local-admin";
const roomId = `smoke-${Date.now()}`;
const sessionId = `session-${Date.now()}`;
const sessionToken = `token-${Date.now()}`;
const tokenHash = createHash("sha256").update(sessionToken).digest("hex");

async function json(path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const registered = await json("/internal/sessions", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Internal-Secret": internalSecret },
  body: JSON.stringify({ sessionId, tokenHash, roomId, owner: true, expiresAt: Date.now() + 60_000 }),
});
assert.equal(registered.response.status, 200);

const content = new TextEncoder().encode("ChatP2P R2 smoke test");
const created = await json(`/rooms/${roomId}/uploads`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
  body: JSON.stringify({ name: "smoke.txt", size: content.byteLength, contentType: "text/plain", expiresInSeconds: 3600, linkExpiresInSeconds: 3600 }),
});
assert.equal(created.response.status, 201);

const uploaded = await json(`/uploads/${created.body.fileId}/parts/1`, {
  method: "PUT",
  headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${sessionToken}` },
  body: content,
});
assert.equal(uploaded.response.status, 200);

const completed = await json(`/uploads/${created.body.fileId}/complete`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
  body: JSON.stringify({ parts: [uploaded.body] }),
});
assert.equal(completed.response.status, 200);
assert.equal(completed.body.file.status, "ready");

const downloaded = await fetch(`${base}/files/${created.body.fileId}/content?token=${created.body.shareToken}`);
assert.equal(downloaded.status, 200);
assert.equal(await downloaded.text(), "ChatP2P R2 smoke test");

const ranged = await fetch(`${base}/files/${created.body.fileId}/content?token=${created.body.shareToken}`, { headers: { Range: "bytes=0-6" } });
assert.equal(ranged.status, 206);
assert.equal(await ranged.text(), "ChatP2P");

const roomFiles = await json(`/rooms/${roomId}/files`, { headers: { Authorization: `Bearer ${sessionToken}` } });
assert.equal(roomFiles.response.status, 200);
assert.equal(roomFiles.body.files.length, 1);
assert.equal(roomFiles.body.files[0].canManage, true);

const downloadGrant = await json(`/files/${created.body.fileId}/download-link`, {
  method: "POST",
  headers: { Authorization: `Bearer ${sessionToken}` },
});
assert.equal(downloadGrant.response.status, 200);
assert.equal((await fetch(downloadGrant.body.url)).status, 200);

const revokedLink = await json(`/files/${created.body.fileId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
  body: JSON.stringify({ expiresAt: completed.body.file.expiresAt, linkExpiresAt: Date.now() }),
});
assert.equal(revokedLink.response.status, 200);
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal((await fetch(`${base}/files/${created.body.fileId}/content?token=${created.body.shareToken}`)).status, 403);

const admin = await json("/admin/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password: adminPassword }),
});
assert.equal(admin.response.status, 200);
const inventory = await json("/admin/files", { headers: { Authorization: `Bearer ${admin.body.token}` } });
assert.equal(inventory.response.status, 200);
assert.ok(inventory.body.files.some((file) => file.id === created.body.fileId));

const revoked = await json(`/internal/sessions/${sessionId}`, {
  method: "DELETE",
  headers: { "X-Internal-Secret": internalSecret },
});
assert.equal(revoked.response.status, 200);
const blocked = await json(`/rooms/${roomId}/files`, { headers: { Authorization: `Bearer ${sessionToken}` } });
assert.equal(blocked.response.status, 401);

const removed = await json(`/admin/files/${created.body.fileId}`, {
  method: "DELETE",
  headers: { Authorization: `Bearer ${admin.body.token}` },
});
assert.equal(removed.response.status, 200);

console.log("File API smoke test passed");
