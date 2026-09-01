import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MobilityEntity } from "@japan-live/shared";
import { formatJstClock, formatJstDate, serviceSecondsFor } from "@japan-live/core";
import type { SearchResult } from "@japan-live/transit";
import type { Speed } from "@japan-live/simulation";
import { AppStore, type LayerToggles } from "./state/app-store.js";
import { SceneController } from "./scene/controller.js";
import { CAMERA_PRESETS, CITY_VIEW } from "./scene/camera.js";
import { Inspector } from "./ui/Inspector.js";
import { LayerPanel } from "./ui/LayerPanel.js";
import { DataStatus } from "./ui/DataStatus.js";
import { BuildingDiagnosticsPanel } from "./ui/BuildingDiagnostics.js";
import { Timeline } from "./ui/Timeline.js";
import { SearchBox } from "./ui/SearchBox.js";
import { AttributionBar } from "./ui/Attribution.js";

const store = new AppStore();

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
          <nav className="panel presets" aria-label="カメラプリセット">
            {CAMERA_PRESETS.map((p) => (
              <button key={p.id} className="preset-btn" onClick={() => sceneRef.current?.flyTo(p)}>
                {p.label}
              </button>
            ))}
            <button
              className="preset-btn city"
              onClick={() => sceneRef.current?.flyTo(CITY_VIEW)}
              title="3D建物が見える斜め視点"
            >
              CITY VIEW
            </button>
            <button className="preset-btn tour" data-active={tourRunning} onClick={onTour}>
              {tourRunning ? "TOUR 停止" : "TOUR"}
            </button>
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

        <div className="right-stack" data-open={panelsOpen}>
          <LayerPanel layers={snapshot.layers} health={snapshot.sceneHealth} onToggle={onToggle} />
          <BuildingDiagnosticsPanel diagnostics={snapshot.buildings} />
          <DataStatus
            providers={snapshot.providers}
            health={snapshot.sceneHealth}
            dataset={snapshot.dataset}
            now={uiNow}
          />
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
