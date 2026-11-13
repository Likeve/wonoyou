import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
const build = process.env.INOU_BUILD_ID || new Date().toISOString();
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(build), __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
    { name: "inou-version", generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build, version }) });
    }, configureServer(server) {
      server.middlewares.use("/version.json", (_, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ build, version }));
      });
    } },
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",
      registerType: "prompt",
      injectRegister: null,
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        id: "/",
        name: "INOU 私域聊天",
        short_name: "INOU",
        description: "与你信任的人，安心聊。",
        lang: "zh-CN",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#ededed",
        theme_color: "#ededed",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 3000000,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/signal": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
