import type * as Party from "partykit/server";

export default class ChatSignalingServer implements Party.Server {
  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const connections = [...this.room.getConnections()];
    const numClients = connections.length;

    console.log(`[PartyKit] User ${conn.id} joined room ${this.room.id} (total: ${numClients})`);

    // Notify the newly connected client of their room state
    conn.send(
      JSON.stringify({
        type: "room-joined",
        numClients,
      })
    );

    // If another peer is already present, notify them
    if (numClients > 1) {
      this.room.broadcast(
        JSON.stringify({
          type: "peer-joined",
          peerId: conn.id,
        }),
        [conn.id]
      );
    }
  }

  onMessage(message: string, sender: Party.Connection) {
    // Relay signaling messages (offer, answer, candidate) to all other peers in the room
    this.room.broadcast(message, [sender.id]);
  }

  onClose(conn: Party.Connection) {
    console.log(`[PartyKit] User ${conn.id} left room ${this.room.id}`);
    this.room.broadcast(
      JSON.stringify({
        type: "peer-disconnected",
        peerId: conn.id,
      })
    );
  }
}
