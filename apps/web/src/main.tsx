import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "cesium/Build/Cesium/Widgets/widgets.css";
import "./ui/styles.css";
import { App } from "./App.js";

// Cesium loads its workers and assets from here; vite.config.ts sets it to match `base`.
declare global {
  interface Window {
    CESIUM_BASE_URL: string;
  }
}
window.CESIUM_BASE_URL = CESIUM_BASE_URL;

const container = document.getElementById("root");
if (!container) throw new Error("#root missing");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
