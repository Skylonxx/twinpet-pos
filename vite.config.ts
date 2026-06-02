import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// firebase.json is the single source of truth for the deployment region; read it
// here (build tool runs in Node) so the dev proxy host isn't hardcoded.
function firestoreLocation(): string {
  const fb = JSON.parse(readFileSync('./firebase.json', 'utf8'))
  const fs = Array.isArray(fb.firestore)
    ? fb.firestore.find((e: { location?: string }) => e?.location) ?? fb.firestore[0]
    : fb.firestore
  if (!fs?.location) {
    throw new Error('firebase.json: firestore.location is missing — cannot derive the region.')
  }
  return fs.location as string
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const projectId = env.VITE_FIREBASE_PROJECT_ID || 'twinpet-pos'
  const functionsHost = `https://${firestoreLocation()}-${projectId}.cloudfunctions.net`

  return {
    plugins: [react()],
    build: {
      // Vendor chunks (below) keep the app chunk lean for caching; the remaining
      // app bundle still sits above Vite's 500 kB default, so lift the warning
      // threshold to 1000 kB (largest chunk is ~910 kB).
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          // Split heavy third-party libs out of the app chunk so the main
          // bundle stays under the size-warning threshold and vendor code is
          // cached independently of app code.
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return
            if (id.includes('/firebase/') || id.includes('/@firebase/')) return 'firebase'
            if (id.includes('/chart.js/') || id.includes('react-chartjs')) return 'charts'
            if (id.includes('react-router')) return 'react-router'
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/scheduler/')
            ) {
              return 'react-vendor'
            }
            return 'vendor'
          },
        },
      },
    },
    server: {
      // Proxy Cloud Functions through localhost to avoid browser CORS in dev.
      proxy: {
        '/__/firebase/functions': {
          target: functionsHost,
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/__\/firebase\/functions/, ''),
        },
      },
    },
  }
})
