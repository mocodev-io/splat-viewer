import { useEffect, useRef, type RefObject } from 'react';
import { Color, Picker, Vec3 } from 'playcanvas';
import { Entity } from '@playcanvas/react';
import { Camera, Script } from '@playcanvas/react/components';
import { useApp, useAppEvent } from '@playcanvas/react/hooks';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import { CameraFrame } from 'playcanvas/scripts/esm/camera-frame.mjs';
import { horizontalFov, type CameraPose, type Lens, type PostEffectSettings, type Tonemapping, type Vec3Tuple } from '../scene/experience';
import type { DebugView } from '../ui/panel';
import { dofSettings, installPhysicalCoc } from './physicalDof';

export type ViewRequest = { pose: CameraPose; id: number };

export type CameraApi = {
    /** Where the camera is and what it orbits around, for saving the view. */
    getView: () => { position: Vec3Tuple; target: Vec3Tuple };
    /** The world point under a position in the canvas (CSS pixels), or null for empty sky. */
    pick: (x: number, y: number) => Promise<Vec3Tuple | null>;
    /** Distance of a point along the view direction (scene units): what the focus plane is measured in. */
    viewDepth: (p: Vec3Tuple) => number;
    /** A world point in canvas CSS pixels; `behind` when it is behind the camera. */
    toScreen: (p: Vec3Tuple) => { x: number; y: number; behind: boolean };
};

type ViewerCameraProps = {
    view: ViewRequest | null;             // a new id moves the camera there
    lens: Lens;
    farClip: number;
    debugView: DebugView;
    api: RefObject<CameraApi | null>;
    tonemapping: Tonemapping;
    highPrecision: boolean;
    postEffects: PostEffectSettings;
    background: Vec3Tuple;
};

// The camera: the engine's CameraControls for orbit / fly / pan, and the
// engine's CameraFrame for post-processing, driven by the scene settings and
// the lens.
export function ViewerCamera({ view, lens, farClip, debugView, api, tonemapping, highPrecision, postEffects, background }: ViewerCameraProps) {
    const app = useApp();
    const controls = useRef<CameraControls>(null);
    const frame = useRef<CameraFrame>(null);

    useEffect(() => {
        // The engine's picker renders splats and objects into its own buffer
        // with depth, on demand only (one render per pick).
        let picker: Picker | null = null;
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
            pick: async (x, y) => {
                const device = app.graphicsDevice;
                const canvas = device.canvas as HTMLCanvasElement;
                const sx = device.width / canvas.clientWidth;
                const sy = device.height / canvas.clientHeight;
                const px = Math.floor(x * sx);
                const py = Math.floor(y * sy);
                const fresh = !picker;
                picker ??= new Picker(app, device.width, device.height, true);
                picker.resize(device.width, device.height);
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
            picker?.destroy();
        };
    }, [api, app]);

    // move to a requested pose; CameraControls animates there
    useEffect(() => {
        const cc = controls.current;
        if (!view || !cc) return;
        cc.reset(new Vec3(view.pose.target), new Vec3(view.pose.position));
    }, [view]);

    // the Camera component takes colours as hex strings
    const clearColor = '#' + background.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

    // post effects, mapped like SuperSplat's applyPostEffectSettings
    useEffect(() => {
        const cf = frame.current;
        if (!cf) return;
        const pe = postEffects;
        cf.rendering.samples = 1;   // splat depth (and splats in general) want no MSAA
        cf.rendering.toneMapping = tonemapping === 'none' ? 'linear' : tonemapping;
        cf.rendering.renderFormat = highPrecision ? 'rgba16' : 'rg11b10';
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
    }, [tonemapping, highPrecision, postEffects]);

    // The lens: depth of field and the debug views. The engine renders the
    // scene depth only for an effect that reads it, so the depth view turns
    // DoF on as well; the debug output replaces the image anyway.
    useEffect(() => {
        const cf = frame.current;
        if (!cf) return;
        cf.dof.enabled = lens.dof || debugView !== 'image';
        cf.dof.nearBlur = true;     // a real lens blurs in front of the focus plane too
        cf.dof.highQuality = true;
        cf.rendering.debug = debugView === 'depth' ? 'depth' : debugView === 'blur amount' ? 'dofcoc' : 'none';
    }, [lens.dof, debugView]);

    // The blur depends on the image's aspect too, so it is worked out every
    // frame; the physical CoC shader goes in whenever the engine has built
    // (or rebuilt) its DoF passes.
    useAppEvent('prerender', () => {
        const cf = frame.current;
        if (!cf || !cf.dof.enabled) return;
        const { width, height } = app.graphicsDevice;
        Object.assign(cf.dof, dofSettings(lens, width / Math.max(height, 1)));
        installPhysicalCoc(cf);
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
