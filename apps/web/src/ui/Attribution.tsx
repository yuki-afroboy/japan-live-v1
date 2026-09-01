import { useState } from "react";
import type { Attribution as AttributionType } from "@japan-live/shared";

interface Props {
  attributions: AttributionType[];
  datasetNote?: string;
}

/**
 * Required credit (spec §63).
 *
 * Always visible — licences that require attribution are not satisfied by a credit
 * hidden behind a button. The expanded view adds licence names and the demo-data notice.
 */
export function AttributionBar({ attributions, datasetNote }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="attribution">
      {open ? (
        <div className="panel" style={{ padding: "9px 11px", textAlign: "left" }}>
          <div style={{ fontWeight: 700, marginBottom: 5, letterSpacing: "0.1em" }}>
            データ出典 / ATTRIBUTION
          </div>
          {attributions.map((a) => (
            <div key={a.text} style={{ marginBottom: 3 }}>
              {a.url ? (
                <a href={a.url} target="_blank" rel="noreferrer noopener">
                  {a.text}
                </a>
              ) : (
                a.text
              )}
              {a.license ? ` (${a.license})` : ""}
            </div>
          ))}
          {datasetNote && (
            <div style={{ marginTop: 6, color: "#dcc4f5", lineHeight: 1.5 }}>{datasetNote}</div>
          )}
          <button
            onClick={() => setOpen(false)}
            style={{ background: "none", border: "none", padding: "5px 0 0", color: "var(--accent)" }}
          >
            閉じる
          </button>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          style={{ background: "none", border: "none", padding: 0, textAlign: "right", color: "inherit", font: "inherit" }}
        >
          {attributions.slice(0, 2).map((a) => a.text).join(" / ")}
          {attributions.length > 2 ? ` 他${attributions.length - 2}件` : ""} ⓘ
        </button>
      )}
    </div>
  );
}
