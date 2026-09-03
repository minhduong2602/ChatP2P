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
  timestamp: number;
};

export type ConnectionStatus =
  | "connecting"
  | "waiting"
  | "negotiating"
  | "connected"
  | "disconnected";

// Lean ICE config: 1 STUN (Google) + 1 STUN (Cloudflare) + TURN relay cluster.
// Pre-gathering 4 candidates reduces time-to-first-candidate significantly.
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelay",
      credential: "openrelay",
    },
  ],
  iceCandidatePoolSize: 4, // pre-gather before offer — cuts ICE latency
};

// How long to wait (ms) for peer to signal "ready" before sending offer anyway
const READY_TIMEOUT_MS = 3000;

export function useWebRTC(roomId: string | null) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [peerCount, setPeerCount] = useState<number>(1);
  const [messages, setMessages] = useState<Message[]>([]);

  const socketRef = useRef<PartySocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Perfect Negotiation (RFC 8829 §4.1.1)
  const isPoliteRef = useRef(false);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);

  // File receiving state
  const receiveBufferRef = useRef<ArrayBuffer[]>([]);
  const receivedSizeRef = useRef(0);
  const incomingFileInfoRef = useRef<{
    id?: string;
    name: string;
    size: number;
    type: string;
  } | null>(null);

  const addMessage = useCallback((msg: Message) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  // Send a JSON signaling message over the PartySocket
  const sendSignal = useCallback((data: Record<string, unknown>) => {
    const sock = socketRef.current;
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify(data));
    }
  }, []);

  const sendSignalRef = useRef(sendSignal);
  sendSignalRef.current = sendSignal;

  // ----------------------------------------------------------------
  // setupDataChannel
  // ----------------------------------------------------------------
  const setupDataChannel = useCallback(
    (channel: RTCDataChannel) => {
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = 65536;

      channel.onopen = () => {
        console.log("[WebRTC] DataChannel opened ✓");
        setStatus("connected");
      };

      channel.onclose = () => {
        console.log("[WebRTC] DataChannel closed");
        setStatus((s) => (s === "connected" ? "disconnected" : s));
      };

      channel.onerror = (err) =>
        console.error("[WebRTC] DataChannel error", err);

      channel.onmessage = (event) => {
        if (typeof event.data === "string") {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "file-start") {
              incomingFileInfoRef.current = data.meta;
              receiveBufferRef.current = [];
              receivedSizeRef.current = 0;
            } else if (data.type === "text") {
              addMessage({
                id: uuidv4(),
                sender: "peer",
                type: "text",
                content: data.content,
                timestamp: Date.now(),
              });
            }
          } catch (e) {
            console.error("[WebRTC] Failed to parse message", e);
          }
        } else if (event.data instanceof ArrayBuffer) {
          receiveBufferRef.current.push(event.data);
          receivedSizeRef.current += event.data.byteLength;

          if (
            incomingFileInfoRef.current &&
            receivedSizeRef.current >= incomingFileInfoRef.current.size
          ) {
            const blob = new Blob(receiveBufferRef.current, {
              type: incomingFileInfoRef.current.type,
            });
            addMessage({
              id: incomingFileInfoRef.current.id || uuidv4(),
              sender: "peer",
              type: "file",
              content: incomingFileInfoRef.current.name,
              fileUrl: URL.createObjectURL(blob),
              fileType: incomingFileInfoRef.current.type,
              timestamp: Date.now(),
            });
            incomingFileInfoRef.current = null;
            receiveBufferRef.current = [];
            receivedSizeRef.current = 0;
          }
        }
      };

      dataChannelRef.current = channel;
    },
    [addMessage]
  );

  const setupDataChannelRef = useRef(setupDataChannel);
  setupDataChannelRef.current = setupDataChannel;

  // ----------------------------------------------------------------
  // initiateOffer — called only after both peers are ready
  // ----------------------------------------------------------------
  const initiateOffer = useCallback(
    (pc: RTCPeerConnection) => {
      if (dataChannelRef.current && dataChannelRef.current.readyState !== "closed") {
        console.log("[WebRTC] DataChannel already exists, skipping re-initiation");
        return;
      }
      console.log("[WebRTC] Creating DataChannel and triggering offer...");
      const dc = pc.createDataChannel("chat", { ordered: true });
      setupDataChannelRef.current(dc);
      // onnegotiationneeded fires automatically -> sends offer
    },
    []
  );

  const initiateOfferRef = useRef(initiateOffer);
  initiateOfferRef.current = initiateOffer;

  // ----------------------------------------------------------------
  // createPeerConnection — builds fresh RTCPeerConnection
  // ----------------------------------------------------------------
  const createPeerConnection = useCallback((): RTCPeerConnection => {
    if (peerRef.current) {
      peerRef.current.onicecandidate = null;
      peerRef.current.ondatachannel = null;
      peerRef.current.onnegotiationneeded = null;
      peerRef.current.oniceconnectionstatechange = null;
      peerRef.current.onconnectionstatechange = null;
      peerRef.current.close();
      peerRef.current = null;
    }

    iceCandidateQueueRef.current = [];
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;

    const pc = new RTCPeerConnection(ICE_SERVERS);

    // Trickle ICE — send each candidate as soon as it is found (no batching)
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        sendSignalRef.current({
          type: "candidate",
          candidate: candidate.toJSON(),
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.log("[WebRTC] ICE:", s);
      if (s === "failed") {
        // Attempt seamless ICE restart before giving up
        if (typeof pc.restartIce === "function") {
          console.warn("[WebRTC] ICE failed — restarting ICE...");
          pc.restartIce();
        } else {
          setStatus("disconnected");
        }
      }
      // Do NOT set disconnected on "disconnected" ICE state alone —
      // it is transient and usually recovers automatically.
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log("[WebRTC] Connection:", s);
      if (s === "connected") {
        setStatus("connected");
      } else if (s === "failed") {
        // Only hard-fail on connection-level failure, not ICE-level
        setStatus("disconnected");
      }
      // "disconnected" state is transient - do not hard-fail
    };

    pc.ondatachannel = (event) => {
      console.log("[WebRTC] Received remote DataChannel");
      setupDataChannelRef.current(event.channel);
    };

    // Perfect Negotiation: onnegotiationneeded fires when createDataChannel is called
    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current = true;
        setStatus("negotiating");
        console.log("[WebRTC] onnegotiationneeded — creating offer...");
        await pc.setLocalDescription();
        sendSignalRef.current({ type: "offer", offer: pc.localDescription });
        console.log("[WebRTC] Offer sent via PartyKit ✓");
      } catch (err) {
        console.error("[WebRTC] onnegotiationneeded error:", err);
        // Don't immediately set disconnected — error could be transient
      } finally {
        makingOfferRef.current = false;
      }
    };

    peerRef.current = pc;
    return pc;
  }, []);

  const createPeerConnectionRef = useRef(createPeerConnection);
  createPeerConnectionRef.current = createPeerConnection;

  // ----------------------------------------------------------------
  // useEffect — socket lifecycle (only depends on roomId)
  // ----------------------------------------------------------------
  useEffect(() => {
    if (!roomId) return;

    setStatus("connecting");

    const rawHost = (import.meta.env.VITE_PARTYKIT_HOST as string) || "localhost:1999";
    const partyHost = rawHost
      .replace(/^https?:\/\//, "")
      .replace(/^wss?:\/\//, "")
      .replace(/\/.*$/, "");

    console.log(`[Signaling] Connecting to "${partyHost}" room "${roomId}"`);

    const socket = new PartySocket({
      host: partyHost,
      room: roomId,
      connectionTimeout: 15000,
      maxRetries: 10,
    });
    socketRef.current = socket;

    socket.addEventListener("open", () =>
      console.log(`[Signaling] Socket OPEN for room "${roomId}"`)
    );
    socket.addEventListener("error", (e) =>
      console.warn("[Signaling] Socket error:", e)
    );
    socket.addEventListener("close", (e: CloseEvent) =>
      console.log(`[Signaling] Socket CLOSED code=${e.code}`)
    );

    socket.addEventListener("message", async (event: MessageEvent) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return;
      }

      switch (data.type) {
        // ---- room-joined: we just connected to the signaling room ----
        case "room-joined": {
          const numClients = data.numClients as number;
          console.log(`[Signaling] room-joined (peers in room: ${numClients})`);
          setPeerCount(numClients);

          if (numClients > 1) {
            // We are the POLITE peer (late joiner).
            // Create PC immediately, then tell the offerer we're ready.
            isPoliteRef.current = true;
            setStatus("negotiating");
            console.log("[WebRTC] Role: POLITE — sending ready signal");
            createPeerConnectionRef.current();
            // Signal the other peer that we have our PC set up
            socket.send(JSON.stringify({ type: "ready" }));
          } else {
            // We are the IMPOLITE peer (early joiner / offerer).
            isPoliteRef.current = false;
            setStatus("waiting");
            console.log("[WebRTC] Role: IMPOLITE — waiting for peer + ready signal");
            createPeerConnectionRef.current();
          }
          break;
        }

        // ---- peer-joined: a 2nd peer has connected to our room ----
        case "peer-joined": {
          console.log("[Signaling] peer-joined — waiting for their ready signal");
          setPeerCount(2);
          // Don't initiate yet; wait for "ready" from the peer.
          // Safety fallback: if ready never arrives within READY_TIMEOUT_MS, initiate anyway.
          if (readyTimerRef.current) clearTimeout(readyTimerRef.current);
          readyTimerRef.current = setTimeout(() => {
            const pc = peerRef.current;
            if (pc && (!dataChannelRef.current || dataChannelRef.current.readyState === "closed")) {
              console.warn("[WebRTC] ready signal timeout — initiating offer anyway");
              initiateOfferRef.current(pc);
            }
          }, READY_TIMEOUT_MS);
          break;
        }

        // ---- ready: peer-2 has their PC set up, safe to send offer ----
        case "ready": {
          console.log("[Signaling] Peer sent ready ✓ — initiating offer");
          if (readyTimerRef.current) {
            clearTimeout(readyTimerRef.current);
            readyTimerRef.current = null;
          }
          const pc = peerRef.current;
          if (pc) {
            initiateOfferRef.current(pc);
          }
          break;
        }

        // ---- room-full ----
        case "room-full": {
          console.warn("[Signaling] Room is full!");
          setStatus("disconnected");
          break;
        }

        // ---- offer ----
        case "offer": {
          const pc = peerRef.current;
          if (!pc) return;

          const offerCollision =
            makingOfferRef.current || pc.signalingState !== "stable";
          ignoreOfferRef.current = !isPoliteRef.current && offerCollision;

          if (ignoreOfferRef.current) {
            console.log("[WebRTC] Glare — ignoring offer (impolite)");
            return;
          }

          setStatus("negotiating");
          try {
            if (offerCollision) {
              console.log("[WebRTC] Glare — rolling back (polite)");
              await pc.setLocalDescription({ type: "rollback" });
            }
            await pc.setRemoteDescription(
              new RTCSessionDescription(data.offer as RTCSessionDescriptionInit)
            );
            // Flush queued ICE candidates
            const queued = iceCandidateQueueRef.current.splice(0);
            for (const c of queued) {
              await pc.addIceCandidate(new RTCIceCandidate(c)).catch((e) =>
                console.warn("[WebRTC] Queued ICE flush:", e)
              );
            }
            await pc.setLocalDescription();
            socket.send(
              JSON.stringify({ type: "answer", answer: pc.localDescription })
            );
            console.log("[WebRTC] Answer sent ✓");
          } catch (err) {
            console.error("[WebRTC] Error handling offer:", err);
            // Don't set disconnected — let ICE recovery try
          }
          break;
        }

        // ---- answer ----
        case "answer": {
          const pc = peerRef.current;
          if (!pc || ignoreOfferRef.current) return;

          if (pc.signalingState !== "have-local-offer") {
            console.warn("[WebRTC] Answer in unexpected state:", pc.signalingState);
            return;
          }
          try {
            await pc.setRemoteDescription(
              new RTCSessionDescription(data.answer as RTCSessionDescriptionInit)
            );
            // Flush queued ICE candidates
            const queued = iceCandidateQueueRef.current.splice(0);
            for (const c of queued) {
              await pc.addIceCandidate(new RTCIceCandidate(c)).catch((e) =>
                console.warn("[WebRTC] Queued ICE flush:", e)
              );
            }
            console.log("[WebRTC] Answer applied ✓");
          } catch (err) {
            console.error("[WebRTC] Error applying answer:", err);
          }
          break;
        }

        // ---- candidate (trickle ICE) ----
        case "candidate": {
          if (!data.candidate || ignoreOfferRef.current) return;
          const pc = peerRef.current;
          if (!pc) return;

          const cand = data.candidate as RTCIceCandidateInit;
          if (pc.remoteDescription?.type) {
            await pc
              .addIceCandidate(new RTCIceCandidate(cand))
              .catch((e) => console.warn("[WebRTC] ICE candidate error:", e));
          } else {
            // Queue until remote description is set
            iceCandidateQueueRef.current.push(cand);
          }
          break;
        }

        // ---- peer-disconnected ----
        case "peer-disconnected": {
          console.log("[Signaling] Peer disconnected");
          if (readyTimerRef.current) {
            clearTimeout(readyTimerRef.current);
            readyTimerRef.current = null;
          }
          setPeerCount(1);
          setStatus("waiting");
          iceCandidateQueueRef.current = [];
          makingOfferRef.current = false;
          ignoreOfferRef.current = false;
          isPoliteRef.current = false;
          dataChannelRef.current = null;
          // Rebuild PC so we're ready for the next peer
          createPeerConnectionRef.current();
          break;
        }
      }
    });

    return () => {
      if (readyTimerRef.current) clearTimeout(readyTimerRef.current);
      socket.close();
      if (peerRef.current) {
        peerRef.current.close();
        peerRef.current = null;
      }
      dataChannelRef.current = null;
      socketRef.current = null;
    };
  }, [roomId]);

  // ----------------------------------------------------------------
  // retryConnection — manual re-kick
  // ----------------------------------------------------------------
  const retryConnection = useCallback(() => {
    if (readyTimerRef.current) {
      clearTimeout(readyTimerRef.current);
      readyTimerRef.current = null;
    }
    iceCandidateQueueRef.current = [];
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    isPoliteRef.current = false;
    dataChannelRef.current = null;

    const pc = createPeerConnectionRef.current();
    initiateOfferRef.current(pc);
    setStatus("negotiating");
  }, []);

  // ----------------------------------------------------------------
  // sendMessage
  // ----------------------------------------------------------------
  const sendMessage = useCallback(
    (text: string) => {
      if (dataChannelRef.current?.readyState === "open") {
        dataChannelRef.current.send(JSON.stringify({ type: "text", content: text }));
        addMessage({
          id: uuidv4(),
          sender: "me",
          type: "text",
          content: text,
          timestamp: Date.now(),
        });
      }
    },
    [addMessage]
  );

  // ----------------------------------------------------------------
  // sendFile
  // ----------------------------------------------------------------
  const sendFile = useCallback(
    async (file: File) => {
      if (!dataChannelRef.current || dataChannelRef.current.readyState !== "open") return;

      const fileId = uuidv4();
      dataChannelRef.current.send(
        JSON.stringify({
          type: "file-start",
          meta: { id: fileId, name: file.name, size: file.size, type: file.type },
        })
      );

      const CHUNK_SIZE = 16 * 1024;
      const arrayBuffer = await file.arrayBuffer();
      let offset = 0;
      const channel = dataChannelRef.current;

      const sendChunks = () => {
        while (offset < arrayBuffer.byteLength) {
          if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
            channel.onbufferedamountlow = () => {
              channel.onbufferedamountlow = null;
              sendChunks();
            };
            return;
          }
          const chunk = arrayBuffer.slice(offset, offset + CHUNK_SIZE);
          channel.send(chunk);
          offset += chunk.byteLength;
        }
        addMessage({
          id: fileId,
          sender: "me",
          type: "file",
          content: file.name,
          fileUrl: URL.createObjectURL(file),
          fileType: file.type,
          timestamp: Date.now(),
        });
      };

      sendChunks();
    },
    [addMessage]
  );

  return { status, peerCount, messages, sendMessage, sendFile, retryConnection };
}