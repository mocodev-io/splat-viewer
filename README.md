# splat-viewer

A self-hosted browser viewer for 3D Gaussian splats, built on
[PlayCanvas React](https://developer.playcanvas.com/user-manual/react/).
It is rebuilt from scratch in small steps; this is step 1, the basis.
The first version lives in the git history (before commit "Clean restart").

## Run

```yaml
services:
  splat-viewer:
    image: ghcr.io/mocodev-io/splat-viewer:latest
    ports:
      - "8096:80"
    volumes:
      - /path/to/splats:/splats:ro
    restart: unless-stopped
```

Open `http://<host>:8096`, pick a splat and press **Load**. **Unload** frees
it again.

### The splats folder

- `*.ply`, `*.compressed.ply`, `*.sog`
- folders with unbundled SOG or LOD streaming output (`meta.json` /
  `lod-meta.json`)

Each splat can have a **scene settings file** next to it: `scene.json` for
`scene.sog` / `scene.ply`, or `settings.json` inside a SOG / LOD folder.
That file is SuperSplat's *Experience Settings v2*, the JSON that
[SuperSplat Studio](https://developer.playcanvas.com/user-manual/supersplat/studio/)
writes, so a scene prepared there opens here with the same start camera,
tone mapping, background and post effects. Without a settings file the
viewer frames the splat itself.

## Controls

The engine's own `CameraControls` script: left drag orbits, right drag or
W A S D flies, middle / shift drag pans, the wheel zooms.

## How it is put together

```
src/
  App.tsx                  state: which splat, its settings, the view
  scene/experience.ts      Experience Settings v2: types, defaults, ranges, loader
  scene/splats.ts          the /splats folder listing
  viewer/SplatSetup.tsx    scene-wide splat settings
  viewer/Splat.tsx         one loaded splat; unmounting frees it
  viewer/ViewerCamera.tsx  camera, CameraControls, CameraFrame (post effects)
  viewer/FrameStats.tsx    fps / status line
  ui/panel.ts              Leva panel
```

Principles this is built on:

- **Every element has a depth.** Splats write theirs in the scene pass
  (`app.scene.gsplat.sceneDepthWrite`, engine PR #9174), so depth-based
  effects (DoF, fog, SSAO) and opaque meshes added later work together with
  them. That rules out MSAA.
- **Engine first.** Camera and post-processing are the engine's ready-made
  `CameraControls` and `CameraFrame` scripts. Own effects will extend the
  engine's compose shader through its hooks or add a render pass, not
  replace it.
- **Scene data in a known format.** Experience Settings v2, with our own
  additions under `extras` (which SuperSplat ignores).

Next steps, each small and with its own reference: 3D React objects in the
scene, labels as DOM overlays, the lens (focal length, f-stop, DoF).

Notes:

- `@playcanvas/react` selects the engine's deprecated legacy splat renderer
  unless `unified` is set on `<GSplat>`; the viewer sets it.
- Unlike the SuperSplat viewer, colours stay in linear HDR through the post
  effects (SuperSplat keeps splats in gamma space), which is what physically
  based effects such as DoF and bloom expect.
- `@playcanvas/react` registers the Draco mesh decoder from Google's CDN,
  loaded only if a Draco-compressed model is ever used.

## Develop

```sh
npm ci
npm run dev                                   # http://localhost:5173
SPLATS_URL=http://<host>:8096 npm run dev     # use a running viewer's splats
npm run typecheck && npm run build
```

## References

- [PlayCanvas: Gaussian splatting manual](https://developer.playcanvas.com/user-manual/gaussian-splatting/)
- [PlayCanvas React](https://developer.playcanvas.com/user-manual/react/) and
  [its splat tutorial](https://developer.playcanvas.com/user-manual/gaussian-splatting/building/your-first-app/react/)
- [CameraFrame API](https://api.playcanvas.com/engine/classes/CameraFrame.html)
- [Splat depth for post effects (engine issue #7484)](https://github.com/playcanvas/engine/issues/7484)
- [SuperSplat viewer](https://github.com/playcanvas/supersplat-viewer): settings schema in `src/schemas/`

## License

MIT
