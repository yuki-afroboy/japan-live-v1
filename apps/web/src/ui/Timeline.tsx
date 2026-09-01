import { useCallback } from "react";
import { formatServiceTime } from "@japan-live/core";
import { SPEEDS, type Speed } from "@japan-live/simulation";

interface Props {
  mode: "LIVE" | "SIMULATION";
  speed: Speed;
  paused: boolean;
  /** Service-day seconds of the displayed instant. May exceed 86400. */
  serviceSeconds: number;
  onSpeed: (speed: Speed) => void;
  onLive: () => void;
  onSeek: (seconds: number) => void;
  onPause: (paused: boolean) => void;
}

/** 04:00 through 26:00 — a full service day, including the post-midnight tail (spec §26). */
const START = 4 * 3600;
const END = 26 * 3600;
const TICKS = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26];

export function Timeline({
  mode,
  speed,
  paused,
  serviceSeconds,
  onSpeed,
  onLive,
  onSeek,
  onPause,
}: Props) {
  const isSim = mode === "SIMULATION";
  const clamped = Math.min(END, Math.max(START, serviceSeconds));
  const progress = ((clamped - START) / (END - START)) * 100;

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => onSeek(Number(e.target.value)),
    [onSeek],
  );

  return (
    <div className="panel timeline">
      <div className="timeline-top">
        <div className="speed-group" role="group" aria-label="時間速度">
          <button
            className="speed-btn live"
            data-active={mode === "LIVE"}
            onClick={onLive}
            aria-pressed={mode === "LIVE"}
          >
            LIVE
          </button>
          {SPEEDS.map((s) => (
            <button
              key={s}
              className="speed-btn"
              data-active={isSim && speed === s}
              aria-pressed={isSim && speed === s}
              onClick={() => onSpeed(s)}
            >
              ×{s}
            </button>
          ))}
        </div>

        {isSim && (
          <button className="speed-btn" onClick={() => onPause(!paused)} aria-pressed={paused}>
            {paused ? "▶ 再生" : "❚❚ 一時停止"}
          </button>
        )}

        <span className="timeline-hint">
          {isSim
            ? "SIMULATION — ドラッグで時刻を変更できます"
            : "LIVE — 現在時刻です。ドラッグするには速度を変更してください"}
        </span>
      </div>

      <div className="track">
        <div className="track-line">
          <div className="track-fill" style={{ width: `${progress}%` }} />
        </div>
        <input
          type="range"
          min={START}
          max={END}
          step={60}
          value={clamped}
          disabled={!isSim}
          onChange={handleSeek}
          aria-label="時刻"
          aria-valuetext={formatServiceTime(clamped)}
        />
      </div>

      <div className="track-ticks" aria-hidden="true">
        {TICKS.map((h) => (
          <span key={h}>{String(h).padStart(2, "0")}</span>
        ))}
      </div>
    </div>
  );
}
