import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { v4 as uuidv4 } from "uuid";

export type Message = {
  id: string;
  sender: "me" | "peer";
  type: "text" | "file";
  content: string; // text content or file name
  fileUrl?: string; // object URL for downloaded file
  fileType?: string;
  timestamp: number;
};

export type ConnectionStatus = "connecting" | "waiting" | "negotiating" | "connected" | "disconnected";

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.services.mozilla.com" }
  ]
};

export function useWebRTC(roomId: string | null) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [peerCount, setPeerCount] = useState<number>(1);
  const [messages, setMessages] = useState<Message[]>([]);
  
  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);

  // File receiving state
  const receiveBufferRef = useRef<ArrayBuffer[]>([]);
  const receivedSizeRef = useRef(0);
  const incomingFileInfoRef = useRef<{ id?: string; name: string; size: number; type: string } | null>(null);

  const addMessage = useCallback((msg: Message) => {
    setMessages(prev => [...prev, msg]);
  }, []);

  const flushCandidates = async (pc: RTCPeerConnection) => {
    while (iceCandidateQueueRef.current.length > 0) {
      const cand = iceCandidateQueueRef.current.shift();
      if (cand) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {
          console.warn("[WebRTC] Error adding queued ICE candidate", e);
        }
      }
    }
  };

  const setupDataChannel = useCallback((channel: RTCDataChannel) => {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 65536; // 64KB threshold

    channel.onopen = () => {
      console.log("[WebRTC] Data channel opened");
      setStatus("connected");
    };

    channel.onclose = () => {
      console.log("[WebRTC] Data channel closed");
      setStatus("disconnected");
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
              timestamp: Date.now()
            });
          }
        } catch (e) {
          console.error("[WebRTC] Failed to parse string message", e);
        }
      } else if (event.data instanceof ArrayBuffer) {
        // File chunk received
        receiveBufferRef.current.push(event.data);
        receivedSizeRef.current += event.data.byteLength;

        if (incomingFileInfoRef.current && receivedSizeRef.current >= incomingFileInfoRef.current.size) {
          const blob = new Blob(receiveBufferRef.current, { type: incomingFileInfoRef.current.type });
          const url = URL.createObjectURL(blob);

          addMessage({
            id: incomingFileInfoRef.current.id || uuidv4(),
            sender: "peer",
            type: "file",
            content: incomingFileInfoRef.current.name,
            fileUrl: url,
            fileType: incomingFileInfoRef.current.type,
            timestamp: Date.now()
          });

          incomingFileInfoRef.current = null;
          receiveBufferRef.current = [];
          receivedSizeRef.current = 0;
        }
      }
    };

    dataChannelRef.current = channel;
  }, [addMessage]);

  const setupPeerConnection = useCallback(() => {
    if (peerRef.current) {
      peerRef.current.close();
      peerRef.current = null;
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);

    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current && roomId) {
        socketRef.current.emit("candidate", roomId, event.candidate.toJSON());
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("[WebRTC] ICE connection state:", pc.iceConnectionState);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        setStatus("connected");
      } else if (pc.iceConnectionState === "failed") {
        console.warn("[WebRTC] ICE state failed, restarting ICE if supported");
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
      console.log("[WebRTC] Peer connection state:", pc.connectionState);
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

    peerRef.current = pc;
    return pc;
  }, [roomId, setupDataChannel]);

  const initiateCall = useCallback(async () => {
    if (!roomId) return;
    console.log("[WebRTC] Initiating P2P call...");
    setStatus("negotiating");

    const pc = setupPeerConnection();
    const dc = pc.createDataChannel("chat", { ordered: true });
    setupDataChannel(dc);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("offer", roomId, offer);
      console.log("[WebRTC] Created & sent offer to room", roomId);
    } catch (err) {
      console.error("[WebRTC] Error creating offer:", err);
      setStatus("disconnected");
    }
  }, [roomId, setupPeerConnection, setupDataChannel]);

  const handleReceiveOffer = useCallback(async (offer: any) => {
    if (!roomId) return;
    console.log("[WebRTC] Handling received offer...");
    setStatus("negotiating");

    const pc = setupPeerConnection();

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushCandidates(pc);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current?.emit("answer", roomId, answer);
      console.log("[WebRTC] Created & sent answer to room", roomId);
    } catch (err) {
      console.error("[WebRTC] Error responding to offer:", err);
      setStatus("disconnected");
    }
  }, [roomId, setupPeerConnection]);

  const handleReceiveAnswer = useCallback(async (answer: any) => {
    if (!peerRef.current) return;
    console.log("[WebRTC] Handling received answer...");

    try {
      await peerRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      await flushCandidates(peerRef.current);
      console.log("[WebRTC] Remote description set successfully from answer");
    } catch (err) {
      console.error("[WebRTC] Error setting remote description from answer:", err);
    }
  }, []);

  const handleReceiveCandidate = useCallback(async (candidate: any) => {
    if (!candidate) return;
    const pc = peerRef.current;
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn("[WebRTC] Error adding ICE candidate:", e);
      }
    } else {
      iceCandidateQueueRef.current.push(candidate);
    }
  }, []);

  useEffect(() => {
    if (!roomId) return;

    setStatus("connecting");

    // Connect to signaling server with automatic reconnects
    const socket = io({
      transports: ["polling", "websocket"],
      reconnectionAttempts: 5,
      timeout: 10000
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("[Signaling] Connected to server, joining room", roomId);
      socket.emit("join-room", roomId);
    });

    socket.on("room-joined", (data: { roomId: string; numClients: number }) => {
      console.log("[Signaling] Room joined event:", data);
      setPeerCount(data.numClients);
      if (data.numClients > 1) {
        // There is already a peer in the room!
        // We can request the peer to offer if connection doesn't happen quickly
        setStatus("negotiating");
        setTimeout(() => {
          if (peerRef.current?.connectionState !== "connected" && dataChannelRef.current?.readyState !== "open") {
            console.log("[Signaling] Requesting offer from peer...");
            socket.emit("request-offer", roomId);
          }
        }, 1500);
      } else {
        setStatus("waiting");
      }
    });

    socket.on("peer-joined", () => {
      console.log("[Signaling] Another peer joined room. We will initiate WebRTC offer.");
      setPeerCount(2);
      initiateCall();
    });

    socket.on("offer", async (offer) => {
      await handleReceiveOffer(offer);
    });

    socket.on("answer", async (answer) => {
      await handleReceiveAnswer(answer);
    });

    socket.on("candidate", async (candidate) => {
      await handleReceiveCandidate(candidate);
    });

    socket.on("peer-disconnected", () => {
      console.log("[Signaling] Peer disconnected");
      setPeerCount(1);
      setStatus("waiting");
      if (peerRef.current) {
        peerRef.current.close();
        peerRef.current = null;
      }
      dataChannelRef.current = null;
    });

    return () => {
      socket.disconnect();
      if (peerRef.current) {
        peerRef.current.close();
        peerRef.current = null;
      }
      dataChannelRef.current = null;
    };
  }, [roomId, initiateCall, handleReceiveOffer, handleReceiveAnswer, handleReceiveCandidate]);

  const retryConnection = useCallback(() => {
    if (!socketRef.current || !roomId) return;
    console.log("[WebRTC] Manually retrying connection...");
    socketRef.current.emit("request-offer", roomId);
    initiateCall();
  }, [roomId, initiateCall]);

  const sendMessage = useCallback((text: string) => {
    if (dataChannelRef.current && dataChannelRef.current.readyState === "open") {
      dataChannelRef.current.send(JSON.stringify({ type: "text", content: text }));
      addMessage({
        id: uuidv4(),
        sender: "me",
        type: "text",
        content: text,
        timestamp: Date.now()
      });
    }
  }, [addMessage]);

  const sendFile = useCallback(async (file: File) => {
    if (!dataChannelRef.current || dataChannelRef.current.readyState !== "open") return;

    const fileId = uuidv4();
    dataChannelRef.current.send(JSON.stringify({
      type: "file-start",
      meta: { id: fileId, name: file.name, size: file.size, type: file.type }
    }));

    // Use 16KB chunk size for optimal cross-platform WebRTC compatibility
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

      // Add local file message
      addMessage({
        id: fileId,
        sender: "me",
        type: "file",
        content: file.name,
        fileUrl: URL.createObjectURL(file),
        fileType: file.type,
        timestamp: Date.now()
      });
    };

    sendChunks();
  }, [addMessage]);

  return {
    status,
    peerCount,
    messages,
    sendMessage,
    sendFile,
    retryConnection
  };
}
