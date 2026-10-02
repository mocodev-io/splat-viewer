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
  -v /path/to/splats:/splats:ro \
  -v /path/to/luts:/luts:ro \
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
      - /path/to/splats:/splats:ro
      - /path/to/luts:/luts:ro
    restart: unless-stopped
```

### Splats folder

The viewer lists these; pick one and press **Load** (**Unload** frees the memory again):

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
| M | measure: click two points |
| H | hide interface |
| ? | help |

Touch works too: one finger looks or orbits, two fingers pinch and pan.

## What's in the panel

- **Camera:** focal length in mm on a chosen sensor (full frame, Super 35,
  APS-C, Micro 4/3), dolly zoom (vertigo), roll, true fisheye projection of
  the splats, move/look speed, smoothing, auto-orbit drift.
- **Camera shake:** handheld, walk, run, vehicle and earthquake, with amount
  and speed.
- **Lens:** autofocus (click or continuous centre) with focus pull speed,
  barrel/pincushion distortion, chromatic aberration, anamorphic streaks,
  lens dirt, and thin-lens depth of field: the blur follows from focal
  length, f-stop (down to f/0.5, beyond real lenses), focus distance and
  sensor, in front of and behind the focus plane. Blurred foreground spills
  over sharp background, highlights turn into bokeh, chromatic aberration
  blurs along. Bokeh shape: round, hexagon, octagon, anamorphic, swirl.
- **Measure (M):** click two points, enter their real length, and *Set scale*
  fills in **Scene → Meters per unit**, so the lens maths knows the real size
  of the scene. Do this once per scene.
- **Light:** exposure, tone mapping (ACES, ACES2, Filmic, Hejl, Neutral,
  Linear), bloom, halation, light leaks, ambient occlusion.
- **Fog & sun:** volumetric height fog, with optional light shafts through
  the splats.
- **Colour:** LUT looks, brightness/contrast/saturation/tint,
  shadows/midtones/highlights, vibrance, dehaze.
- **Vignette:** intensity, shape, colour.
- **Film:** grain (animated or fixed), flicker, gate weave, sharpen,
  temporal AA.
- **Stylize:** motion blur (shutter-based, independent of framerate),
  letterbox aspect ratios, looks (duotone, thermal, night vision, halftone,
  ascii), pixelate, posterize, oil paint, outlines, paper, glitch, CRT.
- **Presets:** Cinematic, Dream, VHS, Noir, Found footage, Comic, Oil paint,
  Sketch, Thermal, Night vision, Terminal, Vertigo. Presets don't touch your
  move/look speed or smoothing.
- **Export / import settings** as JSON.

## Performance

The same viewer has to run on a 4K desktop GPU and on integrated graphics at
1080p. Under **Performance**:

- **Quality** (low / medium / high / ultra) sets the sample counts of lens
  DoF and motion blur, fog and AO quality, how many tiny splats are skipped,
  and whether HiDPI displays render at full pixel density (high: up to 1.5x,
  ultra: 2x; low and medium always 1x).
- **Resolution: auto** scales the whole pipeline (splats and every effect)
  to hold the target fps; the HUD shows the current scale. **Fixed** lets
  you pick the scale yourself.

The biggest costs, roughly in order: lens DoF (cheap where the image is
sharp), light shafts, oil paint, chromatic aberration together with lens DoF,
SSAO. The splat count itself matters too; a `.sog` export with fewer splats
and SH bands 0 helps weak GPUs most.

Effects marked as needing bloom (halation, anamorphic streaks, lens dirt)
switch bloom on in the background when used.

## How it works

The engine's `CameraFrame` handles bloom, fog, SSAO, TAA, grading, LUT and
vignette. `src/compose.js` replaces the engine's final compose shader with a
copy that adds the lens (thin-lens DoF, chromatic aberration), camera and
stylize stages around the engine's own steps. Every effect is switched by a
uniform, so toggling an effect never recompiles a shader.

DoF and motion blur read the depth the splats write. The engine only renders
that depth for its own effects, so `post.js` adds one more reason to the
engine's option check; it never falls back to a depth prepass, which would
render every splat twice.

```
src/
  main.js      app setup, splat loading, frame loop
  camera.js    camera rig: controls, shake, dolly zoom, autofocus, motion data
  post.js      settings -> CameraFrame + compose uniforms, lens maths
  measure.js   measure tool and its overlay
  compose.js   the compose shader
  luts.js      built-in looks, .cube / PNG LUT loading
  perf.js      quality levels, auto resolution
  settings.js  defaults and presets
  ui.js        lil-gui panel
```

## Develop

```sh
npm ci
npm run build                  # writes dist/
docker build -t splat-viewer .
```

`dist/` needs nginx (see `nginx.conf`), which also serves `/splats` and
`/luts` from outside the site. The splat and LUT pickers read the folder
listing as JSON (`autoindex_format json`).

### Updating PlayCanvas

The engine version is pinned in `package.json` on purpose, because
`src/compose.js` is a modified copy of the engine's compose shader. When you
bump the version, diff the engine's
`build/playcanvas/src/scene/shader-lib/glsl/chunks/render-pass/frag/compose/compose.js`
against the old one and carry the changes over.

WebGL2 only. The compose shader is GLSL.

## License

MIT
