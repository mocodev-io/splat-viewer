import { useEffect } from 'react';
import { useControls, folder, button } from 'leva';
import { ranges, TONEMAPPING, type ExperienceSettings, type PostEffectSettings, type Tonemapping, type Vec3Tuple } from '../scene/experience';
import { ORIENTATIONS, type Orientation } from '../viewer/Splat';

// colours: scene settings store 0..1 rgb, the panel edits hex
const toHex = (c: Vec3Tuple) =>
    '#' + c.map(v => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string): Vec3Tuple => {
    const n = parseInt(hex.slice(1, 7), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

type SplatPanelProps = {
    splats: string[];
    onLoad: (name: string) => void;
    onUnload: () => void;
    onResetView: () => void;
    onSave: () => void;
};

// Splat choice and camera. Loading is always an explicit button press.
export function useSplatPanel({ splats, onLoad, onUnload, onResetView, onSave }: SplatPanelProps) {
    const [values, set] = useControls('Splat', () => ({
        file: { value: splats[0] ?? '', options: splats, label: 'File' },
        orientation: { value: 'x180' as Orientation, options: [...ORIENTATIONS], label: 'Orientation' },
        // read inside the handlers through `get`, so the buttons see the current choice
        Load: button(get => onLoad(get('Splat.file') as string)),
        Unload: button(() => onUnload()),
        'Reset view': button(() => onResetView()),
        'Save settings': button(() => onSave())
    }), [splats, onLoad, onUnload, onResetView, onSave]);

    // the list arrives after the panel exists; pick its first entry then
    useEffect(() => {
        if (splats.length && !splats.includes(values.file as string)) set({ file: splats[0] });
    }, [splats, values.file, set]);

    return { orientation: values.orientation as Orientation, set };
}

export function useCameraPanel() {
    const [values, set] = useControls('Camera', () => ({
        fov: { value: 60, ...ranges.fov, label: 'Field of view' }
    }));
    return { fov: values.fov, set };
}

// Everything the scene settings file can hold about the look of the image.
export function useLookPanel() {
    const pe = ranges;
    const [v, set] = useControls('Look', () => ({
        tonemapping: { value: 'linear' as Tonemapping, options: [...TONEMAPPING], label: 'Tone mapping' },
        highPrecision: { value: false, label: 'High precision' },
        background: { value: '#000000', label: 'Background' },
        Sharpness: folder({
            sharpness: { value: false, label: 'On' },
            sharpnessAmount: { value: 0, ...pe.sharpness.amount, label: 'Amount' }
        }, { collapsed: true }),
        Bloom: folder({
            bloom: { value: false, label: 'On' },
            bloomIntensity: { value: 0.1, ...pe.bloom.intensity, label: 'Intensity' },
            bloomBlur: { value: 2, ...pe.bloom.blurLevel, label: 'Blur level' }
        }, { collapsed: true }),
        Grading: folder({
            grading: { value: false, label: 'On' },
            brightness: { value: 1, ...pe.grading.brightness, label: 'Brightness' },
            contrast: { value: 1, ...pe.grading.contrast, label: 'Contrast' },
            saturation: { value: 1, ...pe.grading.saturation, label: 'Saturation' },
            tint: { value: '#ffffff', label: 'Tint' }
        }, { collapsed: true }),
        Vignette: folder({
            vignette: { value: false, label: 'On' },
            vignetteIntensity: { value: 0.5, ...pe.vignette.intensity, label: 'Intensity' },
            vignetteInner: { value: 0.3, ...pe.vignette.inner, label: 'Inner' },
            vignetteOuter: { value: 0.75, ...pe.vignette.outer, label: 'Outer' },
            vignetteCurvature: { value: 1, ...pe.vignette.curvature, label: 'Curvature' }
        }, { collapsed: true }),
        Fringing: folder({
            fringing: { value: false, label: 'On' },
            fringingIntensity: { value: 0.5, ...pe.fringing.intensity, label: 'Intensity' }
        }, { collapsed: true })
    }));

    const postEffects: PostEffectSettings = {
        sharpness: { enabled: v.sharpness, amount: v.sharpnessAmount },
        bloom: { enabled: v.bloom, intensity: v.bloomIntensity, blurLevel: v.bloomBlur },
        grading: {
            enabled: v.grading, brightness: v.brightness, contrast: v.contrast,
            saturation: v.saturation, tint: fromHex(v.tint)
        },
        vignette: {
            enabled: v.vignette, intensity: v.vignetteIntensity, inner: v.vignetteInner,
            outer: v.vignetteOuter, curvature: v.vignetteCurvature
        },
        fringing: { enabled: v.fringing, intensity: v.fringingIntensity }
    };

    // puts a loaded settings file into the panel
    const apply = (s: ExperienceSettings) => {
        const p = s.postEffectSettings;
        set({
            tonemapping: s.tonemapping,
            highPrecision: s.highPrecisionRendering,
            background: toHex(s.background.color),
            sharpness: p.sharpness.enabled,
            sharpnessAmount: p.sharpness.amount,
            bloom: p.bloom.enabled,
            bloomIntensity: p.bloom.intensity,
            bloomBlur: p.bloom.blurLevel,
            grading: p.grading.enabled,
            brightness: p.grading.brightness,
            contrast: p.grading.contrast,
            saturation: p.grading.saturation,
            tint: toHex(p.grading.tint),
            vignette: p.vignette.enabled,
            vignetteIntensity: p.vignette.intensity,
            vignetteInner: p.vignette.inner,
            vignetteOuter: p.vignette.outer,
            vignetteCurvature: p.vignette.curvature,
            fringing: p.fringing.enabled,
            fringingIntensity: p.fringing.intensity
        });
    };

    return {
        tonemapping: v.tonemapping as Tonemapping,
        highPrecision: v.highPrecision,
        background: fromHex(v.background),
        postEffects,
        apply
    };
}

// Checks for the depth principle: is the scene depth what we expect, and do
// objects and splats cover each other correctly.
export function useDebugPanel() {
    const [values] = useControls('Debug', () => ({
        depthView: { value: false, label: 'Depth view' },
        testObjects: { value: false, label: 'Test objects' }
    }), { collapsed: true });
    return values;
}
