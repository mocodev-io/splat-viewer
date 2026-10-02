import { useEffect, useRef, type RefObject } from 'react';
import { Color, Vec3 } from 'playcanvas';
import { Entity } from '@playcanvas/react';
import { Camera, Script } from '@playcanvas/react/components';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import { CameraFrame } from 'playcanvas/scripts/esm/camera-frame.mjs';
import type { CameraPose, PostEffectSettings, Tonemapping, Vec3Tuple } from '../scene/experience';

export type ViewRequest = { pose: CameraPose; id: number };

export type CameraApi = {
    /** Where the camera is and what it looks at, for saving the view. */
    getPose: () => CameraPose;
};

type ViewerCameraProps = {
    view: ViewRequest | null;             // a new id moves the camera there
    fov: number;                          // vertical, degrees
    farClip: number;
    depthView: boolean;                   // show the scene depth instead of the image
    api: RefObject<CameraApi | null>;
    tonemapping: Tonemapping;
    highPrecision: boolean;
    postEffects: PostEffectSettings;
    background: Vec3Tuple;
};

// The camera: the engine's CameraControls for orbit / fly / pan, and the
// engine's CameraFrame for post-processing, driven by the scene settings.
export function ViewerCamera({ view, fov, farClip, depthView, api, tonemapping, highPrecision, postEffects, background }: ViewerCameraProps) {
    const controls = useRef<CameraControls>(null);
    const frame = useRef<CameraFrame>(null);

    useEffect(() => {
        api.current = {
            getPose: () => {
                const cc = controls.current!;
                const entity = cc.entity;
                const p = entity.getPosition();
                // CameraControls keeps its orbit distance privately; the
                // target is that far along the view direction
                const distance = (cc as unknown as { _pose?: { distance?: number } })._pose?.distance || 1;
                const t = entity.forward.clone().mulScalar(distance).add(p);
                return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z], fov: entity.camera!.fov };
            }
        };
        return () => { api.current = null; };
    }, [api]);

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

        // The engine renders the scene depth only for an effect that reads it.
        // For the depth view, DoF is that reader; the debug output replaces
        // the image anyway, so its blur never shows.
        cf.dof.enabled = depthView;
        cf.rendering.debug = depthView ? 'depth' : 'none';
    }, [tonemapping, highPrecision, postEffects, depthView]);

    return (
        <Entity name="camera" position={[0, 1, 4]}>
            <Camera fov={fov} clearColor={clearColor} nearClip={0.01} farClip={farClip} />
            <Script script={CameraControls} ref={controls} />
            <Script script={CameraFrame} ref={frame} />
        </Entity>
    );
}
