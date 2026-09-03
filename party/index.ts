import type * as Party from "partykit/server";

export default class ChatSignalingServer implements Party.Server {
  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection) {
    const connections = [...this.room.getConnections()];
    const numClients = connections.length;

    console.log(`[PartyKit] +conn ${conn.id} room="${this.room.id}" peers=${numClients}`);

    // Reject if room is already full (only 2 peers allowed)
    if (numClients > 2) {
      conn.send(JSON.stringify({ type: "room-full" }));
      conn.close(4000, "room-full");
      return;
    }

    // Tell the new peer how many others are in the room
    conn.send(JSON.stringify({ type: "room-joined", numClients }));

    // Notify existing peers that a new peer joined
    if (numClients === 2) {
      this.room.broadcast(
        JSON.stringify({ type: "peer-joined", peerId: conn.id }),
        [conn.id]
      );
    }
  }

  onMessage(message: string, sender: Party.Connection) {
    try {
      const data = JSON.parse(message);
      console.log(`[PartyKit] msg "${data.type}" from ${sender.id}`);
      // Relay all signaling (ready, offer, answer, candidate) to other peers
      this.room.broadcast(message, [sender.id]);
    } catch {
      console.warn("[PartyKit] Non-JSON message ignored");
    }
  }

  onClose(conn: Party.Connection) {
    console.log(`[PartyKit] -conn ${conn.id} left room "${this.room.id}"`);
    this.room.broadcast(
      JSON.stringify({ type: "peer-disconnected", peerId: conn.id }),
      [conn.id]
    );
  }

  onError(conn: Party.Connection, err: Error) {
    console.error(`[PartyKit] conn ${conn.id} error:`, err.message);
  }
}