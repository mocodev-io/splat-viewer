// The shape of the lens opening, and points spread evenly over it.
//
// The still DoF renders the scene from points on the aperture (stillFrames.ts,
// useStillDof.ts), so the bokeh is exactly the shape those points fill:
//
// - round, or a diaphragm of 5–9 straight blades with its corners on the
//   f-stop circle (as Blender and most renderers draw it), rotated by
//   `bladeRotation`; `bladeRoundness` bends the blades out towards the
//   circle, as curved blades on real lenses do;
// - `anamorphic` squeezes the shape horizontally into an upright oval, the
//   look of an anamorphic lens (1 is spherical, 2 a 2× squeeze).
//
// The points come in groups of eight on the unit disc: two rings of four
// points a quarter turn apart, at radius √u and √(1 − u), the second ring
// turned an eighth of a turn against the first. The still is shown after
// each whole group (stillFrames.ts), and every group on its own averages
// out at the centre, spreads equally in every direction and has the mean
// square radius of the whole disc (u and 1 − u average to a half). So an
// out-of-focus object neither sits off its place, nor gets stretched one way
// and then another, nor grows and shrinks while the samples come in: it only
// gets smoother. u comes from the van der Corput sequence (halved, so the
// inner rings fill the inner half of the area and the outer rings the
// outer) in base 2, the ring angle from it in base 3: together the Halton
// sequence, whose two coordinates do not line up into a pattern.
//
// Each shape is a star shape around the centre with its edge at distance
// b(θ). A disc point (ρ, α) goes to angle θ = F⁻¹(α / 2π), where F is the
// cumulative distribution of b(θ)², and radius ρ · b(θ): that is uniform over
// the shape again. F⁻¹ comes from a small table; for the round opening it is
// the identity.

import type { Lens } from '../scene/experience';

export type ApertureShape = Pick<Lens, 'blades' | 'bladeRoundness' | 'bladeRotation' | 'anamorphic'>;

const TABLE = 512;
/** Lens points per group; the still is shown after whole groups. */
export const APERTURE_GROUP = 8;
/** The van der Corput sequence in a base: in base 2, 1 → 1/2, 2 → 1/4, 3 → 3/4, 4 → 1/8, ... */
function vanDerCorput(n: number, base: number) {
    let v = 0;
    let f = 1 / base;
    for (; n > 0; n = Math.floor(n / base), f /= base) v += (n % base) * f;
    return v;
}

/** Distance from the centre to the edge of the unsqueezed shape, at angle θ. */
function edge(shape: ApertureShape, theta: number) {
    const n = shape.blades;
    if (n < 3) return 1;
    const sector = 2 * Math.PI / n;
    const a = theta - shape.bladeRotation * Math.PI / 180;
    const local = ((a % sector) + sector) % sector - sector / 2;     // angle from the middle of a blade
    const polygon = Math.cos(sector / 2) / Math.cos(local);
    return polygon + (1 - polygon) * shape.bladeRoundness;
}

export class Aperture {
    private shape: ApertureShape;
    private cdf = new Float64Array(TABLE + 1);    // cumulative ∫ b(θ)² dθ, normalized

    constructor(shape: ApertureShape) {
        this.shape = { ...shape };
        let sum = 0;
        for (let i = 0; i < TABLE; i++) {
            const b = edge(shape, (i + 0.5) / TABLE * 2 * Math.PI);
            sum += b * b;
            this.cdf[i + 1] = sum;
        }
        for (let i = 1; i <= TABLE; i++) this.cdf[i] /= sum;
    }

    /** Whether this aperture has the given shape. */
    is(shape: ApertureShape) {
        const s = this.shape;
        return s.blades === shape.blades && s.bladeRoundness === shape.bladeRoundness
            && s.bladeRotation === shape.bladeRotation && s.anamorphic === shape.anamorphic;
    }

    /** Point i of the sequence, in units of the f-stop radius (x right, y up). */
    sample(i: number): [number, number] {
        const group = Math.floor(i / APERTURE_GROUP);
        const member = i % APERTURE_GROUP;
        // inner ring (members 0–3) or outer ring (4–7), four quarter turns each
        const u = vanDerCorput(group + 1, 2) / 2;
        const outer = member >= 4;
        const rho = Math.sqrt(outer ? 1 - u : u);
        const turn = vanDerCorput(group, 3) * Math.PI / 2 + (outer ? Math.PI / 4 : 0);
        const alpha = (turn + (member % 4) * Math.PI / 2) % (2 * Math.PI);
        const t = alpha / (2 * Math.PI);
        // invert the angle distribution: find the bin, interpolate within it
        let lo = 0;
        let hi = TABLE;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (this.cdf[mid] <= t) lo = mid; else hi = mid;
        }
        const span = this.cdf[lo + 1] - this.cdf[lo];
        const theta = (lo + (span > 0 ? (t - this.cdf[lo]) / span : 0.5)) / TABLE * 2 * Math.PI;
        const r = rho * edge(this.shape, theta);
        return [r * Math.cos(theta) / this.shape.anamorphic, r * Math.sin(theta)];
    }
}
