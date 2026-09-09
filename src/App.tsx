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
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useWebRTC, type Message, type FileProgress } from "./lib/useWebRTC";
import { cn } from "./lib/utils";
import { format } from "date-fns";
import { QRScanner } from "./components/QRScanner";
import { useNotification } from "./lib/useNotification";

const EXPECTED_PASSWORD = (
  (import.meta.env.VITE_APP_PASSWORD as string) || "chat123"
).trim();
const STORAGE_KEY = "chatp2p_auth_token";
const EMOJI_LIST = ["👍", "❤️", "😂", "😮", "😢"];

/** Formats bytes into a human-readable string */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function VercelTriangle({ className = "w-4 h-4 text-[#171717]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 75 65" height="14" width="16" fill="currentColor" className={className}>
      <polygon points="37.5,0 75,65 0,65" />
    </svg>
  );
}

export default function App() {
  const [password, setPassword] = useState<string>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)?.trim();
    if (saved && saved === EXPECTED_PASSWORD) return saved;

    if (typeof window !== "undefined") {
      const urlParams = new URLSearchParams(window.location.search);
      const pwd = urlParams.get("pwd")?.trim();
      if (pwd && pwd === EXPECTED_PASSWORD) {
        localStorage.setItem(STORAGE_KEY, pwd);
        return pwd;
      }
    }
    return "";
  });

  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [roomId, setRoomId] = useState<string | null>(null);
  const [joinInput, setJoinInput] = useState("");
  const [joinError, setJoinError] = useState("");
  const [showScanner, setShowScanner] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const room = params.get("room")?.trim();
    if (room) {
      setRoomId(room);
    }
  }, []);

  const handleUnlock = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (passwordInput.trim() === EXPECTED_PASSWORD) {
      localStorage.setItem(STORAGE_KEY, passwordInput.trim());
      setPassword(passwordInput.trim());
      setPasswordError("");
    } else {
      setPasswordError("Invalid password. Access denied.");
    }
  };

  const handleLock = () => {
    localStorage.removeItem(STORAGE_KEY);
    setPassword("");
    setPasswordInput("");
    setPasswordError("");

    const url = new URL(window.location.href);
    if (url.searchParams.has("pwd")) {
      url.searchParams.delete("pwd");
      window.history.replaceState({}, "", url.toString());
    }
  };

  const handleCreateRoom = () => {
    const newRoom = uuidv4().slice(0, 8);
    window.history.pushState({}, "", `?room=${newRoom}`);
    setRoomId(newRoom);
  };

  const handleJoinRoom = (overrideId?: string) => {
    const raw = (overrideId ?? joinInput).trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!raw) {
      setJoinError("Enter a valid Room ID.");
      return;
    }
    window.history.pushState({}, "", `?room=${raw}`);
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

  // ── 1. Password Gate ─────────────────────────────────────────
  if (password !== EXPECTED_PASSWORD) {
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
              className="w-full bg-[#171717] hover:bg-black text-white rounded-full py-2.5 px-4 text-sm font-medium transition-colors cursor-pointer flex items-center justify-center gap-2 shadow-sm"
            >
              <Unlock size={16} />
              <span>Unlock Instance</span>
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
              WEBRTC // ZERO-LOG RELAY
            </span>
            <div className="w-10 h-10 rounded-[6px] border border-[#ebebeb] bg-[#fafafa] flex items-center justify-center mx-auto text-[#171717] my-2">
              <VercelTriangle className="w-5 h-5 text-[#171717]" />
            </div>
            <h1 className="text-2xl font-semibold tracking-[-0.04em] text-[#171717]">
              Secure P2P Chat
            </h1>
            <p className="text-sm text-[#4d4d4d] leading-relaxed max-w-xs mx-auto">
              Direct peer-to-peer data tunnel with end-to-end encryption. Zero server message logging.
            </p>
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
  return <ChatRoom roomId={roomId} password={password} onLock={handleLock} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// ChatRoom
// ─────────────────────────────────────────────────────────────────────────────

function ChatRoom({
  roomId,
  password,
  onLock,
}: {
  roomId: string;
  password: string;
  onLock: () => void;
}) {
  const {
    status,
    peerCount,
    messages,
    sendMessage,
    sendFiles,
    sendTyping,
    sendReaction,
    clearMessages,
    retryConnection,
    transferProgress,
    isPeerTyping,
    reactions,
  } = useWebRTC(roomId, password);

  const { notify } = useNotification();

  const [text, setText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
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
      if (latest?.sender === "peer") notify();
    }
    prevMsgCount.current = messages.length;
  }, [messages, notify]);

  const shareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${window.location.pathname}?room=${roomId}&pwd=${encodeURIComponent(password)}`
      : "";

  const handleCopyLink = () => {
    navigator.clipboard.writeText(shareUrl || window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim() && status === "connected") {
      sendMessage(text.trim());
      setText("");
    }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.target.value);
    sendTyping();
  };

  // Multiple files
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0 && status === "connected") {
      sendFiles(files);
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
        sendFiles(files);
      }
    },
    [status, sendFiles]
  );

  // Active transfers
  const activeTransfers = (Object.entries(transferProgress) as [string, FileProgress][]).filter(
    ([, p]) => !p.done
  );

  const currentUrl = typeof window !== "undefined" ? window.location.href : "";

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
        <header className="h-14 border-b border-[#ebebeb] flex items-center justify-between px-4 sm:px-6 bg-white shrink-0 z-10">
          <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <VercelTriangle className="w-4 h-4 text-[#171717] shrink-0" />
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="font-mono text-xs sm:text-sm font-medium text-[#171717] shrink-0">
                room: <span className="text-[#8f8f8f]">{roomId}</span>
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
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
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
                      onClick={() => { clearMessages(); setShowClearConfirm(false); }}
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

            <button
              onClick={handleCopyLink}
              className="font-mono text-xs text-[#171717] px-2.5 py-1 rounded-[6px] border border-[#ebebeb] hover:border-[#171717] transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              {copied ? <Check size={12} className="text-emerald-600" /> : <LinkIcon size={12} />}
              <span>{copied ? "Copied" : "Copy Link"}</span>
            </button>

            <button
              onClick={onLock}
              title="Lock session"
              className="font-mono text-xs text-[#8f8f8f] hover:text-rose-600 px-2 py-1 rounded-[6px] border border-[#ebebeb] hover:border-rose-300 transition-colors flex items-center gap-1 cursor-pointer"
            >
              <LogOut size={12} />
              <span className="hidden sm:inline">Lock</span>
            </button>
          </div>
        </header>

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
              <div className="bg-white p-6 rounded-[12px] border border-[#ebebeb] shadow-[0_1px_2px_rgba(0,0,0,0.04)] flex flex-col items-center space-y-3">
                <div className="p-2 border border-[#ebebeb] rounded-[6px] bg-white">
                  <QRCodeSVG value={shareUrl || currentUrl} size={160} level="M" className="text-[#171717]" />
                </div>
                <p className="font-mono text-[10px] text-[#8f8f8f] uppercase tracking-wider">
                  SCAN WITH CAMERA TO JOIN INSTANTLY
                </p>
              </div>

              <div className="space-y-1.5">
                <h3 className="text-base font-semibold tracking-tight text-[#171717]">
                  {status === "waiting" && "Waiting for Peer to Join"}
                  {status === "connecting" && "Establishing Edge Connection..."}
                  {status === "disconnected" && "Peer Left Room"}
                </h3>
                <p className="text-xs text-[#4d4d4d] leading-relaxed">
                  {status === "waiting" &&
                    "Share this link or QR code with your chat partner. Connection activates as soon as they open the link."}
                  {status === "connecting" &&
                    "Connecting to PartyKit relay server. Please hold on..."}
                  {status === "disconnected" &&
                    "The session ended. Re-share the room link to connect with someone else."}
                </p>
              </div>

              {status === "disconnected" ? (
                <button
                  onClick={retryConnection}
                  className="rounded-full bg-[#171717] hover:bg-black text-white text-xs px-4 py-2 font-medium flex items-center gap-1.5 shadow-sm cursor-pointer"
                >
                  <RefreshCw size={13} /> Reconnect
                </button>
              ) : (
                <button
                  onClick={handleCopyLink}
                  className="rounded-full bg-[#171717] hover:bg-black text-white text-xs px-4 py-2 font-medium flex items-center gap-1.5 shadow-sm cursor-pointer"
                >
                  {copied ? <Check size={13} /> : <LinkIcon size={13} />}
                  <span>{copied ? "Link Copied!" : "Copy Direct Share Link"}</span>
                </button>
              )}
            </div>
          )}

          <div className="space-y-4">
            {messages.map((msg) => {
              const msgId = msg.id;
              return (
                <MessageBubble
                  key={msgId}
                  msg={msg}
                  msgReactions={reactions[msgId]}
                  onReact={(emoji) => sendReaction(msgId, emoji)}
                />
              );
            })}
          </div>

          {/* Typing indicator */}
          {isPeerTyping && (
            <div className="flex items-end gap-2.5 mt-4 msg-from-peer">
              <div className="h-6 w-6 rounded-[4px] border border-[#ebebeb] bg-white text-[#171717] font-mono text-[10px] font-semibold flex items-center justify-center shrink-0">
                P
              </div>
              <div className="bg-white border border-[#ebebeb] rounded-[12px] rounded-bl-[2px] shadow-[0_1px_2px_rgba(0,0,0,0.02)] px-4 py-3 flex items-center gap-1">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
            </div>
          )}
        </div>

        {/* Input Area */}
        <footer className="p-3 sm:p-4 bg-white border-t border-[#ebebeb] shrink-0">
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
              disabled={status !== "connected"}
              className="p-2 text-[#8f8f8f] hover:text-[#171717] transition-colors rounded-[6px] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
              title="Attach files (multiple supported)"
            >
              <Paperclip size={18} />
            </button>
            <input
              type="text"
              value={text}
              onChange={handleTextChange}
              placeholder={
                status === "connected"
                  ? "Type an encrypted message..."
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
            </span>
            {/* Desktop: security tagline */}
            <p className="hidden sm:block font-mono text-[10px] text-[#8f8f8f] tracking-wide">
              DIRECT P2P // END-TO-END ENCRYPTED // ZERO LOGS
            </p>
          </div>
        </footer>
      </div>
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
}: {
  key?: React.Key;
  msg: Message;
  msgReactions?: Record<string, number>;
  onReact?: (emoji: string) => void;
}) {
  const isMe = msg.sender === "me";
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
      className={cn(
        "flex w-full items-end gap-2.5",
        isMe ? "justify-end msg-from-me" : "justify-start msg-from-peer"
      )}
    >
      {!isMe && (
        <div className="h-6 w-6 rounded-[4px] border border-[#ebebeb] bg-white text-[#171717] font-mono text-[10px] font-semibold flex items-center justify-center shrink-0">
          P
        </div>
      )}

      <div
        className={cn(
          "max-w-[85%] sm:max-w-[70%] flex flex-col",
          isMe ? "items-end" : "items-start"
        )}
      >
        {/* Bubble wrapper — relative so 😊 button can be absolutely positioned */}
        <div className="relative">
          <div
            className={cn(
              "relative group rounded-[12px] overflow-hidden text-sm leading-relaxed",
              isMe
                ? "bg-[#171717] text-white rounded-br-[2px]"
                : "bg-white border border-[#ebebeb] text-[#171717] rounded-bl-[2px] shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
            )}
          >
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
              <div className={cn(
                "flex items-center gap-3 p-2.5",
                isMe ? "text-white" : "text-[#171717]"
              )}>
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

          {/* 😊 Reaction trigger — absolute at bottom-right corner of bubble */}
          {onReact && (
            <div
              className={cn(
                "absolute -bottom-3 z-10",
                isMe ? "left-1" : "right-1"
              )}
              ref={pickerRef}
            >
              <button
                onClick={() => setShowPicker((v) => !v)}
                className={cn(
                  "p-1 rounded-full border transition-all cursor-pointer select-none text-sm leading-none shadow-sm",
                  showPicker
                    ? "bg-[#f5f5f5] border-[#171717]"
                    : "bg-white border-[#d0d0d0] hover:border-[#171717] hover:bg-[#f5f5f5]"
                )}
                title="Add reaction"
              >
                😊
              </button>
              {showPicker && (
                <div
                  className={cn(
                    "reaction-picker absolute z-20 bg-white border border-[#ebebeb] rounded-full shadow-lg px-2 py-1.5 flex items-center gap-1",
                    isMe ? "bottom-6 right-0" : "bottom-6 left-0"
                  )}
                >
                  {EMOJI_LIST.map((emoji) => (
                    <button
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
      </div>
    </div>
  );
}

// TypeScript augmentation for PWA install prompt
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
