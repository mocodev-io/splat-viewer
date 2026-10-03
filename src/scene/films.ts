// Film emulation: what a film stock does with the light the lens gives it.
//
// The profiles are approximations from the published character of each
// stock (datasheet curves and spectral sensitivity, and how they look in
// practice), not measured lab profiles: they carry the character of the
// film, not a scan-exact match.
//
// A profile works on scene-linear light (stillFrames.ts): the image is not
// tone mapped first, the film's characteristic curve does that, with its own
// toe (how shadows run off) and shoulder (how far highlights hold before
// they burn out).
//
// - colour: a white balance (Vision3 500T is balanced for tungsten light, so
//   daylight turns blue on it, as on the real film), a 3 x 3 matrix for how
//   its layers see the colours (rows sum to 1, so grey stays grey), the
//   curve, a tint for shadows and for highlights, and saturation;
// - black and white: the film's sensitivity per colour (orthochromatic film
//   does not see red at all), times a lens filter if one is set, then the
//   curve.
//
// The curve, in stops x from middle grey (0.18): a logistic, steeper or
// flatter on each side (`latShadow`, `latHighlight`: more is a longer, softer
// run-off), between `black` and `white`, with middle grey staying middle
// grey. Neutral follows a usual filmic display curve.

export type FilmKind = 'digital' | 'color' | 'bw';

export type FilmProfile = {
    label: string;
    kind: FilmKind;
    whiteBalance: [number, number, number];
    matrix: [number, number, number, number, number, number, number, number, number];   // rows; bw: one row, repeated
    contrast: number;
    latShadow: number;
    latHighlight: number;
    black: number;
    white: number;
    exposure: number;            // stops
    saturation: number;
    shadowTint: [number, number, number];
    highlightTint: [number, number, number];
    grain?: { intensity: number; size: number; color: number };   // typical grain; set on choosing the film
};

const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1] as FilmProfile['matrix'];
const bwRow = (r: number, g: number, b: number): FilmProfile['matrix'] => {
    const s = r + g + b;
    return [r / s, g / s, b / s, r / s, g / s, b / s, r / s, g / s, b / s];
};

const neutral = {
    whiteBalance: [1, 1, 1], matrix: I3, contrast: 0.968, latShadow: 1.388, latHighlight: 0.943,
    black: 0, white: 1, exposure: 0, saturation: 1, shadowTint: [1, 1, 1], highlightTint: [1, 1, 1]
} satisfies Omit<FilmProfile, 'label' | 'kind'>;

export const FILMS = {
    none: { label: 'None (digital)', kind: 'digital', ...neutral },
    portra400: {
        label: 'Portra 400', kind: 'color', ...neutral,
        matrix: [0.97, 0.03, 0, 0.02, 0.97, 0.01, 0, 0.03, 0.97],
        contrast: 0.88, latShadow: 1.3, latHighlight: 1.2, black: 0.003, white: 0.99, saturation: 0.9,
        shadowTint: [0.97, 1, 1.03], highlightTint: [1.03, 1, 0.94],
        grain: { intensity: 0.25, size: 1, color: 0.3 }
    },
    ektar100: {
        label: 'Ektar 100', kind: 'color', ...neutral,
        matrix: [1.08, -0.05, -0.03, -0.03, 1.04, -0.01, -0.02, -0.04, 1.06],
        contrast: 1.08, latShadow: 1.25, latHighlight: 1, black: 0.001, white: 1, saturation: 1.18,
        shadowTint: [0.98, 0.99, 1.04], highlightTint: [1.02, 1, 0.97],
        grain: { intensity: 0.12, size: 0.8, color: 0.25 }
    },
    superia400: {
        label: 'Superia 400', kind: 'color', ...neutral,
        matrix: [1, 0, 0, -0.02, 1.02, 0, 0, 0.02, 0.98],
        contrast: 1, latShadow: 1.3, latHighlight: 1.1, black: 0.003, white: 0.99, saturation: 1.08,
        shadowTint: [0.94, 1.03, 1], highlightTint: [1.02, 0.98, 1],
        grain: { intensity: 0.35, size: 1.1, color: 0.45 }
    },
    velvia50: {
        label: 'Velvia 50 (slide)', kind: 'color', ...neutral,
        matrix: [1.05, -0.03, -0.02, -0.05, 1.08, -0.03, -0.04, -0.06, 1.1],
        contrast: 1.25, latShadow: 1.1, latHighlight: 0.85, black: 0, white: 1, exposure: -0.2, saturation: 1.25,
        shadowTint: [0.97, 0.98, 1.05], highlightTint: [1, 1, 0.98],
        grain: { intensity: 0.1, size: 0.7, color: 0.2 }
    },
    vision3_500t: {
        label: 'Vision3 500T (tungsten)', kind: 'color', ...neutral,
        whiteBalance: [0.78, 0.92, 1.22],
        contrast: 0.9, latShadow: 1.35, latHighlight: 1.3, black: 0.004, white: 0.99, saturation: 0.95,
        shadowTint: [0.95, 1, 1.02], highlightTint: [1, 1, 1],
        grain: { intensity: 0.35, size: 1.2, color: 0.35 }
    },
    bwNeutral: {
        label: 'B&W neutral', kind: 'bw', ...neutral, matrix: bwRow(0.2126, 0.7152, 0.0722)
    },
    trix400: {
        label: 'Tri-X 400', kind: 'bw', ...neutral, matrix: bwRow(0.19, 0.63, 0.18),
        contrast: 1.1, latShadow: 1.3, latHighlight: 1.05, black: 0.004,
        grain: { intensity: 0.45, size: 1.3, color: 0 }
    },
    hp5: {
        label: 'HP5 Plus', kind: 'bw', ...neutral, matrix: bwRow(0.21, 0.62, 0.17),
        contrast: 0.92, latShadow: 1.35, latHighlight: 1.25, black: 0.006,
        grain: { intensity: 0.4, size: 1.2, color: 0 }
    },
    panf50: {
        label: 'Pan F 50', kind: 'bw', ...neutral, matrix: bwRow(0.25, 0.65, 0.1),
        contrast: 1.3, latShadow: 1.15, latHighlight: 0.95, black: 0.002,
        grain: { intensity: 0.12, size: 0.7, color: 0 }
    },
    ortho: {
        label: 'Orthochromatic', kind: 'bw', ...neutral, matrix: bwRow(0, 0.42, 0.58),
        contrast: 1.25, latShadow: 1.2, latHighlight: 1, black: 0.003,
        grain: { intensity: 0.3, size: 1, color: 0 }
    }
} satisfies Record<string, FilmProfile>;

export type FilmId = keyof typeof FILMS;
export const FILM_IDS = Object.keys(FILMS) as FilmId[];

// Lens filters for black and white film: how much of red, green and blue
// each lets through. Yellow darkens a blue sky a little, red makes it nearly
// black, green lightens foliage and darkens skin.
export const BW_FILTERS = {
    none: [1, 1, 1],
    yellow: [1, 0.9, 0.35],
    orange: [1, 0.6, 0.12],
    red: [1, 0.18, 0.05],
    green: [0.35, 1, 0.4]
} as const;
export type BwFilter = keyof typeof BW_FILTERS;
export const BW_FILTER_IDS = Object.keys(BW_FILTERS) as BwFilter[];

/** The film settings of a scene: which stock, its filter (black and white) and how strongly it applies. */
export type FilmSettings = { id: FilmId; filter: BwFilter; strength: number };

export const defaultFilm = (): FilmSettings => ({ id: 'none', filter: 'none', strength: 1 });

/**
 * The profile to render with: the film blended towards neutral by
 * `strength` (0 is the neutral curve of the same kind), and for black and
 * white the filter folded into its sensitivity.
 */
export function resolveFilm(f: FilmSettings): FilmProfile {
    const film: FilmProfile = FILMS[f.id] ?? FILMS.none;
    const base: FilmProfile = film.kind === 'bw' ? FILMS.bwNeutral : FILMS.none;
    const t = Math.min(Math.max(f.strength, 0), 1);
    const lerp = (a: number, b: number) => a + (b - a) * t;
    const lerpN = <T extends number[]>(a: T, b: T) => a.map((v, i) => lerp(v, b[i])) as T;
    let matrix = lerpN(base.matrix, film.matrix);
    if (film.kind === 'bw') {
        const [fr, fg, fb] = BW_FILTERS[f.filter] ?? BW_FILTERS.none;
        const r = matrix[0] * fr, g = matrix[1] * fg, b = matrix[2] * fb;
        matrix = bwRow(r, g, b);
    }
    return {
        ...film,
        whiteBalance: lerpN(base.whiteBalance, film.whiteBalance),
        matrix,
        contrast: lerp(base.contrast, film.contrast),
        latShadow: lerp(base.latShadow, film.latShadow),
        latHighlight: lerp(base.latHighlight, film.latHighlight),
        black: lerp(base.black, film.black),
        white: lerp(base.white, film.white),
        exposure: lerp(base.exposure, film.exposure),
        saturation: lerp(base.saturation, film.saturation),
        shadowTint: lerpN(base.shadowTint, film.shadowTint),
        highlightTint: lerpN(base.highlightTint, film.highlightTint)
    };
}
