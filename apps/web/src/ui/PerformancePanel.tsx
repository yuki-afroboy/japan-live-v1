import { useCallback, useSyncExternalStore } from "react";
import type { AppStore } from "../state/app-store.js";
import type { QualityProfile } from "../scene/quality.js";

interface Props {
  store: AppStore;
  /** Subscribing is what makes the scene compute percentiles, so it is opt-in. */
  active: boolean;
  onToggle?: () => void;
  profile: QualityProfile;
}

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function secs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

/** How the browser says this document was loaded, in words a person can act on. */
const NAV_LABEL: Record<string, string> = {
  navigate: "通常の読み込み",
  reload: "再読み込み",
  back_forward: "戻る/進む",
  prerender: "先読み",
};

/**
 * Frame timings, on the device the user is actually holding.
 *
 * The reason this is in the product rather than in a test: a headless CI container
 * renders with SwiftShader on a CPU, so its frame rate says nothing about an iPhone's
 * GPU. Comparing a before and an after on real hardware needs a readout on real
 * hardware — one that fits in a screenshot.
 *
 * It costs nothing when closed. The scene records frame intervals either way (two
 * array writes), but the sort behind the percentiles and the 2 Hz React update happen
 * only while this panel has a subscriber.
 */
export function PerformancePanel({ store, active, onToggle, profile }: Props) {
  const subscribe = useCallback(
    (cb: () => void) => (active ? store.subscribePerf(cb) : () => undefined),
    [store, active],
  );
  const perf = useSyncExternalStore(subscribe, () => (active ? store.perfSnapshot() : null));
  const diagnostics = useSyncExternalStore(subscribe, () =>
    active ? store.diagnosticsSnapshot() : null,
  );

  return (
    <section className="panel" aria-label="パフォーマンス">
      <div className="panel-head">
        <span>PERFORMANCE</span>
        {onToggle ? (
          <button onClick={onToggle} aria-expanded={active} aria-label="パフォーマンス計測">
            {active ? "▾" : "▸"}
          </button>
        ) : (
          <span className={`status-chip ${perf && perf.fps >= 30 ? "LIVE" : "SCHEDULE"}`}>
            {perf ? `${Math.round(perf.fps)} FPS` : "…"}
          </span>
        )}
      </div>

      {active && (
        <div className="panel-body">
          {!perf || perf.frames === 0 ? (
            <div className="data-sub">計測中… 数秒お待ちください</div>
          ) : (
            <>
              <dl className="diag diag-wide">
                <dt>FPS</dt>
                <dd className={perf.fps >= 30 ? "diag-good" : perf.fps >= 24 ? "" : "diag-bad"}>
                  {fmt(perf.fps)}
                </dd>
                <dt>平均フレーム</dt><dd>{fmt(perf.avgFrameMs)} ms</dd>
                <dt>中央値</dt><dd>{fmt(perf.medianFrameMs)} ms</dd>
                <dt>p95</dt>
                <dd className={perf.p95FrameMs <= 50 ? "" : "diag-bad"}>{fmt(perf.p95FrameMs)} ms</dd>
                <dt>p99</dt><dd>{fmt(perf.p99FrameMs)} ms</dd>
                <dt>最悪</dt><dd>{fmt(perf.maxFrameMs)} ms</dd>
                <dt>長いフレーム</dt>
                <dd>
                  &gt;33ms {perf.long33} · &gt;50ms {perf.long50} ·{" "}
                  <span className={perf.long100 > 0 ? "diag-bad" : ""}>
                    &gt;100ms {perf.long100}
                  </span>
                </dd>
                <dt>描画要求</dt>
                <dd>
                  {fmt(perf.renderRequestsPerSec, 0)} /s · rAF {fmt(perf.rafPerSec, 0)} /s
                </dd>
                <dt>CPU/フレーム</dt>
                <dd>
                  合計 {fmt(perf.cpu.total, 2)} ms（列車 {fmt(perf.cpu.train, 2)} · 路線{" "}
                  {fmt(perf.cpu.rail, 2)} · 建物 {fmt(perf.cpu.buildings, 2)}）
                </dd>
                <dt>計測窓</dt>
                <dd>
                  {(perf.windowMs / 1000).toFixed(1)} s · {perf.frames} フレーム
                </dd>
              </dl>

              <div className="perf-divider" />

              {/*
                Where the long frames actually are.

                Cesium's update pass parses and uploads every downloaded tile inside
                one frame with no time budget, so a stall shows up here as `更新` and
                not in the per-layer CPU split above — that split only covers our own
                code, which measures in fractions of a millisecond.
              */}
              <dl className="diag diag-wide">
                <dt>Cesium 更新</dt>
                <dd className={perf.cesium.updateP95Ms > 50 ? "diag-bad" : ""}>
                  平均 {fmt(perf.cesium.updateAvgMs, 2)} · p95 {fmt(perf.cesium.updateP95Ms)} ·
                  最大 {fmt(perf.cesium.updateMaxMs)} ms
                </dd>
                <dt>Cesium 描画</dt>
                <dd className={perf.cesium.renderP95Ms > 50 ? "diag-bad" : ""}>
                  平均 {fmt(perf.cesium.renderAvgMs, 2)} · p95 {fmt(perf.cesium.renderP95Ms)} ·
                  最大 {fmt(perf.cesium.renderMaxMs)} ms
                </dd>
                <dt>50ms 超の内訳</dt>
                <dd>
                  更新 {perf.cesium.updateLong50} · 描画 {perf.cesium.renderLong50}
                </dd>
                {perf.worst && (
                  <>
                    <dt>最悪フレーム</dt>
                    <dd>
                      {fmt(perf.worst.frameMs)} ms
                      <br />
                      更新 {fmt(perf.worst.updateMs)} · アプリ {fmt(perf.worst.ourMs, 2)} · 描画{" "}
                      {fmt(perf.worst.renderMs)} ·{" "}
                      {/*
                        The bucket that decides what to fix. Time here is GPU, buffer
                        swap and compositing — pixels, overdraw, geometry. Time in
                        `更新` is 3D Tiles parsing and upload. They share no fix.
                      */}
                      <strong>その他 {fmt(perf.worst.otherMs)}</strong> ms
                      <br />
                      タイル処理 {perf.worst.tilesProcessing} · 要求{" "}
                      {perf.worst.pendingRequests}
                    </dd>
                  </>
                )}
              </dl>

              {diagnostics && (
                <>
                  <div className="perf-divider" />
                  <dl className="diag diag-wide">
                    <dt>TILES 配信中</dt>
                    <dd>
                      要求 {diagnostics.tiles.pendingRequests} · 処理待ち{" "}
                      {diagnostics.tiles.tilesProcessing}
                    </dd>
                    <dt>TILES 常駐</dt>
                    <dd>
                      {diagnostics.tiles.tilesets} タイルセット（落ち着き{" "}
                      {diagnostics.tiles.settled}） · {fmt(diagnostics.tiles.memoryMb, 0)} MB
                    </dd>
                    <dt>TILES 累計</dt>
                    <dd>
                      読込 {diagnostics.tiles.loaded} · 破棄 {diagnostics.tiles.unloaded} · 失敗{" "}
                      {diagnostics.tiles.failed}
                    </dd>
                  </dl>

                  <div className="perf-divider" />
                  <dl className="diag diag-wide">
                    <dt>WEBGL</dt>
                    <dd>
                      {diagnostics.stability.webgl.version} ·{" "}
                      {diagnostics.stability.webgl.renderer ?? "renderer 非公開"}
                    </dd>
                    <dt>描画バッファ</dt>
                    <dd>
                      {diagnostics.stability.webgl.drawingBuffer} · stencil{" "}
                      {diagnostics.stability.webgl.stencilBits} bit · 最大テクスチャ{" "}
                      {diagnostics.stability.webgl.maxTextureSize}
                    </dd>
                    <dt>コンテキスト消失</dt>
                    <dd
                      className={
                        diagnostics.stability.contextLosses > 0 ? "diag-bad" : "diag-good"
                      }
                    >
                      {diagnostics.stability.contextLosses} 回
                      {diagnostics.stability.contextLost ? "（現在消失中）" : ""}
                    </dd>
                  </dl>

                  <div className="perf-divider" />
                  <dl className="diag diag-wide">
                    <dt>SESSION</dt>
                    <dd>
                      {diagnostics.stability.sessionId} · 稼働{" "}
                      {secs(diagnostics.stability.uptimeMs)}
                    </dd>
                    <dt>読み込み種別</dt>
                    <dd>
                      {NAV_LABEL[diagnostics.stability.navigationType] ??
                        diagnostics.stability.navigationType}
                    </dd>
                    <dt>予期しない再起動</dt>
                    <dd
                      className={
                        diagnostics.stability.unexpectedRestarts > 0 ? "diag-bad" : "diag-good"
                      }
                    >
                      {diagnostics.stability.unexpectedRestarts} 回
                      {diagnostics.stability.storage === "unavailable" ? "（記録不可）" : ""}
                    </dd>
                    {diagnostics.stability.previous && (
                      <>
                        <dt>前回セッション</dt>
                        <dd>
                          {secs(diagnostics.stability.previous.uptimeMs)}で
                          {diagnostics.stability.previous.closedCleanly
                            ? "正常終了"
                            : "予告なく終了"}
                          {diagnostics.stability.previous.lastEvent
                            ? ` · 最後: ${diagnostics.stability.previous.lastEvent.kind}`
                            : ""}
                        </dd>
                        {diagnostics.stability.previous.state && (
                          <>
                            <dt>終了時の状態</dt>
                            <dd>
                              タイル{" "}
                              {fmt(diagnostics.stability.previous.state.tileMemoryMb, 0)} MB ·{" "}
                              {diagnostics.stability.previous.state.tilesets} セット · 高度{" "}
                              {Math.round(diagnostics.stability.previous.state.altitude)} m
                            </dd>
                          </>
                        )}
                      </>
                    )}
                  </dl>

                  <div className="perf-divider" />
                  <div className="diag-hint">STABILITY ログ（新しい順）</div>
                  <ul className="stability-log">
                    {diagnostics.stability.log.slice(0, 8).map((event, i) => (
                      <li key={`${event.t}-${event.kind}-${i}`}>
                        <span className="stability-t">{(event.t / 1000).toFixed(1)}s</span>
                        <span className="stability-kind">{event.kind}</span>
                        {event.detail && <span className="stability-detail">{event.detail}</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className="perf-divider" />

              <dl className="diag diag-wide">
                <dt>品質プロファイル</dt><dd>{profile.tier}</dd>
                <dt>解像度倍率</dt>
                <dd>
                  {profile.resolutionScale} (DPR {window.devicePixelRatio ?? 1})
                </dd>
                <dt>アンチエイリアス</dt>
                <dd>
                  MSAA ×{profile.msaaSamples} · FXAA {profile.fxaa ? "ON" : "OFF"}
                </dd>
                <dt>建物予算</dt><dd>{profile.wardBudget} 区</dd>
                <dt>3D Tiles</dt>
                <dd>
                  skipLOD {profile.tiles.skipLevelOfDetail ? "ON" : "OFF"} · preferLeaves{" "}
                  {profile.tiles.preferLeaves ? "ON" : "OFF"} · 同時要求{" "}
                  {profile.tiles.maximumRequests}
                </dd>
                <dt>アニメーション上限</dt><dd>{profile.animationHz} Hz</dd>
                <dt>画面</dt>
                <dd>
                  {window.innerWidth}×{window.innerHeight}
                </dd>
              </dl>

              <div className="diag-hint">
                実機の値です。CI（SwiftShader ソフトウェア描画）の数値とは比較できません。
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
