/**
 * The subset of ODPT's data model JAPAN LIVE reads.
 *
 * Every field is optional because a feed may omit any of them, and a missing field
 * must become `undefined` — never a default that looks like data.
 */

/** `odpt:Train` — realtime train location. Note: there is NO latitude or longitude. */
export interface OdptTrain {
  "@id"?: string;
  "@type"?: string;
  "dc:date"?: string;
  "dct:valid"?: string;
  "odpt:operator"?: string;
  "odpt:railway"?: string;
  "odpt:trainNumber"?: string;
  "odpt:trainType"?: string;
  "odpt:railDirection"?: string;
  /** Station the train is at, or has departed from. */
  "odpt:fromStation"?: string;
  /** Station it is heading to. Absent when the train is standing at `fromStation`. */
  "odpt:toStation"?: string;
  /** Seconds. Absent means "not reported", which is not the same as no delay. */
  "odpt:delay"?: number;
  "odpt:carComposition"?: number;
  "odpt:destinationStation"?: string[] | string;
  "odpt:trainOwner"?: string;
}

/** `odpt:TrainInformation` — service status (delays, suspensions). */
export interface OdptTrainInformation {
  "@id"?: string;
  "dc:date"?: string;
  "odpt:operator"?: string;
  "odpt:railway"?: string;
  "odpt:timeOfOrigin"?: string;
  "odpt:trainInformationText"?: string | { ja?: string; en?: string };
  "odpt:trainInformationStatus"?: string | { ja?: string; en?: string };
}

export interface OdptStation {
  "@id"?: string;
  "owl:sameAs"?: string;
  "dc:title"?: string;
  "odpt:stationTitle"?: { ja?: string; en?: string };
  "odpt:railway"?: string;
  "odpt:operator"?: string;
  "geo:lat"?: number;
  "geo:long"?: number;
  "odpt:stationCode"?: string;
}

/** Pull the display text out of ODPT's sometimes-multilingual fields. */
export function odptText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    const o = value as { ja?: string; en?: string };
    return (o.ja ?? o.en)?.trim() || undefined;
  }
  return undefined;
}

/** `odpt.Station:Toei.Oedo.Roppongi` -> `Roppongi`. Returns undefined for junk. */
export function odptLocalName(uri: unknown): string | undefined {
  if (typeof uri !== "string" || !uri) return undefined;
  const parts = uri.split(".");
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : undefined;
}

/** ISO-8601 -> epoch ms. Returns undefined rather than NaN or "now". */
export function odptDate(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
