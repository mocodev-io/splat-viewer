import { useEffect } from 'react';
import { useControls, folder, button } from 'leva';
import {
    BLADE_COUNTS, BLUR_QUALITIES, defaultGrain, defaultLens, defaultLensVignette, defaultViewport, FILM_TYPES, FOCUS_MODES,
    grainRanges, lensRanges, ranges, sceneFilm, sceneGrain, sceneLensVignette, SENSOR_NAMES, SENSORS, TONEMAPPING,
    type ExperienceSettings, type FilmType, type Grain, type Lens, type LensVignette, type PostEffectSettings,
    type SensorName, type Tonemapping, type Vec3Tuple, type Viewport
} from '../scene/experience';
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

const filmOptions = Object.fromEntries(FILM_TYPES.map(t => [t === 'bw' ? 'Black & white' : 'Color', t]));

// The vignette falloff runs from `start` to `end`, 1 being the frame corner.
// The panel shows it as Lightroom does, a midpoint and a feather (its
// width); stored as SuperSplat's inner / outer, which put the corner at √2.
const fromMidpoint = (midpoint: number, feather: number) => {
    const clampSS = (x: number) => Math.min(Math.max(x, ranges.vignette.inner.min), ranges.vignette.inner.max);
    return {
        inner: clampSS((midpoint - feather / 2) * Math.SQRT2),
        outer: clampSS((midpoint + feather / 2) * Math.SQRT2)
    };
};
const toMidpoint = (inner: number, outer: number) => ({
    midpoint: Math.min(Math.max((inner + outer) / 2 / Math.SQRT2, 0), 1),
    feather: Math.min(Math.max(Math.abs(outer - inner) / Math.SQRT2, 0), 1)
});

const bladeOptions = Object.fromEntries(BLADE_COUNTS.map(n => [n ? `${n} blades` : 'Round', n]));

type LensPanelProps = {
    onAfCenter: () => void;
    onMeasure: () => void;
    onApplyScale: (realLength: number) => void;
};

// The lens. A sensor preset fixes the sensor size; 'Custom' shows the fields.
// Focus is manual (the slider, the focus ring) or auto: continuous autofocus
// on the AF point, which a click in the image moves.
export function useLensPanel({ onAfCenter, onMeasure, onApplyScale }: LensPanelProps) {
    const r = lensRanges;
    const d = defaultLens();
    const custom = (get: (path: string) => unknown) => get('Lens.sensor') === 'Custom';
    const auto = (get: (path: string) => unknown) => get('Lens.focusMode') === 'auto';
    const dof = (get: (path: string) => unknown) => get('Lens.dof') as boolean;
    const blades = (get: (path: string) => unknown) => (get('Lens.Bokeh.blades') as number) > 0;
    const [v, set] = useControls('Lens', () => ({
        sensor: { value: d.sensor, options: SENSOR_NAMES, label: 'Sensor' },
        sensorWidth: { value: d.sensorWidth, ...r.sensorWidth, label: 'Width mm', render: custom },
        sensorHeight: { value: d.sensorHeight, ...r.sensorHeight, label: 'Height mm', render: custom },
        // the frame has the sensor's aspect; around it the same lens goes on
        // (overscan), dimmed by the passepartout, black at 1
        passepartout: { value: defaultViewport().passepartout, min: 0, max: 1, step: 0.01, label: 'Passepartout' },
        focalLength: { value: d.focalLength, ...r.focalLength, label: 'Focal length mm' },
        fStop: { value: d.fStop, ...r.fStop, label: 'f-stop' },
        focusMode: { value: d.focusMode, options: [...FOCUS_MODES], label: 'Focus' },
        focusDistance: { value: d.focusDistance, ...r.focusDistance, label: 'Focus m', render: get => !auto(get) },
        afTransition: { value: d.afTransition, ...r.afTransition, label: 'AF transition s', render: auto },
        'AF center': button(() => onAfCenter()),
        dof: { value: d.dof, label: 'Depth of field' },
        // the AF point exists only with autofocus and depth of field on
        afFrame: { value: d.afFrame, label: 'AF frame', render: get => auto(get) && dof(get) },
        blurQuality: { value: d.blurQuality, options: [...BLUR_QUALITIES], label: 'Still quality', render: dof },
        // how the still builds up: the over-blur that runs the first lens
        // points together, and how fast each new group of samples fades in
        Still: folder({
            overblur: { value: d.overblur, ...r.overblur, label: 'Over-blur' },
            stillFade: { value: d.stillFade, ...r.stillFade, label: 'Fade-in' }
        }, { collapsed: true, render: dof }),
        // the bokeh shape; exact in the still, the quick DoF while moving stays round
        Bokeh: folder({
            blades: { value: d.blades as number, options: bladeOptions, label: 'Aperture' },
            bladeRoundness: { value: d.bladeRoundness, ...r.bladeRoundness, label: 'Roundness', render: blades },
            bladeRotation: { value: d.bladeRotation, ...r.bladeRotation, label: 'Rotation °', render: blades },
            anamorphic: { value: d.anamorphic, ...r.anamorphic, label: 'Anamorphic' },
            catsEye: { value: d.catsEye, ...r.catsEye, label: "Cat's eye" }
        }, { collapsed: true, render: dof }),
        Scale: folder({
            metersPerUnit: { value: d.metersPerUnit, ...r.metersPerUnit, label: 'Meters / unit' },
            Measure: button(() => onMeasure()),
            realLength: { value: 1, min: 0.001, step: 0.01, label: 'Real length m' },
            'Apply scale': button(get => onApplyScale(get('Lens.Scale.realLength') as number))
        }, { collapsed: true })
    }), [onAfCenter, onMeasure, onApplyScale]);

    const sensor = v.sensor as SensorName;
    const [sensorWidth, sensorHeight] = sensor === 'Custom' ? [v.sensorWidth, v.sensorHeight] : SENSORS[sensor];
    const lens: Lens = {
        sensor, sensorWidth, sensorHeight,
        focalLength: v.focalLength,
        fStop: v.fStop,
        focusMode: v.focusMode as Lens['focusMode'],
        focusDistance: v.focusDistance,
        afTransition: v.afTransition,
        metersPerUnit: v.metersPerUnit,
        dof: v.dof,
        blurQuality: v.blurQuality as Lens['blurQuality'],
        blades: v.blades as Lens['blades'],
        bladeRoundness: v.bladeRoundness,
        bladeRotation: v.bladeRotation,
        anamorphic: v.anamorphic,
        catsEye: v.catsEye,
        overblur: v.overblur,
        stillFade: v.stillFade,
        afFrame: v.afFrame
    };

    const viewport: Viewport = { passepartout: v.passepartout };

    // puts a loaded or computed lens into the panel
    const apply = (l: Partial<Lens>) => set(l);
    const applyViewport = (vp: Viewport) => set({ passepartout: vp.passepartout });

    return { lens, apply, viewport, applyViewport };
}

// Everything the scene settings file can hold about the look of the image.
export function useLookPanel() {
    const pe = ranges;
    const g = defaultGrain();
    const lv = defaultLensVignette();
    const mid = toMidpoint(0.3, 0.75);
    const byHand = (get: (path: string) => unknown) => !get('Look.Vignette.vignettePhysical');
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
        // light lost in the lens (stillFrames.ts): by hand, as in Lightroom,
        // or physical, from the focal length and f-stop of the lens
        Vignette: folder({
            vignette: { value: false, label: 'On' },
            vignettePhysical: { value: lv.physical, label: 'Physical' },
            vignetteIntensity: { value: 0.5, ...pe.vignette.intensity, label: 'Amount' },
            vignetteMidpoint: { value: mid.midpoint, min: 0, max: 1, step: 0.01, label: 'Midpoint', render: byHand },
            vignetteFeather: { value: mid.feather, min: 0, max: 1, step: 0.01, label: 'Feather', render: byHand },
            vignetteRoundness: { value: lv.roundness, min: 0, max: 1, step: 0.01, label: 'Roundness', render: byHand },
            // SuperSplat's curvature, not used here; kept so saving does not change it
            vignetteCurvature: { value: 1, ...pe.vignette.curvature, render: () => false }
        }, { collapsed: true }),
        // stored as SuperSplat's `fringing`; drawn as lateral chromatic
        // aberration on the final image (stillFrames.ts)
        'Chromatic aberration': folder({
            fringing: { value: false, label: 'On' },
            fringingIntensity: { value: 0.5, ...pe.fringing.intensity, label: 'Intensity' }
        }, { collapsed: true }),
        // what the film records (colour, or brightness only) and its grain
        Film: folder({
            film: { value: 'color' as FilmType, options: filmOptions, label: 'Type' },
            grain: { value: g.enabled, label: 'Grain' },
            grainIntensity: { value: g.intensity, ...grainRanges.intensity, label: 'Intensity' },
            grainSize: { value: g.size, ...grainRanges.size, label: 'Size' },
            grainColor: { value: g.color, ...grainRanges.color, label: 'Color', render: get => get('Look.Film.film') !== 'bw' },
            grainAnimation: { value: g.animation, ...grainRanges.animation, label: 'Animation' }
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
            enabled: v.vignette, intensity: v.vignetteIntensity, ...fromMidpoint(v.vignetteMidpoint, v.vignetteFeather),
            curvature: v.vignetteCurvature
        },
        fringing: { enabled: v.fringing, intensity: v.fringingIntensity }
    };
    const film = v.film as FilmType;
    const lensVignette: LensVignette = { physical: v.vignettePhysical, roundness: v.vignetteRoundness };
    const grain: Grain = {
        enabled: v.grain, intensity: v.grainIntensity, size: v.grainSize, color: v.grainColor, animation: v.grainAnimation
    };

    // puts a loaded settings file into the panel
    const apply = (s: ExperienceSettings) => {
        const p = s.postEffectSettings;
        const gr = sceneGrain(s);
        const sv = sceneLensVignette(s);
        const m = toMidpoint(p.vignette.inner, p.vignette.outer);
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
            vignettePhysical: sv.physical,
            vignetteIntensity: p.vignette.intensity,
            vignetteMidpoint: m.midpoint,
            vignetteFeather: m.feather,
            vignetteRoundness: sv.roundness,
            vignetteCurvature: p.vignette.curvature,
            fringing: p.fringing.enabled,
            fringingIntensity: p.fringing.intensity,
            film: sceneFilm(s),
            grain: gr.enabled,
            grainIntensity: gr.intensity,
            grainSize: gr.size,
            grainColor: gr.color,
            grainAnimation: gr.animation
        });
    };

    return {
        tonemapping: v.tonemapping as Tonemapping,
        highPrecision: v.highPrecision,
        background: fromHex(v.background),
        postEffects,
        grain,
        film,
        lensVignette,
        apply
    };
}

export const DEBUG_VIEWS = ['image', 'depth', 'blur amount'] as const;
export type DebugView = typeof DEBUG_VIEWS[number];
export const DEPTH_RANGES = ['camera near/far', 'scene linear', 'scene inverse'] as const;
export type DepthRange = typeof DEPTH_RANGES[number];

// Checks: is the scene depth what we expect, how much blur does the lens
// give where (red behind the focus, green in front or spilled over from it),
// and do objects and splats cover each other correctly.
// Depth range: the engine's view runs from the camera's near to its far
// clip; the scene ranges are normalized from the nearest to the farthest
// depth in the image (z-depth normalize), linearly or by 1 / depth.
export function useDebugPanel() {
    const [values] = useControls('Debug', () => ({
        view: { value: 'image' as DebugView, options: [...DEBUG_VIEWS], label: 'View' },
        depthRange: {
            value: 'scene linear' as DepthRange, options: [...DEPTH_RANGES], label: 'Depth range',
            render: get => get('Debug.view') === 'depth'
        },
        testObjects: { value: false, label: 'Test objects' }
    }), { collapsed: true });
    return { view: values.view as DebugView, depthRange: values.depthRange as DepthRange, testObjects: values.testObjects };
}
