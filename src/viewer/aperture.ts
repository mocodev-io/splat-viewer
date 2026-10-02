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
// Points come from the R2 sequence (Roberts 2018), mapped onto the unit disc
// with Shirley & Chiu's concentric map, which keeps them as evenly spread
// as they were in the square (a plain polar map bunches them into spokes).
// Any first n points cover the aperture evenly, so the still looks right
// early and only gets smoother.
//
// Each shape is a star shape around the centre with its edge at distance
// b(θ). A disc point (ρ, α) goes to angle θ = F⁻¹(α / 2π), where F is the
// cumulative distribution of b(θ)², and radius ρ · b(θ): that is uniform over
// the shape again. F⁻¹ comes from a small table; for the round opening it is
// the identity.

import type { Lens } from '../scene/experience';

export type ApertureShape = Pick<Lens, 'blades' | 'bladeRoundness' | 'bladeRotation' | 'anamorphic'>;

const TABLE = 512;
const R2 = [0.7548776662466927, 0.5698402909980532];

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

/** Shirley & Chiu's concentric map from the unit square to the disc: radius, angle in [0, 2π). */
function concentric(u: number, v: number): [number, number] {
    const a = 2 * u - 1;
    const b = 2 * v - 1;
    if (a === 0 && b === 0) return [0, 0];
    const [r, phi] = Math.abs(a) > Math.abs(b)
        ? [a, (Math.PI / 4) * (b / a)]
        : [b, Math.PI / 2 - (Math.PI / 4) * (a / b)];
    const angle = r < 0 ? phi + Math.PI : phi;
    return [Math.abs(r), ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)];
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
        const [rho, alpha] = concentric((0.5 + R2[0] * i) % 1, (0.5 + R2[1] * i) % 1);
        const v = alpha / (2 * Math.PI);
        // invert the angle distribution: find the bin, interpolate within it
        let lo = 0;
        let hi = TABLE;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (this.cdf[mid] <= v) lo = mid; else hi = mid;
        }
        const span = this.cdf[lo + 1] - this.cdf[lo];
        const theta = (lo + (span > 0 ? (v - this.cdf[lo]) / span : 0.5)) / TABLE * 2 * Math.PI;
        const r = rho * edge(this.shape, theta);
        return [r * Math.cos(theta) / this.shape.anamorphic, r * Math.sin(theta)];
    }
}
