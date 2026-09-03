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

export type ConnectionStatus = "connecting" | "waiting" | "negotiating" | "connected" | "disconnected";

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    // Free public TURN servers from OpenRelay (Metered) to bypass 4G/Symmetric NAT firewalls
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelay",
      credential: "openrelay",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelay",
      credential: "openrelay",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelay",
      credential: "openrelay",
    },
  ],
};

export function useWebRTC(roomId: string | null) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [peerCount, setPeerCount] = useState<number>(1);
  const [messages, setMessages] = useState<Message[]>([]);

  const socketRef = useRef<PartySocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);

  // Perfect Negotiation refs (RFC 8829 §4.1.1)
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

  const sendSignal = useCallback((data: Record<string, any>) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(data));
    }
  }, []);

  const setupDataChannel = useCallback(
    (channel: RTCDataChannel) => {
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = 65536; // 64 KB

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

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: "candidate",
          candidate: event.candidate.toJSON(),
        });
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

    // Perfect Negotiation offer creation
    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current = true;
        console.log("[WebRTC] Negotiation needed - creating offer...");
        setStatus("negotiating");
        await pc.setLocalDescription();
        sendSignal({
          type: "offer",
          offer: pc.localDescription,
        });
        console.log("[WebRTC] Offer sent to room via PartyKit");
      } catch (err) {
        console.error("[WebRTC] onnegotiationneeded error:", err);
        setStatus("disconnected");
      } finally {
        makingOfferRef.current = false;
      }
    };

    peerRef.current = pc;
    return pc;
  }, [sendSignal, setupDataChannel]);

  const createPeerConnectionRef = useRef(createPeerConnection);
  createPeerConnectionRef.current = createPeerConnection;

  useEffect(() => {
    if (!roomId) return;

    setStatus("connecting");

    // Clean up host string in case user passed full URL with https://
    const rawHost = import.meta.env.VITE_PARTYKIT_HOST || "localhost:1999";
    const partyHost = rawHost.replace(/^https?:\/\//, "").replace(/^wss?:\/\//, "").replace(/\/.*$/, "");

    console.log(`[Signaling:PartyKit] Connecting to host "${partyHost}" for room "${roomId}"`);

    const socket = new PartySocket({
      host: partyHost,
      room: roomId,
      connectionTimeout: 15000, // 15 seconds to prevent premature timeout on slower networks
      maxRetries: 10,
    });
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      console.log(`[Signaling:PartyKit] Connected successfully to room "${roomId}" on ${partyHost}`);
    });

    socket.addEventListener("error", (err) => {
      console.warn(`[Signaling:PartyKit] Socket error on room "${roomId}":`, err);
    });

    socket.addEventListener("close", (event) => {
      console.log(`[Signaling:PartyKit] Socket closed (code: ${event.code}, reason: ${event.reason || "none"})`);
    });

    socket.addEventListener("message", async (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case "room-joined": {
            console.log("[Signaling] room-joined:", data);
            setPeerCount(data.numClients);

            if (data.numClients > 1) {
              // Polite peer (late joiner): rolls back on glare
              isPoliteRef.current = true;
              setStatus("negotiating");
              console.log("[WebRTC] Role: POLITE - waiting for offer");
              createPeerConnectionRef.current();
            } else {
              // Impolite peer (early joiner): initiates offer when peer joins
              isPoliteRef.current = false;
              setStatus("waiting");
              console.log("[WebRTC] Role: IMPOLITE - waiting for peer");
              createPeerConnectionRef.current();
            }
            break;
          }

          case "peer-joined": {
            console.log("[Signaling] Peer joined. Initiating offer as impolite peer.");
            setPeerCount(2);

            const pc = peerRef.current;
            if (!pc) {
              console.warn("[WebRTC] peer-joined but no RTCPeerConnection available");
              return;
            }

            if (!dataChannelRef.current || dataChannelRef.current.readyState === "closed") {
              const dc = pc.createDataChannel("chat", { ordered: true });
              setupDataChannel(dc);
              // onnegotiationneeded triggers offer automatically
            }
            break;
          }

          case "offer": {
            const pc = peerRef.current;
            if (!pc) return;

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

              await pc.setRemoteDescription(new RTCSessionDescription(data.offer));

              const queued = iceCandidateQueueRef.current.splice(0);
              for (const cand of queued) {
                await pc
                  .addIceCandidate(new RTCIceCandidate(cand))
                  .catch((e) => console.warn("[WebRTC] Queued ICE flush error:", e));
              }

              await pc.setLocalDescription();
              sendSignal({
                type: "answer",
                answer: pc.localDescription,
              });
              console.log("[WebRTC] Answer sent via PartyKit");
            } catch (err) {
              console.error("[WebRTC] Error handling offer:", err);
              setStatus("disconnected");
            }
            break;
          }

          case "answer": {
            const pc = peerRef.current;
            if (!pc || ignoreOfferRef.current) return;

            console.log("[WebRTC] Handling answer...");
            try {
              if (pc.signalingState !== "have-local-offer") {
                console.warn("[WebRTC] Unexpected state for answer:", pc.signalingState);
                return;
              }

              await pc.setRemoteDescription(new RTCSessionDescription(data.answer));

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
            break;
          }

          case "candidate": {
            if (!data.candidate || ignoreOfferRef.current) return;
            const pc = peerRef.current;
            if (!pc) return;

            if (pc.remoteDescription?.type) {
              await pc
                .addIceCandidate(new RTCIceCandidate(data.candidate))
                .catch((e) => console.warn("[WebRTC] ICE candidate error:", e));
            } else {
              iceCandidateQueueRef.current.push(data.candidate);
            }
            break;
          }

          case "peer-disconnected": {
            console.log("[Signaling] Peer disconnected");
            setPeerCount(1);
            setStatus("waiting");
            iceCandidateQueueRef.current = [];
            makingOfferRef.current = false;
            ignoreOfferRef.current = false;
            isPoliteRef.current = false;
            dataChannelRef.current = null;
            createPeerConnectionRef.current();
            break;
          }
        }
      } catch (err) {
        console.error("[PartyKit] Failed to parse message:", err);
      }
    });

    return () => {
      socket.close();
      if (peerRef.current) {
        peerRef.current.close();
        peerRef.current = null;
      }
      dataChannelRef.current = null;
      socketRef.current = null;
    };
  }, [roomId]);

  const retryConnection = useCallback(() => {
    if (!roomId) return;
    console.log("[WebRTC] Manual retry...");

    iceCandidateQueueRef.current = [];
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    isPoliteRef.current = false;
    dataChannelRef.current = null;

    const pc = createPeerConnection();
    const dc = pc.createDataChannel("chat", { ordered: true });
    setupDataChannel(dc);
    setStatus("negotiating");
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