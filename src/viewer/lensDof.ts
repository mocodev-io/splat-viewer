// Thin-lens depth of field, gathered in the engine's compose pass.
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

import { SHADERLANGUAGE_GLSL, ShaderChunks, type AppBase } from 'playcanvas';
import type { CameraFrame } from 'playcanvas/scripts/esm/camera-frame.mjs';
import type { BLUR_QUALITIES, Lens } from '../scene/experience';

const composeDofGLSL = /* glsl */ `
    #ifdef DOF
        // screenDepthPS declares the depth map too, for the depth debug view
        #ifdef DEBUG_COMPOSE
            #if DEBUG_COMPOSE == depth
                #define LENS_DEPTH_DECLARED
            #endif
        #endif
        #ifndef LENS_DEPTH_DECLARED
            uniform highp sampler2D uSceneDepthMap;
        #endif

        uniform vec3 lens_params;    // focus (scene units), c∞ (pixels, radius), max radius (pixels)
        uniform vec4 lens_quality;   // samples, depth probes, depth format (1 linear, 2 reciprocal), far

        // read by the engine's debug views
        vec2 dCoc;
        vec3 dBlur;

        float lensDepth(vec2 uv) {
            float v = texture2DLod(uSceneDepthMap, uv, 0.0).r;
            if (lens_quality.z > 1.5) return v > 0.0 ? 1.0 / v : lens_quality.w;
            return v;
        }

        float lensCoc(float depth) {
            return min(abs(1.0 - lens_params.x / max(depth, 1e-4)) * lens_params.y, lens_params.z);
        }

        float lensHash(vec2 p) {
            return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        // Scatter-as-gather on a golden-angle spiral: a sample counts when its
        // own blur circle reaches this pixel. A blurred foreground therefore
        // spills over a sharp background, while background behind a sharp
        // edge is held back (no halos).
        vec3 applyDof(vec3 base, vec2 uv) {
            float maxR = lens_params.z;
            float centerDepth = lensDepth(uv);
            float centerSize = lensCoc(centerDepth);
            dCoc = centerDepth > lens_params.x ? vec2(centerSize / maxR, 0.0) : vec2(0.0, centerSize / maxR);
            dBlur = base;

            // each pixel turns its pattern by its own angle: fine noise
            // instead of visible sample directions
            float spin = lensHash(gl_FragCoord.xy) * 6.2831853;

            // How far to gather: this pixel's own blur, or further when a
            // nearer, more blurred neighbour reaches over it. The widening
            // fades in with how well the neighbour reaches, so spill edges move
            // smoothly while focusing. Sharp pixels with nothing blurred in
            // front of them stop here, which is most of the frame.
            float reach = centerSize;
            for (int i = 0; i < 32; i++) {
                if (float(i) >= lens_quality.y) break;
                float r = maxR * sqrt((float(i) + 0.5) / lens_quality.y);
                float a = spin + float(i) * 2.39996323;
                float d = lensDepth(uv + vec2(cos(a), sin(a)) * r * sceneTextureInvRes);
                if (d < centerDepth) {
                    float size = lensCoc(d);
                    reach = max(reach, mix(reach, size, smoothstep(r * 0.5, r, size)));
                }
            }
            if (reach < 0.25) return base;
            reach = min(reach, maxR);

            // samples spread evenly over the disc of that reach
            vec3 color = base;
            float total = 1.0;
            float angle = spin;
            for (int i = 0; i < 256; i++) {
                if (float(i) >= lens_quality.x) break;
                float radius = reach * sqrt((float(i) + 0.5) / lens_quality.x);
                vec2 tc = uv + vec2(cos(angle), sin(angle)) * radius * sceneTextureInvRes;
                vec3 sampleColor = texture2DLod(sceneTexture, tc, 0.0).rgb;
                float sampleDepth = lensDepth(tc);
                float sampleSize = lensCoc(sampleDepth);
                // background does not spread over what is in front of it
                if (sampleDepth > centerDepth) sampleSize = min(sampleSize, centerSize * 2.0);
                float m = smoothstep(radius - 1.0, radius + 1.0, sampleSize);
                color += mix(color / total, sampleColor, m);
                total += 1.0;
                angle += 2.39996323;
            }
            dBlur = color / total;
            // fades in over the first pixel of blur instead of switching on
            return mix(base, dBlur, smoothstep(0.25, 1.25, reach));
        }
    #endif
`;

/** Puts the lens DoF into the engine's compose shader. Call once, before DoF is first switched on. */
export function installLensDof(app: AppBase) {
    ShaderChunks.get(app.graphicsDevice, SHADERLANGUAGE_GLSL).set('composeDofPS', composeDofGLSL);
}

// Samples and depth probes per quality step, and the largest blur radius as
// a fraction of the image height: more samples keep a bigger blur smooth.
type BlurQuality = typeof BLUR_QUALITIES[number];
const QUALITY: Record<BlurQuality, { samples: number; probes: number; maxBlur: number }> = {
    low: { samples: 24, probes: 8, maxBlur: 0.015 },
    medium: { samples: 48, probes: 12, maxBlur: 0.025 },
    high: { samples: 96, probes: 16, maxBlur: 0.04 }
};

/**
 * Sets the engine's DoF to its cheapest (it only has to provide the scene
 * depth and the compose hook) and the lens uniforms for this frame.
 * `focus` in meters; `blur` false keeps the image sharp (debug views).
 */
export function updateLensDof(app: AppBase, cf: CameraFrame, lens: Lens, focus: number, blur: boolean) {
    const dof = cf.dof;
    dof.highQuality = false;
    dof.nearBlur = false;
    dof.blurRings = 1;
    dof.blurRingPoints = 1;

    const device = app.graphicsDevice;
    const q = QUALITY[lens.blurQuality];
    const f = lens.focalLength / 1000;                     // m
    const S = Math.max(focus, f * 1.01);                   // m, beyond the lens
    const cInf = (f * f) / (lens.fStop * (S - f));         // blur diameter at infinity on the sensor, m
    const radiusPx = (cInf / 2) / (lens.sensorWidth / 1000) * device.width;   // sensor width = image width

    // the splat scene depth is stored as 1 / depth; a depth prepass stores it linear
    const camera = cf.entity.camera!;
    const reciprocal = (camera as unknown as { shaderParams: { sceneDepthMapReciprocal: boolean } }).shaderParams.sceneDepthMapReciprocal;
    const scope = device.scope;
    scope.resolve('lens_params').setValue([S / lens.metersPerUnit, blur ? radiusPx : 0, q.maxBlur * device.height]);
    scope.resolve('lens_quality').setValue([q.samples, q.probes, reciprocal ? 2 : 1, camera.farClip]);
}
