# splat-viewer

A self-hosted browser viewer for 3D Gaussian splats, built on
[PlayCanvas React](https://developer.playcanvas.com/user-manual/react/).
It is rebuilt from scratch in small steps.
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

**Save settings** (Splat folder) downloads the current look, view and lens as
such a file, keeping anything else the loaded file had (annotations, tracks,
other extras). Put it next to the splat.

### The lens

The camera is a physical one: sensor, focal length, f-stop and focus
distance, no separate field of view.

- **Sensor**: Full frame, Super 35, APS-C, Micro 4/3 or Custom. The sensor
  width spans the image width (like Blender's default), so the angle of view
  is `2·atan(sensor width / 2·focal length)`.
- **Focus m** is in meters (0.1–50). **Double-click** in the image focuses
  on what is there, **Focus center** on what is in the middle of the image.
  Both read the depth of the splat or object under that point (the
  engine's picker) and measure it along the view direction, as a real
  focus plane is.
- **Depth of field** follows the thin-lens formula, the circle of confusion
  `c = f² / (N·(S − f)) · |d − S| / d`, so f-stop, focal length and focus
  distance act as on a real camera, in front of the focus plane as well as
  behind it.
- **Blur quality** caps the blur radius (low 1.2 %, medium 2.2 %, high 3.5 %
  of the image height) at what the engine's blur can sample smoothly. A
  long lens wide open hits that cap; that is the limit, not a fault.
- **Scale**: splats have no scale of their own, and the DoF needs one.
  Press **Measure**, click both ends of something of known size (a door is
  about 2 m), enter that size as **Real length m** and press **Apply
  scale**; **Meters / unit** follows. Esc stops measuring, a third click
  starts a new measurement.

The lens is saved under `extras.lens`. The `fov` in `cameras` stays filled
(the vertical angle over the sensor height) so SuperSplat still reads the
file; a file without a lens, from SuperSplat say, gets the focal length
that matches its `fov`.

### Objects in the scene

Our additions live under `extras`, which SuperSplat ignores:

```json
"extras": {
  "objects": [
    {
      "id": "pillar",
      "type": "cylinder",
      "position": [1.6, 0.6, -2.0],
      "rotation": [0, 0, 0],
      "scale": [0.3, 1.2, 0.3],
      "material": {
        "color": [0.9, 0.75, 0.2],
        "opacity": 1,
        "emissive": [0, 0, 0],
        "metalness": 0.2,
        "gloss": 0.6,
        "writeDepth": true
      }
    }
  ],
  "lighting": {
    "ambient": { "color": [1, 1, 1], "intensity": 0.35 },
    "sun": { "color": [1, 0.96, 0.9], "intensity": 1.2, "yaw": 30, "pitch": -45 }
  }
}
```

- `type`: box, sphere, cylinder, cone, capsule, plane, torus. Positions are
  in world space, after the splat's orientation.
- Colours are 0..1 rgb, rotations euler degrees.
- `opacity` below 1 makes an object transparent.
- `writeDepth` decides whether depth-based effects (DoF, fog, SSAO) see the
  object. Opaque objects do by default; transparent ones don't, so those
  effects look through glass to the splats behind it. Set it to `true` for
  a transparent object that should count as solid.
- Splats are unlit and objects are lit, so objects need `lighting`; without
  it a default ambient light and sun are used. The light has no effect on
  the splats.

**Debug** (collapsed in the panel): *View* shows the image, the scene depth
the effects work with, or the blur amount (the circle of confusion: red
behind the focus plane, green in front of it, dark where it is sharp).
*Test objects* puts an opaque box and a glass sphere where the start view
looks, to check how objects and splats cover each other.

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
  viewer/SceneObjects.tsx  objects and their lighting from the scene data
  viewer/ViewerCamera.tsx  camera, CameraControls, CameraFrame (post effects, lens)
  viewer/physicalDof.ts    thin-lens circle of confusion for the engine's DoF
  viewer/ScenePointer.tsx  clicks in the image: double-click focus, measuring
  viewer/MeasureOverlay.tsx the measuring line
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

Next step, small and with its own reference: labels as DOM overlays (the
annotations already in Experience Settings v2).

Notes:

- `@playcanvas/react` selects the engine's deprecated legacy splat renderer
  unless `unified` is set on `<GSplat>`; the viewer sets it.
- Its `useMaterial` hook drops `blendType` and `depthWrite`, so objects use
  a plain engine material instead.
- A material that does not write scene depth but is rendered opaquely
  leaves a "far away" hole in the depth; transparency and `writeDepth`
  therefore always go together here.
- The engine's DoF blurs along a straight ramp between two distances. Its
  small CoC shader (`RenderPassCoC`, engine 2.23) is swapped for the
  thin-lens formula; blur, near / far handling and quality stay the
  engine's. This touches engine internals, which is why the engine version
  is pinned. Near blur is always on; the engine lets a blurred foreground
  edge spread only partly over a sharp background.
- A new engine `Picker` returns a wrong point for its very first pick (seen
  with splats); the viewer picks twice the first time.
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
- [Circle of confusion (thin lens)](https://en.wikipedia.org/wiki/Circle_of_confusion)
- [Splat depth for post effects (engine issue #7484)](https://github.com/playcanvas/engine/issues/7484)
- [SuperSplat viewer](https://github.com/playcanvas/supersplat-viewer): settings schema in `src/schemas/`

## License

MIT
