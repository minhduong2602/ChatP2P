import { useEffect, useRef, useCallback } from "react";

/**
 * useNotification — plays a subtle sound and updates the document title
 * with an unread badge when the tab is not focused.
 */
export function useNotification() {
  const originalTitle = useRef(typeof document !== "undefined" ? document.title : "ChatP2P");
  const unreadCount = useRef(0);
  const isHidden = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const handleVisibility = () => {
      isHidden.current = document.hidden;
      if (!document.hidden) {
        // Reset badge when user returns to tab
        unreadCount.current = 0;
        document.title = originalTitle.current;
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  /** Play a soft notification chime via Web Audio API */
  const playSound = useCallback(() => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume();

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.15);

      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
    } catch {
      // AudioContext may not be available in all environments
    }
  }, []);

  /**
   * Call this when a new message arrives.
   * Only plays sound and updates badge if the tab is hidden.
   */
  const notify = useCallback(() => {
    if (isHidden.current) {
      unreadCount.current += 1;
      document.title = `(${unreadCount.current}) ${originalTitle.current}`;
      playSound();
    }
  }, [playSound]);

  return { notify };
}
