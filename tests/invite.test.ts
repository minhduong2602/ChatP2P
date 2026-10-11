import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ChatSignalingServer from "../party/index";
import type * as Party from "partykit/server";

const PASSWORD = "owner-secret";
const ORIGIN = "https://chat.example.com";

function makeRoom(id: string) {
  const values = new Map<string, string>();
  const connections: FakeConnection[] = [];
  const room = {
    id,
    env: { APP_PASSWORD: PASSWORD, APP_URL: ORIGIN },
    storage: {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: string) => { values.set(key, value); },
    },
    getConnections: () => connections,
  } as unknown as Party.Room;
  return { room, connections };
}

class FakeConnection {
  id: string;
  uri: string;
  state: { authorized?: boolean; owner?: boolean } | null = null;
  received: string[] = [];
  closedCode: number | null = null;

  constructor(id: string, room: string, query: string) {
    this.id = id;
    this.uri = `https://relay.example.com/parties/main/${room}?${query}`;
  }
  setState(state: { authorized: boolean; owner: boolean }) { this.state = state; return state; }
  send(value: string) { this.received.push(value); }
  close(code: number) { this.closedCode = code; }
}

async function invite(server: ChatSignalingServer, action: "get" | "rotate", password = PASSWORD) {
  const roomId = server.room.id;
  const request = new Request(`https://relay.example.com/parties/main/${roomId}/invite`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ action, password }),
  });
  return server.onRequest(request as unknown as Party.Request);
}

describe("room invite authorization", () => {
  it("verifies the owner password on the server and rejects missing configuration", async () => {
    const request = (password: string) => new Request("https://relay.example.com/auth/verify", {
      method: "POST", headers: { Origin: ORIGIN }, body: password,
    });
    const lobby = { env: { APP_PASSWORD: PASSWORD, APP_URL: ORIGIN } } as unknown as Party.FetchLobby;
    assert.equal((await ChatSignalingServer.onFetch(request(PASSWORD), lobby))?.status, 200);
    assert.equal((await ChatSignalingServer.onFetch(request("wrong"), lobby))?.status, 401);
    assert.equal((await ChatSignalingServer.onFetch(request(PASSWORD), { env: { APP_URL: ORIGIN } } as unknown as Party.FetchLobby))?.status, 401);
    const socketRequest = (query: string) => new Request(`https://relay.example.com/parties/main/room-one?${query}`) as unknown as Party.Request;
    const socketLobby = { env: { APP_PASSWORD: PASSWORD } } as unknown as Party.Lobby;
    assert.equal(ChatSignalingServer.onBeforeConnect(socketRequest(`auth=${PASSWORD}`), socketLobby).url, socketRequest(`auth=${PASSWORD}`).url);
    assert.equal((ChatSignalingServer.onBeforeConnect(socketRequest("auth=wrong"), socketLobby) as Response).status, 401);
    assert.equal((ChatSignalingServer.onBeforeConnect(socketRequest(`auth=${PASSWORD}`), { env: {} } as unknown as Party.Lobby) as Response).status, 503);
  });

  it("allows only the matching room token and blocks the old token after rotation", async () => {
    const first = makeRoom("room-one");
    const second = makeRoom("room-two");
    const firstServer = new ChatSignalingServer(first.room);
    const secondServer = new ChatSignalingServer(second.room);
    const firstResponse = await invite(firstServer, "get");
    assert.equal(firstResponse.status, 200);
    const token = (await firstResponse.json() as { invite: string }).invite;
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal((await invite(firstServer, "rotate", "wrong")).status, 401);
    await invite(secondServer, "get");

    const owner = new FakeConnection("owner", "room-one", `auth=${PASSWORD}`);
    first.connections.push(owner);
    await firstServer.onConnect(owner as unknown as Party.Connection);
    const guest = new FakeConnection("guest", "room-one", `invite=${token}`);
    first.connections.push(guest);
    await firstServer.onConnect(guest as unknown as Party.Connection);
    assert.equal(guest.state?.authorized, true);

    const wrongRoom = new FakeConnection("wrong-room", "room-two", `invite=${token}`);
    second.connections.push(wrongRoom);
    await secondServer.onConnect(wrongRoom as unknown as Party.Connection);
    assert.equal(wrongRoom.closedCode, 4001);
    const malformed = new FakeConnection("malformed", "room-one", "invite=wrong");
    first.connections.push(malformed);
    await firstServer.onConnect(malformed as unknown as Party.Connection);
    assert.equal(malformed.closedCode, 4001);

    const rotated = await invite(firstServer, "rotate");
    const newToken = (await rotated.json() as { invite: string }).invite;
    assert.notEqual(newToken, token);
    const oldGuest = new FakeConnection("old-guest", "room-one", `invite=${token}`);
    first.connections.push(oldGuest);
    await firstServer.onConnect(oldGuest as unknown as Party.Connection);
    assert.equal(oldGuest.closedCode, 4001);
    firstServer.onMessage(JSON.stringify({
      type: "chat-text",
      content: "still here",
      replyTo: { messageId: "original", senderName: "Owner", type: "text", content: "hello" },
    }), guest as unknown as Party.Connection);
    const relayedReply = JSON.parse(owner.received.at(-1) || "{}");
    assert.equal(relayedReply.content, "still here");
    assert.deepEqual(relayedReply.replyTo, {
      messageId: "original",
      senderName: "Owner",
      type: "text",
      content: "hello",
    });
    firstServer.onMessage(JSON.stringify({ type: "chat-text", content: "blocked" }), oldGuest as unknown as Party.Connection);
    assert.doesNotMatch(owner.received.at(-1) || "", /blocked/);

    const newGuest = new FakeConnection("new-guest", "room-one", `invite=${newToken}`);
    first.connections.push(newGuest);
    await firstServer.onConnect(newGuest as unknown as Party.Connection);
    assert.equal(newGuest.state?.authorized, true);
  });

  it("retains messages and shared files sent by a solo user for late joiners, and clears history only when the room is empty", async () => {
    const setup = makeRoom("solo-room");
    const server = new ChatSignalingServer(setup.room);
    const inv = await invite(server, "get");
    const token = (await inv.json() as { invite: string }).invite;

    // 1. Solo owner joins alone and sends a message + file-ready
    const owner = new FakeConnection("owner-1", "solo-room", `auth=${PASSWORD}`);
    setup.connections.push(owner);
    await server.onConnect(owner as unknown as Party.Connection);

    server.onMessage(JSON.stringify({ type: "peer-info", nickname: "Alice" }), owner as unknown as Party.Connection);
    server.onMessage(JSON.stringify({
      type: "chat-text",
      id: "msg-1",
      content: "Hello before anyone else joins!",
      timestamp: 1000,
    }), owner as unknown as Party.Connection);
    server.onMessage(JSON.stringify({
      type: "file-ready",
      id: "file-1",
      name: "report.pdf",
      size: 2048,
      fileType: "application/pdf",
      fileUrl: "https://files.example.com/files/file-1/content?token=abc",
      shareUrl: "https://chat.example.com/?share=file-1&token=abc",
      shareToken: "abc",
      maxDownloads: 5,
      hasPassword: true,
      expiresAt: 9999999,
      linkExpiresAt: 9999999,
      timestamp: 2000,
    }), owner as unknown as Party.Connection);

    // 2. Late guest joins and receives the buffered history
    const guest = new FakeConnection("guest-1", "solo-room", `invite=${token}`);
    setup.connections.push(guest);
    await server.onConnect(guest as unknown as Party.Connection);

    const joinedPayload = JSON.parse(guest.received[0] || "{}");
    assert.equal(joinedPayload.type, "room-joined");
    assert.equal(joinedPayload.numClients, 2);
    assert.equal(joinedPayload.history.length, 2);
    assert.equal(joinedPayload.history[0].content, "Hello before anyone else joins!");
    assert.equal(joinedPayload.history[0].senderName, "Alice");
    assert.equal(joinedPayload.history[1].name, "report.pdf");
    assert.equal(joinedPayload.history[1].maxDownloads, 5);
    assert.equal(joinedPayload.history[1].hasPassword, true);

    // 3. Owner leaves, guest is still in the room -> history still preserved
    await server.onClose(owner as unknown as Party.Connection);
    assert.equal(server.history.length, 2);

    // 4. Guest leaves -> room is now completely empty -> history wiped
    await server.onClose(guest as unknown as Party.Connection);
    assert.equal(server.history.length, 0);
  });
});

