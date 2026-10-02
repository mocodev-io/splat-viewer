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
- **Focus**: *manual* or *auto*, as on a camera.
  - *Manual*: **Focus m** (0.1–50 m) is the focus ring.
  - *Auto* (continuous AF, with DoF on): the camera keeps focusing on what
    is under the AF point, the frame in the image. A click in the image
    moves the AF point, **AF center** puts it back (and switches to auto).
    It measures only when the camera, the AF point or the scene changed,
    at most four times a second, and moves the focus to each new distance
    in **AF transition s** (0 is instant, longer is a slow focus pull).
    Switching back to manual keeps the distance it reached.
  - The distance is the depth of the splat or object under the point (the
    engine's picker) along the view direction, as a real focus plane is.
- **Depth of field** works like a real lens: when the camera stands still,
  the scene is rendered from many points spread over the aperture (its
  size is focal length / f-stop) with the focus plane held in place, and
  the images are averaged (accumulation-buffer DoF, Haeberli & Akeley
  1990), in linear HDR before tone mapping, as a sensor collects light.
  Occlusion, blurred edges that turn see-through, bright bokeh and the
  soft splat edges all come out right without any depth tricks. One
  sample is added per frame; the HUD shows the progress (`still 12/48`).
  While the camera moves, a quick single-pass approximation stands in
  (the thin-lens circle of confusion `c = f² / (N·(S − f)) · |d − S| / d`,
  gathered in the compose shader).
- The still starts as soon as the image stops moving: the camera counts
  as still when the image shifts less than 0.1 px from one frame to the
  next, so the eased-out tail of the camera controls does not hold it up
  (it starts over once the image drifts more than half a pixel). Three
  things keep the build-up calm:
  - the lens points come in mirrored pairs and the still is shown after
    each whole pair, so they always average out at the centre of the lens
    and an out-of-focus object stays in its place instead of wandering by
    up to its blur radius while samples come in;
  - an *over-blur* on top of the average, as in Blender EEVEE: the quick
    DoF with each blur circle scaled to 1.5 / √n after n samples (at most
    the full blur), about the gap between the lens points, so a few
    samples do not show as stepped copies along sharp edges. A little of
    it stays in the finished still (0.2 of the blur at medium), which
    softens bokeh edges slightly;
  - the over-blur uses the depth of the last moving frame (kept every
    frame), not the depth of each aperture sample, which is shifted with
    its lens point and would make the over-blur shake.
- The quick DoF turns its sample pattern per pixel (interleaved gradient
  noise), so a large blur shows a fine grain rather than stepped lines,
  and reaches up to 6 % of the image height, close to what the still
  shows.
- **Still quality** is the number of aperture samples: low 16, medium 48,
  high 128. More samples give smoother bokeh and take longer to finish.
- **Bokeh** (with DoF on) is the shape of the aperture the still is
  rendered over, so the out-of-focus highlights take exactly that shape:
  - **Aperture**: round, or a diaphragm of 5–9 blades with its corners on
    the f-stop circle (as in Blender); **Roundness** bends the blades out
    towards a circle (curved blades), **Rotation °** turns them;
  - **Anamorphic** (1–2) squeezes the shape into an upright oval, the look
    of an anamorphic lens;
  - **Cat's eye** (0–1): towards the corners the lens barrel cuts part of
    the aperture away (mechanical vignetting), so the bokeh there turns
    into ovals along the circle around the centre, the "swirl" of lenses
    like the Helios 44. It is exact per pixel; the corners get fewer
    effective samples, so they are a little grainier at low quality.

  The quick DoF while the camera moves stays round.
- When nothing changes the viewer stops rendering: after the still is
  finished, or after a second without lens DoF. The HUD shows `idle`; any
  change (camera, panel, focus, window size) starts rendering again.
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
the effects work with, or the blur each pixel gets (red behind the focus
plane, green in front of it or spilled over from it, dark where it is
sharp). *Depth range* sets how the depth view shows depth: *camera
near/far* is the engine's view (linear from the near to the far clip, so a
room only uses a small part of the grey scale); *scene linear* and *scene
inverse* normalize it from the nearest to the farthest depth in the image
(z-depth normalize), linearly or by 1 / depth, which shows more detail
close by. White is no depth: nothing there.
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
  viewer/lensDof.ts        quick DoF while moving, debug depth views (compose shader)
  viewer/stillFrames.ts    HDR accumulation for the still DoF (inside CameraFrame), presenting
  viewer/useStillDof.ts    moving / still / idle, aperture samples for the camera
  viewer/aperture.ts       aperture shapes (blades, anamorphic) and evenly spread lens points
  viewer/AutoFocus.tsx     continuous autofocus and the AF point
  viewer/ScenePointer.tsx  clicks in the image: AF point, measuring
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
- The engine's DoF blends a pre-blurred image over the sharp one, which
  looks harsh, and cannot spread a blurred foreground over the background.
  The viewer replaces its compose function (`composeDofPS`, through the
  engine's ShaderChunks API) with its own gather; the engine's DoF stays on
  only for the scene depth and that hook, with its own blur passes at their
  cheapest. When bumping the engine, check that chunk still has the same
  place in the compose shader.
- The still DoF averages the aperture samples in linear HDR, inside
  CameraFrame: a pass of its own runs right after the scene pass and the
  bloom downsample, the engine's DoF passes and the compose pass read the
  average instead of the scene texture. Bright highlights spread over a
  bokeh disc stay bright, and tone mapping, grading, vignette, sharpening
  and bloom work on the averaged image. This relies on the engine's
  `FramePassCameraFrame` internals (its scene pass, `frameUpdate` and the
  passes reading the scene texture); check them when bumping the engine.
  Each aperture sample is a full render: quality is a trade between
  smoothness and time.
- Splat edges are soft. The splat scene depth is accumulated with the same
  premultiplied blending as the colour: per pixel the coverage-weighted
  sum of 1 / depth, plus the uncovered rest times the value it is cleared
  to (1 / far clip). Left like that, a soft edge against empty space is
  dragged towards the far clip. The camera therefore clears the scene
  alpha to 0, so the alpha ends up as the coverage A, and the DoF takes the
  rest off again and divides by A: `depth = A / (stored − (1 − A) / far)`.
  The rim of an object then has the object's own depth up to where its
  coverage runs out, against empty space as well as in front of something.
  That needs an image format with alpha, so with lens DoF on the scene
  renders in rgba16 (as with **High precision**); rg11b10 has no alpha,
  reads as full coverage and gives the plain average. Glass objects change
  the alpha without writing depth, so the depth behind glass is a little
  off. Autofocus and measuring use the engine's picker, which renders its
  own pass, so they are not affected.
- Where a soft edge lies in front of something, its depth is a mix of the
  two surfaces and can land exactly on the focus plane. The quick DoF
  therefore also spreads the blur of a nearer object over a band of about
  1 % of the image height, so its soft rim blurs with it instead of leaving
  a sharp, dark seam. An object in focus has no blur to spread and keeps a
  crisp edge.
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
