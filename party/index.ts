import type * as Party from "partykit/server";

/**
 * ChatSignalingServer — Pure relay server via PartyKit WebSocket.
 * No WebRTC signaling needed. All messages relay directly through
 * Cloudflare Edge for <30ms latency globally.
 */
export default class ChatSignalingServer implements Party.Server {
  constructor(readonly room: Party.Room) {}

  static onBeforeConnect(req: Party.Request, lobby: Party.Lobby) {
    const expectedPassword =
      (lobby.env.APP_PASSWORD as string | undefined) ||
      (lobby.env.VITE_APP_PASSWORD as string | undefined) ||
      "chat123";

    if (expectedPassword) {
      const url = new URL(req.url);
      const auth = url.searchParams.get("auth");
      if (!auth || auth !== expectedPassword) {
        console.warn(`[PartyKit] Connection rejected: invalid auth token from ${req.headers.get("x-forwarded-for") || "unknown"}`);
        return new Response("Unauthorized: Invalid or missing password", { status: 401 });
      }
    }

    return req;
  }

  onConnect(conn: Party.Connection) {
    const connections = [...this.room.getConnections()];
    const numClients = connections.length;

    console.log(`[PartyKit] +conn ${conn.id} room="${this.room.id}" peers=${numClients}`);

    if (numClients > 2) {
      conn.send(JSON.stringify({ type: "room-full" }));
      conn.close(4000, "room-full");
      return;
    }

    // Tell the joining peer their room info
    conn.send(JSON.stringify({ type: "room-joined", numClients, peerId: conn.id }));

    // Tell everyone else that a peer joined
    if (numClients >= 2) {
      this.room.broadcast(
        JSON.stringify({ type: "peer-joined", peerId: conn.id }),
        [conn.id]
      );
    }
  }

  onMessage(message: string, sender: Party.Connection) {
    try {
      const data = JSON.parse(message);
      console.log(`[PartyKit] relay "${data.type}" from ${sender.id}`);
      // Relay everything to all other peers
      this.room.broadcast(message, [sender.id]);
    } catch {
      console.warn("[PartyKit] Non-JSON message ignored");
    }
  }

  onClose(conn: Party.Connection) {
    console.log(`[PartyKit] -conn ${conn.id} left room="${this.room.id}"`);
    this.room.broadcast(
      JSON.stringify({ type: "peer-disconnected", peerId: conn.id }),
      [conn.id]
    );
  }

  onError(conn: Party.Connection, err: Error) {
    console.error(`[PartyKit] conn ${conn.id} error:`, err.message);
  }
}