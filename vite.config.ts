import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const projectId = env.VITE_FIREBASE_PROJECT_ID || 'twinpet-pos'
  const functionsHost = `https://asia-southeast1-${projectId}.cloudfunctions.net`

  return {
    plugins: [react()],
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
