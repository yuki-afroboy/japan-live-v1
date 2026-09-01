import { useState } from "react";
import type { LayerToggles } from "../state/app-store.js";
import type { SceneHealth } from "../scene/viewer.js";

interface Props {
  layers: LayerToggles;
  health: SceneHealth;
  onToggle: <K extends keyof LayerToggles>(key: K, value: boolean) => void;
}

interface RowSpec {
  key: keyof LayerToggles;
  label: string;
  future?: false;
}

const ROWS: RowSpec[] = [
  { key: "terrain", label: "地形 Terrain" },
  { key: "buildings", label: "3D建物 Buildings" },
  { key: "railways", label: "鉄道路線 Railways" },
  { key: "stations", label: "駅 Stations" },
  { key: "trains", label: "列車 Trains" },
  { key: "xray", label: "地下鉄 X-RAY" },
];

/** Layers planned for later versions, shown greyed so the roadmap is visible (spec §53). */
const FUTURE = ["バス Bus", "飛行機 Flight", "船 Ferry", "天気 Weather", "交通量 Traffic", "人流 People"];

export function LayerPanel({ layers, health, onToggle }: Props) {
  // Collapsed by default. Six controls that do nothing in V1 were taking up roughly
  // half the panel's height, pushing the PLATEAU diagnostics — the thing someone is
  // actually looking for when buildings are missing — below the fold on a phone.
  const [futureOpen, setFutureOpen] = useState(false);

  return (
    <section className="panel" aria-label="レイヤー">
      <div className="panel-head">
        <span>LAYERS</span>
      </div>
      <div className="panel-body">
        {ROWS.map((row) => {
          const unavailable =
            (row.key === "terrain" && health.terrain === "unavailable") ||
            (row.key === "buildings" && health.buildings === "unavailable");
          return (
            <div key={row.key} className={`toggle-row${unavailable ? " disabled" : ""}`}>
              <div>
                <div>{row.label}</div>
                {unavailable && <div className="hint">利用できません</div>}
              </div>
              <button
                className="switch"
                data-on={layers[row.key]}
                aria-pressed={layers[row.key]}
                aria-label={row.label}
                disabled={unavailable}
                onClick={() => onToggle(row.key, !layers[row.key])}
              />
            </div>
          );
        })}

        {layers.xray && (
          <div className="xray-note">
            <strong>地下鉄 X-RAY</strong>
            <br />
            地下の路線・列車を地表へ投影して表示しています。実際の高度ではありません。
          </div>
        )}

        <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--panel-border)" }}>
          <button
            className="diag-toggle"
            onClick={() => setFutureOpen((v) => !v)}
            aria-expanded={futureOpen}
          >
            {futureOpen ? "▾" : "▸"} V2以降で追加予定（{FUTURE.length}件）
          </button>
          {futureOpen &&
            FUTURE.map((f) => (
              <div key={f} className="toggle-row disabled">
                <div>{f}</div>
                <button className="switch" data-on={false} disabled aria-label={f} />
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}
