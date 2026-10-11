import { useEffect, useRef, useState, useCallback } from "react";
import PartySocket from "partysocket";
import { v4 as uuidv4 } from "uuid";
import { partyHost } from "./partyApi";
import { fileStorageConfigured, uploadStoredFile, type UploadOptions } from "./fileApi";

export type Message = {
  id: string;
  senderId: string;
  isMe: boolean;
  senderName?: string;
  type: "text" | "file";
  content: string;
  fileUrl?: string;
  shareUrl?: string;
  shareToken?: string;
  maxDownloads?: number | null;
  hasPassword?: boolean;
  fileType?: string;
  fileSize?: number;
  fileId?: string;
  expiresAt?: number;
  linkExpiresAt?: number;
  timestamp: number;
  replyTo?: ReplyReference;
};

export type ReplyReference = {
  messageId: string;
  senderName: string;
  type: "text" | "file";
  content: string;
};

export type ConnectionStatus =
  | "connecting" // Socket connecting to PartyKit
  | "waiting" // In room (1 peer), room active & ready to send/upload
  | "connected" // 2+ peers present, relay active
  | "disconnected" // Socket error/closed
  | "unauthorized"; // Invite revoked or invalid

export type FileProgress = {
  name: string;
  /** 0–100 */
  progress: number;
  direction: "upload" | "download";
  done: boolean;
};

export type Reactions = Record<string, Record<string, number>>; // msgId → emoji → count

// File chunking constants for relay
const CHUNK_SIZE = 32 * 1024; // 32 KB per chunk as base64 over WebSocket

function sanitizeReply(rawReply: unknown): ReplyReference | undefined {
  if (!rawReply || typeof rawReply !== "object") return undefined;
  const candidate = rawReply as Partial<ReplyReference>;
  if (
    typeof candidate.messageId === "string" &&
    typeof candidate.senderName === "string" &&
    (candidate.type === "text" || candidate.type === "file") &&
    typeof candidate.content === "string"
  ) {
    return {
      messageId: candidate.messageId.slice(0, 100),
      senderName: candidate.senderName.slice(0, 80),
      type: candidate.type,
      content: candidate.content.slice(0, 500),
    };
  }
  return undefined;
}

export function useWebRTC(roomId: string | null, nickname: string, credential: { password?: string; invite?: string }) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [peerCount, setPeerCount] = useState<number>(1);
  const [peers, setPeers] = useState<Record<string, string>>({}); // peerId -> nickname
  const [messages, setMessages] = useState<Message[]>([]);
  const [transferProgress, setTransferProgress] = useState<Record<string, FileProgress>>({});
  const [typingPeers, setTypingPeers] = useState<Set<string>>(new Set());
  const [reactions, setReactions] = useState<Reactions>({});
  const [fileSessionToken, setFileSessionToken] = useState<string>("");

  const socketRef = useRef<PartySocket | null>(null);
  const myPeerIdRef = useRef<string>("");
  const peersRef = useRef<Record<string, string>>({});
  
  const typingTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const typingCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // File receiving state (parallel downloads map)
  type IncomingFile = {
    id: string;
    senderId: string;
    name: string;
    size: number;
    type: string;
    totalChunks: number;
    chunks: string[];
    receivedChunks: number;
  };
  const incomingFilesRef = useRef<Record<string, IncomingFile>>({});

  const addMessage = useCallback((msg: Message) => {
    setMessages((prev) => (prev.some((existing) => existing.id === msg.id) ? prev : [...prev, msg]));
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

  const clearMessages = useCallback(() => {
    setMessages([]);
    setReactions({});
    sendRelayRef.current({ type: "clear-history" });
  }, []);

  useEffect(() => {
    if (!roomId) return;

    setStatus("connecting");
    setMessages([]);
    setPeerCount(1);
    setPeers({});
    peersRef.current = {};
    setTransferProgress({});
    setTypingPeers(new Set());
    setReactions({});

    const relayHost = partyHost();

    if (import.meta.env.DEV) {
      console.log(`[Relay] Connecting to "${relayHost}" room "${roomId}"`);
    }

    const socket = new PartySocket({
      host: relayHost,
      room: roomId,
      query: credential.password ? { auth: credential.password } : { invite: credential.invite },
      connectionTimeout: 15000,
      maxRetries: 20,
    });
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      if (import.meta.env.DEV) console.log("[Relay] Socket OPEN");
    });

    socket.addEventListener("error", (e) => {
      console.warn("[Relay] Socket error:", e);
    });

    socket.addEventListener("close", (e: CloseEvent) => {
      console.log(`[Relay] Socket CLOSED code=${e.code}`);
      if (e.code === 4001) {
        socket.close();
        setStatus("unauthorized");
      } else if (e.code !== 1000 && e.code !== 4000) {
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
          const myId = data.peerId as string;
          myPeerIdRef.current = myId;
          setFileSessionToken(typeof data.fileSessionToken === "string" ? data.fileSessionToken : "");
          setPeerCount(numClients);
          if (numClients >= 2) {
            setStatus("connected");
          } else {
            setStatus("waiting");
          }
          if (data.peers && typeof data.peers === "object") {
            const initialPeers = { ...(data.peers as Record<string, string>) };
            peersRef.current = initialPeers;
            setPeers(initialPeers);
          }
          if (Array.isArray(data.history)) {
            const hydrated: Message[] = [];
            for (const item of data.history as Record<string, unknown>[]) {
              const senderId = (item.senderId as string) || "unknown";
              const senderName = (item.senderName as string) || peersRef.current[senderId] || "Unknown";
              if (item.type === "chat-text" && typeof item.content === "string") {
                hydrated.push({
                  id: (item.id as string) || uuidv4(),
                  senderId,
                  isMe: senderId === myId,
                  senderName,
                  type: "text",
                  content: item.content,
                  timestamp: (item.timestamp as number) || Date.now(),
                  replyTo: sanitizeReply(item.replyTo),
                });
              } else if (item.type === "file-ready" && typeof item.id === "string" && typeof item.name === "string") {
                hydrated.push({
                  id: item.id,
                  senderId,
                  isMe: senderId === myId,
                  senderName,
                  type: "file",
                  content: item.name,
                  fileId: item.id,
                  fileUrl: item.fileUrl as string | undefined,
                  shareUrl: item.shareUrl as string | undefined,
                  shareToken: item.shareToken as string | undefined,
                  maxDownloads: typeof item.maxDownloads === "number" ? item.maxDownloads : null,
                  hasPassword: Boolean(item.hasPassword),
                  fileType: (item.fileType as string) || "application/octet-stream",
                  fileSize: item.size as number | undefined,
                  expiresAt: item.expiresAt as number | undefined,
                  linkExpiresAt: item.linkExpiresAt as number | undefined,
                  timestamp: (item.timestamp as number) || Date.now(),
                });
              }
            }
            setMessages(hydrated);
          }
          if (data.reactions && typeof data.reactions === "object") {
            setReactions(data.reactions as Reactions);
          }
          // Broadcast our info to the room
          sendRelayRef.current({ type: "peer-info", nickname });
          break;
        }

        case "peer-joined": {
          setPeerCount((prev) => prev + 1);
          setStatus("connected");
          // Tell the new peer who we are
          sendRelayRef.current({ type: "peer-info", nickname });
          break;
        }

        case "peer-info": {
          const senderId = data.senderId as string;
          const peerNickname = data.nickname as string;
          if (senderId && peerNickname && senderId !== myPeerIdRef.current) {
            setPeers((prev) => {
              const next = { ...prev, [senderId]: peerNickname };
              peersRef.current = next;
              return next;
            });
          }
          break;
        }

        case "room-full": {
          console.warn("[Relay] Room full");
          setStatus("disconnected");
          break;
        }

        case "peer-disconnected": {
          const peerId = data.peerId as string;
          setPeerCount((prev) => {
            const next = Math.max(1, prev - 1);
            if (next < 2) setStatus("waiting");
            return next;
          });
          setPeers((prev) => {
            const next = { ...prev };
            delete next[peerId];
            peersRef.current = next;
            return next;
          });
          setTypingPeers((prev) => {
            if (!prev.has(peerId)) return prev;
            const next = new Set(prev);
            next.delete(peerId);
            return next;
          });
          if (typingTimersRef.current[peerId]) {
            clearTimeout(typingTimersRef.current[peerId]);
            delete typingTimersRef.current[peerId];
          }
          break;
        }

        // ── Text message relay ─────────────────────────────────
        case "chat-text": {
          const senderId = data.senderId as string;
          const replyTo = sanitizeReply(data.replyTo);
          addMessage({
            id: (data.id as string) || uuidv4(),
            senderId,
            isMe: false,
            senderName: (data.senderName as string) || peersRef.current[senderId] || "Unknown",
            type: "text",
            content: data.content as string,
            timestamp: (data.timestamp as number) || Date.now(),
            replyTo,
          });
          break;
        }

        case "clear-history": {
          setMessages([]);
          setReactions({});
          break;
        }

        // ── Typing indicator ───────────────────────────────────
        case "typing": {
          const senderId = data.senderId as string;
          if (!senderId) return;
          setTypingPeers((prev) => {
            const next = new Set(prev);
            next.add(senderId);
            return next;
          });
          if (typingTimersRef.current[senderId]) clearTimeout(typingTimersRef.current[senderId]);
          typingTimersRef.current[senderId] = setTimeout(() => {
            setTypingPeers((prev) => {
              const next = new Set(prev);
              next.delete(senderId);
              return next;
            });
          }, 2500);
          break;
        }

        // ── Emoji reaction ─────────────────────────────────────
        case "reaction": {
          const msgId = data.msgId as string;
          const emoji = data.emoji as string;
          if (msgId && emoji) {
            setReactions((prev) => ({
              ...prev,
              [msgId]: {
                ...(prev[msgId] || {}),
                [emoji]: ((prev[msgId] || {})[emoji] || 0) + 1,
              },
            }));
          }
          break;
        }

        // ── File relay (chunked) ───────────────────────────────
        case "file-start": {
          const fileId = data.id as string;
          const senderId = data.senderId as string;
          incomingFilesRef.current[fileId] = {
            id: fileId,
            senderId,
            name: data.name as string,
            size: data.size as number,
            type: data.fileType as string,
            totalChunks: data.totalChunks as number,
            chunks: [],
            receivedChunks: 0,
          };
          // Init download progress
          setTransferProgress((prev) => ({
            ...prev,
            [fileId]: { name: data.name as string, progress: 0, direction: "download", done: false },
          }));
          break;
        }

        case "file-chunk": {
          const fileId = data.id as string;
          const f = incomingFilesRef.current[fileId];
          if (!f) return;
          const idx = data.index as number;
          f.chunks[idx] = data.chunk as string;
          f.receivedChunks += 1;

          // Update download progress
          const dlProgress = Math.round((f.receivedChunks / f.totalChunks) * 100);
          setTransferProgress((prev) => ({
            ...prev,
            [f.id]: { ...prev[f.id], progress: dlProgress },
          }));

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
              senderId: f.senderId,
              isMe: false,
              senderName: peersRef.current[f.senderId] || "Unknown",
              type: "file",
              content: f.name,
              fileUrl: url,
              fileType: f.type,
              fileSize: f.size,
              timestamp: Date.now(),
            });
            // Mark done then cleanup
            setTransferProgress((prev) => ({
              ...prev,
              [f.id]: { ...prev[f.id], progress: 100, done: true },
            }));
            const doneId = f.id;
            setTimeout(() => {
              setTransferProgress((prev) => {
                const next = { ...prev };
                delete next[doneId];
                return next;
              });
            }, 3000);
            delete incomingFilesRef.current[fileId];
          }
          break;
        }

        case "file-ready": {
          const senderId = data.senderId as string;
          if (!data.id || !data.name || !data.fileUrl) return;
          addMessage({
            id: data.id as string,
            senderId,
            isMe: false,
            senderName: (data.senderName as string) || peersRef.current[senderId] || "Unknown",
            type: "file",
            content: data.name as string,
            fileId: data.id as string,
            fileUrl: data.fileUrl as string,
            shareUrl: data.shareUrl as string | undefined,
            shareToken: data.shareToken as string | undefined,
            maxDownloads: typeof data.maxDownloads === "number" ? data.maxDownloads : null,
            hasPassword: Boolean(data.hasPassword),
            fileType: (data.fileType as string) || "application/octet-stream",
            fileSize: data.size as number,
            expiresAt: data.expiresAt as number,
            linkExpiresAt: data.linkExpiresAt as number,
            timestamp: (data.timestamp as number) || Date.now(),
          });
          break;
        }
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
      incomingFilesRef.current = {};
      Object.values(typingTimersRef.current).forEach(clearTimeout);
      typingTimersRef.current = {};
      if (typingCooldownRef.current) clearTimeout(typingCooldownRef.current);
    };
  }, [roomId, nickname, credential.password, credential.invite, addMessage]);

  const isRoomActive = status === "connected" || status === "waiting";

  // ── sendMessage ──────────────────────────────────────────────
  const sendMessage = useCallback(
    (text: string, replyTo?: ReplyReference) => {
      if (!isRoomActive) return;
      const id = uuidv4();
      const timestamp = Date.now();
      sendRelayRef.current({ type: "chat-text", id, senderName: nickname, content: text, timestamp, replyTo });
      addMessage({
        id,
        senderId: myPeerIdRef.current,
        isMe: true,
        senderName: nickname,
        type: "text",
        content: text,
        timestamp,
        replyTo,
      });
    },
    [isRoomActive, nickname, addMessage]
  );

  // ── sendTyping (debounced — max 1 signal/second) ──────────────
  const sendTyping = useCallback(() => {
    if (status !== "connected") return;
    if (typingCooldownRef.current) return; // still in cooldown
    sendRelayRef.current({ type: "typing" });
    typingCooldownRef.current = setTimeout(() => {
      typingCooldownRef.current = null;
    }, 1000);
  }, [status]);

  // ── sendReaction ─────────────────────────────────────────────
  const sendReaction = useCallback(
    (msgId: string, emoji: string) => {
      if (!isRoomActive) return;
      sendRelayRef.current({ type: "reaction", msgId, emoji });
      // Optimistic local update
      setReactions((prev) => ({
        ...prev,
        [msgId]: {
          ...(prev[msgId] || {}),
          [emoji]: ((prev[msgId] || {})[emoji] || 0) + 1,
        },
      }));
    },
    [isRoomActive]
  );

  // ── sendFile (R2 storage or chunked base64 relay) ────────────
  const sendFile = useCallback(
    async (file: File, optionsOrHours: number | UploadOptions = 24) => {
      if (!isRoomActive) return;

      if (fileStorageConfigured()) {
        if (!fileSessionToken) throw new Error("File storage is not ready. Reconnect and try again.");
        const pendingId = uuidv4();
        setTransferProgress((prev) => ({
          ...prev,
          [pendingId]: { name: file.name, progress: 0, direction: "upload", done: false },
        }));
        try {
          const uploaded = await uploadStoredFile(roomId || "", fileSessionToken, file, optionsOrHours, (progress) => {
            setTransferProgress((prev) => ({
              ...prev,
              [pendingId]: { ...prev[pendingId], progress },
            }));
          });
          const timestamp = Date.now();
          const message = {
            type: "file-ready",
            id: uploaded.file.id,
            senderName: nickname,
            name: uploaded.file.name,
            size: uploaded.file.size,
            fileType: uploaded.file.contentType,
            fileUrl: uploaded.downloadUrl,
            shareUrl: uploaded.sharePageUrl,
            shareToken: uploaded.shareToken,
            maxDownloads: uploaded.file.maxDownloads,
            hasPassword: uploaded.file.hasPassword,
            expiresAt: uploaded.file.expiresAt,
            linkExpiresAt: uploaded.file.linkExpiresAt,
            timestamp,
          };
          sendRelayRef.current(message);
          addMessage({
            id: uploaded.file.id,
            senderId: myPeerIdRef.current,
            isMe: true,
            senderName: nickname,
            type: "file",
            content: uploaded.file.name,
            fileId: uploaded.file.id,
            fileUrl: uploaded.downloadUrl,
            shareUrl: uploaded.sharePageUrl,
            shareToken: uploaded.shareToken,
            maxDownloads: uploaded.file.maxDownloads,
            hasPassword: uploaded.file.hasPassword,
            fileType: uploaded.file.contentType,
            fileSize: uploaded.file.size,
            expiresAt: uploaded.file.expiresAt || undefined,
            linkExpiresAt: uploaded.file.linkExpiresAt || undefined,
            timestamp,
          });
          setTransferProgress((prev) => ({
            ...prev,
            [pendingId]: { ...prev[pendingId], progress: 100, done: true },
          }));
        } finally {
          setTimeout(() => {
            setTransferProgress((prev) => {
              const next = { ...prev };
              delete next[pendingId];
              return next;
            });
          }, 3000);
        }
        return;
      }

      const fileId = uuidv4();
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // Split into base64 chunks
      const chunks: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
        const slice = bytes.slice(offset, offset + CHUNK_SIZE);
        let binary = "";
        slice.forEach((b) => (binary += String.fromCharCode(b)));
        chunks.push(btoa(binary));
      }
      const totalChunks = chunks.length || 1;

      // Init upload progress
      setTransferProgress((prev) => ({
        ...prev,
        [fileId]: { name: file.name, progress: 0, direction: "upload", done: false },
      }));

      // Send file-start header
      sendRelayRef.current({
        type: "file-start",
        id: fileId,
        name: file.name,
        size: file.size,
        fileType: file.type,
        totalChunks,
      });

      // Send each chunk with progress updates
      for (let i = 0; i < chunks.length; i++) {
        sendRelayRef.current({ type: "file-chunk", id: fileId, index: i, chunk: chunks[i] });
        // Yield every 10 chunks to keep UI responsive
        if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
        const progress = Math.round(((i + 1) / totalChunks) * 100);
        setTransferProgress((prev) => ({
          ...prev,
          [fileId]: { ...prev[fileId], progress },
        }));
      }

      addMessage({
        id: fileId,
        senderId: myPeerIdRef.current,
        isMe: true,
        senderName: nickname,
        type: "file",
        content: file.name,
        fileUrl: URL.createObjectURL(file),
        fileType: file.type,
        fileSize: file.size,
        timestamp: Date.now(),
      });

      // Mark done then cleanup
      setTransferProgress((prev) => ({
        ...prev,
        [fileId]: { ...prev[fileId], progress: 100, done: true },
      }));
      setTimeout(() => {
        setTransferProgress((prev) => {
          const next = { ...prev };
          delete next[fileId];
          return next;
        });
      }, 3000);
    },
    [isRoomActive, nickname, addMessage, fileSessionToken, roomId]
  );

  // ── sendFiles (send multiple files sequentially) ─────────────
  const sendFiles = useCallback(
    async (files: File[], optionsOrHours: number | UploadOptions = 24) => {
      for (const file of files) {
        if (!isRoomActive) break;
        await sendFile(file, optionsOrHours);
      }
    },
    [isRoomActive, sendFile]
  );

  // ── retryConnection (reconnect socket) ───────────────────────
  const retryConnection = useCallback(() => {
    const sock = socketRef.current;
    if (sock) {
      sock.reconnect();
      setStatus("connecting");
    }
  }, []);

  return {
    status,
    peerCount,
    peers,
    messages,
    sendMessage,
    sendFile,
    sendFiles,
    sendTyping,
    sendReaction,
    clearMessages,
    retryConnection,
    transferProgress,
    typingPeers,
    reactions,
    fileSessionToken,
  };
}

