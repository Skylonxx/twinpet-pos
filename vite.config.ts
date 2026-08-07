import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import flowbiteReact from "flowbite-react/plugin/vite";

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

type ArtifactPrep = {
  schemaVersion: number
  preparedSourceCommit: string
  preparedBuildId: string
  preparedAt: string
  compatFloor: string
}

type RuntimeArtifactMarker = {
  sourceCommit: string
  buildId: string
  compatFloor: string
}

function currentSourceCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

/**
 * BUILD-time provenance gate (R6): read .artifact-provenance.json, fail closed on
 * missing / malformed / stale preparation, and bind the runtime marker
 * (sourceCommit, buildId, compatFloor) — never buildHash.
 */
function loadBuildPreparation(): { prep: ArtifactPrep; marker: RuntimeArtifactMarker } {
  const prepFile = resolve(process.cwd(), '.artifact-provenance.json')
  if (!existsSync(prepFile)) {
    throw new Error(
      'PROVENANCE_FAIL_CLOSED: missing preparation (.artifact-provenance.json). Use `npm run build` (prebuild prepare); direct Vite is not an accepted release path.',
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(prepFile, 'utf8'))
  } catch {
    throw new Error('PROVENANCE_FAIL_CLOSED: malformed preparation (invalid JSON)')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('PROVENANCE_FAIL_CLOSED: malformed preparation (not an object)')
  }
  const prep = raw as Partial<ArtifactPrep>
  if (prep.schemaVersion !== 1) {
    throw new Error('PROVENANCE_FAIL_CLOSED: malformed preparation (schemaVersion)')
  }
  if (typeof prep.preparedSourceCommit !== 'string' || !prep.preparedSourceCommit) {
    throw new Error('PROVENANCE_FAIL_CLOSED: malformed preparation (preparedSourceCommit)')
  }
  if (typeof prep.preparedBuildId !== 'string' || !prep.preparedBuildId) {
    throw new Error('PROVENANCE_FAIL_CLOSED: malformed preparation (preparedBuildId)')
  }
  if (typeof prep.preparedAt !== 'string' || !prep.preparedAt) {
    throw new Error('PROVENANCE_FAIL_CLOSED: malformed preparation (preparedAt)')
  }
  if (typeof prep.compatFloor !== 'string' || !prep.compatFloor) {
    throw new Error('PROVENANCE_FAIL_CLOSED: malformed preparation (compatFloor)')
  }
  if (Object.prototype.hasOwnProperty.call(prep, 'buildHash')) {
    throw new Error('PROVENANCE_FAIL_CLOSED: malformed preparation (buildHash must not be present)')
  }
  const head = currentSourceCommit()
  if (prep.preparedSourceCommit !== head) {
    throw new Error(
      'PROVENANCE_FAIL_CLOSED: stale preparation (preparedSourceCommit mismatch). Re-run `npm run build` so prebuild prepare refreshes identity.',
    )
  }
  const marker: RuntimeArtifactMarker = {
    sourceCommit: prep.preparedSourceCommit,
    buildId: prep.preparedBuildId,
    compatFloor: prep.compatFloor,
  }
  return {
    prep: prep as ArtifactPrep,
    marker,
  }
}

function twinpetArtifactMarkerPlugin(marker: RuntimeArtifactMarker): Plugin {
  const literal = JSON.stringify(marker)
  return {
    name: 'twinpet-artifact-provenance-marker',
    apply: 'build',
    transformIndexHtml(html) {
      // Ensures globalThis.__TWINPET_ARTIFACT__ is present in the built artifact
      // without requiring a src/ edit. Identity comes from the define-backed prep.
      const snippet = `<script>globalThis.__TWINPET_ARTIFACT__=${literal};</script>`
      if (html.includes('<head>')) {
        return html.replace('<head>', `<head>${snippet}`)
      }
      return `${snippet}${html}`
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const projectId = env.VITE_FIREBASE_PROJECT_ID || 'twinpet-pos'
  const functionsHost = `https://${firestoreLocation()}-${projectId}.cloudfunctions.net`

  // Provenance is enforced only for production builds. Dev server must not
  // require preparation (direct `vite` / `dev:web` remain non-release paths).
  let artifactDefine: Record<string, string> = {}
  const buildPlugins: Plugin[] = []
  if (command === 'build') {
    const { marker } = loadBuildPreparation()
    artifactDefine = {
      'globalThis.__TWINPET_ARTIFACT__': JSON.stringify(marker),
    }
    buildPlugins.push(twinpetArtifactMarkerPlugin(marker))
  }

  return {
    define: artifactDefine,
    plugins: [react(), tailwindcss(), flowbiteReact(), ...buildPlugins],
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