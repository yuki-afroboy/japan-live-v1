import type { MobilityEntity } from "@japan-live/shared";
import {
  dataModeColor,
  dataModeDescription,
  dataModeLabel,
  formatAge,
  isRealtimeMode,
  positionSourceDescription,
} from "@japan-live/shared";

interface Props {
  entity: MobilityEntity;
  now: number;
  following: boolean;
  onFollow: () => void;
  onStopFollow: () => void;
  onClose: () => void;
}

/** Renders a value, or an explicit "unknown" — never a plausible-looking default. */
function Field({ label, value }: { label: string; value?: string | number }) {
  const empty = value === undefined || value === "" || value === null;
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd className={empty ? "unknown" : undefined}>{empty ? "不明" : String(value)}</dd>
    </div>
  );
}

/**
 * The train Inspector (spec §28).
 *
 * Two rules: nothing is shown that was not in the data, and the DataMode block states
 * both what the data is and how the position on screen was produced.
 */
export function Inspector({ entity, now, following, onFollow, onStopFollow, onClose }: Props) {
  const d = entity.details ?? {};
  const color = dataModeColor(entity.dataMode);
  const age = entity.sourceTimestamp !== undefined ? now - entity.sourceTimestamp : undefined;

  const delay =
    d.delaySeconds === undefined
      ? undefined
      : d.delaySeconds === 0
        ? "定刻"
        : `${Math.round(d.delaySeconds / 60)}分 (${d.delaySeconds}秒)`;

  return (
    <aside className="panel inspector" aria-label="列車情報">
      <header className="inspector-head">
        <div className="inspector-line">
          <span className="line-swatch" style={{ background: d.lineColor ?? "#7fd1ff" }} />
          <span>{d.railwayName ?? "路線不明"}</span>
        </div>
        <div className="inspector-sub">
          {d.operatorName ?? "事業者不明"}
          {d.trainNumber ? ` · 列車 ${d.trainNumber}` : ""}
        </div>
      </header>

      <div className="inspector-body">
        <div className="segment">
          <span>{d.fromStation ?? "不明"}</span>
          {d.atStation ? (
            <span className="arrow">停車中</span>
          ) : (
            <>
              <span className="arrow">→</span>
              <span>{d.toStation ?? "不明"}</span>
            </>
          )}
        </div>
        {!d.atStation && d.segmentProgress !== undefined && (
          <div className="segment-bar">
            <div style={{ width: `${Math.round(d.segmentProgress * 100)}%` }} />
          </div>
        )}

        <dl style={{ margin: "8px 0 0" }}>
          <Field label="種別" value={d.trainType} />
          <Field label="行先" value={d.destination} />
          <Field label="次駅" value={d.atStation ? d.toStation : d.toStation} />
          <Field label="遅延" value={delay} />
          <Field label="編成" value={d.carComposition ? `${d.carComposition}両` : undefined} />
          <Field
            label="速度"
            value={entity.speed !== undefined ? `${Math.round(entity.speed * 3.6)} km/h` : undefined}
          />
        </dl>

        {/* The honesty block. Never collapsed, never abbreviated. */}
        <div className="mode-block" style={{ color }}>
          <div className="mode-title">{dataModeLabel(entity.dataMode)}</div>
          <div className="mode-desc">{dataModeDescription(entity.dataMode)}</div>
          <div className="mode-meta">
            表示位置: {positionSourceDescription(entity.positionSource)}
            <br />
            {isRealtimeMode(entity.dataMode)
              ? `データ最終更新: ${age !== undefined ? formatAge(age) : "不明"}`
              : "リアルタイム観測ではありません"}
          </div>
        </div>
      </div>

      <div className="inspector-actions">
        {following ? (
          <button className="btn active" onClick={onStopFollow}>
            追跡を解除
          </button>
        ) : (
          <button className="btn primary" onClick={onFollow}>
            追跡 FOLLOW
          </button>
        )}
        <button className="btn" onClick={onClose} style={{ flex: "0 0 auto" }}>
          閉じる
        </button>
      </div>
    </aside>
  );
}
