import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
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

export type ConnectionStatus = "connecting" | "waiting" | "negotiating" | "connected" | "disconnected";

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.services.mozilla.com" },
  ],
};

export function useWebRTC(roomId: string | null) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [peerCount, setPeerCount] = useState<number>(1);
  const [messages, setMessages] = useState<Message[]>([]);

  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);

  // Perfect Negotiation refs
  const isPoliteRef = useRef(false);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);

  // File receiving state
  const receiveBufferRef = useRef<ArrayBuffer[]>([]);
  const receivedSizeRef = useRef(0);
  const incomingFileInfoRef = useRef<{ id?: string; name: string; size: number; type: string } | null>(null);

  const addMessage = useCallback((msg: Message) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const setupDataChannel = useCallback(
    (channel: RTCDataChannel) => {
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = 65536;

      channel.onopen = () => {
        console.log("[WebRTC] Data channel opened");
        setStatus("connected");
      };

      channel.onclose = () => {
        console.log("[WebRTC] Data channel closed");
        setStatus((s) => (s === "connected" ? "disconnected" : s));
      };

      channel.onerror = (err) => {
        console.error("[WebRTC] Data channel error", err);
      };

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
            console.error("[WebRTC] Failed to parse string message", e);
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
            const url = URL.createObjectURL(blob);
            addMessage({
              id: incomingFileInfoRef.current.id || uuidv4(),
              sender: "peer",
              type: "file",
              content: incomingFileInfoRef.current.name,
              fileUrl: url,
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

  /**
   * Creates (or re-creates) the single RTCPeerConnection for this session.
   * Offer creation is driven by onnegotiationneeded, which fires automatically
   * when createDataChannel() is called - no separate initiateCall() needed.
   */
  const createPeerConnection = useCallback(
    (socket: Socket, currentRoomId: string): RTCPeerConnection => {
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

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("candidate", currentRoomId, event.candidate.toJSON());
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log("[WebRTC] ICE state:", pc.iceConnectionState);
        if (pc.iceConnectionState === "failed") {
          console.warn("[WebRTC] ICE failed - restarting ICE");
          if (typeof pc.restartIce === "function") {
            pc.restartIce();
          } else {
            setStatus("disconnected");
          }
        } else if (pc.iceConnectionState === "disconnected") {
          setStatus("disconnected");
        }
      };

      pc.onconnectionstatechange = () => {
        console.log("[WebRTC] Connection state:", pc.connectionState);
        if (pc.connectionState === "connected") {
          setStatus("connected");
        } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          setStatus("disconnected");
        }
      };

      pc.ondatachannel = (event) => {
        console.log("[WebRTC] Received remote data channel");
        setupDataChannel(event.channel);
      };

      // Perfect Negotiation: onnegotiationneeded fires when createDataChannel() is called.
      pc.onnegotiationneeded = async () => {
        try {
          makingOfferRef.current = true;
          console.log("[WebRTC] Negotiation needed - creating offer...");
          setStatus("negotiating");
          await pc.setLocalDescription();
          socket.emit("offer", currentRoomId, pc.localDescription);
          console.log("[WebRTC] Offer sent to room", currentRoomId);
        } catch (err) {
          console.error("[WebRTC] onnegotiationneeded error:", err);
          setStatus("disconnected");
        } finally {
          makingOfferRef.current = false;
        }
      };

      peerRef.current = pc;
      return pc;
    },
    [setupDataChannel]
  );

  useEffect(() => {
    if (!roomId) return;

    setStatus("connecting");

    const signalingUrl = import.meta.env.VITE_SIGNALING_URL as string | undefined;

    const socket = io(signalingUrl || undefined, {
      transports: ["websocket", "polling"],
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 15000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("[Signaling] Connected. Joining room", roomId);
      socket.emit("join-room", roomId);
    });

    // Determines our role for Perfect Negotiation
    socket.on("room-joined", (data: { roomId: string; numClients: number }) => {
      console.log("[Signaling] room-joined:", data);
      setPeerCount(data.numClients);

      if (data.numClients > 1) {
        // POLITE peer (late joiner): waits for offer, rolls back on glare
        isPoliteRef.current = true;
        setStatus("negotiating");
        console.log("[WebRTC] Role: POLITE - waiting for offer");
        createPeerConnection(socket, roomId);
      } else {
        // IMPOLITE peer (early joiner): initiates once the other peer arrives
        isPoliteRef.current = false;
        setStatus("waiting");
        console.log("[WebRTC] Role: IMPOLITE - waiting for peer");
        createPeerConnection(socket, roomId);
      }
    });

    // Impolite peer initiates by creating a data channel, which triggers
    // onnegotiationneeded -> offer is sent automatically. No double-offer guard
    // prevents re-initiation if peer-joined fires again (race condition fix).
    socket.on("peer-joined", () => {
      console.log("[Signaling] Peer joined. Initiating as impolite peer.");
      setPeerCount(2);

      const pc = peerRef.current;
      if (!pc) {
        console.warn("[WebRTC] peer-joined but no RTCPeerConnection available");
        return;
      }

      if (!dataChannelRef.current || dataChannelRef.current.readyState === "closed") {
        const dc = pc.createDataChannel("chat", { ordered: true });
        setupDataChannel(dc);
      } else {
        console.log("[WebRTC] Data channel already active, skipping re-initiation");
      }
    });

    // Perfect Negotiation offer handler (RFC 8829 section 4.1.1)
    socket.on("offer", async (offer) => {
      const pc = peerRef.current;
      if (!pc) {
        console.warn("[WebRTC] Got offer but no RTCPeerConnection");
        return;
      }

      const offerCollision = makingOfferRef.current || pc.signalingState !== "stable";
      ignoreOfferRef.current = !isPoliteRef.current && offerCollision;

      if (ignoreOfferRef.current) {
        console.log("[WebRTC] Glare - ignoring offer (impolite peer)");
        return;
      }

      console.log("[WebRTC] Handling offer...");
      setStatus("negotiating");

      try {
        if (offerCollision) {
          console.log("[WebRTC] Glare - rolling back local offer (polite peer)");
          await pc.setLocalDescription({ type: "rollback" });
        }

        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        const queued = iceCandidateQueueRef.current.splice(0);
        for (const cand of queued) {
          await pc
            .addIceCandidate(new RTCIceCandidate(cand))
            .catch((e) => console.warn("[WebRTC] Queued ICE flush error:", e));
        }

        await pc.setLocalDescription();
        socket.emit("answer", roomId, pc.localDescription);
        console.log("[WebRTC] Answer sent to room", roomId);
      } catch (err) {
        console.error("[WebRTC] Error handling offer:", err);
        setStatus("disconnected");
      }
    });

    socket.on("answer", async (answer) => {
      const pc = peerRef.current;
      if (!pc) return;
      if (ignoreOfferRef.current) return;

      console.log("[WebRTC] Handling answer...");

      try {
        if (pc.signalingState !== "have-local-offer") {
          console.warn(
            "[WebRTC] Unexpected state for answer:", pc.signalingState, "- skipping"
          );
          return;
        }

        await pc.setRemoteDescription(new RTCSessionDescription(answer));

        const queued = iceCandidateQueueRef.current.splice(0);
        for (const cand of queued) {
          await pc
            .addIceCandidate(new RTCIceCandidate(cand))
            .catch((e) => console.warn("[WebRTC] Queued ICE flush error:", e));
        }
        console.log("[WebRTC] Remote description set from answer");
      } catch (err) {
        console.error("[WebRTC] Error setting remote description from answer:", err);
      }
    });

    socket.on("candidate", async (candidate) => {
      if (!candidate || ignoreOfferRef.current) return;
      const pc = peerRef.current;
      if (!pc) return;

      if (pc.remoteDescription?.type) {
        await pc
          .addIceCandidate(new RTCIceCandidate(candidate))
          .catch((e) => console.warn("[WebRTC] ICE candidate error:", e));
      } else {
        iceCandidateQueueRef.current.push(candidate);
      }
    });

    socket.on("peer-disconnected", () => {
      console.log("[Signaling] Peer disconnected");
      setPeerCount(1);
      setStatus("waiting");
      iceCandidateQueueRef.current = [];
      makingOfferRef.current = false;
      ignoreOfferRef.current = false;
      isPoliteRef.current = false;
      dataChannelRef.current = null;
      createPeerConnection(socket, roomId);
    });

    return () => {
      socket.disconnect();
      if (peerRef.current) {
        peerRef.current.close();
        peerRef.current = null;
      }
      dataChannelRef.current = null;
      socketRef.current = null;
    };
  }, [roomId, createPeerConnection, setupDataChannel]);

  const retryConnection = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || !roomId) return;
    console.log("[WebRTC] Manual retry...");

    iceCandidateQueueRef.current = [];
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    isPoliteRef.current = false;
    dataChannelRef.current = null;

    const pc = createPeerConnection(socket, roomId);
    const dc = pc.createDataChannel("chat", { ordered: true });
    setupDataChannel(dc);
    setStatus("negotiating");
    socket.emit("request-offer", roomId);
  }, [roomId, createPeerConnection, setupDataChannel]);

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