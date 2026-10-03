// Thin-lens depth of field shown while the camera moves (and as the
// shrinking over-blur while a still builds up): the same lens as the exact
// still (stillFrames.ts, useStillDof.ts), so you always look through it and
// the still only refines.
//
// The way games do it (Unreal's Diaphragm DOF, Jimenez's "Next-generation
// post-processing in Call of Duty"): a pass of our own at half resolution,
// right after the scene (and after the still's accumulation), then a blend
// at full resolution in the engine's compose pass.
//
// 1. Prepare: the scene at half size, with each pixel's signed blur radius
//    (behind the focus +, in front −) from its coverage-corrected depth
//    (the nearest of the four it covers, so foreground edges keep their blur).
// 2. Gather: each pixel collects the points whose blur reaches it, through a
//    kernel shaped like the lens at that pixel, with the same formulas as the
//    still:
//    - the aperture: round, blades, anamorphic (aperture.ts lens points);
//    - cat's eye: the same mask per lens point and pixel;
//    - astigmatism: the radial and the tangential blur apart (stretched
//      outwards or along circles);
//    - field curvature and tilt: the focus distance per pixel;
//    - bubble: a weight per lens point;
//    - fringing: each colour with its own blur.
//    Two layers: the pixel's own surface and what lies behind it (a sample
//    counts where its blur reaches; background behind a sharper edge is held
//    back, so no halos), and nearer blurred surfaces laid over it by how much
//    of the pixel their blur covers. So a blurred foreground spreads over
//    the background with its own soft edge, and the blur can be as large as
//    the still's without the sharp outline of a foreground showing through.
//    Inside that outline the foreground turns see-through as well: what
//    shows through is the background just beside it, also when that is
//    sharp (its own blur reaches nowhere).
// 3. Blend (compose, full resolution): sharp where the pixel's own blur is
//    under a pixel, the half-size result where it is more or where a nearer
//    blur covers it; edges of sharp objects stay crisp.
//
// Blur radius for a point at depth d, lens focused at S (thin lens):
//     c(d) = c∞ · |1 − S / d|
// with c∞ the blur of a point at infinity. With a focus plane that is bent
// or tilted (focusRatio in experience.ts), 1/S becomes ratio/S, so
//     c(d) = c∞ · |ratio − S / d|
// and astigmatism moves the ratio by ∓a along and across the radius.

import {
    ADDRESS_CLAMP_TO_EDGE, BlendState, FILTER_LINEAR, FILTER_LINEAR_MIPMAP_LINEAR, FramePass, PIXELFORMAT_RGBA16F, RenderTarget,
    SEMANTIC_POSITION, ShaderUtils, Texture, drawQuadWithShader, type AppBase, type GraphicsDevice, type Shader
} from 'playcanvas';
import type { CameraFrame } from 'playcanvas/scripts/esm/camera-frame.mjs';
import { FOCUS_RATIO_MIN, frameRect, type FrameShape, type Lens } from '../scene/experience';
import { Aperture } from './aperture';
import { depthIsReciprocal, setShaderChunks } from './engine';

/** Lens points in the gather kernel (six groups of eight, aperture.ts). */
const KERNEL = 48;
/** Probes looking for nearer, more blurred neighbours. */
const PROBES = 16;
// The largest blur radius, as a fraction of the frame height: as the
// still's over-blur, so the moving view reaches the still's blur.
const MAX_BLUR = 0.08;
// Astigmatism at full strength: in the frame corner the radial focus moves
// this far one way and the tangential focus as far the other, in units of
// the focus ratio (the still uses the same, stillFrames.ts).
export const ASTIGMATISM = 0.6;
// Bokeh fringing at full strength: green focuses 0.5 mm off red and blue on
// the image side, which shifts 1 / distance by δ / f² (useStillDof.ts).
export const FRINGING_MM = 0.5;
// cat's eye at full strength: the barrel disc is shifted by this many
// aperture radii at the frame corner (stillFrames.ts)
export const CATS_EYE_SHIFT = 1;

// What both the passes and the compose shader need: the depth of what is
// actually there, and the focus distance per pixel.
//
// The splat scene depth holds, per pixel, the coverage-weighted sum of
// 1 / depth of the splats, plus the uncovered rest (1 - A) times the value
// it was cleared to, 1 / far. The scene alpha is that coverage A (the camera
// clears it to 0, and splats blend it premultiplied like their colour), so
// the rest can be taken off again and the sum divided by A: the depth of
// what is actually there, also at a soft splat edge against empty space.
const commonGLSL = (depthMap: string, scene: string) => /* glsl */ `
    uniform vec4 lens_params;    // focus (scene units), c∞ (full-size pixels, radius), -, -
    uniform vec4 lens_quality;   // -, -, depth format (1 linear, 2 reciprocal), far
    uniform vec4 lens_field;     // field curvature, tilt x, tilt y, astigmatism (focus ratio in the corner)
    uniform vec4 lens_frameUv;   // frame half size in uv x, y; sensor width² and height² over the diagonal²

    float lensDepth(vec2 uv) {
        float v = texture2DLod(${depthMap}, uv, 0.0).r;
        if (lens_quality.z > 1.5) {
            float far = lens_quality.w;
            float a = texture2DLod(${scene}, uv, 0.0).a;
            float s = v - (1.0 - a) / far;
            return a > 0.01 && s > 1e-7 ? min(a / s, far) : far;
        }
        return v;
    }

    // -1..1 over the frame
    vec2 lensQ(vec2 uv) {
        return (uv - 0.5) / lens_frameUv.xy;
    }
    // squared distance from the centre, 1 in the frame corner (sensor millimetres)
    float lensR2(vec2 q) {
        return q.x * q.x * lens_frameUv.z + q.y * q.y * lens_frameUv.w;
    }
    // how much nearer than in the centre the focus is here, in 1 / distance
    float lensRatio(vec2 q) {
        return max(1.0 + lens_field.x * lensR2(q) + lens_field.y * q.x + lens_field.z * q.y, ${FOCUS_RATIO_MIN.toFixed(3)});
    }
    // signed blur radius (c∞ units): behind the focus +, in front −
    float lensCoc(vec2 uv, float depth) {
        return lensRatio(lensQ(uv)) - lens_params.x / max(depth, 1e-4);
    }
`;

// 1. The scene at half size with each pixel's signed blur radius (half-size
// pixels), from the nearest of the four depths it covers.
const prepGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform sampler2D dof_scene;
    uniform highp sampler2D dof_depth;
    uniform vec4 dof_size;       // full-size texel x, y, c∞ in half-size pixels, max radius (half-size pixels)
    ${commonGLSL('dof_depth', 'dof_scene')}
    void main() {
        vec2 t = dof_size.xy * 0.5;
        vec2 uv[4] = vec2[4](uv0 + vec2(-t.x, -t.y), uv0 + vec2(t.x, -t.y), uv0 + vec2(-t.x, t.y), uv0 + t);
        vec3 c = vec3(0.0);
        float d = 1e30;
        for (int i = 0; i < 4; i++) {
            c += texture2D(dof_scene, uv[i]).rgb;
            d = min(d, lensDepth(uv[i]));
        }
        float coc = clamp(lensCoc(uv0, d) * dof_size.z, -dof_size.w, dof_size.w);
        gl_FragColor = vec4(c * 0.25, coc);
    }
`;

// 2. The gather, at half size.
const gatherGLSL = /* glsl */ `
    // in front of the focus by more than this (half-size pixels of blur): foreground
    #define NEAR 0.5
    varying vec2 uv0;
    uniform sampler2D dof_prep;
    uniform vec4 dof_kernel[${KERNEL}];    // lens point x, y (f-stop radius units, shaped), weight (bubble), -
    uniform vec4 dof_size;       // half-size texel x, y, c∞ in half-size pixels, max radius (half-size pixels)
    uniform vec4 dof_lens;       // cat's eye shift, fringing (focus ratio), -, -
    ${commonGLSL('dof_prep', 'dof_prep')}

    // how far a point with blur coc (signed) at offset o reaches this pixel,
    // through its kernel stretched along and across the radius er
    float reaches(vec2 o, vec2 er, float coc, float astig) {
        vec2 axes = max(abs(vec2(coc - astig, coc + astig)), vec2(0.5));
        float n = length(vec2(dot(o, er) / axes.x, (o.y * er.x - o.x * er.y) / axes.y));
        float soft = 1.0 / max(min(axes.x, axes.y), 1.0);
        return 1.0 - smoothstep(1.0 - soft, 1.0 + soft, n);
    }

    void main() {
        vec4 center = texture2D(dof_prep, uv0);
        float c0 = center.a;
        float maxR = dof_size.w;
        float R0 = dof_size.z;
        vec2 q = lensQ(uv0);
        float astig = lens_field.w * lensR2(q) * R0;            // half-size pixels
        vec3 fringe = dof_lens.y * vec3(-0.5, 0.5, -0.5) * R0;  // per colour, half-size pixels

        // direction from the centre, in square pixels
        vec2 texel = dof_size.xy;
        vec2 dir = (uv0 - 0.5) / texel;
        vec2 er = dot(dir, dir) > 1e-6 ? normalize(dir) : vec2(1.0, 0.0);
        vec2 et = vec2(-er.y, er.x);

        // The lens points turned per pixel (interleaved gradient noise): with
        // few samples over a large blur, a pattern shared by all pixels shows
        // as copies, crosses and rings that move as the focus changes; turned
        // per pixel the same error is fine grain.
        float turn = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        mat2 rot = mat2(cos(turn), sin(turn), -sin(turn), cos(turn));

        // How far to look: this pixel's own blur along and across the
        // radius, or further where a blurred foreground reaches over it
        // (probes spaced evenly in radius).
        vec2 own = abs(vec2(c0 - astig, c0 + astig));
        float spill = 0.0;
        for (int i = 0; i < ${PROBES}; i++) {
            float r = maxR * (float(i) + 0.5) / float(${PROBES});
            float a = float(i) * 2.39996323 + turn;
            float s = texture2DLod(dof_prep, uv0 + vec2(cos(a), sin(a)) * r * texel, 0.0).a;
            if (s < -NEAR) spill = max(spill, mix(spill, -s, smoothstep(r * 0.5, r, -s)));
        }
        spill = min(spill, maxR);
        bool spilled = spill > max(own.x, own.y);
        vec2 axes = spilled ? vec2(spill) : min(own, vec2(maxR));
        if (max(axes.x, axes.y) < 0.5) {
            gl_FragColor = vec4(center.rgb, 0.0);
            return;
        }

        // Prefiltered: each sample reads the half-size image at the detail
        // level that matches the spacing of the samples, so a large blur is
        // smooth rather than made of copies (mipmaps of the prepared image).
        float spacing = max(axes.x, axes.y) * sqrt(3.14159 / float(${KERNEL}));
        float lod = clamp(log2(max(spacing / 1.5, 1.0)), 0.0, 5.0);

        // cat's eye: pixel position, 1 at the frame corner
        vec2 p = q * sqrt(lens_frameUv.zw);
        // a background point reaches this pixel from the opposite side of the
        // lens point, a foreground point from the same side
        float side = c0 >= 0.0 && !spilled ? -1.0 : 1.0;
        // the pixel's own blur as background (0 when it is foreground)
        float bgOwn = max(c0, 0.0);

        // Two layers. Foreground: everything blurred in front of the focus,
        // this pixel's own surface included, by how much of this pixel its
        // blur covers (each sample its share of its blur disc), so the edge
        // of a blurred foreground turns see-through on both sides.
        // Background: the rest, where its blur reaches (behind a sharper
        // pixel held to that pixel's blur, so no halos).
        vec3 bgSum = vec3(0.0);
        vec3 bgTotal = vec3(0.0);
        vec3 nearSum = vec3(0.0);
        vec3 nearCover = vec3(0.0);
        float area = axes.x * axes.y / float(${KERNEL});        // kernel area per sample (over pi)
        for (int i = 0; i < ${KERNEL}; i++) {
            vec4 k = dof_kernel[i];
            float w = k.z;
            vec2 kp = rot * k.xy;
            if (dof_lens.x > 0.0) w *= 1.0 - smoothstep(0.92, 1.08, length(kp + p * dof_lens.x));
            if (w <= 0.0) continue;
            vec2 o = side * (er * dot(kp, er) * axes.x + et * dot(kp, et) * axes.y);
            vec4 s = texture2DLod(dof_prep, uv0 + o * texel, lod);
            float cs = s.a;
            if (cs < -NEAR) {
                vec3 cover = vec3(
                    reaches(o, er, cs + fringe.r, astig),
                    reaches(o, er, cs + fringe.g, astig),
                    reaches(o, er, cs + fringe.b, astig));
                vec2 sa = max(abs(vec2(cs - astig, cs + astig)), vec2(0.5));
                cover *= w * area / (sa.x * sa.y);
                nearSum += s.rgb * cover;
                nearCover += cover;
            } else if (c0 < -NEAR) {
                // This pixel is foreground: what shows through its blurred
                // edge is the background just beside it, sharp or not, so
                // every background sample counts, the nearest by far the most.
                float m = w * exp(-6.0 * length(o) / max(axes.x, axes.y));
                bgSum += s.rgb * m;
                bgTotal += vec3(m);
            } else {
                float cb = min(max(cs, 0.0), max(bgOwn * 2.0, 0.5));
                vec3 m = w * vec3(
                    reaches(o, er, cb + fringe.r, astig),
                    reaches(o, er, cb + fringe.g, astig),
                    reaches(o, er, cb + fringe.b, astig));
                bgSum += s.rgb * m;
                bgTotal += m;
            }
        }
        // the background where nothing reached (or, for a foreground pixel,
        // none lies within its blur): this pixel
        vec3 bg = bgTotal.g > 1e-3 ? bgSum / max(bgTotal, vec3(1e-4)) : center.rgb;
        vec3 cover = clamp(nearCover, 0.0, 1.0);
        vec3 nearColor = nearSum / max(nearCover, vec3(1e-4));
        float a = max(cover.r, max(cover.g, cover.b));
        // A sharp pixel is blended with the foreground over it in compose,
        // at full size: hand it the foreground colour alone. A blurred one
        // gets the whole result.
        bool sharp = max(own.x, own.y) < 1.0;
        vec3 result = sharp ? (a > 0.0 ? nearColor : center.rgb) : mix(bg, nearColor, cover);
        gl_FragColor = vec4(result, a);
    }
`;

// 3. The blend, in the engine's compose pass: replaces its DoF compose
// function (composeDofPS). The engine's DoF stays on only for the scene
// depth it makes the engine render and this hook; its own blur passes are
// set to their cheapest.
const composeDofGLSL = /* glsl */ `
    #ifdef DOF
        // The depth debug view declares the depth map itself, further down in
        // the compose shader; that view replaces the image anyway, so the
        // lens stays out of it.
        #ifdef DEBUG_COMPOSE
            #if DEBUG_COMPOSE == depth
                #define LENS_OFF
            #endif
        #endif

        // read by the engine's debug views
        vec2 dCoc;
        vec3 dBlur;

        #ifdef LENS_OFF
            vec3 applyDof(vec3 base, vec2 uv) { return base; }
        #else
        uniform highp sampler2D uSceneDepthMap;
        uniform float lens_view;     // normalized depth view: 0 off, 1 linear, 2 inverse
        uniform vec4 lens_extra;     // -, largest blur radius (pixels, white in the blur amount view), depth range ready, lens DoF on
        uniform highp sampler2D lens_rangeMap;   // depth range of the image (stillFrames.ts): nearest, farthest
        uniform sampler2D lens_dofMap;           // the half-size gather: blurred colour, nearer blur's cover
        ${commonGLSL('uSceneDepthMap', 'sceneTexture')}

        vec3 applyDof(vec3 base, vec2 uv) {
            if (lens_extra.w < 0.5) {
                dCoc = vec2(0.0);
                return base;
            }
            // this pixel's own blur, at full size, along and across the radius
            float c = lensCoc(uv, lensDepth(uv)) * lens_params.y;
            float astig = lens_field.w * lensR2(lensQ(uv)) * lens_params.y;
            float own = max(abs(c - astig), abs(c + astig));
            vec4 b = texture2D(lens_dofMap, uv);
            float a = max(smoothstep(0.5, 2.0, own), b.a);
            dBlur = mix(base, b.rgb, a);

            // Debug view: red is this pixel's own blur behind the focus plane,
            // green in front of it or the blurred foreground over it. White
            // is the largest blur (lens_extra.y), so nothing clips; the
            // square root keeps small blurs visible (the blur in front of the
            // focus grows with 1 / distance, behind it stays under c∞).
            // Raised to 2.2 against the gamma the debug output gets.
            float amount = sqrt(clamp(own / lens_extra.y, 0.0, 1.0));
            vec2 v = c >= 0.0 ? vec2(amount, b.a) : vec2(0.0, max(amount, b.a));
            dCoc = pow(clamp(v, 0.0, 1.0), vec2(2.2));
            return dBlur;
        }
        #endif
    #endif
`;

// The normalized depth view, through the engine's composeMainEndPS hook (after
// tone mapping, before gamma, like the engine's own depth view): z-depth
// normalize, as compositing tools do it. The nearest and farthest depth in
// the image come from a pass of their own (stillFrames.ts), over a 32 x 32
// grid of well covered pixels and eased over a few frames, so the view stays
// steady while the camera moves; until that is ready, from a 12 x 12 grid
// here. The depth is spread over 0..1 between them, linearly or by 1 / depth
// (more detail close by). Pixels without depth (nothing there) come out
// white and do not count.
const composeMainEndGLSL = /* glsl */ `
    // With a film stock (films.ts) the tone mapping is linear and the film's
    // curve does its work later (stillFrames.ts): the scene-linear light is
    // log encoded over 16 stops (2^-12 .. 2^4) to fit the 10-bit frame. The
    // gamma the engine applies next is undone here, so the frame holds the
    // log value itself.
    if (look_logEncode > 0.5) {
        result = pow(clamp((log2(max(result, vec3(1.0 / 4096.0))) + 12.0) / 16.0, 0.0, 1.0), vec3(2.2));
    }
    #ifdef DOF
    #ifndef LENS_OFF
        if (lens_view > 0.5) {
            float dMin = 1e30;
            float dMax = 0.0;
            if (lens_extra.z > 0.5) {
                vec2 range = texture2DLod(lens_rangeMap, vec2(0.5), 0.0).rg;
                dMin = range.x;
                dMax = range.y;
            } else {
                for (int gy = 0; gy < 12; gy++) {
                    for (int gx = 0; gx < 12; gx++) {
                        vec2 g = (vec2(float(gx), float(gy)) + 0.5) / 12.0;
                        float gd = lensDepth(g);
                        if (gd < lens_quality.w * 0.999) {
                            dMin = min(dMin, gd);
                            dMax = max(dMax, gd);
                        }
                    }
                }
            }
            dMax = max(dMax, dMin * 1.001);
            float d = lensDepth(uv);
            float t = lens_view > 1.5
                ? (1.0 / dMin - 1.0 / max(d, 1e-6)) / (1.0 / dMin - 1.0 / dMax)
                : (d - dMin) / (dMax - dMin);
            result = d < lens_quality.w * 0.999 ? vec3(clamp(t, 0.0, 1.0)) : vec3(1.0);
        }
    #endif
    #endif
`;

// declared at the top level of the compose shader, for composeMainEndPS
const composeDeclarationsGLSL = /* glsl */ `
    uniform float look_logEncode;
`;

/** Whether the compose pass hands over log-encoded scene-linear light (a film is on). */
export function setLogEncode(app: AppBase, on: boolean) {
    app.graphicsDevice.scope.resolve('look_logEncode').setValue(on ? 1 : 0);
}

/** Puts the lens DoF into the engine's compose shader. Call once, before DoF is first switched on. */
export function installLensDof(app: AppBase) {
    setShaderChunks(app, 'composePS', {
        composeDofPS: composeDofGLSL,
        composeDeclarationsPS: composeDeclarationsGLSL,
        composeMainEndPS: composeMainEndGLSL
    });
}

/** Normalized depth view: 0 off, 1 linear, 2 inverse. */
export type DepthView = 0 | 1 | 2;

// mipmapped: the engine makes the levels after each render into it
function halfTarget(device: GraphicsDevice, name: string, mipmaps: boolean) {
    const colorBuffer = new Texture(device, {
        name, width: Math.max(1, device.width >> 1), height: Math.max(1, device.height >> 1),
        format: PIXELFORMAT_RGBA16F, mipmaps,
        minFilter: mipmaps ? FILTER_LINEAR_MIPMAP_LINEAR : FILTER_LINEAR, magFilter: FILTER_LINEAR,
        addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE
    });
    return new RenderTarget({ name, colorBuffer, depth: false });
}

function quadShader(device: GraphicsDevice, name: string, fragmentGLSL: string): Shader {
    return ShaderUtils.createShader(device, {
        uniqueName: name,
        attributes: { aPosition: SEMANTIC_POSITION },
        vertexChunk: 'quadVS',
        fragmentGLSL
    });
}

/**
 * The half-size DoF pass, run inside CameraFrame after the scene (and the
 * still's accumulation; stillFrames.ts places it). `source` is what the
 * compose pass reads this frame: the scene, or a still's average.
 */
export class LensDofPass extends FramePass {
    /** Whether the lens DoF is wanted this frame (set by updateLensDof). */
    wanted = false;
    source: Texture | null = null;
    depth: Texture | null = null;
    /** c∞ and the largest blur radius, full-size pixels (set by updateLensDof). */
    radii: [number, number] = [0, 0];
    private prep: RenderTarget;
    private gather: RenderTarget;
    private prepShader: Shader;
    private gatherShader: Shader;
    private kernel = new Float32Array(KERNEL * 4);
    private kernelKey = '';

    constructor(device: GraphicsDevice) {
        super(device);
        this.name = 'LensDof';
        this.prep = halfTarget(device, 'LensDofPrep', true);
        this.gather = halfTarget(device, 'LensDofGather', false);
        this.prepShader = quadShader(device, 'LensDofPrep', prepGLSL);
        this.gatherShader = quadShader(device, 'LensDofGather', gatherGLSL);
    }

    /** The lens points of the kernel: the aperture's shape, weighted for bubble. */
    setKernel(lens: Lens) {
        const key = `${lens.blades}|${lens.bladeRoundness}|${lens.bladeRotation}|${lens.anamorphic}|${lens.bokehCharacter}`;
        if (key === this.kernelKey) return;
        this.kernelKey = key;
        const aperture = new Aperture(lens);
        for (let i = 0; i < KERNEL; i++) {
            const [u, v] = aperture.sample(i);
            this.kernel.set([u, v, Math.max(0, 1 + lens.bokehCharacter * (2 * (u * u + v * v) - 1)), 0], i * 4);
        }
    }

    execute() {
        const { source, depth, device } = this;
        if (!source || !depth) return;
        const w = Math.max(1, source.width >> 1);
        const h = Math.max(1, source.height >> 1);
        if (this.prep.width !== w || this.prep.height !== h) {
            this.prep.resize(w, h);
            this.gather.resize(w, h);
        }
        const scope = device.scope;
        const [R0, maxR] = this.radii;
        device.setBlendState(BlendState.NOBLEND);
        scope.resolve('dof_scene').setValue(source);
        scope.resolve('dof_depth').setValue(depth);
        scope.resolve('dof_size').setValue([1 / source.width, 1 / source.height, R0 / 2, maxR / 2]);
        drawQuadWithShader(device, this.prep, this.prepShader);

        scope.resolve('dof_prep').setValue(this.prep.colorBuffer);
        scope.resolve('dof_kernel[0]').setValue(this.kernel);
        scope.resolve('dof_size').setValue([1 / w, 1 / h, R0 / 2, maxR / 2]);
        drawQuadWithShader(device, this.gather, this.gatherShader);
        scope.resolve('lens_dofMap').setValue(this.gather.colorBuffer);
    }

    // Not destroy(): the engine calls that on every pass in the camera's list
    // whenever CameraFrame rebuilds its passes, and this one lives on.
    /** Frees the buffers; StillFrames calls it when it goes. */
    dispose() {
        for (const rt of [this.prep, this.gather]) {
            rt.destroyTextureBuffers();
            rt.destroy();
        }
    }
}

/**
 * Sets the engine's DoF to its cheapest (it only has to provide the scene
 * depth and the compose hook), and the lens for this frame: `focus` in
 * meters; `blur` scales every blur circle: 1 for the lens, less for the
 * over-blur on a still being accumulated (useStillDof.ts), 0 keeps the image
 * sharp (debug views); `still` turns the kernel per pixel for the over-blur.
 * `range` is the depth range texture for the normalized depth view
 * (stillFrames.ts), when it is ready.
 */
export function updateLensDof(app: AppBase, cf: CameraFrame, pass: LensDofPass | null, lens: Lens, shape: FrameShape,
    focus: number, blur: number, still: boolean, view: DepthView, range: { texture: Texture; ready: boolean }) {
    const dof = cf.dof;
    dof.highQuality = false;
    dof.nearBlur = false;
    dof.blurRings = 1;
    dof.blurRingPoints = 1;

    const device = app.graphicsDevice;
    const f = lens.focalLength / 1000;                     // m
    const S = Math.max(focus, f * 1.01);                   // m, beyond the lens
    const cInf = (f * f) / (lens.fStop * (S - f));         // blur diameter at infinity on the sensor, m
    // the frame (the sensor's aspect) inside the canvas; outside it is overscan
    const frame = frameRect(device.width, device.height, shape);
    const radiusPx = (cInf / 2) / (lens.sensorWidth / 1000) * frame.w;   // sensor width = frame width

    // the splat scene depth is stored as 1 / depth; a depth prepass stores it linear
    const camera = cf.entity.camera!;
    const reciprocal = depthIsReciprocal(camera);
    const scope = device.scope;
    const on = blur > 0 && !!pass;
    const w2 = lens.sensorWidth * lens.sensorWidth;
    const h2 = lens.sensorHeight * lens.sensorHeight;
    // bokeh fringing as a focus ratio between green and red / blue (δ / f² · S)
    const fringing = lens.bokehFringing * (FRINGING_MM / 1000) / (f * f) * S;
    scope.resolve('lens_params').setValue([S / lens.metersPerUnit, radiusPx * blur, 0, 0]);
    scope.resolve('lens_quality').setValue([0, 0, reciprocal ? 2 : 1, camera.farClip]);
    scope.resolve('lens_field').setValue([lens.fieldCurvature, lens.tiltX, lens.tiltY, lens.astigmatism * ASTIGMATISM]);
    scope.resolve('lens_frameUv').setValue([frame.w / (2 * device.width), frame.h / (2 * device.height), w2 / (w2 + h2), h2 / (w2 + h2)]);
    scope.resolve('lens_view').setValue(view);
    scope.resolve('lens_extra').setValue([0, MAX_BLUR * frame.h, range.ready ? 1 : 0, on ? 1 : 0]);
    scope.resolve('lens_rangeMap').setValue(range.texture);
    scope.resolve('dof_lens').setValue([lens.catsEye * CATS_EYE_SHIFT, fringing, still ? 1 : 0, 0]);
    if (pass) {
        pass.wanted = on;
        pass.radii = [radiusPx * blur, MAX_BLUR * frame.h];
        pass.setKernel(lens);
    }
}
