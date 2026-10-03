// Everything the viewer uses of PlayCanvas beyond its public API, in one
// place, each with a check.
//
// The still DoF, the lens DoF and a few conveniences reach into engine
// internals: fields of the CameraFrame passes, shader chunk names, camera
// shader parameters. They hold for the pinned engine (TESTED_ENGINE); an
// engine update can rename or drop any of them. Each accessor here checks
// what it finds and, when something is missing, reports it once (console,
// and `engineProblems` for the HUD) instead of failing somewhere deep in a
// frame. The still DoF switches itself off when its hooks are missing; the
// moving view keeps working.

import {
    SHADERLANGUAGE_GLSL, ShaderChunks, version, type AppBase, type CameraComponent, type FramePass, type RenderTarget,
    type Texture
} from 'playcanvas';
import type { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import type { CameraFrame } from 'playcanvas/scripts/esm/camera-frame.mjs';

/** The engine version these hooks were written and tested against. */
export const TESTED_ENGINE = '2.23.0';

const problems = new Set<string>();
/** Hooks found missing so far. */
export const engineProblems = (): readonly string[] => [...problems];

function report(what: string) {
    if (problems.has(what)) return;
    problems.add(what);
    console.error(`[splat-viewer] engine ${version} (tested ${TESTED_ENGINE}): ${what}`);
}

// (typed as a build placeholder in the engine's declarations)
if ((version as string) !== TESTED_ENGINE) {
    console.warn(`[splat-viewer] engine ${version}, the hooks were tested with ${TESTED_ENGINE}; any missing one is reported`);
}

// ---- the camera frame pass (FramePassCameraFrame, not in the public types)

/** What the still DoF uses of the engine's camera frame pass. */
export type CameraFramePass = FramePass & {
    rt: RenderTarget | null;
    sceneDepthTexture: Texture | null;
    scenePass: FramePass | null;
    scenePassTransparent: FramePass | null;
    composePass: { sceneTexture: Texture } | null;
    scenePassHalf: { setSourceTexture(t: Texture): void } | null;
    dofPass: { setSceneTexture(t: Texture): void } | null;
};

// the pass is built when the CameraFrame is enabled; frames to wait for it
// before calling it missing
const BUILD_FRAMES = 10;
let waited = 0;
const checked = new WeakSet<object>();

/**
 * The camera frame pass behind the CameraFrame script, checked, or null
 * when it is not there (yet, or no longer in this engine).
 */
export function cameraFramePass(script: CameraFrame | null): CameraFramePass | null {
    if (!script) return null;
    if (!('engineCameraFrame' in script)) {
        report('CameraFrame script has no engineCameraFrame; still DoF off');
        return null;
    }
    const engine = (script as unknown as { engineCameraFrame?: { renderPassCamera?: unknown } }).engineCameraFrame;
    const rpc = engine?.renderPassCamera as CameraFramePass | null | undefined;
    if (!rpc) {
        if (engine && !('renderPassCamera' in engine)) report('engine CameraFrame has no renderPassCamera; still DoF off');
        else if (++waited > BUILD_FRAMES) report('camera frame pass not built; still DoF off');
        return null;
    }
    waited = 0;
    if (checked.has(rpc)) return rpc;
    const lacks = [
        typeof rpc.frameUpdate !== 'function' && 'frameUpdate()',
        !Array.isArray(rpc.beforePasses) && 'beforePasses',
        // the transparent, half-size and DoF passes exist only when in use
        ...(['rt', 'sceneDepthTexture', 'scenePass', 'composePass'] as const).filter(k => !(k in rpc))
    ].filter(Boolean);
    if (lacks.length) {
        report(`camera frame pass lacks ${lacks.join(', ')}; still DoF off`);
        return null;
    }
    checked.add(rpc);
    return rpc;
}

/** Whether the compose pass of this frame can be pointed at another scene texture. */
export function composeReadsScene(rpc: CameraFramePass): boolean {
    if (!rpc.composePass) return true;          // not built this frame; nothing to point
    if ('sceneTexture' in rpc.composePass) return true;
    report('compose pass has no sceneTexture; still DoF off');
    return false;
}

/** Whether the still DoF can run: its hooks have all been found. */
export const stillHooksOk = () => ![...problems].some(p => p.endsWith('still DoF off'));

// ---- camera shader parameters

/** Whether the scene depth map holds 1 / depth (splats) rather than linear depth. */
export function depthIsReciprocal(camera: CameraComponent | null | undefined): boolean {
    if (!camera) return false;
    const params = (camera as unknown as { shaderParams?: { sceneDepthMapReciprocal?: unknown } }).shaderParams;
    if (typeof params?.sceneDepthMapReciprocal !== 'boolean') {
        report('camera shaderParams.sceneDepthMapReciprocal not found; splat depth read as linear (DoF wrong)');
        return false;
    }
    return params.sceneDepthMapReciprocal;
}

// ---- shader chunks
//
// The engine adds its compose chunks only when it first builds a compose
// pass, and keeps chunks already set; so ours go in early, and are checked
// once the engine's compose shader (`composePS`) is there: it must still
// include them by these names.

const hooked: { host: string; names: string[] }[] = [];

/** Puts chunks into the shader `host` (an engine chunk that includes them by name). */
export function setShaderChunks(app: AppBase, host: string, chunks: Record<string, string>) {
    const map = ShaderChunks.get(app.graphicsDevice, SHADERLANGUAGE_GLSL);
    for (const [name, code] of Object.entries(chunks)) map.set(name, code);
    hooked.push({ host, names: Object.keys(chunks) });
}

/** Checks the hooked chunks once their host exists; cheap to call every frame. */
export function verifyShaderChunks(app: AppBase) {
    if (!hooked.length) return;
    const map = ShaderChunks.get(app.graphicsDevice, SHADERLANGUAGE_GLSL);
    for (let i = hooked.length - 1; i >= 0; i--) {
        const source = map.get(hooked[i].host);
        if (typeof source !== 'string') continue;          // not built yet
        for (const name of hooked[i].names) {
            if (!source.includes(`#include "${name}"`)) report(`shader chunk ${name} is no longer used by ${hooked[i].host}; the lens DoF does not show`);
        }
        hooked.splice(i, 1);
    }
}

// ---- splats

/** Splats writing their depth into the scene depth (engine PR #9174). */
export function enableSplatDepth(app: AppBase) {
    const gsplat = app.scene.gsplat as unknown as Record<string, unknown>;
    if (!('sceneDepthWrite' in gsplat)) report('gsplat.sceneDepthWrite not found; DoF sees no splat depth');
    gsplat.sceneDepthWrite = true;
}

// ---- camera controls

/** The orbit distance of CameraControls (kept privately), or null. */
export function orbitDistance(controls: CameraControls): number | null {
    const pose = (controls as unknown as { _pose?: { distance?: unknown } })._pose;
    if (typeof pose?.distance !== 'number') {
        report('CameraControls _pose.distance not found; saved views use a target 1 unit ahead');
        return null;
    }
    return pose.distance;
}
