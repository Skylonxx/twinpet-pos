# Phase 6A: Capacitor Setup & Packaging Smoke Test

## 1. Phase Purpose
The purpose of Phase 6A is to wrap the current validated Twinpet POS React web application into a native Capacitor Android shell and verify basic packaging viability. This answers the question of whether the React/PWA MVP can build, sync into Capacitor, and generate an Android shell without breaking existing browser/PWA behavior.

## 2. Scope Boundaries
**Allowed**: Minimal Capacitor installation, Capacitor initialization, Android platform setup, web build verification, Capacitor sync, Android project generation.
**Explicitly Deferred/Prohibited**: SQLite/native storage plugins, hardware plugins (printers, scanners, Bluetooth, USB), App Store/Play Store pipelines, iOS work, modifying `src/pages/POSPage.tsx`, modifying cache/Firestore/checkout/order-sync logic.

## 3. Package & Environment Changes
- **Package Manager**: npm
- **Build Tool**: Vite / React (`tsc -b && vite build`)
- **Output Directory**: `dist`
- **Installed Packages**: 
  - `@capacitor/core` (dependencies)
  - `@capacitor/cli` (devDependencies)
  - `@capacitor/android` (devDependencies)

## 4. Capacitor Config Values (`capacitor.config.ts`)
- **App Name**: "Twinpet POS"
- **App ID**: "com.twinpet.pos"
- **Web Dir**: "dist"

## 5. Execution & Smoke Test Results
*Note: For `npx cap add android`, raw excerpts were not captured during the first execution and the command cannot be safely re-run destructively, so we rely on summary-only evidence for the initial execution of that specific step.*

### 5.1. Web Build: PASS
```
> twinpet-pos@0.0.0 build
> tsc -b && vite build

vite v8.0.14 building client environment for production...
Generating .flowbite-react\class-list.json file...

transforming...✓ 547 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                             1.42 kB │ gzip:   0.62 kB
dist/assets/index-DHiWVHO_.css            339.21 kB │ gzip:  52.50 kB
dist/assets/rolldown-runtime-Bh1tDfsg.js    0.56 kB │ gzip:   0.36 kB
dist/assets/react-router-BVImBSaZ.js       42.27 kB │ gzip:  15.07 kB
dist/assets/vendor-ech4Bep8.js            117.86 kB │ gzip:  33.73 kB
dist/assets/charts-xn6RU_C7.js            177.58 kB │ gzip:  61.51 kB
dist/assets/react-vendor-CzRZBWxH.js      250.54 kB │ gzip:  80.54 kB
dist/assets/firebase-BY1e-tG2.js          465.05 kB │ gzip: 140.03 kB
dist/assets/index-Ce452ctE.js             946.13 kB │ gzip: 216.23 kB

✓ built in 796ms
```

### 5.2. Capacitor Sync: PASS
```
√ Copying web assets from dist to android\app\src\main\assets\public in 9.12ms
√ Creating capacitor.config.json in android\app\src\main\assets in 671.70μs
√ copy android in 32.28ms
√ Updating Android plugins in 6.12ms
√ update android in 38.22ms
√ copy web in 12.23ms
√ update web in 12.52ms
[info] Sync finished in 0.147s
```

### 5.3. Android Platform: PASS
`npx cap add android` generated the `android/` project directory successfully. (Summary-only evidence for the initial execution).

### 5.4. Android Build/Open/Run: LIMITED / NOT VALIDATED
Tried to run `.\gradlew assembleDebug` in the `android` directory.
The build failed with `SDK location not found` because the automated testing environment does not have the Android SDK or Android Studio installed.
```
> Configure project :app
WARNING: Using flatDir should be avoided because it doesn't support any meta-data formats.

> Configure project :capacitor-cordova-android-plugins
WARNING: Using flatDir should be avoided because it doesn't support any meta-data formats.

FAILURE: Build failed with an exception.

* What went wrong:
Could not determine the dependencies of task ':app:compileDebugJavaWithJavac'.
> SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable or by setting the sdk.dir path in your project's local properties file at 'C:\Users\Narachat\twinpet-pos\android\local.properties'.
```

### 5.5. Native Runtime (Firebase Auth / POS route): NOT VALIDATED
No emulator or device available. Native WebView runtime was not executed. Validation is strictly limited to the packaging and sync logic.

### 5.6. Browser/PWA Build Preservation: PASS
Running `npm run build` after Capacitor setup continues to produce a clean web build without errors. No native-only logic leaked into the PWA.

## 6. Packaging Hygiene Note
- `android/.gradle/` must not be force-added.
- `android/app/build/` must not be force-added.
- `.claude/` must remain excluded from commits and package handoff.
- Ignored Android build/cache artifacts must remain ignored.

## 7. Files Changed / Added
- `package.json`
- `package-lock.json`
- `capacitor.config.ts` (added)
- `android/` (directory added)

## 8. Deferred Items
- **SQLite/native storage**: NOT INSTALLED.
- **Hardware plugins**: NOT INSTALLED.
- **Signing/app store pipelines**: NOT CONFIGURED.
- **iOS work**: NOT CONFIGURED.
