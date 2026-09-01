import { describe, expect, it } from "vitest";
import { fromJstParts } from "@japan-live/core";
import { SimulationClock } from "@japan-live/simulation";

const T0 = fromJstParts(2026, 8, 18, 7, 30, 0);

describe("SimulationClock LIVE/SIM separation", () => {
  it("starts LIVE at x1", () => {
    const c = new SimulationClock(T0);
    expect(c.currentMode).toBe("LIVE");
    expect(c.currentSpeed).toBe(1);
    expect(c.isLive).toBe(true);
  });

  it("tracks the wall clock in LIVE regardless of tick spacing", () => {
    const c = new SimulationClock(T0);
    c.tick(T0 + 5_000);
    expect(c.currentTime).toBe(T0 + 5_000);
  });

  it("LEAVES LIVE the moment speed is not x1", () => {
    // The rule the whole product hangs on: accelerated data is not live data.
    const c = new SimulationClock(T0);
    c.setSpeed(60, T0);
    expect(c.currentMode).toBe("SIMULATION");
    expect(c.isLive).toBe(false);
  });

  it("is not live at any speed above x1", () => {
    for (const s of [10, 60, 600] as const) {
      const c = new SimulationClock(T0);
      c.setSpeed(s, T0);
      expect(c.isLive).toBe(false);
    }
  });

  it("stays live when speed is set to x1 while already live", () => {
    const c = new SimulationClock(T0);
    c.setSpeed(1, T0);
    expect(c.isLive).toBe(true);
    expect(c.currentMode).toBe("LIVE");
  });

  it("is not live in SIMULATION even at x1", () => {
    const c = new SimulationClock(T0);
    c.goSimulation(T0, 1, T0);
    expect(c.currentMode).toBe("SIMULATION");
    expect(c.isLive).toBe(false);
  });

  it("keeps the current instant when transitioning live -> sim, so the view is continuous", () => {
    const c = new SimulationClock(T0);
    c.tick(T0 + 1_000);
    c.setSpeed(60, T0 + 1_000);
    expect(c.currentTime).toBe(T0 + 1_000);
  });

  it("advances simulated time by speed x real elapsed", () => {
    const c = new SimulationClock(T0);
    c.goSimulation(T0, 60, T0);
    c.tick(T0 + 1_000);
    expect(c.currentTime).toBe(T0 + 60_000);
  });

  it("returning to LIVE forces x1 and snaps back to the wall clock", () => {
    const c = new SimulationClock(T0);
    c.goSimulation(T0 - 86_400_000, 600, T0);
    c.goLive(T0 + 12_345);
    expect(c.currentMode).toBe("LIVE");
    expect(c.currentSpeed).toBe(1);
    expect(c.currentTime).toBe(T0 + 12_345);
    expect(c.isLive).toBe(true);
  });

  it("refuses to scrub in LIVE so the live clock can never show a false time", () => {
    const c = new SimulationClock(T0);
    c.seek(T0 - 3_600_000);
    expect(c.currentTime).toBe(T0);
    c.seekServiceSeconds(3600);
    expect(c.currentTime).toBe(T0);
  });

  it("scrubs in SIMULATION", () => {
    const c = new SimulationClock(T0);
    c.goSimulation(T0, 1, T0);
    c.seek(T0 - 3_600_000, T0);
    expect(c.currentTime).toBe(T0 - 3_600_000);
  });

  it("pauses only in SIMULATION", () => {
    const live = new SimulationClock(T0);
    live.setPaused(true);
    live.tick(T0 + 1_000);
    expect(live.currentTime).toBe(T0 + 1_000);

    const sim = new SimulationClock(T0);
    sim.goSimulation(T0, 60, T0);
    sim.setPaused(true);
    sim.tick(T0 + 1_000);
    expect(sim.currentTime).toBe(T0);
  });

  it("seeks to a service second, including past 24:00", () => {
    const c = new SimulationClock(T0);
    c.goSimulation(T0, 1, T0);
    c.seekServiceSeconds(25 * 3600, T0);
    // 25:00 on service day 2026-08-18 is 01:00 JST on the 19th.
    expect(c.formatClock(false)).toBe("01:00");
    expect(c.serviceSeconds).toBe(25 * 3600);
  });

  it("reports JST clock and date", () => {
    const c = new SimulationClock(T0);
    expect(c.formatClock()).toBe("07:30:00");
    expect(c.formatDate()).toBe("2026/08/18");
  });
});
