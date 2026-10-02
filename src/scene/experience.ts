// Scene data: SuperSplat's Experience Settings v2, the JSON that SuperSplat
// Studio writes and the SuperSplat viewer reads. Field names, defaults and
// ranges follow playcanvas/supersplat-viewer (src/schemas/), so a settings
// file authored there works here and the other way round.
//
// Our own additions go in `extras`, which the SuperSplat viewer ignores.

export type Vec3Tuple = [number, number, number];

export type CameraPose = {
    position: Vec3Tuple;
    target: Vec3Tuple;
    fov: number;                 // vertical, degrees
};

export type PostEffectSettings = {
    sharpness: { enabled: boolean; amount: number };
    bloom: { enabled: boolean; intensity: number; blurLevel: number };
    grading: { enabled: boolean; brightness: number; contrast: number; saturation: number; tint: Vec3Tuple };
    vignette: { enabled: boolean; intensity: number; inner: number; outer: number; curvature: number };
    fringing: { enabled: boolean; intensity: number };
};

export const TONEMAPPING = ['none', 'linear', 'filmic', 'hejl', 'aces', 'aces2', 'neutral'] as const;
export type Tonemapping = typeof TONEMAPPING[number];

export type ExperienceSettings = {
    version: 2;
    tonemapping: Tonemapping;
    highPrecisionRendering: boolean;
    background: { color: Vec3Tuple };
    postEffectSettings: PostEffectSettings;
    cameras: { initial: CameraPose }[];
    // read and kept, not used yet
    animTracks: unknown[];
    annotations: unknown[];
    startMode: 'default' | 'animTrack' | 'annotation';
    extras?: Record<string, unknown>;
};

// ---- our extras: 3D objects and the light they need

export const OBJECT_TYPES = ['box', 'sphere', 'cylinder', 'cone', 'capsule', 'plane', 'torus'] as const;
export type ObjectType = typeof OBJECT_TYPES[number];

export type SceneObject = {
    id: string;
    type: ObjectType;
    position: Vec3Tuple;
    rotation: Vec3Tuple;         // euler, degrees
    scale: Vec3Tuple;
    material: {
        color: Vec3Tuple;        // 0..1 rgb
        opacity: number;         // 1 = opaque
        emissive: Vec3Tuple;
        metalness: number;
        gloss: number;
        // Write into the scene depth that DoF, fog and SSAO read. Opaque
        // objects do by default; transparent ones don't (engine default), so
        // depth effects look through them to the splats behind.
        writeDepth?: boolean;
    };
};

// Splats are unlit, objects are lit: without light they render black.
export type Lighting = {
    ambient: { color: Vec3Tuple; intensity: number };
    sun: { color: Vec3Tuple; intensity: number; yaw: number; pitch: number };
};

export const defaultLighting = (): Lighting => ({
    ambient: { color: [1, 1, 1], intensity: 0.35 },
    sun: { color: [1, 0.96, 0.9], intensity: 1.2, yaw: 30, pitch: -45 }
});

const defaultObject = (): SceneObject => ({
    id: '',
    type: 'box',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    material: { color: [0.8, 0.8, 0.8], opacity: 1, emissive: [0, 0, 0], metalness: 0, gloss: 0.4 }
});

export function sceneObjects(s: ExperienceSettings): SceneObject[] {
    const list = s.extras?.objects;
    if (!Array.isArray(list)) return [];
    return list.flatMap((raw, i) => {
        if (!isObject(raw) || !OBJECT_TYPES.includes(raw.type as ObjectType)) return [];
        const obj = mergeKnown(defaultObject(), raw);
        if (isObject(raw.material) && typeof raw.material.writeDepth === 'boolean') {
            obj.material.writeDepth = raw.material.writeDepth;
        }
        obj.id = typeof raw.id === 'string' && raw.id ? raw.id : `object-${i}`;
        return [obj];
    });
}

export function sceneLighting(s: ExperienceSettings): Lighting {
    return mergeKnown(defaultLighting(), s.extras?.lighting);
}

// ---- our extras: the lens
//
// A physical camera instead of a field of view. The sensor width spans the
// image width (like Blender's default sensor fit), so the horizontal angle
// of view is 2·atan(sensorWidth / 2f). Distances are in meters; splats have
// no scale of their own, so `metersPerUnit` says how big one scene unit is.

export const SENSORS = {
    'Full frame': [36, 24],
    'Super 35': [24.89, 18.66],
    'APS-C': [23.5, 15.6],
    'Micro 4/3': [17.3, 13]
} as const;
export type SensorName = keyof typeof SENSORS | 'Custom';
export const SENSOR_NAMES = [...Object.keys(SENSORS), 'Custom'] as SensorName[];

export const BLUR_QUALITIES = ['low', 'medium', 'high'] as const;
export const FOCUS_MODES = ['manual', 'auto'] as const;
/** Diaphragm blades; 0 is a round opening. */
export const BLADE_COUNTS = [0, 5, 6, 7, 8, 9] as const;

export type Lens = {
    sensor: SensorName;
    sensorWidth: number;         // mm
    sensorHeight: number;        // mm
    focalLength: number;         // mm
    fStop: number;
    focusMode: typeof FOCUS_MODES[number];
    focusDistance: number;       // m; manual focus, and where autofocus starts
    afTransition: number;        // s, how long autofocus takes to reach a new distance
    metersPerUnit: number;
    dof: boolean;
    blurQuality: typeof BLUR_QUALITIES[number];
    // bokeh (aperture.ts)
    blades: typeof BLADE_COUNTS[number];
    bladeRoundness: number;      // 0 straight blades, 1 round
    bladeRotation: number;       // degrees
    anamorphic: number;          // horizontal squeeze, 1 spherical, 2 a 2x anamorphic
    catsEye: number;             // 0 none, 1 strong: bokeh turns to tangential ovals towards the corners
    // the still (useStillDof.ts, stillFrames.ts)
    overblur: number;            // gather on the average, × the gap between lens points; 0 off
    stillFade: number;           // how much of the way to a new group of samples the screen goes per frame
    afFrame: boolean;            // show the AF point
};

export const lensRanges = {
    sensorWidth: { min: 1, max: 70, step: 0.01 },
    sensorHeight: { min: 1, max: 70, step: 0.01 },
    focalLength: { min: 8, max: 300, step: 1 },
    fStop: { min: 0.95, max: 22, step: 0.05 },
    focusDistance: { min: 0.1, max: 50, step: 0.01 },
    afTransition: { min: 0, max: 3, step: 0.05 },
    metersPerUnit: { min: 0.001, max: 100, step: 0.001 },
    bladeRoundness: { min: 0, max: 1, step: 0.01 },
    bladeRotation: { min: 0, max: 180, step: 1 },
    anamorphic: { min: 1, max: 2, step: 0.01 },
    catsEye: { min: 0, max: 1, step: 0.01 },
    overblur: { min: 0, max: 2, step: 0.05 },
    stillFade: { min: 0.05, max: 1, step: 0.01 }
} as const;

export const defaultLens = (): Lens => ({
    sensor: 'Full frame',
    sensorWidth: 36,
    sensorHeight: 24,
    focalLength: 35,
    fStop: 2.8,
    focusMode: 'manual',
    focusDistance: 3,
    afTransition: 0.5,
    metersPerUnit: 1,
    dof: false,
    blurQuality: 'medium',
    blades: 0,
    bladeRoundness: 0,
    bladeRotation: 0,
    anamorphic: 1,
    catsEye: 0,
    overblur: 1.5,
    stillFade: 0.35,
    afFrame: true
});

const toDeg = (r: number) => r * 180 / Math.PI;
const toRad = (d: number) => d * Math.PI / 180;

/**
 * The image frame: the sensor's aspect, as large as fits in a canvas of
 * width × height and centred in it. What lies outside is overscan, shown
 * dimmed or black by the passepartout.
 */
export function frameRect(width: number, height: number, aspect: number) {
    const w = Math.min(width, height * aspect);
    const h = w / aspect;
    return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

export const sensorAspect = (l: Pick<Lens, 'sensorWidth' | 'sensorHeight'>) => l.sensorWidth / l.sensorHeight;

/** Horizontal angle of view of the frame, degrees. */
export const horizontalFov = (l: Lens) => toDeg(2 * Math.atan(l.sensorWidth / (2 * l.focalLength)));
/** Vertical angle of view over the sensor's own height, degrees; what the v2 `fov` field gets. */
export const verticalFov = (l: Lens) => toDeg(2 * Math.atan(l.sensorHeight / (2 * l.focalLength)));
const focalForVerticalFov = (fov: number, sensorHeight: number) => sensorHeight / (2 * Math.tan(toRad(fov) / 2));

const clamp = (v: number, r: { min: number; max: number }) => Math.min(Math.max(v, r.min), r.max);

/**
 * The lens of a scene: `extras.lens`, or for a file without one (from
 * SuperSplat, say) the focal length that gives its camera's field of view.
 */
export function sceneLens(s: ExperienceSettings): Lens {
    const lens = mergeKnown(defaultLens(), s.extras?.lens);
    if (!SENSOR_NAMES.includes(lens.sensor)) lens.sensor = 'Custom';
    if (lens.sensor !== 'Custom') [lens.sensorWidth, lens.sensorHeight] = SENSORS[lens.sensor];
    if (!BLUR_QUALITIES.includes(lens.blurQuality)) lens.blurQuality = 'medium';
    if (!FOCUS_MODES.includes(lens.focusMode)) lens.focusMode = 'manual';
    if (!BLADE_COUNTS.includes(lens.blades)) lens.blades = 0;
    const fov = s.cameras[0]?.initial.fov;
    if (!isObject(s.extras?.lens) && fov) lens.focalLength = focalForVerticalFov(fov, lens.sensorHeight);
    for (const key of Object.keys(lensRanges) as (keyof typeof lensRanges)[]) {
        lens[key] = clamp(lens[key], lensRanges[key]);
    }
    return lens;
}

// ---- our extras: film grain
//
// Grain sits in the film or sensor, not in the lens: it is added to the
// final image, after depth of field, bloom and tone mapping, and is never
// averaged into a still (stillFrames.ts). SuperSplat has no grain, so it
// lives under `extras.look.grain`.

export type Grain = {
    enabled: boolean;
    intensity: number;           // 1 heavy
    size: number;                // grain size, pixels
    color: number;               // 0 monochrome, 1 independent per colour channel
    animation: number;           // 0 a fixed pattern, 1 a new one 24 times a second, as film
};

export const grainRanges = {
    intensity: { min: 0, max: 1, step: 0.01 },
    size: { min: 0.5, max: 3, step: 0.05 },
    color: { min: 0, max: 1, step: 0.01 },
    animation: { min: 0, max: 1, step: 0.01 }
} as const;

export const defaultGrain = (): Grain => ({ enabled: false, intensity: 0.3, size: 1, color: 0, animation: 1 });

export function sceneGrain(s: ExperienceSettings): Grain {
    const look = s.extras?.look;
    const grain = mergeKnown(defaultGrain(), isObject(look) ? look.grain : undefined);
    for (const key of Object.keys(grainRanges) as (keyof typeof grainRanges)[]) {
        grain[key] = clamp(grain[key], grainRanges[key]);
    }
    return grain;
}

// ---- our extras: the film and the lens vignette
//
// The image goes through the lens (aberration, vignette) and then onto the
// film: colour, or black and white, which records only brightness (a later
// film emulation would hang its own sensitivity per colour here). Stored as
// `extras.look.film`.

export const FILM_TYPES = ['color', 'bw'] as const;
export type FilmType = typeof FILM_TYPES[number];

export function sceneFilm(s: ExperienceSettings): FilmType {
    const look = s.extras?.look;
    const film = isObject(look) ? look.film : undefined;
    return FILM_TYPES.includes(film as FilmType) ? film as FilmType : 'color';
}

// The vignette: SuperSplat's `vignette` keeps the amount and where the
// falloff runs (inner / outer); our additions in `extras.look.vignette`:
// `roundness` (1 a circle around the optical axis, as a real lens; 0 the
// frame's own shape) and `physical`, the falloff of the lens itself from
// its focal length and f-stop.
export type LensVignette = { physical: boolean; roundness: number };

export const defaultLensVignette = (): LensVignette => ({ physical: false, roundness: 1 });

export function sceneLensVignette(s: ExperienceSettings): LensVignette {
    const look = s.extras?.look;
    const v = mergeKnown(defaultLensVignette(), isObject(look) ? look.vignette : undefined);
    v.roundness = clamp(v.roundness, { min: 0, max: 1 });
    return v;
}

// ---- our extras: the viewport
//
// Outside the frame the view goes on with the same lens (overscan); the
// passepartout dims it, 1 is black bars. Stored as `extras.viewport`.

export type Viewport = { passepartout: number };

export const defaultViewport = (): Viewport => ({ passepartout: 1 });

export function sceneViewport(s: ExperienceSettings): Viewport {
    const v = mergeKnown(defaultViewport(), s.extras?.viewport);
    v.passepartout = clamp(v.passepartout, { min: 0, max: 1 });
    return v;
}

// Authoring ranges from supersplat-viewer/src/schemas/ranges.ts
export const ranges = {
    sharpness: { amount: { min: 0, max: 1, step: 0.01 } },
    bloom: { intensity: { min: 0, max: 0.1, step: 0.01 }, blurLevel: { min: 1, max: 16, step: 1 } },
    grading: {
        brightness: { min: 0, max: 3, step: 0.01 },
        contrast: { min: 0.5, max: 1.5, step: 0.01 },
        saturation: { min: 0, max: 2, step: 0.01 }
    },
    vignette: {
        intensity: { min: 0, max: 1, step: 0.01 },
        inner: { min: 0, max: 3, step: 0.01 },
        outer: { min: 0, max: 3, step: 0.01 },
        curvature: { min: 0.01, max: 10, step: 0.01 }
    },
    fringing: { intensity: { min: 0, max: 100, step: 1 } }
} as const;

// Defaults from supersplat-viewer/src/schemas/defaults.ts
export const defaultPostEffects = (): PostEffectSettings => ({
    sharpness: { enabled: false, amount: 0 },
    bloom: { enabled: false, intensity: 0.1, blurLevel: 2 },
    grading: { enabled: false, brightness: 1, contrast: 1, saturation: 1, tint: [1, 1, 1] },
    vignette: { enabled: false, intensity: 0.5, inner: 0.3, outer: 0.75, curvature: 1 },
    fringing: { enabled: false, intensity: 0.5 }
});

export const defaultExperience = (): ExperienceSettings => ({
    version: 2,
    tonemapping: 'linear',
    highPrecisionRendering: false,
    background: { color: [0, 0, 0] },
    postEffectSettings: defaultPostEffects(),
    cameras: [],                 // empty: the viewer frames the splat itself
    animTracks: [],
    annotations: [],
    startMode: 'default'
});

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const isVec3 = (v: unknown): v is Vec3Tuple =>
    Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));

// Copies the fields of `src` that exist in `dst` with the same type, so a
// file with missing or odd fields still gives a complete, valid object.
function mergeKnown<T extends Record<string, unknown>>(dst: T, src: unknown): T {
    if (!isObject(src)) return dst;
    for (const key of Object.keys(dst) as (keyof T & string)[]) {
        const d = dst[key];
        const s = src[key];
        if (s === undefined) continue;
        if (isVec3(d)) {
            if (isVec3(s)) dst[key] = [...s] as T[typeof key];
        } else if (isObject(d)) {
            mergeKnown(d, s);
        } else if (typeof d === typeof s) {
            dst[key] = s as T[typeof key];
        }
    }
    return dst;
}

function parseCameraPose(v: unknown): CameraPose | null {
    if (!isObject(v) || !isVec3(v.position) || !isVec3(v.target)) return null;
    const fov = typeof v.fov === 'number' && Number.isFinite(v.fov) ? v.fov : 60;
    return { position: [...v.position], target: [...v.target], fov };
}

// Reads a settings document. Only version 2 is understood; anything else is
// reported and replaced by defaults rather than half-applied.
export function parseExperience(json: unknown): { settings: ExperienceSettings; warning?: string } {
    const settings = defaultExperience();
    if (!isObject(json) || json.version !== 2) {
        return { settings, warning: 'settings file is not Experience Settings v2, using defaults' };
    }
    if (TONEMAPPING.includes(json.tonemapping as Tonemapping)) settings.tonemapping = json.tonemapping as Tonemapping;
    if (typeof json.highPrecisionRendering === 'boolean') settings.highPrecisionRendering = json.highPrecisionRendering;
    if (isObject(json.background) && isVec3(json.background.color)) settings.background.color = [...json.background.color];
    mergeKnown(settings.postEffectSettings, json.postEffectSettings);
    if (Array.isArray(json.cameras)) {
        settings.cameras = json.cameras
            .map(c => (isObject(c) ? parseCameraPose(c.initial) : null))
            .filter((c): c is CameraPose => c !== null)
            .map(initial => ({ initial }));
    }
    if (Array.isArray(json.animTracks)) settings.animTracks = json.animTracks;
    if (Array.isArray(json.annotations)) settings.annotations = json.annotations;
    if (json.startMode === 'animTrack' || json.startMode === 'annotation') settings.startMode = json.startMode;
    if (isObject(json.extras)) settings.extras = json.extras;
    return { settings };
}

// Where the settings of a splat live: `scene.json` next to `scene.sog` or
// `scene.ply`; for a folder (unbundled SOG, LOD streaming) `settings.json`
// inside it, as SuperSplat exports it.
export function settingsUrlFor(splatUrl: string): string {
    if (/\/(lod-)?meta\.json$/i.test(splatUrl)) {
        return splatUrl.replace(/[^/]+$/, 'settings.json');
    }
    return splatUrl.replace(/(\.compressed)?\.(ply|sog)$/i, '.json');
}

export async function loadExperience(splatUrl: string): Promise<{ settings: ExperienceSettings; found: boolean; warning?: string }> {
    try {
        const res = await fetch(settingsUrlFor(splatUrl), { headers: { Accept: 'application/json' } });
        if (!res.ok) return { settings: defaultExperience(), found: false };
        const { settings, warning } = parseExperience(await res.json());
        return { settings, found: true, warning };
    } catch (err) {
        return { settings: defaultExperience(), found: false, warning: `could not read settings: ${String(err)}` };
    }
}
