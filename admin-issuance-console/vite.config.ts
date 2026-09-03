import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// SEC-001 Packet C-A Admin Issuance Console — minimal Tauri v2 + React app.
// Tauri expects a fixed dev server port and ignores src-tauri/ for HMR.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'esnext',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})
