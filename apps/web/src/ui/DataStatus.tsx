import type { ProviderState } from "@japan-live/providers";
import { dataModeLabel, formatAge } from "@japan-live/shared";
import type { SceneHealth } from "../scene/viewer.js";

interface Props {
  providers: ProviderState[];
  health: SceneHealth;
  dataset?: { name: string; approximate: boolean; note?: string };
  now: number;
}

/**
 * Data Status (spec §54).
 *
 * "これは非常に重要です" — this panel is where the product proves it is not
 * overstating anything. Every provider, its real status, and why, at all times.
 */
export function DataStatus({ providers, health, dataset, now }: Props) {
  const layerIssues = (
    [
      ["terrain", "地形"],
      ["basemap", "地図"],
      ["buildings", "建物"],
    ] as const
  ).filter(([key]) => health[key] === "unavailable");

  return (
    <section className="panel" aria-label="データ状態">
      <div className="panel-head">
        <span>DATA</span>
      </div>
      <div className="panel-body">
        {providers.length === 0 && <div className="data-sub">プロバイダを初期化中…</div>}

        {providers.map((p) => {
          const age =
            p.lastSourceTimestamp !== undefined ? formatAge(now - p.lastSourceTimestamp) : undefined;
          return (
            <div key={p.id} className="data-row">
              <div>
                <div className="data-name">{p.name}</div>
                <div className="data-sub">
                  {p.status === "DISABLED"
                    ? p.disabledReason
                    : p.status === "ERROR"
                      ? `取得できません（${p.error ?? "不明なエラー"}）`
                      : `${dataModeLabel(p.effectiveDataMode)} · ${p.entityCount}本${
                          age ? ` · ${age}` : ""
                        }`}
                </div>
              </div>
              <span className={`status-chip ${p.status}`}>{p.status}</span>
            </div>
          );
        })}

        {dataset && (
          <div className="data-row">
            <div>
              <div className="data-name">路線データ</div>
              <div className="data-sub">{dataset.name}</div>
            </div>
            <span className={`status-chip ${dataset.approximate ? "DEMO" : "SCHEDULE"}`}>
              {dataset.approximate ? "概算" : "実データ"}
            </span>
          </div>
        )}

        {layerIssues.map(([key, label]) => (
          <div key={key} className="data-row">
            <div>
              <div className="data-name">{label}</div>
              <div className="data-sub">{health.notes[key] ?? "利用できません"}</div>
            </div>
            <span className="status-chip ERROR">OFF</span>
          </div>
        ))}
      </div>
    </section>
  );
}
