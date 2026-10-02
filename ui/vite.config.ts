import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: { __BUILD_DATE__: JSON.stringify(new Date().toLocaleDateString("ru-RU")) },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: "es2021", sourcemap: false, minify: true, chunkSizeWarningLimit: 1500 },
  test: { environment: "node" },
} as any);
