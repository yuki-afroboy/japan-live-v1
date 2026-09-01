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
  const perf = useSyncExternalStore(
    useCallback(
      (cb: () => void) => (active ? store.subscribePerf(cb) : () => undefined),
      [store, active],
    ),
    () => (active ? store.perfSnapshot() : null),
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
                <dt>最悪</dt><dd>{fmt(perf.maxFrameMs)} ms</dd>
                <dt>長いフレーム</dt>
                <dd>
                  &gt;33ms {perf.long33} · &gt;50ms {perf.long50}
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
