import { useState } from "react";
import type { BuildingDiagnostics as Diagnostics } from "../scene/buildings.js";

interface Props {
  diagnostics?: Diagnostics;
}

const STATUS_LABEL: Record<Diagnostics["status"], string> = {
  IDLE: "待機中",
  LOADING: "読み込み中",
  OK: "表示中",
  PARTIAL: "一部のみ",
  ERROR: "エラー",
  DISABLED: "無効",
};

const SOURCE_LABEL: Record<Diagnostics["source"], string> = {
  "manifest-catalog": "Manifest (公式カタログ取得済)",
  "manifest-pattern": "Manifest (公式URL規則から生成)",
  none: "なし",
};

function fmtAltitude(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/**
 * Why are there / aren't there buildings?
 *
 * V1 gave the user no way to answer that: buildings were simply absent. This panel
 * reports the whole chain — where the URLs came from, which wards loaded, what the
 * camera is doing, and every failed request with its HTTP status.
 */
export function BuildingDiagnosticsPanel({ diagnostics }: Props) {
  const [open, setOpen] = useState(false);

  if (!diagnostics) {
    return (
      <section className="panel" aria-label="3D建物">
        <div className="panel-head"><span>PLATEAU BUILDINGS</span></div>
        <div className="panel-body">
          <div className="data-sub">初期化中…</div>
        </div>
      </section>
    );
  }

  const d = diagnostics;
  const failures = d.attempts.filter((a) => !a.ok);

  return (
    <section className="panel" aria-label="3D建物">
      <div className="panel-head">
        <span>PLATEAU BUILDINGS</span>
        <span className={`status-chip ${d.status === "OK" ? "LIVE" : d.status === "PARTIAL" ? "SCHEDULE" : d.status === "LOADING" ? "SCHEDULE" : d.status === "DISABLED" ? "DISABLED" : d.status === "IDLE" ? "DISABLED" : "ERROR"}`}>
          {d.status}
        </span>
      </div>
      <div className="panel-body">
        <dl className="diag">
          <dt>状態</dt><dd>{STATUS_LABEL[d.status]}</dd>
          <dt>取得元</dt><dd>{SOURCE_LABEL[d.source]}</dd>
          <dt>読込済</dt>
          <dd>
            {d.wardsLoaded} / {d.wardsTotal} 区
            {d.wardsFailed > 0 && <span className="diag-bad"> （失敗 {d.wardsFailed}）</span>}
          </dd>
          <dt>タイルセット</dt><dd>{d.tilesetsLoaded}</dd>
          <dt>表示</dt>
          <dd className={d.visible ? "diag-good" : "diag-bad"}>{d.visible ? "YES" : "NO"}</dd>
          <dt>カメラ高度</dt><dd>{fmtAltitude(d.cameraAltitude)}</dd>
          <dt>LOD</dt><dd>{d.lod}</dd>
          <dt>データ年度</dt><dd>{d.dataYears}</dd>
        </dl>

        {d.loadedWardNames.length > 0 && (
          <div className="data-sub" style={{ marginTop: 5 }}>
            {d.loadedWardNames.join("・")}
          </div>
        )}

        {!d.visible && d.status === "IDLE" && d.cameraAltitude > 12_000 && (
          <div className="diag-hint">
            カメラが高すぎます。建物は高度12km以下で読み込まれます。
            「東京」または「CITY VIEW」を押してください。
          </div>
        )}

        {d.manifestError && (
          <div className="diag-hint diag-error">Manifest: {d.manifestError}</div>
        )}
        {d.source === "manifest-pattern" && (
          <div className="diag-hint">
            URLは国土交通省が公開する複合エンドポイントの規則から生成しています。
            <code>npm run data:plateau</code> をネットワーク接続環境で実行すると
            公式カタログの実URLに置き換わります。
          </div>
        )}
        {d.lastError && !d.manifestError && (
          <div className="diag-hint diag-error">直近のエラー: {d.lastError}</div>
        )}

        {d.attempts.length > 0 && (
          <>
            <button className="diag-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {open ? "▾" : "▸"} 詳細ログ（{d.attempts.length}件{failures.length > 0 ? `・失敗 ${failures.length}` : ""}）
            </button>
            {open && (
              <div className="diag-log">
                {d.attempts.map((a, i) => (
                  <div key={`${a.url}-${i}`} className={a.ok ? "diag-good" : "diag-bad"}>
                    <div>
                      {a.ok ? "OK " : "NG "}
                      {a.ward}
                      {a.httpStatus ? ` HTTP ${a.httpStatus}` : ""} · {a.ms}ms
                    </div>
                    <div className="diag-url">{a.url}</div>
                    {a.error && <div className="diag-url">{a.error}</div>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
