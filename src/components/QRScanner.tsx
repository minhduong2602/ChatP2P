import React, { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { X, Camera } from "lucide-react";

interface QRScannerProps {
  onScan: (roomId: string) => void;
  onClose: () => void;
}

export function QRScanner({ onScan, onClose }: QRScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string>("");
  const [scanning, setScanning] = useState(false);
  const animFrameRef = useRef<number>(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    startCamera();
    return () => {
      mountedRef.current = false;
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 640 } },
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setScanning(true);
        animFrameRef.current = requestAnimationFrame(scanFrame);
      }
    } catch {
      if (mountedRef.current) {
        setError("Camera access denied. Please allow camera permission and try again.");
      }
    }
  };

  const stopCamera = () => {
    cancelAnimationFrame(animFrameRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const scanFrame = () => {
    if (!mountedRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < video.HAVE_ENOUGH_DATA) {
      animFrameRef.current = requestAnimationFrame(scanFrame);
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "dontInvert",
    });

    if (code?.data) {
      try {
        const url = new URL(code.data);
        const roomId = url.searchParams.get("room");
        if (roomId) {
          stopCamera();
          onScan(roomId.trim().toLowerCase().replace(/[^a-z0-9-]/g, ""));
          return;
        }
      } catch {
        // Not a URL — try as raw Room ID
        const raw = code.data.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (raw.length >= 4) {
          stopCamera();
          onScan(raw);
          return;
        }
      }
    }

    animFrameRef.current = requestAnimationFrame(scanFrame);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-[12px] border border-[#ebebeb] shadow-2xl overflow-hidden max-w-sm w-full">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#ebebeb]">
          <div className="flex items-center gap-2">
            <Camera size={15} className="text-[#171717]" />
            <span className="font-mono text-[11px] font-medium text-[#171717] uppercase tracking-wider">
              Scan Room QR Code
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-[#8f8f8f] hover:text-[#171717] transition-colors cursor-pointer p-1 rounded-[4px] hover:bg-[#fafafa]"
          >
            <X size={15} />
          </button>
        </div>

        {/* Camera viewport */}
        <div className="relative bg-black" style={{ aspectRatio: "1/1" }}>
          {error ? (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
              <p className="text-white/80 text-sm leading-relaxed">{error}</p>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                className="w-full h-full object-cover"
                playsInline
                muted
              />
              {/* Scanning frame overlay */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="relative w-52 h-52">
                  {/* Corner markers */}
                  <span className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-white rounded-tl-[4px]" />
                  <span className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-white rounded-tr-[4px]" />
                  <span className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-white rounded-bl-[4px]" />
                  <span className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-white rounded-br-[4px]" />
                  {/* Animated scan line */}
                  <span className="scanner-line" />
                </div>
              </div>
            </>
          )}
        </div>
        <canvas ref={canvasRef} className="hidden" />

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[#ebebeb]">
          <p className="font-mono text-[10px] text-[#8f8f8f] uppercase tracking-wider text-center">
            {error
              ? "CAMERA UNAVAILABLE"
              : scanning
              ? "SCANNING FOR QR CODE..."
              : "INITIALIZING CAMERA..."}
          </p>
        </div>
      </div>
    </div>
  );
}
