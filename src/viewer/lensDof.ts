// Thin-lens depth of field, gathered in the engine's compose pass. This is
// the quick version shown while the camera moves; a still camera gets the
// exact DoF accumulated over the aperture (stillFrames.ts, useStillDof.ts).
//
// The engine's own DoF blends a pre-blurred image over the sharp one by the
// blur amount, which reads as "sharp plus haze", and it cannot let a blurred
// foreground spread over the background. This replaces only its compose
// function (`composeDofPS`, through the engine's ShaderChunks API) with a
// gather over the full-resolution HDR scene: each pixel collects the scene
// points whose blur circle reaches it. The engine's DoF stays on for two
// things only, the scene depth it makes the engine render and the DOF hook in
// the compose shader; its own blur passes are set to their cheapest.
//
// Blur circle for a point at depth d, lens focused at S (thin lens):
//     c(d) = f² / (N · (S − f)) · |d − S| / d = c∞ · |1 − S / d|
// c∞ is the blur of a point at infinity; behind the focus plane the blur
// levels off towards it, in front of it it keeps growing.

import type { AppBase, Texture } from 'playcanvas';
import type { CameraFrame } from 'playcanvas/scripts/esm/camera-frame.mjs';
import { frameRect, type FrameShape, type Lens } from '../scene/experience';
import { depthIsReciprocal, setShaderChunks } from './engine';

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
        uniform vec4 lens_params;    // focus (scene units), c∞ (pixels, radius), max radius, edge band (pixels)
        uniform vec4 lens_quality;   // samples, depth probes, depth format (1 linear, 2 reciprocal), far
        uniform float lens_view;     // normalized depth view: 0 off, 1 linear, 2 inverse
        uniform vec4 lens_extra;     // grain (over-blur), blur amount view white (pixels), depth range ready, -
        uniform highp sampler2D lens_rangeMap;   // depth range of the image (stillFrames.ts): nearest, farthest

        // The splat scene depth holds, per pixel, the coverage-weighted sum of
        // 1 / depth of the splats, plus the uncovered rest (1 - A) times the
        // value it was cleared to, 1 / far. The scene alpha is that coverage
        // A (the camera clears it to 0, and splats blend it premultiplied like
        // their colour), so the rest can be taken off again and the sum
        // divided by A: the depth of what is actually there, also at a soft
        // splat edge against empty space. Without alpha in the scene format
        // A reads 1 and this is the plain average.
        float lensDepth(vec2 uv) {
            float v = texture2DLod(uSceneDepthMap, uv, 0.0).r;
            if (lens_quality.z > 1.5) {
                float far = lens_quality.w;
                float a = texture2DLod(sceneTexture, uv, 0.0).a;
                float s = v - (1.0 - a) / far;
                return a > 0.01 && s > 1e-7 ? min(a / s, far) : far;
            }
            return v;
        }

        float lensCoc(float depth) {
            return min(abs(1.0 - lens_params.x / max(depth, 1e-4)) * lens_params.y, lens_params.z);
        }

        // The blur of this pixel itself, and whether it belongs to the front.
        //
        // Splat edges are soft: over a band of pixels (lens_params.w) the depth
        // is a coverage-weighted mix of the object and what lies behind it, so
        // the rim of a blurred object would get too little blur (a dark,
        // sharp-looking seam), and a mix that lands on the focus plane none at
        // all. Two rules fix that:
        // - near blur is dilated over that band: a pixel takes the blur of a
        //   nearer neighbour within the band when it is larger (the rim is
        //   mostly that object's own soft splats). An object in focus has no
        //   blur to give, so its edge stays crisp;
        // - when the neighbours straddle the focus plane, the pixel is a mix of
        //   two surfaces and gets at least the smaller of their two blurs.
        vec2 lensCenterCoc(vec2 uv, float depth) {
            float size = lensCoc(depth);
            float front = depth < lens_params.x ? 1.0 : 0.0;
            float dMin = depth;
            float dMax = depth;
            for (int ring = 1; ring <= 3; ring++) {
                float r = lens_params.w * float(ring) / 3.0;
                for (int i = 0; i < 8; i++) {
                    float a = (float(i) + 0.5 * float(ring)) * 0.785398;
                    float d = lensDepth(uv + vec2(cos(a), sin(a)) * r * sceneTextureInvRes);
                    dMin = min(dMin, d);
                    dMax = max(dMax, d);
                    if (d < depth * 0.98) {
                        float s = lensCoc(d);
                        if (s > size) {
                            size = s;
                            front = d < lens_params.x ? 1.0 : front;
                        }
                    }
                }
            }
            if (dMin < lens_params.x && dMax > lens_params.x) {
                size = max(size, min(lensCoc(dMin), lensCoc(dMax)));
            }
            return vec2(size, front);
        }

        // Each pixel gathers samples spread evenly over a disc (golden-angle
        // spiral) and sorts them into two layers:
        //
        // - its own surface and what lies behind it: a sample counts when its
        //   blur circle reaches this pixel (background behind a sharper edge
        //   is held back, so no halos);
        // - nearer, blurred surfaces in front of it: their light is spread
        //   over their blur disc, so each sample adds its share of coverage,
        //   (disc area per sample) / (its blur disc area). Summed, that is how
        //   much of this pixel the out-of-focus foreground covers: about half
        //   right at its edge, fading to nothing one blur radius out, the way
        //   a real lens shows a blurred object in front of a sharp one.
        //
        // The result is the foreground laid over the pixel's own blur by that
        // coverage.
        vec3 applyDof(vec3 base, vec2 uv) {
            // no gather: lens DoF off (or a debug view that keeps the image sharp)
            if (lens_params.y <= 0.0) {
                dCoc = vec2(0.0);
                return base;
            }
            float maxR = lens_params.z;
            float centerDepth = lensDepth(uv);
            vec2 center = lensCenterCoc(uv, centerDepth);
            float centerSize = center.x;
            dBlur = base;

            // How far to look: this pixel's own blur, or further when a
            // nearer, more blurred neighbour reaches over it. Probes are
            // spaced evenly in radius; a neighbour counts when its blur plus
            // the soft-edge band (lens_params.w) reaches, since the depth at a
            // splat's soft rim only gets to the object's real depth some
            // pixels in.
            // For the over-blur on a still (radius up to OVERBLUR_MAX) every
            // pixel turns the sample pattern by its own angle (interleaved
            // gradient noise, Jimenez 2014): with one pattern for all pixels,
            // too few samples for a large blur show as copies, stepped lines;
            // turned per pixel the same error becomes fine grain, which the
            // averaged still hardly shows. The quick DoF while moving keeps
            // one smooth pattern within its smaller radius.
            float turn = lens_extra.x > 0.5
                ? 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))
                : 0.0;

            float reach = centerSize;
            for (int i = 0; i < 32; i++) {
                if (float(i) >= lens_quality.y) break;
                float r = maxR * (float(i) + 0.5) / lens_quality.y;
                float a = float(i) * 2.39996323 + turn;
                float d = lensDepth(uv + vec2(cos(a), sin(a)) * r * sceneTextureInvRes);
                if (d < centerDepth) {
                    float size = lensCoc(d);
                    reach = max(reach, mix(reach, size, smoothstep(r * 0.5, r, size + lens_params.w)));
                }
            }
            reach = min(reach, maxR);

            if (reach < 0.25) {
                dCoc = vec2(0.0);
                return base;
            }

            vec3 ownColor = base;
            float ownTotal = 1.0;
            vec3 nearColor = vec3(0.0);
            float nearCover = 0.0;
            float nearSize = 0.0;
            float area = reach * reach / lens_quality.x;      // disc area per sample, over pi
            float angle = turn;
            for (int i = 0; i < 256; i++) {
                if (float(i) >= lens_quality.x) break;
                float radius = reach * sqrt((float(i) + 0.5) / lens_quality.x);
                vec2 tc = uv + vec2(cos(angle), sin(angle)) * radius * sceneTextureInvRes;
                angle += 2.39996323;
                vec3 sampleColor = texture2DLod(sceneTexture, tc, 0.0).rgb;
                float sampleDepth = lensDepth(tc);
                float sampleSize = lensCoc(sampleDepth);

                if (sampleDepth < centerDepth * 0.98) {
                    // a nearer surface: covers this pixel where its blur reaches
                    float w = smoothstep(radius - 1.0, radius + 1.0, sampleSize) * area / max(sampleSize * sampleSize, 0.25);
                    nearColor += sampleColor * w;
                    nearCover += w;
                    nearSize += sampleSize * w;
                } else {
                    // this surface or behind it; behind is held to this pixel's blur
                    if (sampleDepth > centerDepth) sampleSize = min(sampleSize, centerSize * 2.0);
                    float m = smoothstep(radius - 1.0, radius + 1.0, sampleSize);
                    ownColor += mix(ownColor / ownTotal, sampleColor, m);
                    ownTotal += 1.0;
                }
            }

            // own blur, fading in over its first pixel instead of switching on
            vec3 own = mix(base, ownColor / ownTotal, smoothstep(0.25, 1.25, centerSize));
            float cover = clamp(nearCover, 0.0, 1.0);
            dBlur = nearCover > 0.0 ? mix(own, nearColor / nearCover, cover) : own;

            // Debug view: red is this pixel's own blur behind the focus plane,
            // green in front of it or the blurred foreground over it. Squared
            // against the gamma the debug output gets, so brightness follows
            // the blur size; white is a fixed radius (lens_extra.y).
            float ownAmount = centerSize / lens_extra.y;
            float nearAmount = nearCover > 0.0 ? cover * nearSize / nearCover / lens_extra.y : 0.0;
            vec2 amount = center.y < 0.5 ? vec2(ownAmount, nearAmount) : vec2(0.0, max(ownAmount, nearAmount));
            dCoc = pow(clamp(amount, 0.0, 1.0), vec2(2.2));

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

// The gather stands in while the camera moves, and adds a shrinking
// over-blur while a still is accumulated over the aperture (useStillDof.ts),
// so it has one fixed setting: samples, depth probes and the largest blur
// radius as a fraction of the image height.
const GATHER = { samples: 32, probes: 16, maxBlur: 0.025 };
// The over-blur is a fraction of the full blur, but that fraction of a
// strongly blurred foreground is still more than the moving limit.
const OVERBLUR_MAX = 0.08;
// white in the blur amount view, as a fraction of the image height
const BLUR_VIEW_WHITE = 0.025;

/**
 * Sets the engine's DoF to its cheapest (it only has to provide the scene
 * depth and the compose hook) and the lens uniforms for this frame.
 * `focus` in meters; `blur` scales every blur circle: 1 for the lens, less
 * for the over-blur on a still being accumulated (useStillDof.ts), 0 keeps
 * the image sharp (debug views); `still` gives the over-blur its larger
 * radius limit and grain. `range` is the depth range texture for the
 * normalized depth view (stillFrames.ts), when it is ready.
 */
export function updateLensDof(app: AppBase, cf: CameraFrame, lens: Lens, shape: FrameShape, focus: number, blur: number, still: boolean,
    view: DepthView, range: { texture: Texture; ready: boolean }) {
    const dof = cf.dof;
    dof.highQuality = false;
    dof.nearBlur = false;
    dof.blurRings = 1;
    dof.blurRingPoints = 1;

    const device = app.graphicsDevice;
    const q = GATHER;
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
    // the soft rim of splat edges, roughly a percent of the image height
    const edgeBand = 0.01 * frame.h;
    const maxBlur = still ? OVERBLUR_MAX : q.maxBlur;
    scope.resolve('lens_params').setValue([S / lens.metersPerUnit, radiusPx * blur, maxBlur * frame.h, edgeBand]);
    scope.resolve('lens_quality').setValue([q.samples, q.probes, reciprocal ? 2 : 1, camera.farClip]);
    scope.resolve('lens_view').setValue(view);
    scope.resolve('lens_extra').setValue([still ? 1 : 0, BLUR_VIEW_WHITE * frame.h, range.ready ? 1 : 0, 0]);
    scope.resolve('lens_rangeMap').setValue(range.texture);
}
