// Accumulated depth of field for a still camera.
//
// A real lens is a collection of pinhole cameras spread over its aperture,
// all aimed so that the focus plane lines up. Rendering the scene from many
// points on the aperture and averaging the images gives exact depth of field
// (Haeberli & Akeley, "The Accumulation Buffer", SIGGRAPH 1990): occlusion,
// semi-transparent blurred edges, bokeh and soft splat edges all come out
// right by themselves, with no depth heuristics. The bokeh takes the shape of
// the aperture the points are spread over (aperture.ts).
//
// It costs one render per aperture sample, so it runs only while nothing
// changes: every frame adds one sample until the quality's count is reached,
// then the viewer stops rendering until something changes again. While the
// camera moves, the quick gather DoF (lensDof.ts) stands in.
//
// The samples are averaged in linear HDR, as a camera sensor collects light,
// before tone mapping and the other effects: a pass of our own runs inside
// CameraFrame right after the scene pass, adds the scene texture to `sum`
// and writes the average to `avg`; the bloom downsample, the engine's DoF
// passes and the compose pass then read `avg` instead of the scene texture.
// So a bright highlight spread over a bokeh disc stays bright, and tone
// mapping, grading, vignette, sharpening and bloom all work on the averaged
// image, in their own order. CameraFrame rebuilds its passes when its
// options change, so the hook is checked every frame.
//
// Cat's eye: off the optical axis, the lens barrel cuts part of the aperture
// away (mechanical vignetting), so a pixel towards the corner sees light only
// through the overlap of the aperture and a second disc shifted towards the
// centre. Its bokeh becomes a tangential oval, the "swirl" of lenses like the
// Helios 44. Each sample is a whole frame seen through one point of the lens,
// so this is exact per pixel: a sample counts for a pixel only where its lens
// point lies inside that pixel's disc. The sum keeps the weight in alpha and
// is divided by it; the brightness stays even (darker corners are the
// vignette effect's job).
//
// The over-blur on the average (useStillDof.ts) needs the scene depth, but
// each aperture sample sees the scene from another point of the lens, so its
// depth is shifted by up to the blur radius and the over-blur would shake
// from sample to sample. While the camera moves the pass therefore keeps the
// depth and coverage of every frame (`geo`, one copy); during the still they
// are put back into the scene depth after each sample, so the over-blur and
// the depth views see the unshifted view the still started from.
//
// The lens points come in symmetric groups of eight (aperture.ts), and the
// still shows whole groups only: each shown average is centred, round and of
// the right size. A new group eases in over a few frames (`display`) instead
// of switching at once, so the still refines as one calm sharpening; until
// the first group is in, the last moving frame stays on screen.
//
// The camera renders into `frame` (CameraFrame composes into it), and every
// frame is presented to the canvas from here. That last step also finishes
// the image as a camera would after its lens: lateral chromatic aberration
// and film grain, on the final image, the same for a moving view, a still
// building up and a finished one. The grain is never averaged into a still.
// It moves at film speed (24 new patterns a second at animation 1, slower
// below, fixed at 0), timed by the clock rather than by frames, so it moves
// the same while rendering, building up a still or idle: once the viewer
// stops rendering, only this last step is repeated (`refresh`).

import { APERTURE_GROUP } from './aperture';
import { frameRect, frameShape, type FrameTint, type Grain, type Viewport } from '../scene/experience';
import { resolveFilm, type FilmSettings } from '../scene/films';
import { composeReadsScene, type CameraFramePass } from './engine';
import {
    ADDRESS_CLAMP_TO_EDGE, BLENDEQUATION_ADD, BLENDMODE_ONE, BlendState, FILTER_LINEAR, FILTER_NEAREST,
    FramePass, PIXELFORMAT_RG32F, PIXELFORMAT_RGB10A2, PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F, RenderTarget, SEMANTIC_POSITION, ShaderUtils, Texture,
    drawQuadWithShader, type AppBase, type GraphicsDevice, type Shader
} from 'playcanvas';

// One aperture sample from the scene texture (linear HDR), weighted by the
// cat's eye mask, into the sum.
const accumulateGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform sampler2D still_scene;
    uniform vec4 still_lens;      // lens point (units of the f-stop radius), cat's eye shift at the corner, aspect
    void main() {
        float w = 1.0;
        if (still_lens.z > 0.0) {
            // pixel position, 1 at the image corner
            vec2 p = (uv0 * 2.0 - 1.0) * vec2(still_lens.w, 1.0) / length(vec2(still_lens.w, 1.0));
            float d = length(still_lens.xy + p * still_lens.z);
            // a soft edge, so neighbouring pixels do not switch samples in visible steps
            w = 1.0 - smoothstep(0.92, 1.08, d);
        }
        gl_FragColor = vec4(texture2D(still_scene, uv0).rgb * w, w);
    }
`;

// The weighted average, for the passes after the scene pass, written each
// time a whole group of samples is in (the still shows whole groups only),
// so it holds until the next one. Its alpha is the coverage of the held view
// (see `geo`), which the DoF needs to correct the splat depth (lensDof.ts)
// for the over-blur.
const averageGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform sampler2D still_sum;
    uniform sampler2D still_scene;
    uniform highp sampler2D still_geo;
    uniform float still_geoValid;
    void main() {
        vec4 sum = texture2D(still_sum, uv0);
        vec4 scene = texture2D(still_scene, uv0);
        // a corner pixel can still be without samples in the first few
        vec3 c = sum.a > 1e-3 ? sum.rgb / sum.a : scene.rgb;
        gl_FragColor = vec4(c, still_geoValid > 0.5 ? texture2D(still_geo, uv0).g : scene.a);
    }
`;

// The scene depth and coverage of a moving frame, kept for the still.
const captureGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform highp sampler2D still_depth;
    uniform sampler2D still_scene;
    void main() {
        gl_FragColor = vec4(texture2D(still_depth, uv0).r, texture2D(still_scene, uv0).a, 0.0, 0.0);
    }
`;

// The depth range of the image for the normalized depth view (lensDof.ts):
// nearest and farthest depth over a 32 x 32 grid, only where the coverage is
// above a half (a faint soft edge has an unreliable depth of its own), eased
// from the previous frame's range so the view does not jump as the grid
// lands on other surfaces while the camera moves. One pixel.
const rangeGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform highp sampler2D still_depth;
    uniform sampler2D still_scene;
    uniform highp sampler2D still_prev;
    uniform vec4 still_range;     // far, reciprocal depth (1) or linear (0), easing (0 takes the new range), -
    void main() {
        float far = still_range.x;
        float dMin = 1e30;
        float dMax = 0.0;
        for (int gy = 0; gy < 32; gy++) {
            for (int gx = 0; gx < 32; gx++) {
                vec2 g = (vec2(float(gx), float(gy)) + 0.5) / 32.0;
                float v = texture2DLod(still_depth, g, 0.0).r;
                float d = v;
                if (still_range.y > 0.5) {
                    float a = texture2DLod(still_scene, g, 0.0).a;
                    float s = v - (1.0 - a) / far;
                    d = a > 0.5 && s > 1e-7 ? min(a / s, far) : far;
                }
                if (d < far * 0.999) {
                    dMin = min(dMin, d);
                    dMax = max(dMax, d);
                }
            }
        }
        vec4 prev = texture2DLod(still_prev, vec2(0.5), 0.0);
        bool found = dMax > 0.0;
        bool eased = still_range.z > 0.0 && prev.b > 0.5;
        vec2 range = found ? vec2(dMin, dMax) : prev.rg;
        if (found && eased) range = mix(prev.rg, range, still_range.z);
        gl_FragColor = vec4(range, found || eased ? 1.0 : 0.0, 1.0);
    }
`;

// ... and put back into the scene depth for every aperture sample.
const restoreGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform highp sampler2D still_geo;
    void main() {
        gl_FragColor = vec4(texture2D(still_geo, uv0).r, 0.0, 0.0, 1.0);
    }
`;

// To the canvas: the composed frame, faded in over the held one.
const presentGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform sampler2D still_base;      // the held moving frame
    uniform sampler2D still_frame;     // the frame as composed
    uniform float still_weight;
    void main() {
        gl_FragColor = vec4(mix(texture2D(still_base, uv0).rgb, texture2D(still_frame, uv0).rgb, still_weight), 1.0);
    }
`;

// The image as it goes to the canvas, finished like a camera's: first the
// lens (chromatic aberration, vignette), then the film (colour or black and
// white, its frame edge, grain), then the passepartout over the overscan.
//
// The frame is the sensor's aspect fitted into the canvas (`still_rect`, in
// pixels); everything is measured from it, the overscan around it is the
// same lens going on.
//
// Frame style: a film edge around the image, as a scan of the negative or
// slide with its rebate. The gate edge is rough (a filed-out carrier), its
// corners slightly round, a little light bleeds over it; around it the film
// base (black on a scan of a negative or a slide), on 35 mm the
// perforations with the scanner's light through them, and generic edge
// print: a frame number, an arrow, code bars. Never a brand name. The edge
// pattern is fixed, so it does not flicker.
//
// Lateral chromatic aberration: the lens images each wavelength at a
// slightly different scale, so colours separate towards the edges. The image
// is sampled at a few scales around the centre and each sample counts for
// the colours of its wavelength (red outermost, then green, blue innermost):
// a soft spectral smear rather than a hard red and blue edge. Its strength
// grows with the distance from the centre. On black and white film it is
// recorded as brightness only: a soft smear without colour.
//
// Vignette, as light lost in the lens: the image is darkened in linear
// light, so highlights stay bright rather than turning grey. Either set by
// hand (amount, where the falloff starts and ends, roundness: 1 a circle
// around the optical axis in sensor millimetres, as a real lens, 0 the
// frame's own shape), or physical: the natural cos⁴ falloff of the angle to
// each point (wide lenses lose more), times the optical vignetting of a lens
// wide open, which is gone a few stops down.
//
// The film (films.ts): with a stock chosen, the camera does no tone mapping
// and hands over scene-linear light (log encoded in the 10-bit frame, see
// lensDof.ts); the film's sensitivity per colour and its characteristic
// curve turn it into the image, toe and shoulder included. Without a film
// the image arrives tone mapped as before.
//
// Film grain: random grains (a Gaussian dot each, at a random place in each
// cell of a `size` pixel grid), so even large grains stay irregular instead
// of blocky. Strongest in the mid-tones, as on film; per colour channel by
// `color` (none on black and white). The pattern is chosen by `still_seed`.
const finishGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform sampler2D still_image;
    uniform vec4 still_finish;    // aberration scale at the edge, grain intensity, grain size (pixels), grain colour
    uniform float still_seed;
    uniform vec4 still_rect;      // the frame in pixels: x0, y0, x1, y1
    uniform vec4 still_optics;    // sensor width, height, focal length (mm), -
    uniform vec4 still_vignette;  // mode (0 off, 1 by hand, 2 physical), amount, start, end
    uniform vec4 still_vignette2; // roundness, optical vignetting at the corner (stops), passepartout, -
    uniform vec4 still_film;      // film on (1), exposure (stops), black, white
    uniform float still_veil;     // veiling light of a diffusion filter, linear
    uniform vec4 film_curve;      // contrast, shadow latitude, highlight latitude, saturation
    uniform mat3 film_matrix;     // colour sensitivity (rows)
    uniform vec3 film_balance;    // white balance
    uniform vec3 film_shadow;     // tint of the shadows
    uniform vec3 film_highlight;  // tint of the highlights
    uniform vec4 frame_style;     // style (0 plain, 1 120, 2 35 mm), film edge x, y (pixels), roughness (pixels)
    uniform vec3 frame_base;      // film base colour
    uniform vec3 frame_mark;      // edge print colour

    float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
    float noise1(float x) {
        float i = floor(x);
        float f = fract(x);
        return mix(hash1(i), hash1(i + 1.0), f * f * (3.0 - 2.0 * f));
    }
    // signed distance to a rounded rectangle around the origin (inside < 0)
    float roundRect(vec2 p, vec2 halfSize, float r) {
        vec2 q = abs(p) - halfSize + r;
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    }
    float box(vec2 p, vec2 lo, vec2 hi, float soft) {
        vec2 a = smoothstep(lo - soft, lo + soft, p) * (1.0 - smoothstep(hi - soft, hi + soft, p));
        return a.x * a.y;
    }
    // one seven-segment digit in a 1 x 2 cell (p in cell units)
    float digit(vec2 p, int n, float soft) {
        int bits[10] = int[10](0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F);
        int b = bits[n];
        float t = 0.16;
        float m = 0.0;
        if ((b & 1) != 0) m = max(m, box(p, vec2(0.1, 2.0 - t), vec2(0.9, 2.0), soft));
        if ((b & 2) != 0) m = max(m, box(p, vec2(1.0 - t, 1.0), vec2(1.0, 1.9), soft));
        if ((b & 4) != 0) m = max(m, box(p, vec2(1.0 - t, 0.1), vec2(1.0, 1.0), soft));
        if ((b & 8) != 0) m = max(m, box(p, vec2(0.1, 0.0), vec2(0.9, t), soft));
        if ((b & 16) != 0) m = max(m, box(p, vec2(0.0, 0.1), vec2(t, 1.0), soft));
        if ((b & 32) != 0) m = max(m, box(p, vec2(0.0, 1.0), vec2(t, 1.9), soft));
        if ((b & 64) != 0) m = max(m, box(p, vec2(0.1, 1.0 - t * 0.5), vec2(0.9, 1.0 + t * 0.5), soft));
        return m;
    }
    // edge print at o (pixels, bottom left), u pixels per cell unit:
    // two digits, then an arrow
    float edgePrint(vec2 p, vec2 o, float u, int d1, int d2) {
        vec2 q = (p - o) / u;
        float soft = 0.6 / u;
        float m = digit(q, d1, soft);
        m = max(m, digit(q - vec2(1.4, 0.0), d2, soft));
        vec2 a = q - vec2(3.0, 1.0);
        m = max(m, (1.0 - smoothstep(-soft, soft, max(abs(a.y) * 1.6 + a.x - 1.0, -a.x))));
        return m;
    }

    highp uvec3 pcg3d(highp uvec3 v) {
        v = v * 1664525u + 1013904223u;
        v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
        v ^= v >> 16u;
        v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
        return v;
    }

    vec3 rand3(highp uvec3 v) {
        return vec3(pcg3d(v)) * (1.0 / 4294967296.0);
    }

    void main() {
        // the lens: chromatic aberration
        vec3 c;
        float k = still_finish.x;
        if (k > 0.0) {
            vec2 d = uv0 - 0.5;
            vec3 sum = vec3(0.0);
            vec3 weight = vec3(0.0);
            for (int i = 0; i < 7; i++) {
                float t = float(i) / 3.0 - 1.0;
                vec3 w = max(vec3(0.0), 1.0 - abs(vec3(t) - vec3(1.0, 0.0, -1.0)));
                sum += texture2D(still_image, 0.5 + d * (1.0 + t * k)).rgb * w;
                weight += w;
            }
            c = sum / weight;
        } else {
            c = texture2D(still_image, uv0).rgb;
        }

        // where this pixel lies: -1..1 over the frame, and on the sensor (mm)
        vec2 frameCentre = (still_rect.xy + still_rect.zw) * 0.5;
        vec2 frameHalf = (still_rect.zw - still_rect.xy) * 0.5;
        vec2 q = (gl_FragCoord.xy - frameCentre) / frameHalf;
        vec2 mm = q * 0.5 * still_optics.xy;
        float rCircle = length(mm) / (0.5 * length(still_optics.xy));   // 1 in the corner
        float rFrame = length(q) * 0.70710678;                           // 1 in the corner, frame shaped

        // the lens: vignette as light lost; then the film
        float mode = still_vignette.x;
        bool film = still_film.x > 0.5;
        if (mode > 0.5 || film || still_veil > 0.0) {
            // film: the image arrives as scene-linear light, log encoded
            // (lensDof.ts); without film, tone mapped and gamma encoded
            vec3 lin = film ? exp2(c * 16.0 - 12.0) * step(vec3(1.0 / 1024.0), c) : pow(max(c, vec3(0.0)), vec3(2.2));
            // a diffusion filter scatters a little of all the light over the
            // whole image: the darkest parts lift, as with a Pro-Mist
            lin += still_veil;
            if (mode > 1.5) {
                float t = length(mm) / still_optics.z;           // tan of the angle to this point
                float cos2 = 1.0 / (1.0 + t * t);
                float natural = cos2 * cos2;
                float optical = exp2(-still_vignette2.y * rCircle * rCircle * rCircle);
                lin *= pow(natural * optical, still_vignette.y);
            } else if (mode > 0.5) {
                float r = mix(rFrame, rCircle, still_vignette2.x);
                lin *= 1.0 - still_vignette.y * smoothstep(still_vignette.z, still_vignette.w, r);
            }
            if (film) {
                // how the film's layers see the colours (black and white: one
                // sensitivity, filter included), then its characteristic curve
                // in stops from middle grey
                vec3 v = film_matrix * (lin * film_balance);
                vec3 x = log2(max(v, vec3(1e-6)) / 0.18) + still_film.y;
                vec3 xs = x / mix(vec3(film_curve.z), vec3(film_curve.y), step(x, vec3(0.0)));
                float black = still_film.z;
                float white = still_film.w;
                float p = (0.18 - black) / (white - black);
                vec3 o = black + (white - black) / (1.0 + exp(-(film_curve.x * xs + log(p / (1.0 - p)))));
                float lo = dot(o, vec3(0.2126, 0.7152, 0.0722));
                o *= mix(film_shadow, film_highlight, smoothstep(0.02, 0.5, lo));
                o = max(mix(vec3(lo), o, film_curve.w), vec3(0.0));
                lin = o;
            }
            c = pow(lin, vec3(1.0 / 2.2));
        }

        // the film: its frame edge (frame style)
        vec2 fp = gl_FragCoord.xy;
        float inFilm = 1.0;
        vec3 over = c;                               // the image, and the overscan around it
        if (frame_style.x > 0.5) {
            vec2 pc = fp - frameCentre;
            float H = frameHalf.y * 2.0;
            // the gate: rough along each edge, corners slightly round
            bool side = abs(pc.x) / frameHalf.x > abs(pc.y) / frameHalf.y;
            float along = side ? pc.y + sign(pc.x) * 1000.0 : pc.x + sign(pc.y) * 3000.0;
            float rough = (noise1(along / 6.0) - 0.5) * 0.8 + (noise1(along / 41.0) - 0.5) * 1.6;
            float dGate = roundRect(pc, frameHalf, 0.006 * H) + rough * frame_style.w;
            float inGate = 1.0 - smoothstep(-0.8, 0.8, dGate);
            // the film around it
            vec2 outline = frameHalf + frame_style.yz;
            float dFilm = roundRect(pc, outline, 0.004 * H);
            inFilm = 1.0 - smoothstep(-0.8, 0.8, dFilm);
            // film base, with a little light bled over the gate
            vec3 edge = frame_base + c * 0.3 * exp(-max(dGate, 0.0) / (0.004 * H));
            float mm = H / 24.0;                     // a millimetre of a 24 mm high frame, in pixels
            if (frame_style.x > 1.5) {
                // 35 mm: perforations (4.75 mm pitch, 2.8 x 2 mm, 2.5 mm out
                // from the image edge), the scanner's light through them
                float pitch = 4.75 * mm;
                vec2 h = vec2(mod(pc.x + pitch * 0.5, pitch) - pitch * 0.5, abs(pc.y) - frameHalf.y - 2.5 * mm);
                float hole = 1.0 - smoothstep(-0.8, 0.8, roundRect(h, vec2(1.4, 1.0) * mm, 0.5 * mm));
                edge = mix(edge, vec3(1.0, 0.96, 0.88), hole);
                // edge print in the strip outside the perforations
                vec2 top = vec2(-frameHalf.x * 0.55, frameHalf.y + 4.0 * mm);
                vec2 bottom = vec2(-frameHalf.x * 0.1, -frameHalf.y - 5.0 * mm);
                float print = edgePrint(pc, top, 0.42 * mm, 2, 4);
                print = max(print, edgePrint(pc, bottom, 0.42 * mm, 2, 5));
                // code bars along the bottom
                float bx = (pc.x + frameHalf.x * 0.5) / (0.45 * mm);
                if (bx > 0.0 && bx < 40.0 && hash1(floor(bx)) > 0.45) {
                    print = max(print, box(vec2(fract(bx), pc.y), vec2(0.15, -frameHalf.y - 5.0 * mm), vec2(0.85, -frameHalf.y - 4.0 * mm), 0.3));
                }
                edge = mix(edge, frame_mark, print * 0.85 * inFilm);
            } else {
                // 120: frame number and arrow in the band above, a mark at the side
                vec2 top = vec2(-frameHalf.x * 0.7, frameHalf.y + frame_style.z * 0.3);
                float print = edgePrint(pc, top, frame_style.z * 0.2, 0, 7);
                vec2 sm = vec2(pc.x - frameHalf.x - frame_style.y * 0.5, pc.y - frameHalf.y * 0.6);
                print = max(print, box(sm, -vec2(0.12, 0.9) * frame_style.yz, vec2(0.12, 0.9) * frame_style.yz, 0.8));
                edge = mix(edge, frame_mark, print * 0.8 * inFilm);
            }
            // the film edge only on the film; beyond it the overscan
            c = mix(over, mix(edge, over, inGate), inFilm);
        }

        // the film: grain
        float amount = still_finish.y;
        if (amount > 0.0) {
            vec2 p = gl_FragCoord.xy / still_finish.z;
            vec2 base = floor(p);
            highp uint seed = uint(still_seed);
            vec4 n = vec4(0.0);           // rgb per channel, a monochrome
            for (int j = -1; j <= 1; j++) {
                for (int i = -1; i <= 1; i++) {
                    vec2 cell = base + vec2(float(i), float(j));
                    // offset so the cell index is never negative
                    highp uvec2 id = uvec2(ivec2(cell) + 2);
                    vec3 a = rand3(uvec3(id, seed));                 // place in the cell, monochrome value
                    vec3 b = rand3(uvec3(id, seed + 0x9E3779B9u));  // per channel values
                    vec2 o = p - (cell + a.xy);
                    float w = exp(-2.0 * dot(o, o));                  // sigma half a cell
                    n += vec4(b * 2.0 - 1.0, a.z * 2.0 - 1.0) * w;
                }
            }
            // unit variance: values of variance 1/3, sum of w² about pi/4
            n /= 0.5117;
            float cc = still_finish.w;
            vec3 g = mix(vec3(n.a), n.rgb, cc) / sqrt((1.0 - cc) * (1.0 - cc) + cc * cc);
            float l = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
            c += g * amount * 0.12 * sqrt(4.0 * l * (1.0 - l));
        }

        // the passepartout over the overscan: outside the image, or with a
        // film edge outside the film
        if (frame_style.x > 0.5) c = mix(over * (1.0 - still_vignette2.z), c, inFilm);
        else if (any(lessThan(fp, still_rect.xy)) || any(greaterThan(fp, still_rect.zw))) c *= 1.0 - still_vignette2.z;

        gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
`;

/** The vignette, as the finishing step draws it. */
export type FinishVignette =
    | { mode: 'off' }
    | { mode: 'hand'; amount: number; start: number; end: number; roundness: number }
    | { mode: 'physical'; amount: number; fStop: number };

/** How the image is finished on its way to the canvas. */
export type Finish = {
    fringing: number;            // SuperSplat's fringing intensity, 0 off
    grain: Grain;
    film: FilmSettings;              // off ('none') also while a debug view is shown
    vignette: FinishVignette;
    sensor: [number, number];    // mm; gives the frame its aspect and the vignette its geometry
    focalLength: number;         // mm
    viewport: Viewport;          // passepartout (0 the overscan shows, 1 black), frame style and tint
    diffusion: number;           // diffusion filter, 0–1 (its glow is the engine's bloom)
};

// The film edge per kind of film, as a scan shows it: a negative's base
// inverts to black and its pre-exposed edge print to light (warm on colour
// negative, as the orange mask never inverts quite neutral); a slide's
// unexposed edge is black with a neat edge from its mount. `rough`: how
// ragged the gate edge is, in pixels at a 600 pixel high frame.
const FRAME_LOOKS = {
    colorNeg: { base: [0.018, 0.014, 0.012], mark: [1, 0.72, 0.28], rough: 2.2 },
    bw: { base: [0.02, 0.02, 0.02], mark: [0.8, 0.8, 0.78], rough: 2.2 },
    slide: { base: [0.006, 0.006, 0.008], mark: [0.62, 0.66, 0.7], rough: 0.6 }
} as const;

// veiling light of a diffusion filter at full strength, as linear light
// added everywhere (0.004 lifts black to about 8 % grey)
const VEIL = 0.004;

// Optical vignetting of a lens wide open, at the image corner: about one
// and a half stops at f/1.4, gone by f/5.6.
const opticalStops = (fStop: number) => 1.5 * Math.min(Math.max(Math.log2(5.6 / fStop) / 2, 0), 1);

const ADD = new BlendState(true, BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE);

// The screen counts as settled once it is within 1/64 of the last group's
// image: `fade` is how much of the way it goes each frame.
const settleFrames = (fade: number) =>
    fade >= 1 ? 1 : Math.max(1, Math.ceil(Math.log(1 / 64) / Math.log(1 - fade)));

// New grain patterns a second at full animation: film runs at 24 frames a
// second, each frame its own grain; faster reads as video noise.
const GRAIN_RATE = 24;

// The aberration scale at the image edge for a fringing intensity: the
// outermost red and blue samples land where the engine's fringing puts
// them in the corner (intensity / 1024 · 0.5², either way).
const FRINGING_SCALE = 1 / 2048;

// cat's eye at full strength: the barrel disc is shifted by this many
// aperture radii at the image corner (the overlap there is about 40 %)
const CATS_EYE_SHIFT = 1;

// the grain pattern for now: changes GRAIN_RATE × animation times a second
const grainSeed = (g: Grain) =>
    g.animation > 0 ? Math.floor(performance.now() / 1000 * GRAIN_RATE * g.animation) % 65536 : 0;

function target(device: GraphicsDevice, name: string, format: number, depth: boolean, filter: number = FILTER_NEAREST) {
    const colorBuffer = new Texture(device, {
        name, width: device.width, height: device.height, format, mipmaps: false,
        minFilter: filter, magFilter: filter,
        addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE
    });
    return new RenderTarget({ name, colorBuffer, depth });
}

function quadShader(device: GraphicsDevice, name: string, fragmentGLSL: string): Shader {
    return ShaderUtils.createShader(device, {
        uniqueName: name,
        attributes: { aPosition: SEMANTIC_POSITION },
        vertexChunk: 'quadVS',
        fragmentGLSL
    });
}

const HOOKED = Symbol('stillFrames');

// Runs right after the scene pass: keeps the depth of a moving frame, or for
// a still puts it back, adds the sample and writes the average.
class AccumulatePass extends FramePass {
    constructor(device: GraphicsDevice, private still: StillFrames) {
        super(device);
        this.name = 'StillAccumulate';
    }

    execute() {
        this.still.runPass();
    }
}

export class StillFrames {
    readonly frame: RenderTarget;          // the camera composes here
    private display: [RenderTarget, RenderTarget];   // what is on screen during the still, and the next
    private sum: RenderTarget;             // weighted sum of aperture samples, linear HDR
    private lastShown = 0;                 // samples in the group being eased in
    private sinceGroup = 0;                // frames since that group came in
    private fade = 0.35;                   // part of the way to a new group per frame
    private seed = -1;                     // grain pattern last drawn
    private shownSource: RenderTarget | null = null;   // what is on the canvas, before finishing
    private avg: RenderTarget;             // the average of the whole groups in, read by the passes after the scene pass
    private geo: RenderTarget;             // depth and coverage of the last moving frame (RG32F)
    private geoValid = false;
    private ranges: [RenderTarget, RenderTarget];   // depth range, this frame's and the previous (1 x 1)
    private rangeFrames = 0;               // frames the range has been followed
    private rangeOptions: { far: number; reciprocal: boolean } | null = null;
    private depthTarget: RenderTarget | null = null;   // writes into the scene depth texture
    private pass: AccumulatePass;
    private accumulateShader: Shader;
    private averageShader: Shader;
    private rangeShader: Shader;
    private captureShader: Shader;
    private restoreShader: Shader;
    private presentShader: Shader;
    private finishShader: Shader;
    private device: GraphicsDevice;
    private scene: Texture | null = null;  // the scene texture of this frame
    private depth: Texture | null = null;  // the scene depth texture of this frame
    private sample: [number, number, number] | null = null;
    private active = false;
    private capture = false;
    /** samples in `sum` */
    count = 0;

    /** The depth range for the normalized depth view, and whether it holds one yet. */
    get range() {
        // after a frame the newest range is the second of the pair
        return { texture: this.ranges[1].colorBuffer, ready: this.rangeFrames > 0 };
    }

    /** Samples the still shows: whole groups. */
    get shown() {
        return this.count - this.count % APERTURE_GROUP;
    }

    /** Whether the screen has caught up with the last group. */
    get settled() {
        return this.shown > 0 && this.sinceGroup >= settleFrames(this.fade);
    }

    constructor(app: AppBase) {
        const device = this.device = app.graphicsDevice;
        // 10 bits per channel: with a film these hold scene-linear light,
        // log encoded over 16 stops (64 steps a stop); linear filtering, as
        // the aberration samples between pixels
        this.frame = target(device, 'StillFrame', PIXELFORMAT_RGB10A2, true, FILTER_LINEAR);
        this.display = [
            target(device, 'StillDisplayA', PIXELFORMAT_RGB10A2, false, FILTER_LINEAR),
            target(device, 'StillDisplayB', PIXELFORMAT_RGB10A2, false, FILTER_LINEAR)
        ];
        this.sum = target(device, 'StillSum', PIXELFORMAT_RGBA16F, false);
        this.avg = target(device, 'StillAverage', PIXELFORMAT_RGBA16F, false, FILTER_LINEAR);
        // two channels: depth and coverage
        this.geo = target(device, 'StillGeometry', PIXELFORMAT_RG32F, false);
        this.pass = new AccumulatePass(device, this);
        this.accumulateShader = quadShader(device, 'StillAccumulate', accumulateGLSL);
        this.averageShader = quadShader(device, 'StillAverage', averageGLSL);
        this.rangeShader = quadShader(device, 'StillRange', rangeGLSL);
        const range = (name: string) => {
            const colorBuffer = new Texture(device, {
                name, width: 1, height: 1, format: PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: FILTER_NEAREST, magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE
            });
            return new RenderTarget({ name, colorBuffer, depth: false });
        };
        this.ranges = [range('StillRangeA'), range('StillRangeB')];
        this.captureShader = quadShader(device, 'StillCapture', captureGLSL);
        this.restoreShader = quadShader(device, 'StillRestore', restoreGLSL);
        this.presentShader = quadShader(device, 'StillPresent', presentGLSL);
        this.finishShader = quadShader(device, 'StillFinish', finishGLSL);
    }

    /** Follows the canvas size; returns true when it changed (the still starts over). */
    resize() {
        const { width, height } = this.device;
        if (this.frame.width === width && this.frame.height === height) return false;
        for (const rt of [this.frame, ...this.display]) rt.resize(width, height);
        this.count = 0;
        return true;
    }

    /** Keeps the frame now in `frame` (the last moving one) on screen, and empties the sum. */
    start() {
        this.mix(this.display[0], this.frame, this.frame, 0);
        this.count = 0;
        this.lastShown = 0;
        this.sinceGroup = 0;
    }

    /**
     * Sets up this frame, before it renders: whether the passes after the
     * scene pass read the average (`active`), the aperture sample to add, if
     * any: lens point (x, y) in units of the f-stop radius, `catsEye` 0–1,
     * for a moving frame whether to keep its depth for a coming still, and
     * whether to follow the depth range for the normalized depth view.
     */
    prepare(rpc: CameraFramePass | null, active: boolean, sample: [number, number, number] | null,
        capture: boolean, range: { far: number; reciprocal: boolean } | null) {
        this.active = active;
        this.sample = active ? sample : null;
        this.capture = !active && capture;
        if (!range) this.rangeFrames = 0;
        this.rangeOptions = range;
        if (rpc) this.hook(rpc);
    }

    // Wraps the camera frame pass's frameUpdate, which runs before its passes
    // are collected each frame: keeps our pass right after the scene pass
    // and, for a still, points the passes that read the scene at `avg`.
    private hook(rpc: CameraFramePass) {
        const tagged = rpc as CameraFramePass & { [HOOKED]?: StillFrames };
        if (tagged[HOOKED] === this) return;
        tagged[HOOKED] = this;
        const original = rpc.frameUpdate.bind(rpc);
        rpc.frameUpdate = () => {
            original();
            if (tagged[HOOKED] !== this) return;
            const passes = rpc.beforePasses;
            const at = passes.indexOf(this.pass);
            const after = passes.indexOf(rpc.scenePassTransparent ?? rpc.scenePass!);
            if (at !== after + 1) {
                if (at >= 0) passes.splice(at, 1);
                passes.splice(passes.indexOf(rpc.scenePassTransparent ?? rpc.scenePass!) + 1, 0, this.pass);
            }
            this.scene = rpc.rt?.colorBuffer ?? null;
            this.depth = rpc.sceneDepthTexture;
            this.pass.enabled = (this.active || this.capture || !!this.rangeOptions) && !!this.scene;
            if (!this.pass.enabled || !this.active) return;
            const avg = this.avg.colorBuffer;
            if (rpc.composePass && composeReadsScene(rpc)) rpc.composePass.sceneTexture = avg;
            rpc.scenePassHalf?.setSourceTexture(avg);
            rpc.dofPass?.setSceneTexture(avg);
        };
    }

    /** Our pass, inside the frame: keeps or puts back the depth, adds this frame's sample, writes the average. */
    runPass() {
        const scene = this.scene;
        if (!scene) return;
        if (this.sum.width !== scene.width || this.sum.height !== scene.height) {
            for (const rt of [this.sum, this.avg, this.geo]) rt.resize(scene.width, scene.height);
            this.count = 0;
            this.geoValid = false;
        }
        const scope = this.device.scope;
        const depth = this.depth;
        this.device.setBlendState(BlendState.NOBLEND);

        // the depth range for the normalized depth view
        const range = this.rangeOptions;
        if (range && depth) {
            const [next, prev] = this.ranges;
            scope.resolve('still_depth').setValue(depth);
            scope.resolve('still_scene').setValue(scene);
            scope.resolve('still_prev').setValue(prev.colorBuffer);
            scope.resolve('still_range').setValue([range.far, range.reciprocal ? 1 : 0, this.rangeFrames > 0 ? 0.15 : 0, 0]);
            drawQuadWithShader(this.device, next, this.rangeShader);
            this.ranges = [prev, next];
            this.rangeFrames++;
        }

        // moving: keep this frame's depth and coverage
        if (!this.active) {
            if (!depth || !this.capture) return;
            scope.resolve('still_depth').setValue(depth);
            scope.resolve('still_scene').setValue(scene);
            drawQuadWithShader(this.device, this.geo, this.captureShader);
            this.geoValid = true;
            return;
        }

        // still: the unshifted depth back into the scene depth
        const restore = this.geoValid && !!depth;
        if (restore) {
            if (this.depthTarget?.colorBuffer !== depth) {
                this.depthTarget?.destroy();
                this.depthTarget = new RenderTarget({ name: 'StillDepthRestore', colorBuffer: depth!, depth: false });
            }
            scope.resolve('still_geo').setValue(this.geo.colorBuffer);
            drawQuadWithShader(this.device, this.depthTarget, this.restoreShader);
        }

        if (this.sample) {
            const [x, y, catsEye] = this.sample;
            scope.resolve('still_scene').setValue(scene);
            scope.resolve('still_lens').setValue([x, y, catsEye * CATS_EYE_SHIFT, scene.width / Math.max(scene.height, 1)]);
            this.device.setBlendState(this.count === 0 ? BlendState.NOBLEND : ADD);
            drawQuadWithShader(this.device, this.sum, this.accumulateShader);
            this.count++;
            this.sample = null;
            // the still shows whole groups only: a new average once one is complete
            if (this.count % APERTURE_GROUP === 0) {
                scope.resolve('still_sum').setValue(this.sum.colorBuffer);
                scope.resolve('still_scene').setValue(scene);
                scope.resolve('still_geo').setValue(this.geo.colorBuffer);
                scope.resolve('still_geoValid').setValue(restore ? 1 : 0);
                this.device.setBlendState(BlendState.NOBLEND);
                drawQuadWithShader(this.device, this.avg, this.averageShader);
            }
        }
    }

    /**
     * To the canvas, finished: the frame as composed, or for a still building
     * up, the screen eased `fade` of the way towards the newest whole group
     * (the last moving frame until the first group is in).
     */
    present(still: boolean, fade: number, finish: Finish) {
        this.fade = fade;
        if (!still) {
            this.finish(this.frame, finish);
            return;
        }
        if (this.shown > 0) {
            if (this.shown !== this.lastShown) {
                this.lastShown = this.shown;
                this.sinceGroup = 0;
            }
            const [current, next] = this.display;
            this.mix(next, current, this.frame, fade);
            this.display = [next, current];
            this.sinceGroup++;
        }
        this.finish(this.display[0], finish);
    }

    /**
     * While the viewer does not render: draws the last image again with the
     * next grain pattern once it is due. Only this step, no scene render.
     */
    refresh(finish: Finish) {
        const g = finish.grain;
        if (!this.shownSource || !g.enabled || g.intensity <= 0 || g.animation <= 0) return;
        if (grainSeed(g) === this.seed) return;
        this.finish(this.shownSource, finish);
    }

    private finish(source: RenderTarget, finish: Finish) {
        const scope = this.device.scope;
        const g = finish.grain;
        this.shownSource = source;
        this.seed = grainSeed(g);
        const profile = resolveFilm(finish.film);
        const filmOn = profile.kind !== 'digital';
        const bw = profile.kind === 'bw';
        const [sensorW, sensorH] = finish.sensor;
        const vp = finish.viewport;
        const shape = frameShape({ sensorWidth: sensorW, sensorHeight: sensorH }, vp.frameStyle);
        const r = frameRect(source.width, source.height, shape);
        const tint: Exclude<FrameTint, 'auto'> = vp.frameTint !== 'auto' ? vp.frameTint
            : bw ? 'bw' : profile.slide ? 'slide' : 'colorNeg';
        const look = FRAME_LOOKS[tint];
        scope.resolve('frame_style').setValue([
            vp.frameStyle === 'plain' ? 0 : vp.frameStyle === '120' ? 1 : 2,
            r.w * shape.margin[0], r.h * shape.margin[1], look.rough * r.h / 600
        ]);
        scope.resolve('frame_base').setValue(look.base);
        scope.resolve('frame_mark').setValue(look.mark);
        const v = finish.vignette;
        scope.resolve('still_image').setValue(source.colorBuffer);
        scope.resolve('still_finish').setValue([
            finish.fringing * FRINGING_SCALE, g.enabled ? g.intensity : 0, g.size, bw ? 0 : g.color
        ]);
        scope.resolve('still_seed').setValue(this.seed);
        // the canvas has the same size as the source; the frame is centred, so
        // it lies the same counted from the bottom (gl_FragCoord) as from the top
        scope.resolve('still_rect').setValue([Math.round(r.x), Math.round(r.y), Math.round(r.x + r.w), Math.round(r.y + r.h)]);
        scope.resolve('still_optics').setValue([sensorW, sensorH, finish.focalLength, 0]);
        scope.resolve('still_veil').setValue(finish.diffusion * VEIL);
        scope.resolve('still_film').setValue([filmOn ? 1 : 0, profile.exposure, profile.black, profile.white]);
        scope.resolve('film_curve').setValue([profile.contrast, profile.latShadow, profile.latHighlight, profile.saturation]);
        const m = profile.matrix;   // rows, to column-major
        scope.resolve('film_matrix').setValue([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
        scope.resolve('film_balance').setValue(profile.whiteBalance);
        scope.resolve('film_shadow').setValue(profile.shadowTint);
        scope.resolve('film_highlight').setValue(profile.highlightTint);
        scope.resolve('still_vignette').setValue(
            v.mode === 'hand' ? [1, v.amount, v.start, Math.max(v.end, v.start + 1e-3)]
                : v.mode === 'physical' ? [2, v.amount, 0, 0] : [0, 0, 0, 0]
        );
        scope.resolve('still_vignette2').setValue([
            v.mode === 'hand' ? v.roundness : 0, v.mode === 'physical' ? opticalStops(v.fStop) : 0, vp.passepartout, 0
        ]);
        this.device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(this.device, null, this.finishShader);
    }

    private mix(dest: RenderTarget | null, base: RenderTarget, frame: RenderTarget, weight: number) {
        const scope = this.device.scope;
        scope.resolve('still_base').setValue(base.colorBuffer);
        scope.resolve('still_frame').setValue(frame.colorBuffer);
        scope.resolve('still_weight').setValue(weight);
        this.device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(this.device, dest, this.presentShader);
    }

    destroy() {
        this.active = false;
        this.pass.enabled = false;
        for (const rt of [this.frame, ...this.display, this.sum, this.avg, this.geo, ...this.ranges]) {
            rt.destroyTextureBuffers();
            rt.destroy();
        }
        this.depthTarget?.destroy();
    }
}
