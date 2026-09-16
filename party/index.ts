import type * as Party from "partykit/server";

const INVITE_KEY = "invite-token";

function appPassword(env: Record<string, unknown>): string {
  return typeof env.APP_PASSWORD === "string" ? env.APP_PASSWORD.trim() : "";
}

function allowedOrigin(req: { headers: { get(name: string): string | null } }, env: Record<string, unknown>): string | null {
  const origin = req.headers.get("Origin");
  if (!origin) return null;
  const configured = typeof env.APP_URL === "string" ? env.APP_URL : "";
  try {
    if (configured && origin === new URL(configured).origin) return origin;
    if (!configured && /^https?:\/\/localhost(?::\d+)?$/.test(origin)) return origin;
    if (!configured && /^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin)) return origin;
  } catch {
    return null;
  }
  return null;
}

function corsHeaders(origin: string | null): HeadersInit {
  return origin
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" }
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

/** Relay for a room. Password authenticates owners; a room-bound invite authenticates guests. */
export default class ChatSignalingServer implements Party.Server {
  constructor(readonly room: Party.Room) {}

  static async onFetch(req: Request, lobby: Party.FetchLobby) {
    if (new URL(req.url).pathname !== "/auth/verify") return null;
    const origin = allowedOrigin(req, lobby.env);
    if (req.method === "OPTIONS") {
      return origin ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response("Forbidden", { status: 403 });
    }
    if (req.method !== "POST" || !origin) return json({ error: "Forbidden" }, 403, origin);
    const expected = appPassword(lobby.env);
    const supplied = await req.text();
    return expected && supplied === expected
      ? json({ ok: true }, 200, origin)
      : json({ error: "Invalid password" }, 401, origin);
  }

  static onBeforeRequest(req: Request, lobby: Party.Lobby) {
    if (req.method !== "OPTIONS") return req;
    const origin = allowedOrigin(req, lobby.env);
    return origin ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : new Response("Forbidden", { status: 403 });
  }

  static onBeforeConnect(req: Party.Request, lobby: Party.Lobby) {
    const expected = appPassword(lobby.env);
    if (!expected) return new Response("Server password is not configured", { status: 503 });
    const params = new URL(req.url).searchParams;
    const auth = params.get("auth");
    const invite = params.get("invite");
    if (auth === expected || invite) return req;
    return new Response("Unauthorized", { status: 401 });
  }

  async onRequest(req: Party.Request) {
    const origin = allowedOrigin(req, this.room.env);
    if (new URL(req.url).pathname.split("/").pop() !== "invite" || req.method !== "POST" || !origin) {
      return json({ error: "Forbidden" }, 403, origin);
    }
    const expected = appPassword(this.room.env);
    let payload: { password?: string; action?: string };
    try {
      payload = await req.json();
    } catch {
      return json({ error: "Invalid request" }, 400, origin);
    }
    if (!expected || payload.password !== expected) return json({ error: "Unauthorized" }, 401, origin);
    if (payload.action !== "get" && payload.action !== "rotate") return json({ error: "Invalid action" }, 400, origin);
    let invite = await this.room.storage.get<string>(INVITE_KEY);
    if (!invite || payload.action === "rotate") {
      invite = newInvite();
      await this.room.storage.put(INVITE_KEY, invite);
    }
    return json({ invite }, 200, origin);
  }

  async onConnect(conn: Party.Connection) {
    const params = new URL(conn.uri).searchParams;
    const expected = appPassword(this.room.env);
    const owner = !!expected && params.get("auth") === expected;
    const invite = params.get("invite");
    const current = await this.room.storage.get<string>(INVITE_KEY);
    if (!owner && (!current || invite !== current)) {
      conn.close(4001, "invalid-invite");
      return;
    }

    const connections = [...this.room.getConnections()].filter((peer) => (peer.state as { authorized?: boolean } | null)?.authorized);
    if (connections.length >= 50) {
      conn.send(JSON.stringify({ type: "room-full" }));
      conn.close(4000, "room-full");
      return;
    }
    const fileApi = fileApiConfig(this.room.env);
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
            roomId: this.room.id,
            owner,
            expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          }),
        });
        if (response.ok) fileSessionToken = token;
        else console.error(`[PartyKit] File API rejected session registration (${response.status})`);
      } catch (error) {
        console.error("[PartyKit] File API session registration failed", error);
      }
    }
    conn.setState({ authorized: true, owner, fileSession: !!fileSessionToken });
    const numClients = connections.length + 1;
    conn.send(JSON.stringify({ type: "room-joined", numClients, peerId: conn.id, fileSessionToken }));
    if (numClients >= 2) {
      for (const peer of connections) {
        if (peer.id !== conn.id) peer.send(JSON.stringify({ type: "peer-joined", peerId: conn.id }));
      }
    }
  }

  onMessage(message: string, sender: Party.Connection) {
    if (!(sender.state as { authorized?: boolean } | null)?.authorized) return;
    try {
      const data = JSON.parse(message);
      data.senderId = sender.id;
      for (const peer of this.room.getConnections()) {
        if (peer.id !== sender.id && (peer.state as { authorized?: boolean } | null)?.authorized) {
          peer.send(JSON.stringify(data));
        }
      }
    } catch {
      console.warn("[PartyKit] Non-JSON message ignored");
    }
  }

  async onClose(conn: Party.Connection) {
    if (!(conn.state as { authorized?: boolean } | null)?.authorized) return;
    const fileApi = fileApiConfig(this.room.env);
    if (fileApi && (conn.state as { fileSession?: boolean } | null)?.fileSession) {
      try {
        await fetch(`${fileApi.url}/internal/sessions/${encodeURIComponent(conn.id)}`, {
          method: "DELETE",
          headers: { "X-Internal-Secret": fileApi.secret },
        });
      } catch (error) {
        console.error("[PartyKit] File API session revocation failed", error);
      }
    }
    for (const peer of this.room.getConnections()) {
      if (peer.id !== conn.id && (peer.state as { authorized?: boolean } | null)?.authorized) {
        peer.send(JSON.stringify({ type: "peer-disconnected", peerId: conn.id }));
      }
    }
  }

  onError(conn: Party.Connection, err: Error) {
    console.error(`[PartyKit] conn ${conn.id} error:`, err.message);
  }
}
