import React, { useEffect, useState, useRef, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  Link as LinkIcon,
  Paperclip,
  FileText,
  Download,
  Check,
  Copy,
  RefreshCw,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  LogOut,
  ArrowUp,
  Scan,
  Trash2,
  Upload,
  Smile,
  X,
  MonitorDown,
  Reply as ReplyIcon,
  FolderOpen,
  Database,
  Clock3,
  HardDrive,
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useWebRTC, type Message, type FileProgress, type ReplyReference } from "./lib/useWebRTC";
import { cn } from "./lib/utils";
import { format } from "date-fns";
import { QRScanner } from "./components/QRScanner";
import { useNotification } from "./lib/useNotification";
import { requestInvite, verifyOwnerPassword } from "./lib/partyApi";
import {
  adminLogin,
  createDownloadUrl,
  deleteAdminFile,
  deleteStoredFile,
  fileStorageConfigured,
  listAdminFiles,
  listRoomFiles,
  updateAdminFile,
  updateStoredFile,
  type StoredFile,
} from "./lib/fileApi";

const STORAGE_KEY = "chatp2p_auth_token";
const EMOJI_LIST = ["👍", "❤️", "😂", "😮", "😢"];

/** Formats bytes into a human-readable string */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const AVATAR_COLORS = [
  "bg-blue-500", "bg-indigo-500", "bg-purple-500", "bg-pink-500", 
  "bg-rose-500", "bg-orange-500", "bg-green-500", "bg-teal-500"
];
function getAvatarColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function getInitials(name: string) {
  return name.slice(0, 2).toUpperCase();
}

function VercelTriangle({ className = "w-4 h-4 text-[#171717]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 75 65" height="14" width="16" fill="currentColor" className={className}>
      <polygon points="37.5,0 75,65 0,65" />
    </svg>
  );
}

export default function App() {
  if (window.location.pathname === "/admin/storage") return <StorageAdminPage />;
  return <ChatApp />;
}

function ChatApp() {
  const [password, setPassword] = useState("");
  const [checkingPassword, setCheckingPassword] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return !!(params.get("pwd")?.trim() || localStorage.getItem(STORAGE_KEY)?.trim());
  });

  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [roomId, setRoomId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("room")?.trim() || null);
  const [guestInvite, setGuestInvite] = useState<string | null>(() => new URLSearchParams(window.location.search).get("invite")?.trim() || null);
  const [joinInput, setJoinInput] = useState("");
  const [joinError, setJoinError] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  
  const [nickname, setNickname] = useState(() => {
    return localStorage.getItem("chatp2p_nickname") || "";
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const candidate = params.get("pwd")?.trim() || localStorage.getItem(STORAGE_KEY)?.trim();
    if (!candidate) {
      setCheckingPassword(false);
      return;
    }
    let cancelled = false;
    verifyOwnerPassword(candidate).then((valid) => {
      if (cancelled) return;
      if (valid) {
        localStorage.setItem(STORAGE_KEY, candidate);
        setPassword(candidate);
        setGuestInvite(null);
        if (params.has("pwd")) {
          const url = new URL(window.location.href);
          url.searchParams.delete("pwd");
          window.history.replaceState({}, "", url.toString());
        }
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    }).catch(() => {
      if (!cancelled) setPasswordError("Could not reach the relay. Try again.");
    }).finally(() => {
      if (!cancelled) setCheckingPassword(false);
    });
    return () => { cancelled = true; };
  }, []);

  const handleUnlock = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setCheckingPassword(true);
    try {
      if (await verifyOwnerPassword(passwordInput.trim())) {
        localStorage.setItem(STORAGE_KEY, passwordInput.trim());
        setPassword(passwordInput.trim());
        setPasswordError("");
      } else {
        setPasswordError("Invalid password. Access denied.");
      }
    } catch {
      setPasswordError("Could not reach the relay. Try again.");
    } finally {
      setCheckingPassword(false);
    }
  };

  const handleLock = () => {
    localStorage.removeItem(STORAGE_KEY);
    setPassword("");
    setPasswordInput("");
    setPasswordError("");

    const url = new URL(window.location.href);
    if (url.searchParams.has("pwd") || url.searchParams.has("invite")) {
      url.searchParams.delete("pwd");
      url.searchParams.delete("invite");
      window.history.replaceState({}, "", url.toString());
    }
  };

  const handleCreateRoom = () => {
    const newRoom = uuidv4().slice(0, 8);
    window.history.pushState({}, "", `?room=${newRoom}`);
    setGuestInvite(null);
    setRoomId(newRoom);
  };

  const handleJoinRoom = (overrideId?: string) => {
    const raw = (overrideId ?? joinInput).trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!raw) {
      setJoinError("Enter a valid Room ID.");
      return;
    }
    window.history.pushState({}, "", `?room=${raw}`);
    setGuestInvite(null);
    setRoomId(raw);
  };

  const handleJoinKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleJoinRoom();
  };

  const handleQRScan = (scannedId: string) => {
    setShowScanner(false);
    setJoinInput(scannedId);
    handleJoinRoom(scannedId);
  };

  if (guestInvite && checkingPassword && !password) {
    return <div className="h-[100dvh] w-screen bg-[#fafafa] text-[#4d4d4d] flex items-center justify-center text-sm">Checking access...</div>;
  }

  // ── 1. Password Gate ─────────────────────────────────────────
  if (!guestInvite && !password) {
    return (
      <div className="relative h-[100dvh] max-h-[100dvh] w-screen bg-[#fafafa] text-[#171717] font-sans flex items-center justify-center p-4 overflow-hidden">
        <div className="vercel-mesh-glow" />

        <div className="relative z-10 max-w-[420px] w-full bg-white rounded-[12px] border border-[#ebebeb] shadow-[0_1px_2px_rgba(0,0,0,0.04)] p-8 space-y-6">
          <div className="text-center space-y-3">
            <div className="w-10 h-10 rounded-[6px] border border-[#ebebeb] bg-[#fafafa] flex items-center justify-center mx-auto text-[#171717]">
              <Lock size={18} />
            </div>
            <div className="space-y-1">
              <span className="font-mono text-[10px] font-medium tracking-wider text-[#8f8f8f] uppercase">
                Access Authorization
              </span>
              <h1 className="text-2xl font-semibold tracking-[-0.04em] text-[#171717]">
                Unlock ChatP2P
              </h1>
            </div>
            <p className="text-sm text-[#4d4d4d] leading-relaxed">
              This instance is password protected. Enter your personal key to initialize signaling.
            </p>
          </div>

          <form onSubmit={handleUnlock} className="space-y-4">
            <div className="space-y-1.5">
              <label className="font-mono text-[11px] font-medium text-[#4d4d4d] uppercase tracking-wider block">
                Personal Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={passwordInput}
                  onChange={(e) => {
                    setPasswordInput(e.target.value);
                    setPasswordError("");
                  }}
                  autoFocus
                  placeholder="Enter access password"
                  className="w-full rounded-[6px] border border-[#ebebeb] bg-white px-3.5 py-2.5 pr-10 text-sm text-[#171717] placeholder:text-[#a1a1a1] focus:border-[#171717] focus:ring-1 focus:ring-[#171717] focus:outline-none transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8f8f8f] hover:text-[#171717] p-1 cursor-pointer transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {passwordError && (
                <p className="font-mono text-xs text-rose-600 pt-1">{passwordError}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={checkingPassword}
              className="w-full bg-[#171717] hover:bg-black text-white rounded-full py-2.5 px-4 text-sm font-medium transition-colors cursor-pointer flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
            >
              <Unlock size={16} />
              <span>{checkingPassword ? "Checking..." : "Unlock Instance"}</span>
            </button>
          </form>

          <p className="text-center font-mono text-[10px] text-[#8f8f8f] tracking-wide">
            PARTYKIT RELAY // WEBSOCKET HANDSHAKE DORMANT
          </p>
        </div>
      </div>
    );
  }

  // ── 2. Unlocked: Lobby screen ────────────────────────────────
  if (!roomId) {
    return (
      <div className="relative h-[100dvh] max-h-[100dvh] w-screen bg-[#fafafa] text-[#171717] font-sans flex items-center justify-center p-4 overflow-hidden">
        <div className="vercel-mesh-glow" />

        {showScanner && (
          <QRScanner onScan={handleQRScan} onClose={() => setShowScanner(false)} />
        )}

        <div className="relative z-10 max-w-[440px] w-full bg-white rounded-[12px] border border-[#ebebeb] shadow-[0_1px_2px_rgba(0,0,0,0.04)] p-8 space-y-6">
          {/* Top status bar */}
          <div className="flex justify-between items-center pb-3 border-b border-[#ebebeb]">
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-[#171717] bg-[#fafafa] border border-[#ebebeb] px-2.5 py-0.5 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span>UNLOCKED</span>
            </div>
            <button
              onClick={handleLock}
              className="font-mono text-xs text-[#8f8f8f] hover:text-[#171717] px-2 py-1 rounded-[6px] border border-[#ebebeb] hover:border-[#171717] transition-colors cursor-pointer flex items-center gap-1"
              title="Lock session"
            >
              <LogOut size={12} />
              <span>LOCK</span>
            </button>
          </div>

          {/* Header */}
          <div className="text-center space-y-2.5">
            <span className="font-mono text-[11px] font-medium tracking-wider text-[#8f8f8f] uppercase block">
              SECURE ROOM // EPHEMERAL RELAY
            </span>
            <div className="w-10 h-10 rounded-[6px] border border-[#ebebeb] bg-[#fafafa] flex items-center justify-center mx-auto text-[#171717] my-2">
              <VercelTriangle className="w-5 h-5 text-[#171717]" />
            </div>
            <h1 className="text-2xl font-semibold tracking-[-0.04em] text-[#171717]">
              Secure Room Chat
            </h1>
            <p className="text-sm text-[#4d4d4d] leading-relaxed max-w-xs mx-auto">
              Encrypted in transit through a temporary room relay. No server-side message history.
            </p>
          </div>

          {/* Nickname Input */}
          <div className="space-y-1.5 pb-2 border-b border-[#ebebeb]">
            <label className="font-mono text-[11px] font-medium text-[#4d4d4d] uppercase tracking-wider block">
              Your Nickname (Optional)
            </label>
            <input
              type="text"
              value={nickname}
              maxLength={40}
              onChange={(e) => {
                const val = e.target.value;
                setNickname(val);
                localStorage.setItem("chatp2p_nickname", val);
              }}
              placeholder="Leave empty for random name"
              className="w-full font-mono rounded-[6px] border border-[#ebebeb] px-3.5 py-2 text-sm text-[#171717] placeholder:text-[#a1a1a1] focus:border-[#171717] focus:ring-1 focus:ring-[#171717] focus:outline-none transition-colors"
            />
          </div>

          {/* Create new room */}
          <button
            id="start-chat-btn"
            onClick={handleCreateRoom}
            className="w-full bg-[#171717] hover:bg-black text-white rounded-full py-2.5 px-4 text-sm font-medium transition-colors cursor-pointer flex items-center justify-center gap-2 shadow-sm"
          >
            <span>+ Start New Chat</span>
          </button>

          {/* Divider */}
          <div className="relative flex items-center justify-center my-4">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[#ebebeb]" />
            </div>
            <span className="relative bg-white px-3 font-mono text-[10px] uppercase text-[#a1a1a1] tracking-wider">
              or join existing room
            </span>
          </div>

          {/* Join existing room */}
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                id="join-room-input"
                type="text"
                value={joinInput}
                onChange={(e) => {
                  setJoinInput(e.target.value);
                  setJoinError("");
                }}
                onKeyDown={handleJoinKeyDown}
                placeholder="Room ID (e.g. 4cb52e14)"
                className="flex-1 font-mono rounded-[6px] border border-[#ebebeb] px-3.5 py-2 text-sm text-[#171717] placeholder:text-[#a1a1a1] focus:border-[#171717] focus:ring-1 focus:ring-[#171717] focus:outline-none transition-colors"
              />
              {/* QR scanner button */}
              <button
                id="scan-qr-btn"
                onClick={() => setShowScanner(true)}
                title="Scan QR code to join"
                className="px-3 py-2 border border-[#ebebeb] hover:border-[#171717] rounded-[6px] text-[#8f8f8f] hover:text-[#171717] transition-colors cursor-pointer shrink-0"
              >
                <Scan size={16} />
              </button>
              <button
                id="join-room-btn"
                onClick={() => handleJoinRoom()}
                className="px-4 py-2 bg-[#171717] hover:bg-black text-white rounded-[6px] text-sm font-medium transition-colors cursor-pointer shrink-0"
              >
                Join
              </button>
            </div>
            {joinError && (
              <p className="font-mono text-xs text-rose-600 px-1">{joinError}</p>
            )}
          </div>

          {/* Footer note */}
          <p className="text-center font-mono text-[10px] text-[#8f8f8f] tracking-wide">
            SHARE YOUR ROOM ID WITH A PEER TO CONNECT
          </p>
        </div>
      </div>
    );
  }

  // ── 3. Unlocked: Chat Room ───────────────────────────────────
  return <ChatRoom roomId={roomId} nickname={nickname || `Peer-${uuidv4().slice(0, 4).toUpperCase()}`} password={guestInvite ? undefined : password} invite={guestInvite || undefined} onLock={handleLock} onLeave={() => { window.history.pushState({}, "", window.location.pathname); setGuestInvite(null); setRoomId(null); }} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// ChatRoom
// ─────────────────────────────────────────────────────────────────────────────

function ChatRoom({
  roomId,
  nickname,
  password,
  invite,
  onLock,
  onLeave,
}: {
  roomId: string;
  nickname: string;
  password?: string;
  invite?: string;
  onLock: () => void;
  onLeave: () => void;
}) {
  const {
    status,
    peerCount,
    peers,
    messages,
    sendMessage,
    sendFiles,
    sendTyping,
    sendReaction,
    clearMessages,
    retryConnection,
    transferProgress,
    typingPeers,
    reactions,
    fileSessionToken,
  } = useWebRTC(roomId, nickname, { password, invite });

  const { notify } = useNotification();

  const [text, setText] = useState("");
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(invite || null);
  const [inviteError, setInviteError] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showRoomFiles, setShowRoomFiles] = useState(false);
  const [fileExpiryHours, setFileExpiryHours] = useState(24);
  const [fileError, setFileError] = useState("");
  const prevMsgCount = useRef(messages.length);

  // PWA install prompt
  const [pwaPrompt, setPwaPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setPwaPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = async () => {
    if (!pwaPrompt) return;
    await pwaPrompt.prompt();
    const { outcome } = await pwaPrompt.userChoice;
    if (outcome === "accepted") setPwaPrompt(null);
  };

  // Auto-scroll on new messages + notification
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    // Notify for incoming messages only
    if (messages.length > prevMsgCount.current) {
      const latest = messages[messages.length - 1];
      if (!latest?.isMe) notify();
    }
    prevMsgCount.current = messages.length;
  }, [messages, notify]);

  useEffect(() => {
    if (!password) return;
    let cancelled = false;
    setInviteBusy(true);
    requestInvite(roomId, password, "get").then((token) => {
      if (!cancelled) {
        setInviteToken(token);
        setInviteError("");
        const url = new URL(window.location.href);
        url.searchParams.set("room", roomId);
        url.searchParams.set("invite", token);
        url.searchParams.delete("pwd");
        window.history.replaceState({}, "", url.toString());
      }
    }).catch((error: Error) => {
      if (!cancelled) setInviteError(error.message);
    }).finally(() => {
      if (!cancelled) setInviteBusy(false);
    });
    return () => { cancelled = true; };
  }, [roomId, password]);

  const shareUrl = inviteToken
    ? `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomId)}&invite=${inviteToken}`
    : "";

  const handleCopyLink = async () => {
    if (!shareUrl || !password) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setInviteError("");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setInviteError("Could not copy link. Check clipboard permissions.");
    }
  };

  const handleRotateInvite = async () => {
    if (!password || inviteBusy) return;
    setInviteBusy(true);
    try {
      const token = await requestInvite(roomId, password, "rotate");
      setInviteToken(token);
      const url = new URL(window.location.href);
      url.searchParams.set("room", roomId);
      url.searchParams.set("invite", token);
      window.history.replaceState({}, "", url.toString());
      setCopied(false);
      setInviteError("");
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : "Could not refresh invite");
    } finally {
      setInviteBusy(false);
    }
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim() && status === "connected") {
      const replyTo: ReplyReference | undefined = replyingTo
        ? {
            messageId: replyingTo.id,
            senderName: (replyingTo.senderName || "Unknown").slice(0, 80),
            type: replyingTo.type,
            content: replyingTo.content.slice(0, 500),
          }
        : undefined;
      sendMessage(text.trim(), replyTo);
      setText("");
      setReplyingTo(null);
    }
  };

  const handleReply = (message: Message) => {
    setReplyingTo(message);
    requestAnimationFrame(() => textInputRef.current?.focus());
  };

  const scrollToMessage = (messageId: string) => {
    const target = document.getElementById(`message-${messageId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedMessageId(messageId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1600);
  };

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.target.value);
    sendTyping();
  };

  // Multiple files
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0 && status === "connected") {
      setFileError("");
      sendFiles(files, fileExpiryHours).catch((error) => setFileError(error instanceof Error ? error.message : "File upload failed"));
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Drag & Drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current += 1;
    if (dragCounter.current === 1) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0 && status === "connected") {
        setFileError("");
        sendFiles(files, fileExpiryHours).catch((error) => setFileError(error instanceof Error ? error.message : "File upload failed"));
      }
    },
    [status, sendFiles, fileExpiryHours]
  );

  // Active transfers
  const activeTransfers = (Object.entries(transferProgress) as [string, FileProgress][]).filter(
    ([, p]) => !p.done
  );

  return (
    <div
      className="h-[100dvh] max-h-[100dvh] w-screen bg-[#fafafa] text-[#171717] font-sans flex flex-col md:p-6 p-0 overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="relative flex-1 w-full max-w-4xl mx-auto bg-white md:rounded-[12px] border border-[#ebebeb] shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex flex-col min-h-0 overflow-hidden">

        {/* Drag & Drop overlay */}
        {isDragging && status === "connected" && (
          <div className="drag-overlay rounded-[12px]">
            <div className="p-4 bg-white/10 border border-white/20 rounded-[12px] flex flex-col items-center gap-3">
              <Upload size={32} className="text-white" />
              <p className="text-white font-semibold text-base tracking-tight">Drop files to send</p>
              <p className="text-white/60 font-mono text-[10px] uppercase tracking-wider">
                Multiple files supported
              </p>
            </div>
          </div>
        )}

        {/* Header */}
        <header className="h-14 border-b border-[#ebebeb] flex items-center justify-between px-3 sm:px-6 bg-white shrink-0 z-10">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <VercelTriangle className="w-4 h-4 text-[#171717] shrink-0" />
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="font-mono text-xs sm:text-sm font-medium text-[#171717] truncate">
                <span className="hidden min-[390px]:inline">room: </span><span className="text-[#8f8f8f]">{roomId}</span>
              </span>

              {/* Status dot (mobile) — full pill on sm+ */}
              <div className="flex items-center shrink-0">
                {/* Mobile: small colored dot only */}
                <span className={cn(
                  "sm:hidden w-2 h-2 rounded-full",
                  status === "connected" ? "bg-emerald-500" :
                  status === "waiting"   ? "bg-amber-500 animate-pulse" :
                  status === "connecting" ? "bg-sky-500 animate-pulse" :
                  "bg-rose-500"
                )} />

                {/* Desktop: full pill */}
                {status === "connected" && (
                  <span className="hidden sm:flex font-mono text-[11px] px-2.5 py-0.5 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    <span>CONNECTED ({peerCount} PEERS)</span>
                  </span>
                )}
                {status === "waiting" && (
                  <span className="hidden sm:flex font-mono text-[11px] px-2.5 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-700 items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    <span>WAITING FOR PEER</span>
                  </span>
                )}
                {status === "connecting" && (
                  <span className="hidden sm:flex font-mono text-[11px] px-2.5 py-0.5 rounded-full border border-sky-200 bg-sky-50 text-sky-700 items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
                    <span>CONNECTING</span>
                  </span>
                )}
                {status === "disconnected" && (
                  <span className="hidden sm:flex font-mono text-[11px] px-2.5 py-0.5 rounded-full border border-rose-200 bg-rose-50 text-rose-700 items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                    <span>DISCONNECTED</span>
                  </span>
                )}
                {status === "unauthorized" && (
                  <span className="hidden sm:flex font-mono text-[11px] px-2.5 py-0.5 rounded-full border border-rose-200 bg-rose-50 text-rose-700 items-center gap-1.5">
                    INVITE INVALID
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            <span className="hidden md:inline-flex items-center font-mono text-[10px] text-[#8f8f8f] px-2 py-1 rounded-[6px] border border-[#ebebeb] bg-[#fafafa]">
              CLOUDFLARE EDGE
            </span>

            {/* PWA Install */}
            {pwaPrompt && (
              <button
                onClick={handleInstall}
                title="Install app"
                className="font-mono text-xs text-[#171717] px-2.5 py-1 rounded-[6px] border border-[#ebebeb] hover:border-[#171717] transition-colors flex items-center gap-1 cursor-pointer"
              >
                <MonitorDown size={12} />
                <span className="hidden sm:inline">Install</span>
              </button>
            )}

            {(status === "disconnected" || status === "connecting") && (
              <button
                onClick={retryConnection}
                title="Reconnect"
                className="font-mono text-xs text-[#171717] px-2.5 py-1 rounded-[6px] border border-[#ebebeb] hover:border-[#171717] transition-colors flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw size={12} className={cn({ "animate-spin": status === "connecting" })} />
                <span className="hidden sm:inline">Retry</span>
              </button>
            )}

            {/* Clear chat */}
            {messages.length > 0 && (
              <div className="relative">
                {showClearConfirm ? (
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-[10px] text-[#8f8f8f] hidden sm:inline">Clear?</span>
                    <button
                      onClick={() => { clearMessages(); setReplyingTo(null); setShowClearConfirm(false); }}
                      className="font-mono text-[10px] text-rose-600 hover:text-rose-700 px-2 py-1 rounded-[6px] border border-rose-200 hover:border-rose-300 transition-colors cursor-pointer"
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setShowClearConfirm(false)}
                      className="font-mono text-[10px] text-[#8f8f8f] px-2 py-1 rounded-[6px] border border-[#ebebeb] hover:border-[#171717] transition-colors cursor-pointer"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowClearConfirm(true)}
                    title="Clear chat history"
                    className="font-mono text-xs text-[#8f8f8f] hover:text-[#171717] px-2 py-1 rounded-[6px] border border-[#ebebeb] hover:border-[#171717] transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 size={12} />
                    <span className="hidden sm:inline">Clear</span>
                  </button>
                )}
              </div>
            )}

            {fileStorageConfigured() && fileSessionToken && (
              <button
                onClick={() => setShowRoomFiles(true)}
                title="Manage room files"
                className="font-mono text-xs text-[#171717] px-2.5 py-1 rounded-[6px] border border-[#ebebeb] hover:border-[#171717] transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <FolderOpen size={12} />
                <span className="hidden sm:inline">Files</span>
              </button>
            )}

            {password && (
              <>
                <button
                  onClick={handleCopyLink}
                  disabled={!shareUrl || inviteBusy}
                  className="font-mono text-xs text-[#171717] px-2.5 py-1 rounded-[6px] border border-[#ebebeb] hover:border-[#171717] transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {copied ? <Check size={12} className="text-emerald-600" /> : <LinkIcon size={12} />}
                  <span className="hidden sm:inline">{copied ? "Copied" : inviteBusy ? "Preparing..." : "Copy Link"}</span>
                </button>
                <button
                  onClick={handleRotateInvite}
                  disabled={inviteBusy}
                  title="Create a new link and revoke the old one"
                  className="font-mono text-xs text-[#171717] px-2.5 py-1 rounded-[6px] border border-[#ebebeb] hover:border-[#171717] transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw size={12} />
                  <span className="hidden sm:inline">New Link</span>
                </button>
              </>
            )}

            <button
              onClick={password ? onLock : onLeave}
              title={password ? "Lock session" : "Leave room"}
              className="font-mono text-xs text-[#8f8f8f] hover:text-rose-600 px-2 py-1 rounded-[6px] border border-[#ebebeb] hover:border-rose-300 transition-colors flex items-center gap-1 cursor-pointer"
            >
              <LogOut size={12} />
              <span className="hidden sm:inline">{password ? "Lock" : "Leave"}</span>
            </button>
          </div>
        </header>

        {inviteError && password && <p className="px-4 py-2 text-xs text-rose-600 border-b border-[#ebebeb]">{inviteError}</p>}
        {fileError && <p className="px-4 py-2 text-xs text-rose-600 border-b border-[#ebebeb] flex items-center gap-2"><AlertCircle size={13} />{fileError}</p>}
        {status === "unauthorized" && <p className="px-4 py-2 text-xs text-rose-600 border-b border-[#ebebeb]">This invite link is invalid or has been replaced. Ask the owner for a new link.</p>}

        {/* Active Transfer Progress Bars */}
        {activeTransfers.length > 0 && (
          <div className="bg-[#fafafa] border-b border-[#ebebeb] px-4 py-2 space-y-1.5 shrink-0">
            {activeTransfers.map(([id, p]) => (
              <div key={id} className="flex items-center gap-2.5">
                <span className="font-mono text-[10px] text-[#8f8f8f] uppercase tracking-wider shrink-0 w-14">
                  {p.direction === "upload" ? "↑ UP" : "↓ DN"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-[10px] text-[#4d4d4d] truncate mb-0.5">{p.name}</p>
                  <div className="h-1 bg-[#ebebeb] rounded-full overflow-hidden">
                    <div
                      className={cn("h-full rounded-full transition-all duration-200", 
                        p.progress < 100 ? "progress-bar-shimmer" : "bg-emerald-500"
                      )}
                      style={{ width: `${p.progress}%` }}
                    />
                  </div>
                </div>
                <span className="font-mono text-[10px] text-[#171717] font-semibold shrink-0 w-8 text-right">
                  {p.progress}%
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto min-h-0 p-4 sm:p-6 bg-[#fafafa]" ref={scrollRef}>
          {status !== "connected" && messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-sm mx-auto space-y-4 my-auto py-8">
              {password && shareUrl && (
                <div className="bg-white p-6 rounded-[12px] border border-[#ebebeb] shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex flex-col items-center space-y-3">
                  <div className="p-2 border border-[#ebebeb] rounded-[6px] bg-white">
                    <QRCodeSVG value={shareUrl} size={160} level="M" className="text-[#171717]" />
                  </div>
                  <p className="font-mono text-[10px] text-[#8f8f8f] uppercase tracking-wider">
                    SCAN WITH CAMERA TO JOIN INSTANTLY
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <h3 className="text-base font-semibold tracking-tight text-[#171717]">
                  {status === "waiting" && "Waiting for Peer to Join"}
                  {status === "connecting" && "Establishing Edge Connection..."}
                  {status === "disconnected" && "Peer Left Room"}
                  {status === "unauthorized" && "Invite Link Invalid"}
                </h3>
                <p className="text-xs text-[#4d4d4d] leading-relaxed">
                  {status === "waiting" &&
                    "Share this link or QR code with your chat partner. Connection activates as soon as they open the link."}
                  {status === "connecting" &&
                    "Connecting to PartyKit relay server. Please hold on..."}
                  {status === "disconnected" &&
                    "The session ended. Re-share the room link to connect with someone else."}
                  {status === "unauthorized" &&
                    "This invite is invalid or has been replaced. Ask the room owner for a new link."}
                </p>
              </div>

              {status === "unauthorized" ? (
                <button onClick={onLeave} className="rounded-full bg-[#171717] text-white text-xs px-4 py-2 cursor-pointer">Leave Room</button>
              ) : status === "disconnected" ? (
                <button
                  onClick={retryConnection}
                  className="rounded-full bg-[#171717] hover:bg-black text-white text-xs px-4 py-2 font-medium flex items-center gap-1.5 shadow-sm cursor-pointer"
                >
                  <RefreshCw size={13} /> Reconnect
                </button>
              ) : password ? (
                <button
                  onClick={handleCopyLink}
                  disabled={!shareUrl || inviteBusy}
                  className="rounded-full bg-[#171717] hover:bg-black text-white text-xs px-4 py-2 font-medium flex items-center gap-1.5 shadow-sm cursor-pointer disabled:opacity-50"
                >
                  {copied ? <Check size={13} /> : <LinkIcon size={13} />}
                  <span>{copied ? "Link Copied!" : inviteBusy ? "Preparing Link..." : "Copy Direct Share Link"}</span>
                </button>
              ) : null}
            </div>
          )}

          <div className="space-y-4">
            {messages.map((msg, index) => {
              const msgId = msg.id;
              const prevMsg = messages[index - 1];
              // Show avatar if it's the first message in a sequence from this peer
              const showAvatar = !prevMsg || prevMsg.senderId !== msg.senderId;
              
              return (
                <MessageBubble
                  key={msgId}
                  msg={msg}
                  msgReactions={reactions[msgId]}
                  onReact={(emoji) => sendReaction(msgId, emoji)}
                  onReply={() => handleReply(msg)}
                  onJumpToReply={scrollToMessage}
                  showAvatar={showAvatar}
                  highlighted={highlightedMessageId === msgId}
                />
              );
            })}
          </div>

          {/* Typing indicator */}
          {typingPeers.size > 0 && (
            <div className="flex items-end gap-2.5 mt-4 msg-from-peer">
              <div className="h-6 w-6 rounded-[4px] border border-[#ebebeb] bg-white text-[#171717] font-mono text-[10px] font-semibold flex items-center justify-center shrink-0">
                💬
              </div>
              <div className="flex flex-col items-start gap-1">
                <span className="text-[10px] text-[#8f8f8f] font-mono uppercase tracking-wider ml-1">
                  {(() => {
                    const arr = Array.from(typingPeers);
                    const names = arr.map(id => peers[id] || "Someone");
                    if (names.length === 1) return `${names[0]} is typing...`;
                    if (names.length === 2) return `${names[0]} & ${names[1]} are typing...`;
                    return "Multiple people are typing...";
                  })()}
                </span>
                <div className="bg-white border border-[#ebebeb] rounded-[12px] rounded-bl-[2px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] px-4 py-3 flex items-center gap-1">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input Area */}
        <footer className="p-3 sm:p-4 bg-white border-t border-[#ebebeb] shrink-0">
          {replyingTo && (
            <div className="mb-2 flex items-center gap-3 rounded-[8px] border border-[#ebebeb] bg-[#fafafa] px-3 py-2">
              <div className="min-w-0 flex-1 border-l-2 border-[#171717] pl-3">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-[#171717]">
                  Replying to {replyingTo.senderName || "Unknown"}
                </p>
                <p className="mt-0.5 truncate text-xs text-[#6b6b6b]">
                  {replyingTo.type === "file" ? "📎 " : ""}{replyingTo.content}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReplyingTo(null)}
                aria-label="Cancel reply"
                title="Cancel reply"
                className="shrink-0 rounded-[6px] p-1.5 text-[#8f8f8f] hover:bg-[#ebebeb] hover:text-[#171717]"
              >
                <X size={14} />
              </button>
            </div>
          )}
          <form
            onSubmit={handleSend}
            className="flex items-center gap-2 rounded-[8px] border border-[#ebebeb] bg-white p-1.5 focus-within:border-[#171717] transition-colors"
          >
            <input
              type="file"
              className="hidden"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept="*/*"
              multiple
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={status !== "connected" || (fileStorageConfigured() && !fileSessionToken)}
              className="p-2 text-[#8f8f8f] hover:text-[#171717] transition-colors rounded-[6px] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              title="Attach files (multiple supported)"
            >
              <Paperclip size={18} />
            </button>
            {fileStorageConfigured() && (
              <select
                value={fileExpiryHours}
                onChange={(event) => setFileExpiryHours(Number(event.target.value))}
                className="hidden sm:block rounded-[5px] border border-[#ebebeb] bg-[#fafafa] px-1.5 py-1 font-mono text-[10px] text-[#4d4d4d] outline-none"
                title="File and link expiry"
              >
                <option value={1}>1h</option>
                <option value={6}>6h</option>
                <option value={12}>12h</option>
                <option value={24}>24h</option>
              </select>
            )}
            <input
              ref={textInputRef}
              type="text"
              value={text}
              onChange={handleTextChange}
              onKeyDown={(event) => {
                if (event.key === "Escape" && replyingTo) {
                  event.preventDefault();
                  setReplyingTo(null);
                }
              }}
              placeholder={
                status === "connected"
                  ? "Type a message..."
                  : "Waiting for peer to connect..."
              }
              disabled={status !== "connected"}
              className="flex-1 bg-transparent border-none text-sm outline-none px-2 text-[#171717] placeholder:text-[#a1a1a1] disabled:opacity-40"
            />
            <button
              type="submit"
              disabled={!text.trim() || status !== "connected"}
              className="h-8 w-8 rounded-[6px] bg-[#171717] hover:bg-black text-white flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer shrink-0"
              title="Send message"
            >
              <ArrowUp size={16} />
            </button>
          </form>
          {/* Bottom status bar */}
          <div className="flex items-center justify-between mt-2 px-1">
            {/* Mobile: full status label here */}
            <span className={cn(
              "sm:hidden font-mono text-[10px] uppercase tracking-wide",
              status === "connected"   ? "text-emerald-600" :
              status === "waiting"     ? "text-amber-600" :
              status === "connecting"  ? "text-sky-600" :
              "text-rose-600"
            )}>
              {status === "connected"   && `● CONNECTED (${peerCount} PEERS)`}
              {status === "waiting"     && "● WAITING FOR PEER"}
              {status === "connecting"  && "● CONNECTING..."}
              {status === "disconnected" && "● DISCONNECTED"}
              {status === "unauthorized" && "● INVITE INVALID"}
            </span>
            {/* Desktop: security tagline */}
            <p className="hidden sm:block font-mono text-[10px] text-[#8f8f8f] tracking-wide">
              TLS PROTECTED // NO SERVER MESSAGE HISTORY
            </p>
          </div>
        </footer>
        {showRoomFiles && fileSessionToken && (
          <RoomFilesPanel
            roomId={roomId}
            sessionToken={fileSessionToken}
            onClose={() => setShowRoomFiles(false)}
          />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Room file management
// ─────────────────────────────────────────────────────────────────────────────

function timeRemaining(expiresAt: number | null): string {
  if (!expiresAt) return "No expiry";
  const milliseconds = expiresAt - Date.now();
  if (milliseconds <= 0) return "Expired";
  const minutes = Math.ceil(milliseconds / 60000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m left` : `${hours}h left`;
}

function RoomFilesPanel({ roomId, sessionToken, onClose }: { roomId: string; sessionToken: string; onClose: () => void }) {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setFiles(await listRoomFiles(roomId, sessionToken));
      setError("");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not load room files");
    } finally {
      setLoading(false);
    }
  }, [roomId, sessionToken]);

  useEffect(() => { void refresh(); }, [refresh]);

  const changeExpiry = async (file: StoredFile, field: "file" | "link", hours: number) => {
    if (!file.expiresAt || !file.linkExpiresAt) return;
    setBusyId(file.id);
    try {
      const next = Date.now() + hours * 60 * 60 * 1000;
      const updated = field === "file"
        ? await updateStoredFile(file.id, sessionToken, next, Math.min(file.linkExpiresAt, next))
        : await updateStoredFile(file.id, sessionToken, file.expiresAt, hours === 0 ? Date.now() : Math.min(file.expiresAt, next));
      setFiles((current) => current.map((item) => item.id === file.id ? updated : item));
      setError("");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not update expiry");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (file: StoredFile) => {
    if (!window.confirm(`Delete ${file.name}? This cannot be undone.`)) return;
    setBusyId(file.id);
    try {
      await deleteStoredFile(file.id, sessionToken);
      setFiles((current) => current.filter((item) => item.id !== file.id));
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not delete file");
    } finally {
      setBusyId(null);
    }
  };

  const download = async (file: StoredFile) => {
    setBusyId(file.id);
    try {
      const url = await createDownloadUrl(file.id, sessionToken);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (value) {
      setError(value instanceof Error ? value.message : "Could not create download link");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex justify-end bg-black/25 backdrop-blur-[1px]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="h-full w-full max-w-lg overflow-y-auto border-l border-[#ebebeb] bg-white shadow-xl">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-[#ebebeb] bg-white px-5">
          <div>
            <h2 className="text-sm font-semibold">Room files</h2>
            <p className="font-mono text-[10px] text-[#8f8f8f]">ROOM {roomId.toUpperCase()} · MAX 24H</p>
          </div>
          <button onClick={onClose} className="rounded-[6px] p-2 text-[#8f8f8f] hover:bg-[#f2f2f2] hover:text-[#171717]" aria-label="Close room files"><X size={16} /></button>
        </header>
        <div className="p-5">
          <div className="mb-4 rounded-[8px] border border-[#ebebeb] bg-[#fafafa] p-3 text-xs leading-relaxed text-[#4d4d4d]">
            You can manage files you uploaded while this room session is active. The room owner can manage every file in the room.
          </div>
          {error && <p className="mb-4 flex items-center gap-2 rounded-[7px] bg-rose-50 px-3 py-2 text-xs text-rose-700"><AlertCircle size={13} />{error}</p>}
          {loading ? (
            <div className="py-16 text-center font-mono text-xs text-[#8f8f8f]">LOADING FILES...</div>
          ) : files.length === 0 ? (
            <div className="py-16 text-center"><FolderOpen className="mx-auto mb-3 text-[#b5b5b5]" size={28} /><p className="text-sm text-[#737373]">No stored files in this room</p></div>
          ) : (
            <div className="space-y-3">
              {files.map((file) => (
                <article key={file.id} className="rounded-[9px] border border-[#ebebeb] p-3.5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[7px] bg-[#f5f5f5] text-[#4d4d4d]"><FileText size={17} /></div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold" title={file.name}>{file.name}</p>
                      <p className="mt-1 font-mono text-[9px] uppercase text-[#8f8f8f]">{formatFileSize(file.size)} · {file.status} · {timeRemaining(file.expiresAt)}</p>
                    </div>
                    {file.status === "ready" && <button disabled={busyId === file.id} onClick={() => void download(file)} className="rounded-[6px] border border-[#ebebeb] p-2 text-[#4d4d4d] hover:border-[#171717] disabled:opacity-40" title="Download"><Download size={14} /></button>}
                  </div>
                  {file.canManage && (
                    <div className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2 border-t border-[#f2f2f2] pt-3">
                      <label className="text-[9px] font-mono uppercase text-[#8f8f8f]">File expiry
                        <select disabled={busyId === file.id} defaultValue="" onChange={(event) => { if (event.target.value) void changeExpiry(file, "file", Number(event.target.value)); event.target.value = ""; }} className="mt-1 w-full rounded-[5px] border border-[#ebebeb] bg-white px-2 py-1.5 text-[10px] text-[#171717]">
                          <option value="" disabled>Change</option><option value="1">1 hour</option><option value="6">6 hours</option><option value="12">12 hours</option><option value="24">Max 24h</option>
                        </select>
                      </label>
                      <label className="text-[9px] font-mono uppercase text-[#8f8f8f]">Share link
                        <select disabled={busyId === file.id} defaultValue="" onChange={(event) => { if (event.target.value !== "") void changeExpiry(file, "link", Number(event.target.value)); event.target.value = ""; }} className="mt-1 w-full rounded-[5px] border border-[#ebebeb] bg-white px-2 py-1.5 text-[10px] text-[#171717]">
                          <option value="" disabled>Change</option><option value="0">Revoke now</option><option value="1">1 hour</option><option value="6">6 hours</option><option value="12">12 hours</option><option value="24">Max 24h</option>
                        </select>
                      </label>
                      <button disabled={busyId === file.id} onClick={() => void remove(file)} className="mt-4 self-end rounded-[6px] border border-rose-200 p-2 text-rose-600 hover:bg-rose-50 disabled:opacity-40" title="Delete permanently"><Trash2 size={14} /></button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Global storage administration
// ─────────────────────────────────────────────────────────────────────────────

function StorageAdminPage() {
  const [token, setToken] = useState(() => sessionStorage.getItem("chatp2p_storage_admin") || "");
  const [password, setPassword] = useState("");
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [loading, setLoading] = useState(!!token);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (currentToken = token) => {
    if (!currentToken) return;
    setLoading(true);
    try {
      const response = await listAdminFiles(currentToken);
      setFiles(response.files);
      setError(response.truncated ? "The bucket has more than 1,000 objects. Refine or paginate before bulk actions." : "");
    } catch (value) {
      const message = value instanceof Error ? value.message : "Could not load storage";
      setError(message);
      if (/unauthorized/i.test(message)) {
        sessionStorage.removeItem("chatp2p_storage_admin");
        setToken("");
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { if (token) void load(token); }, [token, load]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      const session = await adminLogin(password);
      sessionStorage.setItem("chatp2p_storage_admin", session.token);
      setToken(session.token);
      setPassword("");
      setError("");
    } catch (value) {
      setError(value instanceof Error ? value.message : "Login failed");
      setLoading(false);
    }
  };

  const remove = async (file: StoredFile) => {
    if (!window.confirm(`Permanently delete ${file.name}?`)) return;
    setBusyId(file.id);
    try {
      await deleteAdminFile(file, token);
      setFiles((current) => current.filter((item) => item.id !== file.id));
    } catch (value) {
      setError(value instanceof Error ? value.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  };

  const keepToMax = async (file: StoredFile) => {
    if (file.status === "orphan") return;
    const max = (file.uploadedAt || file.createdAt) + 24 * 60 * 60 * 1000;
    setBusyId(file.id);
    try {
      const updated = await updateAdminFile(file.id, token, max, max);
      setFiles((current) => current.map((item) => item.id === file.id ? updated : item));
    } catch (value) {
      setError(value instanceof Error ? value.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  };

  if (!fileStorageConfigured()) {
    return <div className="min-h-screen bg-[#fafafa] p-8 text-[#171717]"><div className="mx-auto max-w-lg rounded-xl border border-[#ebebeb] bg-white p-6"><h1 className="font-semibold">Storage API is not configured</h1><p className="mt-2 text-sm text-[#737373]">Set VITE_FILE_API_URL and rebuild the app.</p></div></div>;
  }

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#fafafa] p-5 text-[#171717]">
        <form onSubmit={login} className="w-full max-w-sm rounded-[12px] border border-[#ebebeb] bg-white p-6 shadow-sm">
          <Database size={24} className="mb-5" />
          <h1 className="text-lg font-semibold">Storage administration</h1>
          <p className="mt-1 text-xs leading-relaxed text-[#737373]">Manage every object in the ChatP2P bucket. This uses a separate administrator credential.</p>
          <input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Administrator password" className="mt-5 w-full rounded-[7px] border border-[#d9d9d9] px-3 py-2.5 text-sm outline-none focus:border-[#171717]" />
          {error && <p className="mt-3 text-xs text-rose-600">{error}</p>}
          <button disabled={!password || loading} className="mt-4 w-full rounded-[7px] bg-[#171717] py-2.5 text-sm font-medium text-white disabled:opacity-40">{loading ? "Signing in..." : "Sign in"}</button>
        </form>
      </div>
    );
  }

  const visible = files.filter((file) => `${file.name} ${file.roomId || ""} ${file.status}`.toLowerCase().includes(filter.toLowerCase()));
  const totalBytes = files.reduce((sum, file) => file.status === "deleted" ? sum : sum + file.size, 0);
  const orphanCount = files.filter((file) => file.status === "orphan").length;

  return (
    <div className="min-h-screen bg-[#fafafa] text-[#171717]">
      <header className="border-b border-[#ebebeb] bg-white"><div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4"><div className="flex items-center gap-3"><Database size={20} /><div><h1 className="text-sm font-semibold">Storage administration</h1><p className="font-mono text-[9px] text-[#8f8f8f]">R2 BUCKET INVENTORY</p></div></div><div className="flex gap-2"><button onClick={() => void load()} className="rounded-[6px] border border-[#ebebeb] px-3 py-1.5 text-xs hover:border-[#171717]"><RefreshCw size={12} className="mr-1 inline" />Refresh</button><button onClick={() => { sessionStorage.removeItem("chatp2p_storage_admin"); setToken(""); }} className="rounded-[6px] border border-[#ebebeb] px-3 py-1.5 text-xs text-[#737373] hover:border-rose-300 hover:text-rose-600">Sign out</button></div></div></header>
      <main className="mx-auto max-w-6xl p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-[9px] border border-[#ebebeb] bg-white p-4"><HardDrive size={16} className="text-[#737373]" /><p className="mt-3 text-xl font-semibold">{formatFileSize(totalBytes)}</p><p className="font-mono text-[9px] uppercase text-[#8f8f8f]">Current storage</p></div>
          <div className="rounded-[9px] border border-[#ebebeb] bg-white p-4"><FileText size={16} className="text-[#737373]" /><p className="mt-3 text-xl font-semibold">{files.length}</p><p className="font-mono text-[9px] uppercase text-[#8f8f8f]">Tracked objects</p></div>
          <div className="rounded-[9px] border border-[#ebebeb] bg-white p-4"><AlertCircle size={16} className={orphanCount ? "text-amber-600" : "text-[#737373]"} /><p className="mt-3 text-xl font-semibold">{orphanCount}</p><p className="font-mono text-[9px] uppercase text-[#8f8f8f]">Orphan objects</p></div>
        </div>
        <div className="mt-5 overflow-hidden rounded-[10px] border border-[#ebebeb] bg-white">
          <div className="flex flex-col gap-3 border-b border-[#ebebeb] p-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-sm font-semibold">Bucket files</h2><p className="text-[10px] text-[#8f8f8f]">Keep extends only to the hard 24-hour limit.</p></div><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter name, room or status" className="w-full rounded-[6px] border border-[#ebebeb] px-3 py-2 text-xs outline-none focus:border-[#171717] sm:w-72" /></div>
          {error && <p className="border-b border-[#ebebeb] bg-amber-50 px-4 py-2 text-xs text-amber-800">{error}</p>}
          {loading ? <div className="py-16 text-center font-mono text-xs text-[#8f8f8f]">LOADING BUCKET...</div> : (
            <div className="divide-y divide-[#f2f2f2]">
              {visible.map((file) => (
                <div key={file.id} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,2fr)_1fr_1fr_auto] sm:items-center">
                  <div className="min-w-0"><p className="truncate text-xs font-semibold" title={file.name}>{file.name}</p><p className="mt-1 truncate font-mono text-[9px] text-[#8f8f8f]">{file.roomId ? `ROOM ${file.roomId}` : file.objectKey || "ORPHAN"}</p></div>
                  <div><p className="text-xs">{formatFileSize(file.size)}</p><p className="font-mono text-[9px] uppercase text-[#8f8f8f]">{file.status}</p></div>
                  <div><p className="text-xs">{timeRemaining(file.expiresAt)}</p><p className="font-mono text-[9px] uppercase text-[#8f8f8f]">{file.downloadCount} downloads</p></div>
                  <div className="flex gap-2">{file.status !== "orphan" && <button disabled={busyId === file.id} onClick={() => void keepToMax(file)} className="rounded-[6px] border border-[#ebebeb] px-2.5 py-1.5 text-[10px] hover:border-[#171717] disabled:opacity-40" title="Keep until the 24-hour maximum"><Clock3 size={12} className="mr-1 inline" />Keep</button>}<button disabled={busyId === file.id} onClick={() => void remove(file)} className="rounded-[6px] border border-rose-200 p-2 text-rose-600 hover:bg-rose-50 disabled:opacity-40" title="Delete"><Trash2 size={13} /></button></div>
                </div>
              ))}
              {!visible.length && <div className="py-16 text-center text-sm text-[#8f8f8f]">No matching files</div>}
            </div>
          )}
        </div>
        <a href="/" className="mt-5 inline-flex items-center gap-1 text-xs text-[#737373] hover:text-[#171717]"><ExternalLink size={12} />Back to ChatP2P</a>
      </main>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MessageBubble
// ─────────────────────────────────────────────────────────────────────────────

function MessageBubble({
  msg,
  msgReactions,
  onReact,
  onReply,
  onJumpToReply,
  showAvatar = true,
  highlighted = false,
}: {
  key?: React.Key;
  msg: Message;
  msgReactions?: Record<string, number>;
  onReact?: (emoji: string) => void;
  onReply?: () => void;
  onJumpToReply?: (messageId: string) => void;
  showAvatar?: boolean;
  highlighted?: boolean;
}) {
  const isMe = msg.isMe;
  const [copied, setCopied] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const handleCopy = () => {
    if (!msg.content) return;
    navigator.clipboard.writeText(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Close picker when clicking outside
  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPicker]);

  const isImage = msg.type === "file" && msg.fileType?.startsWith("image/");
  const hasReactions = msgReactions && Object.keys(msgReactions).length > 0;

  return (
    <div
      id={`message-${msg.id}`}
      className={cn(
        "flex w-full items-end gap-2.5 rounded-[14px] transition-[background-color,box-shadow] duration-300",
        highlighted && "bg-amber-50 shadow-[0_0_0_4px_rgba(245,158,11,0.12)]",
        isMe ? "justify-end msg-from-me" : "justify-start msg-from-peer"
      )}
    >
      {!isMe && (
        <div className="flex flex-col items-center shrink-0 w-8">
          {showAvatar ? (
            <div
              className={cn(
                "h-8 w-8 rounded-[8px] text-white font-mono text-xs font-semibold flex items-center justify-center shadow-sm",
                getAvatarColor(msg.senderId)
              )}
              title={msg.senderName}
            >
              {getInitials(msg.senderName || "Unknown")}
            </div>
          ) : (
            <div className="h-8 w-8" /> // placeholder spacer
          )}
        </div>
      )}

      <div
        className={cn(
          "max-w-[85%] sm:max-w-[70%] flex flex-col",
          isMe ? "items-end" : "items-start"
        )}
      >
        {!isMe && showAvatar && msg.senderName && (
          <span className="max-w-full truncate text-[10px] text-[#8f8f8f] font-mono uppercase tracking-wider mb-1 ml-1" title={msg.senderName}>
            {msg.senderName}
          </span>
        )}

        {/* Outer wrapper: group here so both copy & 😊 buttons respond to hover */}
        <div className={cn("relative group pb-4")}>
          {/* Bubble */}
          <div
            className={cn(
              "rounded-[12px] overflow-hidden text-sm leading-relaxed",
              isMe
                ? "bg-[#171717] text-white rounded-br-[2px]"
                : "bg-white border border-[#ebebeb] text-[#171717] rounded-bl-[2px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
            )}
          >
            {msg.replyTo && (
              <button
                type="button"
                onClick={() => onJumpToReply?.(msg.replyTo!.messageId)}
                className={cn(
                  "mx-2.5 mt-2.5 block w-[calc(100%-1.25rem)] min-w-0 rounded-[7px] border-l-2 px-2.5 py-2 text-left transition-colors",
                  isMe
                    ? "border-white/70 bg-white/10 hover:bg-white/15"
                    : "border-[#171717] bg-[#f7f7f7] hover:bg-[#f2f2f2]"
                )}
                title="Jump to original message"
              >
                <span className={cn("block truncate font-mono text-[10px] font-semibold uppercase tracking-wide", isMe ? "text-white/80" : "text-[#4d4d4d]")}>
                  {msg.replyTo.senderName}
                </span>
                <span className={cn("mt-0.5 block truncate text-xs", isMe ? "text-white/65" : "text-[#737373]")}>
                  {msg.replyTo.type === "file" ? "📎 " : ""}{msg.replyTo.content}
                </span>
              </button>
            )}
            {msg.type === "text" ? (
              /* ── Text message ─────────────────────── */
              <div className="flex items-start gap-2 p-3 sm:p-3.5">
                <p className="whitespace-pre-wrap break-words flex-1">{msg.content}</p>
                <button
                  onClick={handleCopy}
                  title="Copy"
                  className={cn(
                    "p-1 rounded-[4px] transition-all shrink-0 cursor-pointer",
                    isMe
                      ? "text-white/60 hover:text-white hover:bg-white/10"
                      : "text-[#8f8f8f] hover:text-[#171717] hover:bg-[#fafafa]",
                    copied ? "opacity-100" : "opacity-0 group-hover:opacity-100 max-sm:opacity-60"
                  )}
                >
                  {copied ? (
                    <Check size={12} className={isMe ? "text-white" : "text-emerald-600"} />
                  ) : (
                    <Copy size={12} />
                  )}
                </button>
              </div>
            ) : isImage ? (
              /* ── Image preview ────────────────────── */
              <div style={{ maxWidth: 260 }}>
                <img
                  src={msg.fileUrl}
                  alt={msg.content}
                  className="w-full object-cover block"
                  style={{ maxHeight: 300 }}
                />
                {msg.fileUrl && (
                  <div className={cn(
                    "flex items-center justify-between px-3 py-2",
                    isMe ? "bg-white/10" : "bg-[#fafafa] border-t border-[#ebebeb]"
                  )}>
                    <span className={cn("font-mono text-[9px] uppercase truncate flex-1", isMe ? "text-white/60" : "text-[#8f8f8f]")}>
                      {msg.content}
                      {msg.fileSize ? ` · ${formatFileSize(msg.fileSize)}` : ""}
                    </span>
                    <a
                      href={msg.fileUrl}
                      download={msg.content}
                      className={cn(
                        "ml-2 p-1 rounded-[4px] transition-colors cursor-pointer",
                        isMe ? "text-white/70 hover:text-white hover:bg-white/10" : "text-[#8f8f8f] hover:text-[#171717] hover:bg-[#ebebeb]"
                      )}
                      title="Download"
                    >
                      <Download size={12} />
                    </a>
                  </div>
                )}
              </div>
            ) : (
              /* ── Generic file ─────────────────────── */
              <div className={cn("flex items-center gap-3 p-2.5", isMe ? "text-white" : "text-[#171717]")}>
                <div className={cn(
                  "h-9 w-9 rounded-[4px] border flex items-center justify-center shrink-0",
                  isMe ? "bg-white/10 border-white/20 text-white" : "bg-white border-[#ebebeb] text-[#171717]"
                )}>
                  <FileText size={18} />
                </div>
                <div className="overflow-hidden pr-2 flex-1 min-w-0">
                  <p className={cn("text-xs font-semibold truncate max-w-[120px] sm:max-w-[180px]", isMe ? "text-white" : "text-[#171717]")}>
                    {msg.content}
                  </p>
                  <p className={cn("font-mono text-[9px] uppercase mt-0.5", isMe ? "text-white/60" : "text-[#8f8f8f]")}>
                    {isMe ? "Sent" : "Received"}
                    {msg.fileSize ? ` · ${formatFileSize(msg.fileSize)}` : ""}
                  </p>
                </div>
                {msg.fileUrl && (
                  <a
                    href={msg.fileUrl}
                    download={msg.content}
                    className={cn(
                      "ml-auto px-2.5 py-1 rounded-[6px] font-mono text-xs font-medium flex items-center gap-1 shrink-0 transition-colors",
                      isMe ? "bg-white text-[#171717] hover:bg-[#f2f2f2]" : "bg-[#171717] text-white hover:bg-black"
                    )}
                  >
                    <Download size={12} />
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Message actions */}
          {(onReply || onReact) && (
            <div
              className={cn(
                "absolute bottom-1 z-10 flex items-center gap-1 transition-opacity",
                "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100",
                isMe ? "left-1" : "right-1"
              )}
              ref={pickerRef}
            >
              {onReply && (
                <button
                  type="button"
                  onClick={onReply}
                  className="rounded-full border border-[#d0d0d0] bg-white p-1.5 text-[#6b6b6b] shadow-sm hover:border-[#171717] hover:text-[#171717]"
                  aria-label="Reply to message"
                  title="Reply"
                >
                  <ReplyIcon size={13} />
                </button>
              )}
              {onReact && (
                <button
                  type="button"
                  onClick={() => setShowPicker((v) => !v)}
                  className={cn(
                    "rounded-full border p-1 text-sm leading-none shadow-sm transition-colors",
                    showPicker
                      ? "border-[#171717] bg-[#f5f5f5]"
                      : "border-[#d0d0d0] bg-white hover:border-[#171717] hover:bg-[#f5f5f5]"
                  )}
                  aria-label="Add reaction"
                  title="Add reaction"
                >
                  😊
                </button>
              )}
              {onReact && showPicker && (
                <div
                  className={cn(
                    "reaction-picker absolute z-20 bg-white border border-[#ebebeb] rounded-full shadow-lg px-2 py-1.5 flex items-center gap-1",
                    isMe ? "bottom-9 left-0" : "bottom-9 right-0"
                  )}
                >
                  {EMOJI_LIST.map((emoji) => (
                    <button
                      type="button"
                      key={emoji}
                      onClick={() => {
                        onReact(emoji);
                        setShowPicker(false);
                      }}
                      className="text-base hover:scale-125 transition-transform cursor-pointer leading-none"
                      title={emoji}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Reactions pills */}
        {hasReactions && (
          <div className={cn("flex flex-wrap gap-1 mt-1 px-1", isMe ? "justify-end" : "justify-start")}>
            {Object.entries(msgReactions).map(([emoji, count]) =>
              count > 0 ? (
                <button
                  key={emoji}
                  onClick={() => onReact?.(emoji)}
                  className="flex items-center gap-0.5 px-1.5 py-0.5 bg-white border border-[#ebebeb] rounded-full text-xs hover:border-[#171717] transition-colors cursor-pointer shadow-sm"
                  title={`React ${emoji}`}
                >
                  <span>{emoji}</span>
                  <span className="font-mono text-[10px] text-[#4d4d4d]">{count}</span>
                </button>
              ) : null
            )}
          </div>
        )}

        {/* Timestamp */}
        <div className={cn(
          "flex items-center gap-1.5 mt-1 px-1",
          isMe ? "justify-end" : "justify-start"
        )}>
          <span className="font-mono text-[10px] text-[#8f8f8f]">
            {format(msg.timestamp, "HH:mm")}
          </span>
          {msg.type === "text" && copied && (
            <span className="font-mono text-[10px] text-emerald-600 font-medium flex items-center gap-0.5">
              <Check size={10} /> Copied!
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// TypeScript augmentation for PWA install prompt
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
