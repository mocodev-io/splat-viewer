import { useEffect, useRef, type RefObject } from 'react';
import { Color, Picker, Vec3 } from 'playcanvas';
import { Entity } from '@playcanvas/react';
import { Camera, Script } from '@playcanvas/react/components';
import { useApp, useAppEvent } from '@playcanvas/react/hooks';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import { CameraFrame } from 'playcanvas/scripts/esm/camera-frame.mjs';
import { horizontalFov, type CameraPose, type Lens, type PostEffectSettings, type Tonemapping, type Vec3Tuple } from '../scene/experience';
import type { DebugView, DepthRange } from '../ui/panel';
import { updateLensDof, type DepthView } from './lensDof';
import { useStillDof } from './useStillDof';

export type ViewRequest = { pose: CameraPose; id: number };

export type CameraApi = {
    /** Where the camera is and what it orbits around, for saving the view. */
    getView: () => { position: Vec3Tuple; target: Vec3Tuple };
    /**
     * The world point under a position in the canvas (CSS pixels), or null for
     * empty sky. `coarse` picks from a quarter-resolution buffer (autofocus).
     */
    pick: (x: number, y: number, coarse?: boolean) => Promise<Vec3Tuple | null>;
    /** Distance of a point along the view direction (scene units): what the focus plane is measured in. */
    viewDepth: (p: Vec3Tuple) => number;
    /** A world point in canvas CSS pixels; `behind` when it is behind the camera. */
    toScreen: (p: Vec3Tuple) => { x: number; y: number; behind: boolean };
};

type ViewerCameraProps = {
    view: ViewRequest | null;             // a new id moves the camera there
    lens: Lens;
    focus: RefObject<number>;             // live focus distance, m (manual or autofocus)
    farClip: number;
    debugView: DebugView;
    depthRange: DepthRange;
    api: RefObject<CameraApi | null>;
    tonemapping: Tonemapping;
    highPrecision: boolean;
    postEffects: PostEffectSettings;
    background: Vec3Tuple;
    sceneKey: string;                     // changes whenever the scene content changes
    busy: boolean;                        // a splat is loading
    progress: RefObject<string>;          // still accumulation status for the HUD
};

// The camera: the engine's CameraControls for orbit / fly / pan, and the
// engine's CameraFrame for post-processing, driven by the scene settings and
// the lens.
export function ViewerCamera({ view, lens, focus, farClip, debugView, depthRange, api, tonemapping, highPrecision, postEffects, background, sceneKey, busy, progress }: ViewerCameraProps) {
    const app = useApp();
    const controls = useRef<CameraControls>(null);
    const frame = useRef<CameraFrame>(null);

    useEffect(() => {
        // The engine's picker renders splats and objects into its own buffer
        // with depth, on demand only (one render per pick). A full-resolution
        // one for clicks, a quarter-resolution one for autofocus.
        const pickers: { full: Picker | null; coarse: Picker | null } = { full: null, coarse: null };
        const entity = () => controls.current!.entity;

        api.current = {
            getView: () => {
                const cc = controls.current!;
                const p = entity().getPosition();
                // CameraControls keeps its orbit distance privately; the
                // target is that far along the view direction
                const distance = (cc as unknown as { _pose?: { distance?: number } })._pose?.distance || 1;
                const t = entity().forward.clone().mulScalar(distance).add(p);
                return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
            },
            pick: async (x, y, coarse = false) => {
                const device = app.graphicsDevice;
                const canvas = device.canvas as HTMLCanvasElement;
                const scale = coarse ? 0.25 : 1;
                const w = Math.max(1, Math.floor(device.width * scale));
                const h = Math.max(1, Math.floor(device.height * scale));
                const px = Math.floor(x * w / canvas.clientWidth);
                const py = Math.floor(y * h / canvas.clientHeight);
                const key = coarse ? 'coarse' : 'full';
                const fresh = !pickers[key];
                const picker = pickers[key] ??= new Picker(app, w, h, true);
                picker.resize(w, h);
                picker.prepare(entity().camera!, app.scene);
                // a new picker's first result is not valid yet (seen with
                // splats, engine 2.23); pick once more
                if (fresh) {
                    await picker.getWorldPointAsync(px, py);
                    picker.prepare(entity().camera!, app.scene);
                }
                const p = await picker.getWorldPointAsync(px, py);
                return p ? [p.x, p.y, p.z] : null;
            },
            viewDepth: p => {
                const e = entity();
                return new Vec3(...p).sub(e.getPosition()).dot(e.forward);
            },
            toScreen: p => {
                const s = entity().camera!.worldToScreen(new Vec3(...p));
                return { x: s.x, y: s.y, behind: s.z < 0 };
            }
        };
        return () => {
            api.current = null;
            pickers.full?.destroy();
            pickers.coarse?.destroy();
        };
    }, [api, app]);

    // move to a requested pose; CameraControls animates there
    useEffect(() => {
        const cc = controls.current;
        if (!view || !cc) return;
        cc.reset(new Vec3(view.pose.target), new Vec3(view.pose.position));
    }, [view]);

    // the Camera component takes colours as hex strings; alpha 0, so the scene
    // alpha ends up as the coverage of what was drawn (lensDof.ts uses it to
    // correct the splat depth at soft edges)
    const clearColor = '#' + background.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('') + '00';

    // post effects, mapped like SuperSplat's applyPostEffectSettings
    useEffect(() => {
        const cf = frame.current;
        if (!cf) return;
        const pe = postEffects;
        cf.rendering.samples = 1;   // splat depth (and splats in general) want no MSAA
        cf.rendering.toneMapping = tonemapping === 'none' ? 'linear' : tonemapping;
        // the lens DoF needs the scene alpha (the coverage), which rg11b10 has not
        cf.rendering.renderFormat = highPrecision || lens.dof ? 'rgba16' : 'rg11b10';
        cf.rendering.sharpness = pe.sharpness.enabled ? pe.sharpness.amount : 0;

        cf.bloom.enabled = pe.bloom.enabled;
        cf.bloom.intensity = pe.bloom.intensity;
        cf.bloom.blurLevel = pe.bloom.blurLevel;

        cf.grading.enabled = pe.grading.enabled;
        cf.grading.brightness = pe.grading.brightness;
        cf.grading.contrast = pe.grading.contrast;
        cf.grading.saturation = pe.grading.saturation;
        cf.grading.tint = new Color(...pe.grading.tint);

        cf.vignette.enabled = pe.vignette.enabled;
        cf.vignette.intensity = pe.vignette.intensity;
        cf.vignette.inner = pe.vignette.inner;
        cf.vignette.outer = pe.vignette.outer;
        cf.vignette.curvature = pe.vignette.curvature;

        cf.fringing.enabled = pe.fringing.enabled;
        cf.fringing.intensity = pe.fringing.intensity;
    }, [tonemapping, highPrecision, postEffects, lens.dof]);

    // The lens: depth of field (lensDof.ts) and the debug views. The engine's
    // DoF provides the scene depth and the compose hook, so the debug views
    // turn it on too; without lens DoF they show the image unblurred.
    useEffect(() => {
        const cf = frame.current;
        if (!cf) return;
        cf.dof.enabled = lens.dof || debugView !== 'image';
        // the engine draws the near/far depth view, lensDof.ts the normalized ones
        cf.rendering.debug = debugView === 'depth' && depthRange === 'camera near/far' ? 'depth'
            : debugView === 'blur amount' ? 'dofcoc' : 'none';
    }, [lens.dof, debugView, depthRange]);

    // normalized depth views (lensDof.ts)
    const depthView: DepthView = debugView !== 'depth' ? 0
        : depthRange === 'scene linear' ? 1 : depthRange === 'scene inverse' ? 2 : 0;

    // Still camera: the DoF is accumulated over the aperture (useStillDof.ts);
    // anything shown changing starts it over.
    const still = useStillDof({
        app, controls, frame, lens, focus, progress, busy,
        accumulate: lens.dof && debugView === 'image',
        depthRange: depthView > 0,
        sceneKey: JSON.stringify([sceneKey, lens, tonemapping, highPrecision, postEffects, background, debugView, depthRange, farClip])
    });

    // Focus and image size change between frames, so the lens is set per
    // frame. On a still the gather works on the accumulated average, as the
    // shrinking over-blur (useStillDof.ts).
    useAppEvent('prerender', () => {
        const cf = frame.current;
        if (!cf || !cf.dof.enabled) return;
        const s = still.current;
        const blur = lens.dof || debugView === 'blur amount' ? s.overblur : 0;
        if (!s.range) return;
        updateLensDof(app, cf, lens, focus.current, blur, s.mode !== 'moving', depthView, s.range);
    });

    return (
        <Entity name="camera" position={[0, 1, 4]}>
            <Camera
                fov={horizontalFov(lens)}
                horizontalFov
                clearColor={clearColor}
                nearClip={0.01}
                farClip={farClip}
            />
            <Script script={CameraControls} ref={controls} />
            <Script script={CameraFrame} ref={frame} />
        </Entity>
    );
}
