import React, { useEffect, useState, useRef } from "react";
import { v4 as uuidv4 } from "uuid";
import { Link, MessageSquare, Send, Paperclip, FileText, Download, Check, Copy, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useWebRTC, type Message } from "./lib/useWebRTC";
import { cn } from "./lib/utils";
import { format } from "date-fns";

export default function App() {
  const [roomId, setRoomId] = useState<string | null>(null);
  const [joinInput, setJoinInput] = useState("");
  const [joinError, setJoinError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const room = params.get("room")?.trim();
    if (room) {
      setRoomId(room);
    }
  }, []);

  const handleCreateRoom = () => {
    const newRoom = uuidv4().slice(0, 8);
    window.history.pushState({}, "", `?room=${newRoom}`);
    setRoomId(newRoom);
  };

  const handleJoinRoom = () => {
    const room = joinInput.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!room) {
      setJoinError("Please enter a valid Room ID.");
      return;
    }
    window.history.pushState({}, "", `?room=${room}`);
    setRoomId(room);
  };

  const handleJoinKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleJoinRoom();
  };

  if (!roomId) {
    return (
      <div className="h-[100dvh] max-h-[100dvh] w-screen bg-[#f8fafc] text-[#1e293b] font-sans flex items-center justify-center p-4 overflow-hidden">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-slate-200 p-8 space-y-6">
          {/* Header */}
          <div className="text-center space-y-3">
            <div className="w-16 h-16 bg-indigo-100 text-indigo-700 rounded-2xl flex items-center justify-center mx-auto font-bold">
              <MessageSquare size={32} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-indigo-600">Secure P2P Chat</h1>
            <p className="text-slate-500 text-sm">
              End-to-end encrypted direct connection via WebRTC. Zero server message logging.
            </p>
          </div>

          {/* Create new room */}
          <button
            id="start-chat-btn"
            onClick={handleCreateRoom}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl py-3.5 px-4 font-semibold transition-colors shadow-lg shadow-indigo-200 cursor-pointer"
          >
            + Start New Chat
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-slate-200" />
            <span className="text-xs text-slate-400 font-medium">or join existing room</span>
            <div className="flex-1 h-px bg-slate-200" />
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
                placeholder="Enter Room ID (e.g. 4cb52e14)"
                className="flex-1 border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition-all"
              />
              <button
                id="join-room-btn"
                onClick={handleJoinRoom}
                className="px-4 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-sm font-semibold transition-colors cursor-pointer shrink-0"
              >
                Join
              </button>
            </div>
            {joinError && (
              <p className="text-xs text-rose-500 px-1">{joinError}</p>
            )}
          </div>

          {/* Footer note */}
          <p className="text-center text-[11px] text-slate-400">
            Share your Room ID with a friend so they can join directly.
          </p>
        </div>
      </div>
    );
  }

  return <ChatRoom roomId={roomId} />;
}

function ChatRoom({ roomId }: { roomId: string }) {
  const { status, peerCount, messages, sendMessage, sendFile, retryConnection } = useWebRTC(roomId);
  const [text, setText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && status === "connected") {
      sendFile(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const currentUrl = typeof window !== "undefined" ? window.location.href : "";

  return (
    <div className="h-[100dvh] max-h-[100dvh] w-screen bg-[#f8fafc] text-[#1e293b] font-sans flex flex-col md:p-6 p-0 overflow-hidden">
      <div className="flex-1 w-full max-w-4xl mx-auto bg-white md:rounded-2xl shadow-sm border border-slate-200 flex flex-col min-h-0 overflow-hidden">
        
        {/* Header */}
        <header className="h-16 border-b border-slate-200 flex items-center justify-between px-4 sm:px-6 shadow-sm z-10 shrink-0 bg-white">
          <div className="flex items-center gap-3 sm:gap-4">
            <div className="h-10 w-10 bg-indigo-100 rounded-full flex items-center justify-center text-indigo-700 font-bold shrink-0">
              <MessageSquare size={20} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-slate-800 leading-none text-sm sm:text-base">Room: {roomId}</h2>
                <span className="text-[10px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <Users size={10} /> {peerCount} {peerCount === 1 ? "user" : "users"}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mt-1">
                <span className={cn("w-2 h-2 rounded-full", {
                  "bg-amber-400 animate-pulse": status === "connecting" || status === "waiting",
                  "bg-green-500": status === "connected",
                  "bg-rose-500": status === "disconnected"
                })} />
                <span className="text-[10px] text-slate-500 font-medium uppercase tracking-tighter">
                  {status === "connected" && "Connected (Relay Active)"}
                  {status === "waiting" && "Waiting for peer..."}
                  {status === "connecting" && "Connecting..."}
                  {status === "disconnected" && "Disconnected"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden md:flex items-center px-3 py-1 bg-sky-50 text-sky-700 border border-sky-100 rounded-full text-[10px] font-bold">
              <ShieldCheck size={12} className="mr-1" /> CLOUDFLARE EDGE RELAY
            </div>

            {(status === "disconnected" || status === "connecting") && (
              <button
                onClick={retryConnection}
                title="Reconnect"
                className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 rounded-lg transition-colors border border-slate-200 text-xs flex items-center gap-1"
              >
                <RefreshCw size={14} className={cn({ "animate-spin": status === "connecting" })} />
                <span className="hidden sm:inline">Retry</span>
              </button>
            )}

            <button
              onClick={handleCopyLink}
              className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-slate-100 rounded-lg text-slate-600 text-xs sm:text-sm font-medium transition-colors border border-slate-200"
            >
              {copied ? <Check size={14} className="text-emerald-500" /> : <Link size={14} />}
              <span>{copied ? "Copied" : "Copy Link"}</span>
            </button>
          </div>
        </header>

        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto min-h-0 p-4 sm:p-6 bg-slate-50/50" ref={scrollRef}>
          {status !== "connected" && messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-sm mx-auto space-y-5 my-auto py-8">
              <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex flex-col items-center">
                <QRCodeSVG value={currentUrl} size={180} level="M" className="text-slate-900" />
                <p className="text-[11px] text-slate-400 mt-3">Scan with another phone or camera</p>
              </div>

              <div className="space-y-2">
                <h3 className="text-lg font-semibold text-slate-800">
                  {status === "waiting" && "Scan or Share Link"}
                  {status === "connecting" && "Connecting..."}
                  {status === "disconnected" && "Peer Disconnected"}
                </h3>
                <p className="text-xs sm:text-sm text-slate-500 leading-relaxed">
                  {status === "waiting" && "Share this QR code or room link with another device. Chat starts instantly once they join."}
                  {status === "connecting" && "Connecting to relay server. Please wait a moment..."}
                  {status === "disconnected" && "Your chat partner left the room. Share the link again to invite someone new."}
                </p>
              </div>

              {status === "disconnected" ? (
                <button
                  onClick={retryConnection}
                  className="px-4 py-2 bg-indigo-600 text-white text-xs font-medium rounded-xl hover:bg-indigo-700 shadow-md shadow-indigo-200 flex items-center gap-1.5"
                >
                  <RefreshCw size={14} /> Reconnect
                </button>
              ) : (
                <button
                  onClick={handleCopyLink}
                  className="px-4 py-2 bg-white text-slate-700 text-xs font-medium rounded-xl hover:bg-slate-50 border border-slate-200 shadow-sm flex items-center gap-1.5"
                >
                  {copied ? <Check size={14} className="text-emerald-500" /> : <Link size={14} />}
                  <span>{copied ? "Link Copied to Clipboard!" : "Copy Direct Room Link"}</span>
                </button>
              )}
            </div>
          )}

          <div className="space-y-4">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
          </div>
        </div>

        {/* Input Area */}
        <footer className="p-3 sm:p-4 bg-white border-t border-slate-200 shrink-0">
          <form onSubmit={handleSend} className="flex items-center gap-2 sm:gap-3 bg-slate-50 rounded-2xl px-3 sm:px-4 py-2 ring-1 ring-slate-200">
            <input
              type="file"
              className="hidden"
              ref={fileInputRef}
              onChange={handleFileChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={status !== "connected"}
              className="p-2 text-slate-400 hover:text-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Share file"
            >
              <Paperclip size={20} />
            </button>
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                status === "connected" 
                  ? "Type a secure message..." 
                  : status === "negotiating"
                  ? "Handshaking encrypted tunnel..."
                  : "Waiting for peer to connect..."
              }
              disabled={status !== "connected"}
              className="flex-1 bg-transparent border-none focus:ring-0 text-sm outline-none px-2 text-slate-900 placeholder:text-slate-400 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!text.trim() || status !== "connected"}
              className="bg-indigo-600 p-2.5 rounded-xl text-white shadow-lg shadow-indigo-200 transition-transform active:scale-95 disabled:opacity-40 disabled:shadow-none hover:bg-indigo-700 disabled:cursor-not-allowed"
            >
              <Send size={18} className="ml-0.5" />
            </button>
          </form>
          <div className="flex justify-center mt-2.5">
            <p className="text-[10px] text-slate-400">
              Direct P2P DataChannel • Encrypted locally before transit • No server relays
            </p>
          </div>
        </footer>

      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message; key?: string }) {
  const isMe = msg.sender === "me";
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!msg.content) return;
    navigator.clipboard.writeText(msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={cn("flex w-full items-end gap-2 sm:gap-3", isMe ? "justify-end" : "justify-start")}>
      {!isMe && (
        <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold shrink-0 text-xs">
          P
        </div>
      )}
      
      <div className={cn(
        "max-w-[85%] sm:max-w-[70%] flex flex-col",
        isMe ? "items-end" : "items-start"
      )}>
        <div className={cn(
          "p-3.5 sm:p-4 rounded-2xl relative group",
          isMe 
            ? "bg-indigo-600 text-white rounded-br-none shadow-md" 
            : "bg-white border border-slate-100 text-slate-700 rounded-bl-none shadow-sm"
        )}>
          {msg.type === "text" ? (
            <div className="flex items-start gap-2">
              <p className="text-sm whitespace-pre-wrap break-words flex-1">{msg.content}</p>
              <button
                onClick={handleCopy}
                title="Copy text message"
                aria-label="Copy text message"
                className={cn(
                  "p-1 rounded-md transition-all shrink-0 cursor-pointer",
                  isMe
                    ? "text-indigo-200 hover:text-white hover:bg-indigo-500/50"
                    : "text-slate-400 hover:text-slate-700 hover:bg-slate-100",
                  copied ? "opacity-100" : "opacity-0 group-hover:opacity-100 max-sm:opacity-60"
                )}
              >
                {copied ? (
                  <Check size={13} className={isMe ? "text-indigo-100" : "text-emerald-500"} />
                ) : (
                  <Copy size={13} />
                )}
              </button>
            </div>
          ) : (
            <div className={cn(
              "flex items-center gap-3 sm:gap-4 p-3 rounded-xl border",
              isMe ? "bg-indigo-500/50 border-indigo-400/50" : "bg-slate-50 border-slate-200"
            )}>
              <div className={cn(
                "h-10 w-10 sm:h-12 sm:w-12 rounded-lg border flex items-center justify-center shrink-0",
                isMe ? "bg-indigo-500 border-indigo-400 text-white" : "bg-white border-slate-200 text-indigo-600"
              )}>
                <FileText size={20} />
              </div>
              <div className="overflow-hidden pr-2">
                <p className={cn("text-xs sm:text-sm font-semibold truncate max-w-[120px] sm:max-w-[180px]", isMe ? "text-white" : "text-slate-800")}>
                  {msg.content}
                </p>
                <p className={cn("text-[10px] uppercase mt-0.5", isMe ? "text-indigo-200" : "text-slate-500")}>
                  {isMe ? "Sent" : "Received"}
                </p>
              </div>
              {msg.fileUrl && (
                <a 
                  href={msg.fileUrl} 
                  download={msg.content}
                  className={cn(
                    "ml-auto px-2.5 sm:px-3 py-1 rounded-lg text-xs font-medium flex items-center gap-1 shrink-0",
                    isMe ? "bg-white text-indigo-600 hover:bg-indigo-50" : "bg-indigo-600 text-white hover:bg-indigo-700"
                  )}
                >
                  <Download size={13} />
                </a>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 mt-1 px-1">
          <span className="text-[10px] text-slate-400">
            {format(msg.timestamp, "HH:mm a")}
          </span>
          {msg.type === "text" && copied && (
            <span className="text-[10px] text-emerald-600 font-medium flex items-center gap-0.5">
              <Check size={10} /> Copied!
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
