import { defineConfig, loadEnv } from "vite";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const bridgeTarget = env.BCR_BROWSER_BRIDGE_URL || "http://127.0.0.1:8080";
  const calibrationTarget = env.BCR_CALIBRATION_BRIDGE_URL || "http://127.0.0.1:8091";
  // Relative base keeps built asset URLs portable across local preview and
  // GitHub Pages project paths without requiring different URLs per environment.
  const base = env.BCR_UI_BASE || "./";

  return {
    base,
    build: {
      rollupOptions: {
        input: {
          main: resolve(process.cwd(), "index.html"),
          arucoCalibration: resolve(process.cwd(), "aruco-calibration.html"),
        },
      },
    },
    server: {
      host: env.BCR_UI_HOST || "0.0.0.0",
      port: Number(env.BCR_UI_PORT || 5173),
      proxy: {
        "/api/calibration": {
          target: calibrationTarget,
          changeOrigin: true,
        },
        "/api": {
          target: bridgeTarget,
          changeOrigin: true,
        },
      },
    },
    preview: {
      host: env.BCR_UI_HOST || "0.0.0.0",
      port: Number(env.BCR_UI_PREVIEW_PORT || 4173),
    },
  };
});
