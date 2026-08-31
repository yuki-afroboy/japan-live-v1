/**
 * How trustworthy is the data behind a moving thing.
 *
 * This is the most important type in JAPAN LIVE. It is assigned by the provider
 * adapter at the point data enters the system, and downstream code may only read it
 * or DEGRADE it (see `degradeDataMode`). Nothing may ever raise it.
 */
export type DataMode =
  /** A true observed coordinate (GPS or equivalent) was published by the provider. */
  | "REALTIME_POSITION"
  /** Realtime operational data (which stations a train is between, delay), but no coordinate. */
  | "REALTIME_TRIP"
  /** Realtime status only (delay, suspension). Position, if any, comes from elsewhere. */
  | "REALTIME_STATUS"
  /** Position computed from a timetable and a route shape. */
  | "SCHEDULE_INTERPOLATED"
  /** Generated inside this application. Not real. */
  | "SIMULATED"
  /** Replay of recorded past data. */
  | "HISTORICAL"
  /** No usable data. */
  | "UNAVAILABLE";

export const DATA_MODES: readonly DataMode[] = [
  "REALTIME_POSITION",
  "REALTIME_TRIP",
  "REALTIME_STATUS",
  "SCHEDULE_INTERPOLATED",
  "SIMULATED",
  "HISTORICAL",
  "UNAVAILABLE",
] as const;

/** Modes that came from a live feed. NOT the same as "has a real coordinate". */
const REALTIME_MODES = new Set<DataMode>([
  "REALTIME_POSITION",
  "REALTIME_TRIP",
  "REALTIME_STATUS",
]);

export function isRealtimeMode(mode: DataMode): boolean {
  return REALTIME_MODES.has(mode);
}

/**
 * True only for a mode backed by an actual published coordinate.
 *
 * Deliberately narrower than `isRealtimeMode`. REALTIME_TRIP is realtime data whose
 * on-screen position we interpolated ourselves; it is not a realtime position, and no
 * UI may describe it as one.
 */
export function isRealtimePosition(mode: DataMode): boolean {
  return mode === "REALTIME_POSITION";
}

/** Realtime modes require a source timestamp so staleness can be judged. */
export function requiresSourceTimestamp(mode: DataMode): boolean {
  return isRealtimeMode(mode);
}

/** How a coordinate on screen was actually produced. Separate from `DataMode` on purpose. */
export type PositionSource =
  /** The provider published this exact coordinate. */
  | "PROVIDER_REPORTED"
  /** Interpolated along the route shape between two realtime-reported stations. */
  | "INTERPOLATED_FROM_REALTIME_SEGMENT"
  /** Interpolated along the route shape from the timetable alone. */
  | "INTERPOLATED_FROM_SCHEDULE"
  /** Produced by the simulation engine. */
  | "SIMULATED"
  /** No position could be determined. */
  | "NONE";

/** Short, honest label for a badge. */
export function dataModeLabel(mode: DataMode): string {
  switch (mode) {
    case "REALTIME_POSITION":
      return "REALTIME POSITION";
    case "REALTIME_TRIP":
      return "REALTIME TRIP";
    case "REALTIME_STATUS":
      return "REALTIME STATUS";
    case "SCHEDULE_INTERPOLATED":
      return "SCHEDULE";
    case "SIMULATED":
      return "SIMULATED";
    case "HISTORICAL":
      return "HISTORICAL";
    case "UNAVAILABLE":
      return "UNAVAILABLE";
  }
}

/** One sentence a user can read in the Inspector. Says what the data is AND is not. */
export function dataModeDescription(mode: DataMode): string {
  switch (mode) {
    case "REALTIME_POSITION":
      return "実測位置。事業者が緯度経度を配信しています。";
    case "REALTIME_TRIP":
      return "リアルタイム運行情報。駅間は分かりますが緯度経度は配信されていないため、表示位置は路線形状上に補間したものです。";
    case "REALTIME_STATUS":
      return "リアルタイムの運行状況（遅延・運休）のみ。位置は時刻表から計算しています。";
    case "SCHEDULE_INTERPOLATED":
      return "時刻表から推定した位置です。リアルタイム位置ではありません。";
    case "SIMULATED":
      return "アプリ内で生成した模擬データです。実在の列車ではありません。";
    case "HISTORICAL":
      return "過去データの再生です。現在の状況ではありません。";
    case "UNAVAILABLE":
      return "データを取得できていません。";
  }
}

export function positionSourceDescription(source: PositionSource): string {
  switch (source) {
    case "PROVIDER_REPORTED":
      return "事業者が配信した座標";
    case "INTERPOLATED_FROM_REALTIME_SEGMENT":
      return "リアルタイム駅間情報から路線形状上に補間";
    case "INTERPOLATED_FROM_SCHEDULE":
      return "時刻表から路線形状上に補間";
    case "SIMULATED":
      return "シミュレーション生成";
    case "NONE":
      return "位置なし";
  }
}

/** Display colour per mode. Never the only signal — always paired with a text label. */
export function dataModeColor(mode: DataMode): string {
  switch (mode) {
    case "REALTIME_POSITION":
      return "#3ddc84";
    case "REALTIME_TRIP":
      return "#4ea8ff";
    case "REALTIME_STATUS":
      return "#7fd1ff";
    case "SCHEDULE_INTERPOLATED":
      return "#ffb454";
    case "SIMULATED":
      return "#c07cf0";
    case "HISTORICAL":
      return "#9aa4b2";
    case "UNAVAILABLE":
      return "#6b7280";
  }
}
