// Physical depth of field on top of the engine's DoF.
//
// The engine's CameraFrame DoF blurs by a straight ramp between two
// distances. A real lens does not: the circle of confusion for a point at
// distance d, with the lens focused at S, is
//
//     c(d) = f² / (N · (S − f)) · |d − S| / d
//
// (f focal length, N f-number), which grows quickly in front of the focus
// plane and levels off towards a limit behind it. The engine's blur, its
// near / far handling and its quality settings are kept; only its small
// CoC shader is replaced by this formula. That shader is engine internals
// (RenderPassCoC in engine 2.23); the engine version is pinned.
//
// The replacement reuses the engine's own uniform: CameraFrame's
// dof.focusDistance arrives as params.x and dof.focusRange as params.y. Here
// those carry the focus distance (scene units) and the CoC scale below.

import { SEMANTIC_POSITION, ShaderUtils, PIXELFORMAT_RG8, type Shader } from 'playcanvas';
import type { CameraFrame } from 'playcanvas/scripts/esm/camera-frame.mjs';
import type { BLUR_QUALITIES, Lens } from '../scene/experience';

const cocGLSL = /* glsl */ `
    #include "screenDepthPS"
    varying vec2 uv0;
    uniform vec3 params;
    void main()
    {
        float depth = getLinearScreenDepth(uv0);
        float focus = params.x;
        float scale = params.y;
        float cocFar = clamp(scale * (depth - focus) / depth, 0.0, 1.0);
        #ifdef NEAR_BLUR
            float cocNear = clamp(scale * (focus - depth) / depth, 0.0, 1.0);
        #else
            float cocNear = 0.0;
        #endif
        gl_FragColor = vec4(cocFar, cocNear, 0.0, 0.0);
    }
`;

const cocWGSL = /* wgsl */ `
#include "screenDepthPS"
varying uv0: vec2f;
uniform params: vec3f;
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let depth: f32 = getLinearScreenDepth(uv0);
    let focus: f32 = uniform.params.x;
    let scale: f32 = uniform.params.y;
    let cocFar: f32 = clamp(scale * (depth - focus) / depth, 0.0, 1.0);
    #ifdef NEAR_BLUR
        var cocNear: f32 = clamp(scale * (focus - depth) / depth, 0.0, 1.0);
    #else
        var cocNear: f32 = 0.0;
    #endif
    output.color = vec4f(cocFar, cocNear, 0.0, 0.0);
    return output;
}
`;

// The engine samples the blur with rings of taps; a larger blur needs more
// rings to stay smooth. Each step caps the blur radius (as a fraction of
// the image height) at what its rings can cover.
type BlurQuality = typeof BLUR_QUALITIES[number];
const BLUR_QUALITY: Record<BlurQuality, { maxBlur: number; rings: number; ringPoints: number }> = {
    low: { maxBlur: 0.012, rings: 3, ringPoints: 5 },
    medium: { maxBlur: 0.022, rings: 4, ringPoints: 5 },
    high: { maxBlur: 0.035, rings: 6, ringPoints: 5 }
};

// the engine scales blurRadius by 1/540 of the image height
const ENGINE_REFERENCE_HEIGHT = 540;

/**
 * CameraFrame DoF settings for a lens. `aspect` is the image width / height;
 * the sensor width spans the image width.
 */
export function dofSettings(lens: Lens, aspect: number) {
    const q = BLUR_QUALITY[lens.blurQuality];
    const f = lens.focalLength / 1000;                     // m
    const S = Math.max(lens.focusDistance, f * 1.01);      // m, beyond the lens
    const c = (f * f) / (lens.fStop * (S - f));            // CoC diameter on the sensor, m, per |d−S|/d
    const radius = (c / 2) / (lens.sensorWidth / 1000) * aspect;   // fraction of image height
    return {
        focusDistance: S / lens.metersPerUnit,             // scene units, as the depth is
        focusRange: Math.max(radius / q.maxBlur, 1e-6),    // CoC scale; the engine divides by it
        blurRadius: q.maxBlur * ENGINE_REFERENCE_HEIGHT,
        blurRings: q.rings,
        blurRingPoints: q.ringPoints
    };
}

type CocPass = { shader: Shader; cameraComponent: { shaderParams: unknown } };
type DofPass = { cocPass: CocPass | null; cocTexture: { format: number } | null };
type EngineFrame = { renderPassCamera?: { dofPass?: DofPass | null } | null };

const replaced = new WeakSet<CocPass>();

/** Puts the physical CoC shader into the engine's DoF, whenever the engine (re)creates it. */
export function installPhysicalCoc(cf: CameraFrame) {
    const engine = (cf as unknown as { engineCameraFrame?: EngineFrame }).engineCameraFrame;
    const dof = engine?.renderPassCamera?.dofPass;
    const pass = dof?.cocPass;
    if (!dof || !pass || replaced.has(pass)) return;

    const nearBlur = dof.cocTexture?.format === PIXELFORMAT_RG8;
    const defines = new Map<string, string>();
    if (nearBlur) defines.set('NEAR_BLUR', '');
    const depthKey = ShaderUtils.addScreenDepthChunkDefines(pass.cameraComponent.shaderParams as never, defines);
    pass.shader = ShaderUtils.createShader((pass.shader as unknown as { device: never }).device, {
        uniqueName: `PhysicalCocShader-${nearBlur}${depthKey}`,
        attributes: { aPosition: SEMANTIC_POSITION },
        vertexChunk: 'quadVS',
        fragmentGLSL: cocGLSL,
        fragmentWGSL: cocWGSL,
        fragmentDefines: defines
    });
    replaced.add(pass);
}
