import type { DataMode } from "./data-mode.js";
import { isRealtimeMode } from "./data-mode.js";

/**
 * When realtime data stops arriving it must stop being presented as realtime.
 * These budgets are per provider and come from each feed's documented cadence.
 */
export interface FreshnessPolicy {
  /** Past this age the entity is shown as STALE but keeps its mode. */
  staleAfterMs: number;
  /** Past this age the realtime mode degrades to `degradeTo`. */
  degradeAfterMs: number;
  /** Past this age nothing is claimed at all. */
  unavailableAfterMs: number;
  /** What a degraded realtime entity becomes. */
  degradeTo: DataMode;
}

export const DEFAULT_FRESHNESS: FreshnessPolicy = {
  staleAfterMs: 90_000,
  degradeAfterMs: 300_000,
  unavailableAfterMs: 900_000,
  degradeTo: "SCHEDULE_INTERPOLATED",
};

export type FreshnessState = "FRESH" | "STALE" | "DEGRADED" | "UNAVAILABLE";

export interface FreshnessResult {
  state: FreshnessState;
  /** The mode after degradation. Equal to the input mode when still fresh or merely stale. */
  mode: DataMode;
  ageMs: number;
}

/**
 * Age a data mode. Only ever moves toward less confidence.
 *
 * Non-realtime modes are returned untouched: a timetable-derived or simulated position
 * does not become less true with age, it was never a live observation.
 */
export function evaluateFreshness(
  mode: DataMode,
  sourceTimestamp: number | undefined,
  now: number,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS,
): FreshnessResult {
  if (!isRealtimeMode(mode)) {
    return { state: "FRESH", mode, ageMs: 0 };
  }
  // A realtime claim without a timestamp cannot be verified, so it is not honoured.
  if (sourceTimestamp === undefined || !Number.isFinite(sourceTimestamp)) {
    return { state: "UNAVAILABLE", mode: "UNAVAILABLE", ageMs: Number.POSITIVE_INFINITY };
  }

  const ageMs = Math.max(0, now - sourceTimestamp);

  if (ageMs >= policy.unavailableAfterMs) {
    return { state: "UNAVAILABLE", mode: "UNAVAILABLE", ageMs };
  }
  if (ageMs >= policy.degradeAfterMs) {
    return { state: "DEGRADED", mode: policy.degradeTo, ageMs };
  }
  if (ageMs >= policy.staleAfterMs) {
    return { state: "STALE", mode, ageMs };
  }
  return { state: "FRESH", mode, ageMs };
}

/** "12秒前" / "3分前". Used verbatim in the Inspector. */
export function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return "不明";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  return `${h}時間${m % 60}分前`;
}
