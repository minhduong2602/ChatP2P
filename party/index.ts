/// <reference types="@cloudflare/workers-types" />
import {
  Server,
  routePartykitRequest,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from "partyserver";

const INVITE_KEY = "invite-token";

function appPassword(env: Record<string, unknown>): string {
  return typeof env.APP_PASSWORD === "string" ? env.APP_PASSWORD.trim() : "";
}

function allowedOrigin(req: { headers: { get(name: string): string | null } }, env: Record<string, unknown>): string | null {
  const origin = req.headers.get("Origin");
  if (!origin) return null;
  if (/^https?:\/\/localhost(?::\d+)?$/.test(origin)) return origin;
  if (/^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin)) return origin;
  const configured = typeof env.APP_URL === "string" ? env.APP_URL : "";
  try {
    if (configured && origin === new URL(configured).origin) return origin;
  } catch {
    return null;
  }
  return null;
}

function corsHeaders(origin: string | null): HeadersInit {
  return origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        Vary: "Origin",
      }
    : {};
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(origin) },
  });
}

function newInvite(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fileApiConfig(env: Record<string, unknown>): { url: string; secret: string } | null {
  const url = typeof env.FILE_API_URL === "string" ? env.FILE_API_URL.trim().replace(/\/$/, "") : "";
  const secret = typeof env.FILE_API_SECRET === "string" ? env.FILE_API_SECRET.trim() : "";
  return url && secret ? { url, secret } : null;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type StoredRoomMessage = {
  type: "chat-text" | "file-ready";
  id: string;
  senderId: string;
  senderName?: string;
  content?: string;
  name?: string;
  size?: number;
  fileType?: string;
  fileUrl?: string;
  shareUrl?: string;
  shareToken?: string;
  maxDownloads?: number | null;
  hasPassword?: boolean;
  expiresAt?: number;
  linkExpiresAt?: number;
  timestamp: number;
  replyTo?: {
    messageId: string;
    senderName: string;
    type: "text" | "file";
    content: string;
  };
};

const MAX_ROOM_HISTORY = 500;

export interface RelayEnv {
  APP_PASSWORD?: string;
  APP_URL?: string;
  FILE_API_URL?: string;
  FILE_API_SECRET?: string;
  ChatSignalingServer: DurableObjectNamespace<ChatSignalingServer>;
  main?: DurableObjectNamespace<ChatSignalingServer>;
  [key: string]: unknown;
}

/** Relay for a room. Password authenticates owners; a room-bound invite authenticates guests. */
export class ChatSignalingServer extends Server<RelayEnv> {
  history: StoredRoomMessage[] = [];
  reactions: Record<string, Record<string, number>> = {};
  peerNames = new Map<string, string>();

  async onRequest(req: Request): Promise<Response> {
    const origin = allowedOrigin(req, this.env as Record<string, unknown>);
    if (new URL(req.url).pathname.split("/").pop() !== "invite" || req.method !== "POST" || !origin) {
      return json({ error: "Forbidden" }, 403, origin);
    }
    const expected = appPassword(this.env as Record<string, unknown>);
    let payload: { password?: string; action?: string };
    try {
      payload = await req.json();
    } catch {
      return json({ error: "Invalid request" }, 400, origin);
    }
    if (!expected || payload.password !== expected) return json({ error: "Unauthorized" }, 401, origin);
    if (payload.action !== "get" && payload.action !== "rotate") return json({ error: "Invalid action" }, 400, origin);
    let invite = await this.ctx.storage.get<string>(INVITE_KEY);
    if (!invite || payload.action === "rotate") {
      invite = newInvite();
      await this.ctx.storage.put(INVITE_KEY, invite);
    }
    return json({ invite }, 200, origin);
  }

  async onConnect(conn: Connection, ctx: ConnectionContext) {
    const requestUrl = ctx?.request?.url || conn.uri || "";
    const params = new URL(requestUrl, "http://localhost").searchParams;
    const expected = appPassword(this.env as Record<string, unknown>);
    const owner = !!expected && params.get("auth") === expected;
    const invite = params.get("invite");
    const current = await this.ctx.storage.get<string>(INVITE_KEY);
    if (!owner && (!current || invite !== current)) {
      conn.close(4001, "invalid-invite");
      return;
    }

    const connections = [...this.getConnections()].filter(
      (peer) => peer.id !== conn.id && (peer.state as { authorized?: boolean } | null)?.authorized
    );
    if (connections.length >= 50) {
      conn.send(JSON.stringify({ type: "room-full" }));
      conn.close(4000, "room-full");
      return;
    }
    const fileApi = fileApiConfig(this.env as Record<string, unknown>);
    let fileSessionToken: string | undefined;
    if (fileApi) {
      const token = randomToken();
      try {
        const response = await fetch(`${fileApi.url}/internal/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": fileApi.secret },
          body: JSON.stringify({
            sessionId: conn.id,
            tokenHash: await sha256(token),
            roomId: this.name,
            owner,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          }),
        });
        if (response.ok) fileSessionToken = token;
        else console.error(`[PartyServer] File API rejected session registration (${response.status})`);
      } catch (error) {
        console.error("[PartyServer] File API session registration failed", error);
      }
    }
    conn.setState({ authorized: true, owner, fileSession: !!fileSessionToken });
    const numClients = connections.length + 1;
    const peersSnapshot: Record<string, string> = {};
    for (const [peerId, name] of this.peerNames.entries()) {
      if (peerId !== conn.id) peersSnapshot[peerId] = name;
    }
    conn.send(
      JSON.stringify({
        type: "room-joined",
        numClients,
        peerId: conn.id,
        fileSessionToken,
        history: this.history,
        reactions: this.reactions,
        peers: peersSnapshot,
      })
    );
    if (numClients >= 2) {
      for (const peer of connections) {
        if (peer.id !== conn.id) peer.send(JSON.stringify({ type: "peer-joined", peerId: conn.id }));
      }
    }
  }

  onMessage(sender: Connection, rawMessage: WSMessage) {
    if (!(sender.state as { authorized?: boolean } | null)?.authorized) return;
    try {
      const message = typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
      const data = JSON.parse(message) as Record<string, unknown>;
      data.senderId = sender.id;

      if (data.type === "peer-info" && typeof data.nickname === "string") {
        const cleanName = data.nickname.trim().slice(0, 60);
        if (cleanName) this.peerNames.set(sender.id, cleanName);
      } else if (data.type === "chat-text" && typeof data.content === "string") {
        const senderName =
          (typeof data.senderName === "string" && data.senderName.trim()) ||
          this.peerNames.get(sender.id) ||
          "Unknown";
        data.senderName = senderName;
        this.history.push({
          type: "chat-text",
          id: typeof data.id === "string" ? data.id : crypto.randomUUID(),
          senderId: sender.id,
          senderName,
          content: data.content,
          timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
          replyTo: data.replyTo as StoredRoomMessage["replyTo"],
        });
        if (this.history.length > MAX_ROOM_HISTORY) this.history.shift();
      } else if (data.type === "file-ready" && typeof data.id === "string" && typeof data.name === "string") {
        const senderName =
          (typeof data.senderName === "string" && data.senderName.trim()) ||
          this.peerNames.get(sender.id) ||
          "Unknown";
        data.senderName = senderName;
        this.history.push({
          type: "file-ready",
          id: data.id,
          senderId: sender.id,
          senderName,
          name: data.name,
          size: typeof data.size === "number" ? data.size : undefined,
          fileType: typeof data.fileType === "string" ? data.fileType : "application/octet-stream",
          fileUrl: typeof data.fileUrl === "string" ? data.fileUrl : undefined,
          shareUrl: typeof data.shareUrl === "string" ? data.shareUrl : undefined,
          shareToken: typeof data.shareToken === "string" ? data.shareToken : undefined,
          maxDownloads: typeof data.maxDownloads === "number" ? data.maxDownloads : null,
          hasPassword: Boolean(data.hasPassword),
          expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : undefined,
          linkExpiresAt: typeof data.linkExpiresAt === "number" ? data.linkExpiresAt : undefined,
          timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
        });
        if (this.history.length > MAX_ROOM_HISTORY) this.history.shift();
      } else if (data.type === "reaction" && typeof data.msgId === "string" && typeof data.emoji === "string") {
        const msgId = data.msgId;
        const emoji = data.emoji;
        if (!this.reactions[msgId]) this.reactions[msgId] = {};
        this.reactions[msgId][emoji] = (this.reactions[msgId][emoji] || 0) + 1;
      } else if (data.type === "clear-history") {
        this.history = [];
        this.reactions = {};
      }

      for (const peer of this.getConnections()) {
        if (peer.id !== sender.id && (peer.state as { authorized?: boolean } | null)?.authorized) {
          peer.send(JSON.stringify(data));
        }
      }
    } catch {
      console.warn("[PartyServer] Non-JSON message ignored");
    }
  }

  async onClose(conn: Connection) {
    if (!(conn.state as { authorized?: boolean } | null)?.authorized) return;
    conn.setState({ authorized: false });
    this.peerNames.delete(conn.id);

    const fileApi = fileApiConfig(this.env as Record<string, unknown>);
    if (fileApi && (conn.state as { fileSession?: boolean } | null)?.fileSession) {
      try {
        await fetch(`${fileApi.url}/internal/sessions/${encodeURIComponent(conn.id)}`, {
          method: "DELETE",
          headers: { "X-Internal-Secret": fileApi.secret },
        });
      } catch (error) {
        console.error("[PartyServer] File API session revocation failed", error);
      }
    }

    const remainingPeers = [...this.getConnections()].filter(
      (peer) => peer.id !== conn.id && (peer.state as { authorized?: boolean } | null)?.authorized
    );
    for (const peer of remainingPeers) {
      peer.send(JSON.stringify({ type: "peer-disconnected", peerId: conn.id }));
    }

    if (remainingPeers.length === 0) {
      this.history = [];
      this.reactions = {};
      this.peerNames.clear();
    }
  }

  onError(conn: Connection, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[PartyServer] conn ${conn.id} error:`, message);
  }
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env as Record<string, unknown>);

    if (request.method === "OPTIONS") {
      return origin
        ? new Response(null, { status: 204, headers: corsHeaders(origin) })
        : new Response("Forbidden", { status: 403 });
    }

    if (url.pathname === "/auth/verify") {
      if (!origin) return json({ error: "Forbidden" }, 403, null);
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
      const expected = appPassword(env as Record<string, unknown>);
      const supplied = await request.text();
      return expected && supplied === expected
        ? json({ ok: true }, 200, origin)
        : json({ error: "Invalid password" }, 401, origin);
    }

    // PartySocket connects to /parties/main/:room by default
    const serverEnv = {
      ...env,
      main: env.ChatSignalingServer || env.main,
    };

    const response = await routePartykitRequest(request, serverEnv as any, {
      onBeforeConnect(req) {
        const expected = appPassword(env as Record<string, unknown>);
        if (!expected) return new Response("Server password is not configured", { status: 503 });
        const params = new URL(req.url).searchParams;
        const auth = params.get("auth");
        const invite = params.get("invite");
        if (auth === expected || invite) return req;
        return new Response("Unauthorized", { status: 401 });
      },
      onBeforeRequest(req) {
        if (req.method === "OPTIONS") {
          return origin ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response("Forbidden", { status: 403 });
        }
        return req;
      },
    });

    if (response) return response;

    return new Response("Not found", { status: 404 });
  },
};
