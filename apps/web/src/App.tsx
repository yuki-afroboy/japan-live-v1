import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MobilityEntity } from "@japan-live/shared";
import { formatJstClock, formatJstDate, serviceSecondsFor } from "@japan-live/core";
import type { SearchResult } from "@japan-live/transit";
import type { Speed } from "@japan-live/simulation";
import { AppStore, type LayerToggles } from "./state/app-store.js";
import { SceneController } from "./scene/controller.js";
import { CAMERA_PRESETS, CITY_VIEW } from "./scene/camera.js";
import { NARROW_MAX_WIDTH, currentProfile } from "./scene/quality.js";
import { Inspector } from "./ui/Inspector.js";
import { LayerPanel } from "./ui/LayerPanel.js";
import { DataStatus } from "./ui/DataStatus.js";
import { BuildingDiagnosticsPanel } from "./ui/BuildingDiagnostics.js";
import { PerformancePanel } from "./ui/PerformancePanel.js";
import { Timeline } from "./ui/Timeline.js";
import { SearchBox } from "./ui/SearchBox.js";
import { AttributionBar } from "./ui/Attribution.js";

const store = new AppStore();
// Fixed at load, exactly like the viewer's own profile: antialias and the WebGL
// context cannot change without recreating the viewer, so a panel that re-derived
// this on resize would report settings the renderer is not using.
const profile = currentProfile();

/**
 * Which panel the drawer is showing on a phone.
 *
 * A phone shows exactly one. PR #4 stacked all of them in a single scroll container
 * and it still did not work on real iOS Safari — see D-018. Reaching a panel must not
 * depend on a scroll gesture surviving four layers of CSS.
 */
type DrawerTab = "layers" | "buildings" | "data" | "perf";

const DRAWER_TABS: { id: DrawerTab; label: string; hint: string }[] = [
  { id: "layers", label: "レイヤー", hint: "表示するレイヤー" },
  // Named for what it shows, not for the data source. "PLATEAU" means nothing to
  // someone who just wants to know why there are no buildings.
  { id: "buildings", label: "3D建物", hint: "3D建物の読み込み状況" },
  { id: "data", label: "データ", hint: "データソースの状態" },
  { id: "perf", label: "性能", hint: "フレームレート計測" },
];

/**
 * True on phone-width screens. Reads the same breakpoint the stylesheet and the
 * rendering quality tier use, so the layout and the pixel budget can never disagree.
 */
function useNarrowViewport(): boolean {
  const query = `(max-width: ${NARROW_MAX_WIDTH}px)`;
  const subscribe = useCallback(
    (cb: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

interface Stats {
  fps: number;
  altitude: number;
  lod: string;
  trains: number;
}

export function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneController | null>(null);

  const snapshot = useSyncExternalStore(
    useCallback((cb: () => void) => store.subscribe(cb), []),
    () => store.snapshot(),
  );

  const [selected, setSelected] = useState<MobilityEntity | undefined>();
  const [following, setFollowing] = useState(false);
  const [introPlaying, setIntroPlaying] = useState(true);
  const [tourRunning, setTourRunning] = useState(false);
  const [stats, setStats] = useState<Stats>({ fps: 0, altitude: 0, lod: "point", trains: 0 });
  // On a phone the panels would cover the map, which is the one thing the product is.
  // They collapse behind a toggle there and stay open on desktop.
  const [panelsOpen, setPanelsOpen] = useState(false);
  const narrow = useNarrowViewport();
  const [tab, setTab] = useState<DrawerTab>("layers");
  // Desktop keeps its stack of panels, so PERFORMANCE gets its own disclosure there.
  const [perfOpen, setPerfOpen] = useState(false);
  const perfActive = narrow ? panelsOpen && tab === "perf" : perfOpen;
  // The brand block and the timeline are the two largest permanent obstructions on a
  // phone. Both collapse to a single line, and the Inspector collapses them for you.
  const [brandCompact, setBrandCompact] = useState(false);
  const [timelineCompact, setTimelineCompact] = useState(false);
  // A shared 1 Hz tick so the clock and freshness ages update without the scene
  // driving React, and without each panel owning its own timer.
  const [uiNow, setUiNow] = useState(() => Date.now());

  /** Create the scene exactly once. Cesium lives in a ref, never in React state. */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new SceneController(container, store, {
      onSelect: (entity) => setSelected(entity),
      onStationSelect: (stationId) => {
        const station = store.network?.station(stationId);
        if (station) scene.flyToLonLat(station.longitude, station.latitude, 1_200);
      },
      onIntroDone: () => setIntroPlaying(false),
      onTourStep: () => setTourRunning(true),
      onTourDone: () => setTourRunning(false),
      onStats: setStats,
    });
    sceneRef.current = scene;

    let cancelled = false;
    void (async () => {
      await store.init();
      if (cancelled) return;
      scene.ingest(store.entities, 20_000);
      await scene.load();
    })();

    return () => {
      cancelled = true;
      scene.destroy();
      sceneRef.current = null;
    };
  }, []);

  /** Provider polling. Only runs in LIVE; SIMULATION is driven by the scene's clock. */
  useEffect(() => {
    let stopped = false;
    const timer = window.setInterval(() => {
      if (stopped) return;
      void store.poll(Date.now()).then(() => {
        if (!stopped) sceneRef.current?.ingest(store.entities, 20_000);
      });
    }, 10_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setUiNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  /** Keep the Inspector's contents current as the selected train moves. */
  useEffect(() => {
    if (!selected) return;
    const latest = store.entities.find((e) => e.id === selected.id);
    if (latest && latest !== selected) setSelected(latest);
    else if (!latest) {
      // The train stopped being reported. Close rather than showing a frozen record.
      setSelected(undefined);
      setFollowing(false);
    }
  }, [uiNow, snapshot.trainCount, selected]);

  const onToggle = useCallback(<K extends keyof LayerToggles>(key: K, value: boolean) => {
    store.setLayer(key, value as LayerToggles[K]);
  }, []);

  const onFollow = useCallback(() => {
    if (!selected) return;
    sceneRef.current?.startFollow(selected.id);
    setFollowing(true);
    setTourRunning(false);
  }, [selected]);

  const onStopFollow = useCallback(() => {
    sceneRef.current?.stopFollow();
    setFollowing(false);
  }, []);

  const onSearchPick = useCallback((result: SearchResult) => {
    const scene = sceneRef.current;
    if (!scene || !store.network) return;
    if (result.kind === "station") {
      const s = store.network.station(result.id);
      if (s) scene.flyToLonLat(s.longitude, s.latitude, 1_400);
    } else {
      const shape = store.network.shape(result.id);
      if (shape) {
        const mid = shape.at(shape.totalLengthM / 2).position;
        scene.flyToLonLat(mid[0], mid[1], 14_000);
      }
    }
  }, []);

  const onTour = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (tourRunning) {
      scene.stopTour();
      setTourRunning(false);
    } else {
      scene.startTour();
      setTourRunning(true);
    }
  }, [tourRunning]);

  const displayTime = snapshot.clock.currentTime;
  const serviceSeconds = useMemo(() => serviceSecondsFor(displayTime), [displayTime]);
  const isLive = snapshot.clock.mode === "LIVE";

  return (
    <>
      <div className="map-root" ref={containerRef} />

      {!snapshot.ready && (
        <div className="boot">
          <div>
            <h1>JAPAN LIVE</h1>
            <p>読み込み中…</p>
          </div>
        </div>
      )}

      <div className="hud">
        {/* Opening the Inspector auto-compacts the rest: on a phone the map would
            otherwise be squeezed between four panels at once. */}
        <header className="panel brand" data-compact={brandCompact || Boolean(selected)}>
          <button
            className="brand-toggle"
            onClick={() => setBrandCompact((v) => !v)}
            aria-label={brandCompact ? "情報を展開" : "情報を折りたたむ"}
            aria-expanded={!brandCompact}
          >
            {brandCompact ? "▾" : "▴"}
          </button>
          <h1>JAPAN LIVE</h1>
          <div className="tagline">V1 — TOKYO TRAINS</div>

          {/*
            Two independent facts, so two independent badges:
              DEMO           — where the data came from
              SIMULATION ×N  — whether the clock is real time
            Collapsing them hid time acceleration whenever the app was in demo mode.
            LIVE is shown only when BOTH the feed and the clock are real.
          */}
          <div className="mode-row">
            {snapshot.demoMode && (
              <span className="mode-badge demo">
                <span className="dot" /> DEMO
              </span>
            )}
            {isLive
              ? !snapshot.demoMode && (
                  <span className="mode-badge live">
                    <span className="dot" /> LIVE
                  </span>
                )
              : (
                  <span className="mode-badge sim">
                    <span className="dot" /> SIMULATION ×{snapshot.clock.speed}
                  </span>
                )}
          </div>

          <div className="clock">
            {formatJstClock(displayTime)}
            <span className="clock-zone">JST</span>
          </div>
          <div className="clock-date">{formatJstDate(displayTime)}</div>

          {snapshot.demoMode && (
            <div className="demo-warning">
              <strong>SIMULATED DATA</strong>
              <br />
              APIキー未設定のため模擬データで動作しています。実在の列車ではありません。
            </div>
          )}
          {snapshot.loadError && (
            <div className="demo-warning" style={{ background: "rgba(255,107,107,0.12)", borderColor: "rgba(255,107,107,0.4)", color: "#ffc4c4" }}>
              {snapshot.loadError}
            </div>
          )}
        </header>

        <div className="top-center">
          {/*
            Two groups on purpose. The location presets scroll horizontally when they
            do not fit; CITY VIEW and TOUR are pinned and never do. CITY VIEW is the
            view that shows whether 3D buildings loaded, so it must not be something a
            user has to discover by swiping — at 375px the old single row pushed it and
            TOUR off the end.
          */}
          <nav className="panel presets" aria-label="カメラプリセット">
            <div className="preset-scroll">
              {CAMERA_PRESETS.map((p) => (
                <button key={p.id} className="preset-btn" onClick={() => sceneRef.current?.flyTo(p)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="preset-pinned">
              <button
                className="preset-btn city"
                onClick={() => sceneRef.current?.flyTo(CITY_VIEW)}
                title="3D建物が見える斜め視点"
              >
                CITY VIEW
              </button>
              <button className="preset-btn tour" data-active={tourRunning} onClick={onTour}>
                {tourRunning ? "停止" : "TOUR"}
              </button>
            </div>
          </nav>
          <SearchBox network={store.network} onPick={onSearchPick} />
        </div>

        <button
          className="panel panels-toggle"
          data-open={panelsOpen}
          aria-expanded={panelsOpen}
          onClick={() => setPanelsOpen((v) => !v)}
        >
          {panelsOpen ? "✕ 閉じる" : "☰ レイヤー / データ"}
        </button>

        <div className="right-stack" data-open={panelsOpen} data-narrow={narrow}>
          {/*
            On a phone this is a tab strip, not a scrolling wall. Every panel is two
            taps away: open the drawer, tap the tab. Desktop has room to stack them and
            keeps doing so.
          */}
          {narrow && (
            <nav className="drawer-tabs" role="tablist" aria-label="パネル切り替え">
              {DRAWER_TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  id={`tab-${t.id}`}
                  className="drawer-tab"
                  aria-selected={tab === t.id}
                  aria-controls={`panel-${t.id}`}
                  title={t.hint}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          )}

          <div
            className="drawer-slot"
            id="panel-layers"
            role={narrow ? "tabpanel" : undefined}
            aria-labelledby={narrow ? "tab-layers" : undefined}
            hidden={narrow && tab !== "layers"}
          >
            <LayerPanel layers={snapshot.layers} health={snapshot.sceneHealth} onToggle={onToggle} />
          </div>

          <div
            className="drawer-slot"
            id="panel-buildings"
            role={narrow ? "tabpanel" : undefined}
            aria-labelledby={narrow ? "tab-buildings" : undefined}
            hidden={narrow && tab !== "buildings"}
          >
            <BuildingDiagnosticsPanel diagnostics={snapshot.buildings} />
          </div>

          <div
            className="drawer-slot"
            id="panel-data"
            role={narrow ? "tabpanel" : undefined}
            aria-labelledby={narrow ? "tab-data" : undefined}
            hidden={narrow && tab !== "data"}
          >
            <DataStatus
              providers={snapshot.providers}
              health={snapshot.sceneHealth}
              dataset={snapshot.dataset}
              now={uiNow}
            />
          </div>

          <div
            className="drawer-slot"
            id="panel-perf"
            role={narrow ? "tabpanel" : undefined}
            aria-labelledby={narrow ? "tab-perf" : undefined}
            hidden={narrow && tab !== "perf"}
          >
            <PerformancePanel
              store={store}
              active={perfActive}
              profile={profile}
              onToggle={narrow ? undefined : () => setPerfOpen((v) => !v)}
            />
          </div>
        </div>

        {selected && (
          <Inspector
            entity={selected}
            now={uiNow}
            following={following}
            onFollow={onFollow}
            onStopFollow={onStopFollow}
            onClose={() => {
              setSelected(undefined);
              onStopFollow();
              sceneRef.current?.select(undefined);
            }}
          />
        )}

        {snapshot.alerts.length > 0 && !selected && (
          <div className="panel alerts" role="status">
            {snapshot.alerts.slice(0, 3).map((a) => (
              <div key={a.id} className="alert-item">
                <span className="alert-line">{a.railwayName ?? a.railwayId ?? "運行情報"}</span>
                {a.text}
              </div>
            ))}
          </div>
        )}

        <AttributionBar attributions={snapshot.attributions} datasetNote={snapshot.dataset?.note} />

        <div className="timeline-wrap" data-compact={timelineCompact || Boolean(selected)}>
          <button
            className="timeline-toggle"
            onClick={() => setTimelineCompact((v) => !v)}
            aria-label={timelineCompact ? "タイムラインを展開" : "タイムラインを折りたたむ"}
            aria-expanded={!timelineCompact}
          >
            {timelineCompact ? "▴ 時刻" : "▾"}
          </button>
          <Timeline
            mode={snapshot.clock.mode}
            speed={snapshot.clock.speed}
            paused={snapshot.clock.paused}
            serviceSeconds={serviceSeconds}
            onSpeed={(s: Speed) => store.setSpeed(s)}
            onLive={() => store.goLive()}
            onSeek={(sec) => store.seekServiceSeconds(sec)}
            onPause={(p) => store.setPaused(p)}
          />
        </div>
      </div>

      <div className="stats">
        {Math.round(stats.fps)} fps · {stats.trains} trains · {stats.lod} ·{" "}
        {stats.altitude > 1000
          ? `${(stats.altitude / 1000).toFixed(1)} km`
          : `${Math.round(stats.altitude)} m`}
      </div>

      {introPlaying && (
        <button className="panel intro-skip" onClick={() => sceneRef.current?.skipIntro()}>
          スキップ SKIP
        </button>
      )}
    </>
  );
}
