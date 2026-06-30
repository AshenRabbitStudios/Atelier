# ELECTRON_BUILD.md — Process model, security, packaging, bring-up

Concrete Electron specifics: how to scaffold, wire the secure main/preload/renderer
split, add native menus and file I/O, export images, bundle assets offline, and ship
installers. Assumes the **electron-vite + React + TypeScript + three** stack from
the README.

---

## 1. Scaffold

```bash
npm create @quick-start/electron@latest neural-hologram -- --template react-ts
cd neural-hologram
npm i
npm i three
npm i -D @types/three
```

This yields the standard `electron-vite` layout: `src/main`, `src/preload`,
`src/renderer`, plus `electron.vite.config.ts` and an `electron-builder.yml`. Get the
blank window running (`npm run dev`) before porting anything.

---

## 2. Main process — window + lifecycle (`src/main/index.ts`)

```ts
import { app, BrowserWindow, shell } from 'electron';
import { join } from 'path';
import { registerIpc } from './ipc';
import { buildMenu } from './menu';

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 700,
    backgroundColor: '#03070d',                 // matches scene; no white flash
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,      // ★ required
      nodeIntegration: false,      // ★ required
      sandbox: true,               // keep on; all Node work happens in main via IPC
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

app.whenReady().then(() => {
  registerIpc();
  const win = createWindow();
  buildMenu(win);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
```

GPU note: WebGL + bloom is fine under Electron's default GPU. Do **not** disable
hardware acceleration.

---

## 3. Security baseline (do not skip)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- The renderer touches the filesystem **only** through the preload `window.api`
  bridge → IPC → main. No `fs`/`path` in the renderer.
- Ship a strict **CSP** (renderer `index.html` meta). Because all assets are bundled
  (no CDN), you can be tight:
  ```html
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; img-src 'self' data: blob:;
                 style-src 'self' 'unsafe-inline'; font-src 'self';
                 script-src 'self'; connect-src 'self'">
  ```
  (`'unsafe-inline'` for styles is needed because the HUD uses inline styles; scripts
  stay `'self'`.)
- Validate every IPC payload in main. File dialogs originate in main, not renderer.

---

## 4. Preload bridge (`src/preload/index.ts`)

Expose a minimal, typed API. Nothing else crosses the boundary.

```ts
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  openModel:  (): Promise<{ name: string; json: string } | null> => ipcRenderer.invoke('model:open'),
  saveModel:  (name: string, json: string): Promise<boolean>      => ipcRenderer.invoke('model:save', { name, json }),
  exportPng:  (dataUrl: string): Promise<boolean>                 => ipcRenderer.invoke('export:png', dataUrl),
  loadSettings: (): Promise<Record<string, unknown>>             => ipcRenderer.invoke('settings:load'),
  saveSettings: (s: Record<string, unknown>): Promise<void>      => ipcRenderer.invoke('settings:save', s),
  onMenu:     (cb: (action: string) => void) => ipcRenderer.on('menu', (_e, a) => cb(a)),
};
contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;     // import into renderer for window.api typing
```

Add `declare global { interface Window { api: Api } }` in a renderer `.d.ts`.

---

## 5. File I/O + IPC (`src/main/ipc.ts`)

```ts
import { ipcMain, dialog, app } from 'electron';
import { readFile, writeFile } from 'fs/promises';
import { basename, join } from 'path';

export function registerIpc() {
  ipcMain.handle('model:open', async () => {
    const r = await dialog.showOpenDialog({
      filters: [{ name: 'Neural Architecture', extensions: ['nnviz', 'json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const json = await readFile(r.filePaths[0], 'utf8');
    return { name: basename(r.filePaths[0]), json };
  });

  ipcMain.handle('model:save', async (_e, { name, json }) => {
    const r = await dialog.showSaveDialog({ defaultPath: `${name}.nnviz.json` });
    if (r.canceled || !r.filePath) return false;
    await writeFile(r.filePath, json, 'utf8');
    return true;
  });

  ipcMain.handle('export:png', async (_e, dataUrl: string) => {
    const r = await dialog.showSaveDialog({ defaultPath: 'hologram.png' });
    if (r.canceled || !r.filePath) return false;
    await writeFile(r.filePath, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return true;
  });

  const settingsPath = join(app.getPath('userData'), 'settings.json');
  ipcMain.handle('settings:load', async () => {
    try { return JSON.parse(await readFile(settingsPath, 'utf8')); } catch { return {}; }
  });
  ipcMain.handle('settings:save', async (_e, s) => { await writeFile(settingsPath, JSON.stringify(s)); });
}
```

Renderer usage: `const f = await window.api.openModel(); engine.loadScene(JSON.parse(f.json))`.
Persist tweaks via `settings:load/save`.

---

## 6. High-resolution image (and later, video) export

The bloom canvas needs care (see ARCHITECTURE §12):

1. Create the renderer with `preserveDrawingBuffer: true` **or** render on demand
   right before capture.
2. To export larger than the window, temporarily bump size and pixel ratio, render,
   capture, then restore:

```ts
export async function capturePng(engine: Hologram, w = 3840, h = 2160): Promise<string> {
  const { renderer, composer, camera } = engine;
  const old = renderer.getSize(new THREE.Vector2());
  const oldPR = renderer.getPixelRatio();
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  composer.render();
  const dataUrl = renderer.domElement.toDataURL('image/png');
  // restore
  renderer.setPixelRatio(oldPR);
  renderer.setSize(old.x, old.y, false);
  composer.setSize(old.x, old.y);
  camera.aspect = old.x / old.y; camera.updateProjectionMatrix();
  return dataUrl;
}
```

Then `window.api.exportPng(dataUrl)`. **Video** (stretch): drive a scripted
auto-rotate, grab `canvas.captureStream(60)` into `MediaRecorder` → WebM, write the
blob via an IPC handler.

---

## 7. Offline assets (no CDN)

The prototype loads Three.js via an importmap and fonts via Google Fonts. **Both must
be vendored:**

- **Three.js**: `import * as THREE from 'three'` and addons from
  `three/examples/jsm/...`. Vite bundles them. Remove the `<script type="importmap">`.
- **Fonts**: download Rajdhani (400/500/600/700) and IBM Plex Mono (400/500) as
  woff2 into `src/renderer/assets/fonts/` and declare:
  ```css
  @font-face { font-family:'Rajdhani'; font-weight:600;
    src:url('./assets/fonts/Rajdhani-SemiBold.woff2') format('woff2'); font-display:swap; }
  /* …one per weight, plus IBM Plex Mono… */
  ```
  Keep `await document.fonts.ready` before building canvas labels.
- The `@keyframes` (`hscan`, `hpulse`, `spin`) and body resets are the only other
  global CSS; everything else stays inline on the HUD elements.

---

## 8. Native menu (`src/main/menu.ts`)

Map menu items to `webContents.send('menu', actionId)`; the renderer's `onMenu`
forwards to the engine/HUD.

```ts
import { Menu, BrowserWindow } from 'electron';
export function buildMenu(win: BrowserWindow) {
  const send = (a: string) => win.webContents.send('menu', a);
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [
      { label: 'Open Model…',  accelerator: 'CmdOrCtrl+O', click: () => send('open') },
      { label: 'Save Model…',  accelerator: 'CmdOrCtrl+S', click: () => send('save') },
      { label: 'Export Image…',accelerator: 'CmdOrCtrl+E', click: () => send('export') },
      { type: 'separator' }, { role: 'quit' } ] },
    { label: 'View', submenu: [
      { label: 'Transformer', accelerator: 'CmdOrCtrl+1', click: () => send('model:transformer') },
      { label: 'RNN',         accelerator: 'CmdOrCtrl+2', click: () => send('model:rnn') },
      { type: 'separator' },
      { label: 'Toggle Auto-Rotate', accelerator: 'CmdOrCtrl+R', click: () => send('toggle:autorotate') },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools' } ] },
    { role: 'help', submenu: [{ label: 'About Neural Hologram', click: () => send('about') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
```

Also map Esc → `goBack()` when in a detail view, and Esc → deselect otherwise
(handle in the renderer keydown).

---

## 9. Renderer bootstrap (`src/renderer/main.tsx`)

```tsx
import { createRoot } from 'react-dom/client';
import { Hologram } from './engine/Hologram';
import { App } from './hud/App';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const engine = new Hologram(canvas, { glow: 0.9, autoRotate: true, palette: 'Arc Reactor' });

createRoot(document.getElementById('hud')!).render(<App engine={engine} />);

// menu plumbing
window.api.onMenu((a) => {
  if (a === 'open')   doOpen(engine);
  if (a === 'save')   doSave(engine);
  if (a === 'export') doExport(engine);
  if (a === 'model:transformer') engine.setModel('transformer');
  if (a === 'model:rnn')         engine.setModel('rnn');
  if (a === 'toggle:autorotate') engine.toggleAutoRotate();
});
```

The HUD `App` subscribes to engine events (`select`, `viewchange`, `ready`) and
renders the panels from ARCHITECTURE §9. `#stage` (canvas) and `#hud` (overlay) are
stacked; `#hud` has `pointer-events:none` except on controls.

---

## 10. Packaging (`electron-builder.yml`)

```yaml
appId: com.yourorg.neuralhologram
productName: Neural Hologram
directories: { output: dist, buildResources: resources }
files: ['out/**/*']            # electron-vite build output
mac:
  category: public.app-category.education
  target: [dmg, zip]
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: resources/entitlements.mac.plist
  notarize: true               # requires Apple ID / API key in CI env
win:
  target: [nsis]
linux:
  target: [AppImage, deb]
  category: Education
```

- **Icons**: `resources/icon.icns` (mac), `icon.ico` (win), `512x512.png` (linux).
- **macOS signing/notarization**: Developer ID cert + notarytool creds in CI env
  vars; bloom/WebGL needs no special entitlements (standard hardened runtime is fine).
- **Auto-update (optional)**: add `electron-updater` + a `publish` block (GitHub
  Releases or S3); call `autoUpdater.checkForUpdatesAndNotify()` on launch.

Build: `npm run build && npx electron-builder --mac --win --linux` (each platform
ideally built on its own OS / CI runner).

---

## 11. Performance & robustness

- Cap `renderer.setPixelRatio(Math.min(devicePixelRatio, 2))`.
- **Pause** the rAF loop on `document.visibilityState === 'hidden'` and on window
  blur (optional) to save battery/GPU.
- Dispose thoroughly when swapping scenes and on `dispose()` (geometries, materials,
  sprite textures). The prototype under-disposes; fix it here.
- Guard interactions during a camera tween (already the pattern: ignore clicks while
  `this.tween` is set).
- Handle WebGL context loss (`canvas.addEventListener('webglcontextlost', …)`):
  prevent default, then rebuild the renderer/scene.

---

## 12. Bring-up checklist

1. [ ] Blank secure window renders (`npm run dev`), `#03070d` background, no white flash.
2. [ ] `three` imported from npm; importmap removed.
3. [ ] Fonts vendored; `document.fonts.ready` resolves; labels crisp.
4. [ ] `engine/` ported: scene, glyphs, labels, navigation, loop, `dispose`.
5. [ ] `data/` ported: `getModel`, `getDetail`, schema types; both architectures render.
6. [ ] HUD in React: title/subtitle, model switch, **Back**, inspector, tweaks, hints, loader.
7. [ ] Single-click inspects; **double-click drills in with fly-through**; Back flies out.
8. [ ] Tweaks (glow/auto-rotate/palette) live + persisted via settings IPC.
9. [ ] Native menu + accelerators (Open/Save/Export, model switch, fullscreen, Esc=back).
10. [ ] Open/Save `.nnviz.json`; PNG export at 4K.
11. [ ] Window resize, visibility-pause, context-loss handled; no GPU leak on repeated open/close.
12. [ ] `electron-builder` produces signed installers on mac/win/linux; smoke-tested.

When all boxes are checked you have feature parity with the prototype **plus** the
desktop capabilities (files, offline, export, menus) that justify Electron.
