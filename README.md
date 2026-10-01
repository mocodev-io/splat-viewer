# splat-viewer

A self-hosted browser viewer for 3D Gaussian splats, with a camera emulator and a
large stack of post effects. It runs in real time on the
[PlayCanvas engine](https://github.com/playcanvas/engine), the same renderer as
SuperSplat. It is a viewer and playground only, with no splat editing.

Everything renders in the browser of whoever is watching. The container only
serves static files.

## Run

```sh
docker run -d --name splat-viewer \
  -p 8096:80 \
  -v /path/to/splats:/usr/share/nginx/html/splats:ro \
  -v /path/to/luts:/usr/share/nginx/html/luts:ro \
  ghcr.io/mocodev-io/splat-viewer:latest
```

Then open `http://<host>:8096`.

Or with compose:

```yaml
services:
  splat-viewer:
    image: ghcr.io/mocodev-io/splat-viewer:latest
    ports:
      - "8096:80"
    volumes:
      - /path/to/splats:/usr/share/nginx/html/splats:ro
      - /path/to/luts:/usr/share/nginx/html/luts:ro
    restart: unless-stopped
```

### Splats folder

The viewer lists these automatically:

- `*.ply`: standard 3DGS output, and SuperSplat's compressed `.compressed.ply`
- `*.sog`: bundled SOG
- `<folder>/meta.json`: unbundled SOG
- `<folder>/lod-meta.json`: LOD streaming output

For big scenes, export a compressed format from SuperSplat. It loads many
times faster than a raw `.ply`.

Most COLMAP-based trainers export upside down. **Scene → Flip upside down**
is on by default; turn it off if your scene comes out inverted.

### LUTs folder (optional)

Ten looks are built in. You can add your own:

- `.cube` 3D LUTs, any size
- PNG strips of `N²×N`, such as `256×16` or `1024×32`

## Controls

| Input | Action |
| --- | --- |
| Drag | look (fly) / orbit around pivot (orbit) |
| Right drag / shift drag | pan |
| W A S D, Q E | move, down / up |
| Shift / Ctrl | fast / slow |
| Wheel | move speed (fly) / zoom (orbit) |
| Z / C | roll |
| Click | focus on that point (autofocus: click) |
| Double-click | orbit around that point and focus there |
| O | fly / orbit |
| V | dolly zoom |
| R | reset camera |
| H | hide interface |
| ? | help |

Touch works too: one finger looks or orbits, two fingers pinch and pan.

## What's in the panel

- **Camera:** field of view, dolly zoom (vertigo), roll, true fisheye
  projection of the splats, move/look speed, smoothing, auto-orbit drift.
- **Camera shake:** handheld, walk, run, vehicle and earthquake, with amount
  and speed.
- **Lens:** autofocus (click or continuous centre) with focus pull speed,
  depth of field with bokeh size and foreground blur, barrel/pincushion
  distortion, chromatic aberration, anamorphic streaks, lens dirt.
- **Light:** exposure, tone mapping (ACES, ACES2, Filmic, Hejl, Neutral,
  Linear), bloom, halation, light leaks, ambient occlusion.
- **Fog & sun:** volumetric height fog, with optional light shafts through
  the splats.
- **Colour:** LUT looks, brightness/contrast/saturation/tint,
  shadows/midtones/highlights, vibrance, dehaze.
- **Vignette:** intensity, shape, colour.
- **Film:** grain, flicker, gate weave, sharpen, temporal AA.
- **Stylize:** motion blur (shutter-based, independent of framerate),
  letterbox aspect ratios, looks (duotone, thermal, night vision, halftone,
  ascii), pixelate, posterize, oil paint, outlines, paper, glitch, CRT.
- **Presets:** Cinematic, Dream, VHS, Noir, Found footage, Comic, Oil paint,
  Sketch, Thermal, Night vision, Terminal, Vertigo. Presets don't touch your
  move/look speed or smoothing.
- **Export / import settings** as JSON.

Effects marked as needing bloom (halation, anamorphic streaks, lens dirt)
switch bloom on in the background when used.

## How it works

The engine's `CameraFrame` handles bloom, DoF, fog, SSAO, TAA, grading, LUT
and vignette. `src/compose.js` replaces the engine's final compose shader
with a copy that adds the camera and stylize stages around the engine's own
steps. Every effect is switched by a uniform, so toggling an effect never
recompiles a shader.

```
src/
  main.js      app setup, splat loading, frame loop
  camera.js    camera rig: controls, shake, dolly zoom, autofocus, motion data
  post.js      settings -> CameraFrame + compose uniforms
  compose.js   the compose shader
  luts.js      built-in looks, .cube / PNG LUT loading
  settings.js  defaults and presets
  ui.js        lil-gui panel
```

## Develop

```sh
npm ci
npm run build                  # writes dist/
docker build -t splat-viewer .
```

`dist/` needs nginx (see `nginx.conf`). The splat and LUT pickers read the
folder listing as JSON (`autoindex_format json`).

### Updating PlayCanvas

The engine version is pinned in `package.json` on purpose, because
`src/compose.js` is a modified copy of the engine's compose shader. When you
bump the version, diff the engine's
`build/playcanvas/src/scene/shader-lib/glsl/chunks/render-pass/frag/compose/compose.js`
against the old one and carry the changes over.

WebGL2 only. The compose shader is GLSL.

## License

MIT
