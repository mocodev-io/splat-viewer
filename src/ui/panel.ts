import { useEffect, useRef } from 'react';
import { useControls, folder, button } from 'leva';
import {
    BLADE_COUNTS, BLUR_QUALITIES, defaultGrain, defaultHalation, halationRanges, sceneHalation, type Halation, defaultLens, defaultLensVignette, defaultViewport, FOCUS_MODES,
    FRAME_STYLES, FRAME_TINTS, type FrameStyle, type FrameTint,
    grainRanges, lensRanges, ranges, sceneFilm, sceneGrain, sceneLensVignette, SENSOR_NAMES, SENSORS, TONEMAPPING,
    type ExperienceSettings, type Grain, type Lens, type LensVignette, type PostEffectSettings,
    type SensorName, type Tonemapping, type Vec3Tuple, type Viewport
} from '../scene/experience';
import {
    BW_FILTER_IDS, defaultFilm, FILM_IDS, FILMS, type BwFilter, type FilmId, type FilmProfile, type FilmSettings
} from '../scene/films';
import { ORIENTATIONS, type Orientation } from '../viewer/Splat';

// The panels follow how a camera is put together: the Scene in front of it,
// the Camera body (sensor, framing), the Lens (focus, depth of field, bokeh,
// optics) and the Look (the film and its development, laid out as
// Lightroom's Develop module), then Debug. Some hooks below add controls to
// another hook's panel (the lens optics belong to the Lens panel but to the
// look's data), so the panels are ordered explicitly.
const ORDER = { scene: 0, camera: 1, lens: 2, look: 3, debug: 4 } as const;

type Get = (path: string) => unknown;

// colours: scene settings store 0..1 rgb, the panel edits hex
const toHex = (c: Vec3Tuple) =>
    '#' + c.map(v => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string): Vec3Tuple => {
    const n = parseInt(hex.slice(1, 7), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

type ScenePanelProps = {
    splats: string[];
    onLoad: (name: string) => void;
    onUnload: () => void;
    onResetView: () => void;
    onSave: () => void;
};

// Scene: which splat, how it stands, what is behind it. Loading is always an
// explicit button press. (Its scale is added by the lens panel, which owns it.)
export function useScenePanel({ splats, onLoad, onUnload, onResetView, onSave }: ScenePanelProps) {
    const [values, set] = useControls(() => ({
        Scene: folder({
            file: { value: splats[0] ?? '', options: splats, label: 'File' },
            orientation: { value: 'x180' as Orientation, options: [...ORIENTATIONS], label: 'Orientation' },
            background: { value: '#000000', label: 'Background' },
            // read inside the handlers through `get`, so the buttons see the current choice
            Load: button(get => onLoad(get('Scene.file') as string)),
            Unload: button(() => onUnload()),
            'Reset view': button(() => onResetView()),
            'Save settings': button(() => onSave())
        }, { order: ORDER.scene })
    }), [splats, onLoad, onUnload, onResetView, onSave]);

    // the list arrives after the panel exists; pick its first entry then
    useEffect(() => {
        if (splats.length && !splats.includes(values.file as string)) set({ file: splats[0] });
    }, [splats, values.file, set]);

    return {
        orientation: values.orientation as Orientation,
        background: fromHex(values.background as string),
        // puts a loaded file's background into the panel
        applyBackground: (c: Vec3Tuple) => set({ background: toHex(c) })
    };
}

const filmOptions = Object.fromEntries(FILM_IDS.map(id => [FILMS[id].label, id]));
const filterOptions = Object.fromEntries(BW_FILTER_IDS.map(id => [id === 'none' ? 'None' : id[0].toUpperCase() + id.slice(1), id]));
const frameStyleOptions = Object.fromEntries(FRAME_STYLES.map(s => [s === 'plain' ? 'Plain' : s === '120' ? '120 film' : '35 mm film', s]));
const frameTintOptions = Object.fromEntries(FRAME_TINTS.map(t => [
    { auto: 'Auto (film)', colorNeg: 'Color negative', bw: 'Black & white', slide: 'Slide' }[t], t
]));
const bladeOptions = Object.fromEntries(BLADE_COUNTS.map(n => [n ? `${n} blades` : 'Round', n]));

// Basic > Exposure, in stops; stored as SuperSplat's grading brightness (2^stops, at most 3)
const EXPOSURE = { min: -3, max: 1.5, step: 0.05 };

// Optics > Diffusion: a diffusion filter (Pro-Mist and the like) as the
// engine's bloom, stored as SuperSplat's bloom: amount 1 is its largest
// intensity, the radius its blur level.
const BLOOM_MAX = ranges.bloom.intensity.max;

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

type LensPanelProps = {
    onAfCenter: () => void;
    onMeasure: () => void;
    onApplyScale: (realLength: number) => void;
};

// The camera body and the lens, and the scale of the scene they need.
// A sensor preset fixes the sensor size; 'Custom' shows the fields. Focus
// is manual (the slider, the focus ring) or auto: continuous autofocus on
// the AF point, which a click in the image moves.
export function useLensPanel({ onAfCenter, onMeasure, onApplyScale }: LensPanelProps) {
    const r = lensRanges;
    const d = defaultLens();
    const vp = defaultViewport();
    const custom = (get: Get) => get('Camera.sensor') === 'Custom';
    const auto = (get: Get) => get('Lens.Focus.focusMode') === 'auto';
    const dof = (get: Get) => get('Lens.Depth of field.dof') as boolean;
    const blades = (get: Get) => (get('Lens.Bokeh.blades') as number) > 0;
    const [v, set] = useControls(() => ({
        Scene: folder({
            Scale: folder({
                metersPerUnit: { value: d.metersPerUnit, ...r.metersPerUnit, label: 'Meters / unit' },
                Measure: button(() => onMeasure()),
                realLength: { value: 1, min: 0.001, step: 0.01, label: 'Real length m' },
                'Apply scale': button(get => onApplyScale(get('Scene.Scale.realLength') as number))
            }, { collapsed: true, order: 10 })
        }, { order: ORDER.scene }),
        Camera: folder({
            sensor: { value: d.sensor, options: SENSOR_NAMES, label: 'Sensor' },
            sensorWidth: { value: d.sensorWidth, ...r.sensorWidth, label: 'Width mm', render: custom },
            sensorHeight: { value: d.sensorHeight, ...r.sensorHeight, label: 'Height mm', render: custom },
            // the frame has the sensor's aspect; around it the same lens goes
            // on (overscan), dimmed by the passepartout, black at 1
            // the frame style draws a film edge around the image, as a scan
            // of the negative or slide with its rebate
            Framing: folder({
                passepartout: { value: vp.passepartout, min: 0, max: 1, step: 0.01, label: 'Passepartout' },
                frameStyle: { value: vp.frameStyle as string, options: frameStyleOptions, label: 'Frame style' },
                frameTint: {
                    value: vp.frameTint as string, options: frameTintOptions, label: 'Frame tint',
                    render: get => get('Camera.Framing.frameStyle') !== 'plain'
                }
            })
        }, { order: ORDER.camera }),
        Lens: folder({
            focalLength: { value: d.focalLength, ...r.focalLength, label: 'Focal length mm' },
            fStop: { value: d.fStop, ...r.fStop, label: 'f-stop' },
            Focus: folder({
                focusMode: { value: d.focusMode, options: [...FOCUS_MODES], label: 'Focus' },
                focusDistance: { value: d.focusDistance, ...r.focusDistance, label: 'Focus m', render: get => !auto(get) },
                afTransition: { value: d.afTransition, ...r.afTransition, label: 'AF transition s', render: auto },
                'AF center': button(() => onAfCenter()),
                // the AF point exists only with autofocus and depth of field on
                afFrame: { value: d.afFrame, label: 'AF frame', render: get => auto(get) && dof(get) }
            }),
            // the still: its quality, the over-blur that runs the first lens
            // points together, and how fast each new group of samples fades in
            'Depth of field': folder({
                dof: { value: d.dof, label: 'On' },
                blurQuality: { value: d.blurQuality, options: [...BLUR_QUALITIES], label: 'Still quality', render: dof },
                overblur: { value: d.overblur, ...r.overblur, label: 'Over-blur', render: dof },
                stillFade: { value: d.stillFade, ...r.stillFade, label: 'Fade-in', render: dof }
            }),
            // the bokeh shape; exact in the still, the quick DoF while moving stays round
            Bokeh: folder({
                blades: { value: d.blades as number, options: bladeOptions, label: 'Aperture' },
                bladeRoundness: { value: d.bladeRoundness, ...r.bladeRoundness, label: 'Roundness', render: blades },
                bladeRotation: { value: d.bladeRotation, ...r.bladeRotation, label: 'Rotation °', render: blades },
                anamorphic: { value: d.anamorphic, ...r.anamorphic, label: 'Anamorphic' },
                catsEye: { value: d.catsEye, ...r.catsEye, label: "Cat's eye" }
            }, { collapsed: true, render: dof })
        }, { order: ORDER.lens })
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

    const viewport: Viewport = {
        passepartout: v.passepartout, frameStyle: v.frameStyle as FrameStyle, frameTint: v.frameTint as FrameTint
    };

    // puts a loaded or computed lens into the panel
    const apply = (l: Partial<Lens>) => set(l);
    const applyViewport = (vp: Viewport) => set({ passepartout: vp.passepartout, frameStyle: vp.frameStyle, frameTint: vp.frameTint });

    return { lens, apply, viewport, applyViewport };
}

// The look of the image, laid out as Lightroom's Develop module: Profile
// (the film stock, which replaces the tone mapping), Basic, Detail and
// Effects; and the optics the lens adds, shown in the Lens panel. As in
// Lightroom there are no on / off switches: an amount of 0 is off.
// SuperSplat's `enabled` flags are written from that when saving.
export function useLookPanel() {
    const pe = ranges;
    const g = defaultGrain();
    const lv = defaultLensVignette();
    const mid = toMidpoint(0.3, 0.75);
    const f = defaultFilm();
    const filmKind = (get: Get) => FILMS[get('Look.Profile.film') as FilmId]?.kind;
    const byHand = (get: Get) => !get('Lens.Optics.vignettePhysical');
    const [v, set] = useControls(() => ({
        // what the lens adds (stillFrames.ts): chromatic aberration, stored as
        // SuperSplat's `fringing`; the vignette as light lost, by hand or
        // physical, from the focal length and f-stop; a diffusion filter
        Lens: folder({
            Optics: folder({
                aberration: { value: 0, ...pe.fringing.intensity, label: 'Chromatic aberr.' },
                vignette: { value: 0, ...pe.vignette.intensity, label: 'Vignette' },
                vignettePhysical: { value: lv.physical, label: 'Physical' },
                vignetteMidpoint: { value: mid.midpoint, min: 0, max: 1, step: 0.01, label: 'Midpoint', render: byHand },
                vignetteFeather: { value: mid.feather, min: 0, max: 1, step: 0.01, label: 'Feather', render: byHand },
                vignetteRoundness: { value: lv.roundness, min: 0, max: 1, step: 0.01, label: 'Roundness', render: byHand },
                // SuperSplat's curvature, not used here; kept so saving does not change it
                vignetteCurvature: { value: 1, ...pe.vignette.curvature, render: () => false },
                diffusion: { value: 0, min: 0, max: 1, step: 0.01, label: 'Diffusion' },
                diffusionRadius: { value: 2, ...pe.bloom.blurLevel, label: 'Diffusion radius' }
            }, { collapsed: true, order: 10 })
        }, { order: ORDER.lens }),
        Look: folder({
            Profile: folder({
                film: { value: f.id as string, options: filmOptions, label: 'Film' },
                filmFilter: { value: f.filter as string, options: filterOptions, label: 'Filter', render: get => filmKind(get) === 'bw' },
                filmStrength: { value: f.strength, min: 0, max: 1, step: 0.01, label: 'Amount', render: get => filmKind(get) !== 'digital' },
                // without a film the engine's tone mapping turns the light into an image
                tonemapping: {
                    value: 'linear' as Tonemapping, options: [...TONEMAPPING], label: 'Tone mapping',
                    render: get => filmKind(get) === 'digital'
                }
            }),
            Basic: folder({
                exposure: { value: 0, ...EXPOSURE, label: 'Exposure' },
                contrast: { value: 1, ...pe.grading.contrast, label: 'Contrast' },
                saturation: { value: 1, ...pe.grading.saturation, label: 'Saturation' },
                tint: { value: '#ffffff', label: 'Tint' }
            }),
            Detail: folder({
                sharpness: { value: 0, ...pe.sharpness.amount, label: 'Sharpening' },
                highPrecision: { value: false, label: 'High precision' }
            }, { collapsed: true }),
            Effects: folder({
                halation: { value: 0, ...halationRanges.amount, label: 'Halation' },
                halationRadius: { value: defaultHalation().radius, ...halationRanges.radius, label: 'Halation radius' },
                grain: { value: 0, ...grainRanges.intensity, label: 'Grain' },
                grainSize: { value: g.size, ...grainRanges.size, label: 'Grain size' },
                grainColor: { value: g.color, ...grainRanges.color, label: 'Grain color', render: get => filmKind(get) !== 'bw' },
                grainAnimation: { value: g.animation, ...grainRanges.animation, label: 'Grain animation' }
            }, { collapsed: true })
        }, { order: ORDER.look })
    }));

    // Choosing a film in the panel sets the grain to that film's own; a film
    // that comes with a loaded file keeps the file's grain.
    const lastFilm = useRef(v.film);
    const loadedFilm = useRef<string | null>(null);
    useEffect(() => {
        if (v.film === lastFilm.current) return;
        lastFilm.current = v.film;
        if (loadedFilm.current === v.film) {
            loadedFilm.current = null;
            return;
        }
        const profile = FILMS[v.film as FilmId] as FilmProfile;
        if (profile.grain) set({ grain: profile.grain.intensity, grainSize: profile.grain.size, grainColor: profile.grain.color });
        if (profile.halation !== undefined) set({ halation: profile.halation });
    }, [v.film, set]);

    const brightness = 2 ** v.exposure;
    const tint = fromHex(v.tint);
    const graded = v.exposure !== 0 || v.contrast !== 1 || v.saturation !== 1 || tint.some(c => c !== 1);
    const postEffects: PostEffectSettings = {
        sharpness: { enabled: v.sharpness > 0, amount: v.sharpness },
        bloom: { enabled: v.diffusion > 0, intensity: v.diffusion * BLOOM_MAX, blurLevel: v.diffusionRadius },
        grading: { enabled: graded, brightness, contrast: v.contrast, saturation: v.saturation, tint },
        vignette: {
            enabled: v.vignette > 0, intensity: v.vignette, ...fromMidpoint(v.vignetteMidpoint, v.vignetteFeather),
            curvature: v.vignetteCurvature
        },
        fringing: { enabled: v.aberration > 0, intensity: v.aberration }
    };
    const film: FilmSettings = { id: v.film as FilmId, filter: v.filmFilter as BwFilter, strength: v.filmStrength };
    const lensVignette: LensVignette = { physical: v.vignettePhysical, roundness: v.vignetteRoundness };
    const halation: Halation = { amount: v.halation, radius: v.halationRadius };
    const grain: Grain = {
        enabled: v.grain > 0, intensity: v.grain, size: v.grainSize, color: v.grainColor, animation: v.grainAnimation
    };

    // puts a loaded settings file into the panel; an effect switched off in
    // the file shows as amount 0
    const apply = (s: ExperienceSettings) => {
        const p = s.postEffectSettings;
        const gr = sceneGrain(s);
        const ha = sceneHalation(s);
        const sv = sceneLensVignette(s);
        const fm = sceneFilm(s);
        const m = toMidpoint(p.vignette.inner, p.vignette.outer);
        const on = (enabled: boolean, value: number) => (enabled ? value : 0);
        loadedFilm.current = fm.id;
        set({
            film: fm.id,
            filmFilter: fm.filter,
            filmStrength: fm.strength,
            tonemapping: s.tonemapping,
            exposure: p.grading.enabled ? Math.min(Math.max(Math.log2(Math.max(p.grading.brightness, 1e-3)), EXPOSURE.min), EXPOSURE.max) : 0,
            contrast: p.grading.enabled ? p.grading.contrast : 1,
            saturation: p.grading.enabled ? p.grading.saturation : 1,
            tint: toHex(p.grading.enabled ? p.grading.tint : [1, 1, 1]),
            sharpness: on(p.sharpness.enabled, p.sharpness.amount),
            highPrecision: s.highPrecisionRendering,
            aberration: on(p.fringing.enabled, p.fringing.intensity),
            vignette: on(p.vignette.enabled, p.vignette.intensity),
            vignettePhysical: sv.physical,
            vignetteMidpoint: m.midpoint,
            vignetteFeather: m.feather,
            vignetteRoundness: sv.roundness,
            vignetteCurvature: p.vignette.curvature,
            diffusion: Math.min(on(p.bloom.enabled, p.bloom.intensity) / BLOOM_MAX, 1),
            diffusionRadius: p.bloom.blurLevel,
            halation: ha.amount,
            halationRadius: ha.radius,
            grain: on(gr.enabled, gr.intensity),
            grainSize: gr.size,
            grainColor: gr.color,
            grainAnimation: gr.animation
        });
    };

    return {
        tonemapping: v.tonemapping as Tonemapping,
        highPrecision: v.highPrecision,
        postEffects,
        grain,
        halation,
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
    const [values] = useControls(() => ({
        Debug: folder({
            view: { value: 'image' as DebugView, options: [...DEBUG_VIEWS], label: 'View' },
            depthRange: {
                value: 'scene linear' as DepthRange, options: [...DEPTH_RANGES], label: 'Depth range',
                render: get => get('Debug.view') === 'depth'
            },
            testObjects: { value: false, label: 'Test objects' }
        }, { collapsed: true, order: ORDER.debug })
    }));
    return { view: values.view as DebugView, depthRange: values.depthRange as DepthRange, testObjects: values.testObjects };
}
