import { useEffect, useRef, useState, useCallback } from "react";
import PartySocket from "partysocket";
import { v4 as uuidv4 } from "uuid";

export type Message = {
  id: string;
  sender: "me" | "peer";
  type: "text" | "file";
  content: string;
  fileUrl?: string;
  fileType?: string;
  fileSize?: number;
  timestamp: number;
};

export type ConnectionStatus =
  | "connecting"   // Socket connecting to PartyKit
  | "waiting"      // In room, waiting for peer
  | "connected"    // Peer present, relay active
  | "disconnected"; // Peer left or error

// File chunking constants for relay
const CHUNK_SIZE = 32 * 1024; // 32 KB per chunk as base64 over WebSocket

export function useWebRTC(roomId: string | null) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [peerCount, setPeerCount] = useState<number>(1);
  const [messages, setMessages] = useState<Message[]>([]);

  const socketRef = useRef<PartySocket | null>(null);
  const myPeerIdRef = useRef<string>("");

  // File receiving state (chunked relay)
  const incomingFileRef = useRef<{
    id: string;
    name: string;
    size: number;
    type: string;
    totalChunks: number;
    chunks: string[];
    receivedChunks: number;
  } | null>(null);

  const addMessage = useCallback((msg: Message) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  // Send a JSON message over the relay socket
  const sendRelay = useCallback((data: Record<string, unknown>) => {
    const sock = socketRef.current;
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify(data));
    }
  }, []);

  const sendRelayRef = useRef(sendRelay);
  sendRelayRef.current = sendRelay;

  useEffect(() => {
    if (!roomId) return;

    setStatus("connecting");
    setMessages([]);
    setPeerCount(1);

    const rawHost = (import.meta.env.VITE_PARTYKIT_HOST as string) || "localhost:1999";
    const partyHost = rawHost
      .replace(/^https?:\/\//, "")
      .replace(/^wss?:\/\//, "")
      .replace(/\/.*$/, "");

    console.log(`[Relay] Connecting to "${partyHost}" room "${roomId}"`);

    const socket = new PartySocket({
      host: partyHost,
      room: roomId,
      connectionTimeout: 15000,
      maxRetries: 20,
    });
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      console.log("[Relay] Socket OPEN");
    });

    socket.addEventListener("error", (e) => {
      console.warn("[Relay] Socket error:", e);
    });

    socket.addEventListener("close", (e: CloseEvent) => {
      console.log(`[Relay] Socket CLOSED code=${e.code}`);
      if (e.code !== 1000 && e.code !== 4000) {
        setStatus("disconnected");
      }
    });

    socket.addEventListener("message", (event: MessageEvent) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return;
      }

      switch (data.type) {
        // ── Connection management ──────────────────────────────
        case "room-joined": {
          const numClients = data.numClients as number;
          myPeerIdRef.current = data.peerId as string;
          setPeerCount(numClients);
          if (numClients >= 2) {
            setStatus("connected");
            console.log("[Relay] Peer already present — relay ACTIVE");
          } else {
            setStatus("waiting");
            console.log("[Relay] Waiting for peer...");
          }
          break;
        }

        case "peer-joined": {
          setPeerCount(2);
          setStatus("connected");
          console.log("[Relay] Peer joined — relay ACTIVE");
          break;
        }

        case "room-full": {
          console.warn("[Relay] Room full");
          setStatus("disconnected");
          break;
        }

        case "peer-disconnected": {
          setPeerCount(1);
          setStatus("waiting");
          incomingFileRef.current = null;
          console.log("[Relay] Peer disconnected — waiting for new peer");
          break;
        }

        // ── Text message relay ─────────────────────────────────
        case "chat-text": {
          addMessage({
            id: (data.id as string) || uuidv4(),
            sender: "peer",
            type: "text",
            content: data.content as string,
            timestamp: (data.timestamp as number) || Date.now(),
          });
          break;
        }

        // ── File relay (chunked) ───────────────────────────────
        case "file-start": {
          incomingFileRef.current = {
            id: data.id as string,
            name: data.name as string,
            size: data.size as number,
            type: data.fileType as string,
            totalChunks: data.totalChunks as number,
            chunks: [],
            receivedChunks: 0,
          };
          console.log(`[Relay] Incoming file "${data.name}" (${data.totalChunks} chunks)`);
          break;
        }

        case "file-chunk": {
          const f = incomingFileRef.current;
          if (!f) return;
          const idx = data.index as number;
          f.chunks[idx] = data.chunk as string;
          f.receivedChunks += 1;

          if (f.receivedChunks >= f.totalChunks) {
            // Reassemble from base64 chunks
            const byteArrays = f.chunks.map((b64) => {
              const binary = atob(b64);
              const arr = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
              return arr;
            });
            const blob = new Blob(byteArrays, { type: f.type });
            const url = URL.createObjectURL(blob);
            addMessage({
              id: f.id,
              sender: "peer",
              type: "file",
              content: f.name,
              fileUrl: url,
              fileType: f.type,
              fileSize: f.size,
              timestamp: Date.now(),
            });
            console.log(`[Relay] File "${f.name}" received ✓`);
            incomingFileRef.current = null;
          }
          break;
        }
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
      incomingFileRef.current = null;
    };
  }, [roomId, addMessage]);

  // ── sendMessage ──────────────────────────────────────────────
  const sendMessage = useCallback(
    (text: string) => {
      if (status !== "connected") return;
      const id = uuidv4();
      sendRelayRef.current({ type: "chat-text", id, content: text, timestamp: Date.now() });
      addMessage({
        id,
        sender: "me",
        type: "text",
        content: text,
        timestamp: Date.now(),
      });
    },
    [status, addMessage]
  );

  // ── sendFile (chunked base64 relay) ─────────────────────────
  const sendFile = useCallback(
    async (file: File) => {
      if (status !== "connected") return;

      const fileId = uuidv4();
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // Split into base64 chunks
      const chunks: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
        const slice = bytes.slice(offset, offset + CHUNK_SIZE);
        // Convert to base64
        let binary = "";
        slice.forEach((b) => (binary += String.fromCharCode(b)));
        chunks.push(btoa(binary));
      }

      const totalChunks = chunks.length;
      console.log(`[Relay] Sending file "${file.name}" in ${totalChunks} chunks`);

      // Send file-start header
      sendRelayRef.current({
        type: "file-start",
        id: fileId,
        name: file.name,
        size: file.size,
        fileType: file.type,
        totalChunks,
      });

      // Send each chunk with a small delay to avoid flooding
      for (let i = 0; i < chunks.length; i++) {
        sendRelayRef.current({ type: "file-chunk", id: fileId, index: i, chunk: chunks[i] });
        // Yield every 10 chunks to keep UI responsive
        if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
      }

      addMessage({
        id: fileId,
        sender: "me",
        type: "file",
        content: file.name,
        fileUrl: URL.createObjectURL(file),
        fileType: file.type,
        fileSize: file.size,
        timestamp: Date.now(),
      });
      console.log(`[Relay] File "${file.name}" sent ✓`);
    },
    [status, addMessage]
  );

  // ── retryConnection (reconnect socket) ───────────────────────
  const retryConnection = useCallback(() => {
    const sock = socketRef.current;
    if (sock) {
      sock.reconnect();
      setStatus("connecting");
    }
  }, []);

  return { status, peerCount, messages, sendMessage, sendFile, retryConnection };
}