// All tweakable settings live in one plain object. The UI edits it, presets and
// JSON import overwrite it, and the camera/post modules read it every frame.

export const defaults = () => ({
    scene: {
        splat: '',
        flip: true,             // most COLMAP-based trainers export y-down
        background: '#000000',
        renderScale: 1,         // internal resolution, 1 = native
        metersPerUnit: 1,       // scene scale; COLMAP scenes have no real-world size
        antiAlias: false       // for splats trained with mip-splatting style AA
    },
    camera: {
        mode: 'fly',            // fly | orbit
        focalLength: 24,        // mm; field of view follows from this and the sensor
        sensor: 'full frame',   // full frame | super 35 | aps-c | micro 4/3
        moveSpeed: 2,
        lookSpeed: 0.25,
        smoothing: 0.6,         // 0 = raw input, 1 = very floaty
        roll: 0,
        rollSpeed: 45,          // deg/s for Z / C keys
        fisheye: 0,             // true fisheye projection of the splats
        drift: false,           // slow automatic orbit
        driftSpeed: 6           // deg/s
    },
    shake: {
        style: 'off',           // off | handheld | walk | run | vehicle | earthquake
        amount: 0.5,
        speed: 1
    },
    dolly: {
        enabled: false          // dolly zoom: keeps the focus subject the same size
    },
    lens: {
        autofocus: 'click',     // off | click | center
        focusSpeed: 4,          // focus pull speed, higher = faster
        dof: 'off',             // off | lens (thin lens, own) | fast (engine)
        focusDistance: 3,
        fStop: 2.8,             // lens: f-number, lower = more blur
        bokeh: 'round',         // lens: round | hexagon | octagon | anamorphic | swirl
        focusRange: 1,          // fast: sharp zone around the focus distance
        blurRadius: 4,          // fast: blur size
        nearBlur: true,
        distortion: 0,          // + barrel, - pincushion
        fringing: 0,
        anamorphic: 0,          // horizontal streaks from bright areas (needs bloom)
        anamorphicTint: '#5fa0ff',
        dirt: 0                 // lens dirt lit by bloom (needs bloom)
    },
    light: {
        exposure: 0,
        toneMapping: 'ACES2',
        bloom: 0,
        bloomThreshold: 0.6,
        bloomBlur: 16,
        halation: 0,            // red film glow around highlights (needs bloom)
        lightLeak: 0
    },
    fog: {
        enabled: false,
        density: 0.04,
        heightBase: 0,
        heightFalloff: 0.15,
        anisotropy: 0.6,
        intensity: 1,
        tint: '#ffffff',
        sunYaw: 30,
        sunPitch: -35,
        sunColor: '#fff2d9',
        sunIntensity: 1.5,
        ambient: 0.03,
        shafts: false           // splats cast shadows into the fog
    },
    ssao: {
        enabled: false,
        intensity: 0.5,
        radius: 30
    },
    color: {
        grading: false,
        brightness: 1,
        contrast: 1,
        saturation: 1,
        tint: '#ffffff',
        enhance: false,
        shadows: 0,
        midtones: 0,
        highlights: 0,
        vibrance: 0,
        dehaze: 0,
        lut: 'none',
        lutIntensity: 1
    },
    vignette: {
        intensity: 0,
        inner: 0.5,
        outer: 1.2,
        curvature: 0.5,
        color: '#000000'
    },
    film: {
        grain: 0,
        grainSize: 1.5,
        grainAnimated: true,    // off = a fixed grain pattern
        flicker: 0,
        gateWeave: 0,
        sharpen: 0,
        taa: false
    },
    stylize: {
        motionBlur: 0,          // shutter, 0..1 of a frame
        pixelate: 0,            // pixel size in screen px, 0 = off
        posterize: 0,           // colour levels, 0 = off
        kuwahara: 0,            // painterly radius, 0 = off
        outline: 0,
        outlineColor: '#111111',
        paper: 0,               // fades the image to paper, leaving only the outlines
        glitch: 0,
        crt: 0,
        look: 'none',           // none | duotone | thermal | night vision | halftone | ascii
        lookMix: 1,
        cellSize: 8,            // halftone / ascii cell size in px
        duoDark: '#1b1035',
        duoLight: '#ffd07a',
        letterbox: 'off'        // off | 1.85 | 2 | 2.39 | 2.76 | 1.33 | 1
    }
});

// Presets only list what they change; everything else falls back to defaults.
export const presets = {
    'Clean': {},
    'Cinematic': {
        camera: { focalLength: 50 },
        lens: { dof: 'lens', fStop: 2, bokeh: 'anamorphic', anamorphic: 0.25, fringing: 2 },
        light: { bloom: 0.04, bloomThreshold: 0.7, halation: 0.15 },
        color: { lut: 'teal & orange', lutIntensity: 0.7, enhance: true, vibrance: 0.15, highlights: -0.2 },
        vignette: { intensity: 0.35 },
        film: { grain: 0.06, gateWeave: 0.15 },
        stylize: { motionBlur: 0.5, letterbox: '2.39' },
        shake: { style: 'handheld', amount: 0.2 }
    },
    'Dream': {
        lens: { dof: 'lens', fStop: 1.2, bokeh: 'swirl', fringing: 6 },
        light: { exposure: 0.3, bloom: 0.12, bloomThreshold: 0.4, bloomBlur: 20, lightLeak: 0.5 },
        color: { grading: true, saturation: 0.85, contrast: 0.85, tint: '#ffe9f2', lut: 'faded film', lutIntensity: 0.6 },
        vignette: { intensity: 0.25, color: '#2a1030' },
        film: { grain: 0.04 },
        camera: { focalLength: 50, drift: true }
    },
    'VHS': {
        lens: { fringing: 14, distortion: 0.08 },
        light: { bloom: 0.05, bloomThreshold: 0.5 },
        color: { grading: true, saturation: 1.25, contrast: 1.1, lut: 'cross process', lutIntensity: 0.5 },
        film: { grain: 0.12, grainSize: 2, flicker: 0.15, gateWeave: 0.6 },
        stylize: { glitch: 0.35, crt: 0.45, letterbox: '1.33' },
        shake: { style: 'handheld', amount: 0.4 }
    },
    'Noir': {
        light: { toneMapping: 'FILMIC', bloom: 0.03, bloomThreshold: 0.8, halation: 0.1 },
        color: { grading: true, saturation: 0, contrast: 1.35, brightness: 1.25 },
        vignette: { intensity: 0.55, inner: 0.35 },
        film: { grain: 0.15, flicker: 0.08, gateWeave: 0.25 },
        stylize: { letterbox: '1.85' }
    },
    'Found footage': {
        camera: { focalLength: 16 },
        lens: { distortion: 0.15, fringing: 8 },
        color: { grading: true, saturation: 0.7, contrast: 1.15, tint: '#e6ffe8' },
        vignette: { intensity: 0.4 },
        film: { grain: 0.18, grainSize: 1, flicker: 0.1 },
        stylize: { motionBlur: 0.8, glitch: 0.1 },
        shake: { style: 'run', amount: 0.6 }
    },
    'Comic': {
        stylize: { posterize: 6, outline: 1, outlineColor: '#0a0a0a', look: 'halftone', lookMix: 0.35, cellSize: 6 },
        color: { grading: true, saturation: 1.35, contrast: 1.1 },
        light: { toneMapping: 'NEUTRAL' }
    },
    'Oil paint': {
        stylize: { kuwahara: 5 },
        color: { enhance: true, vibrance: 0.4, shadows: 0.2 },
        light: { bloom: 0.03 },
        vignette: { intensity: 0.2, color: '#20140a' }
    },
    'Sketch': {
        stylize: { outline: 1, outlineColor: '#2b2622', paper: 0.9 },
        film: { grain: 0.05 }
    },
    'Thermal': {
        stylize: { look: 'thermal' },
        film: { grain: 0.05 },
        lens: { distortion: 0.05 }
    },
    'Night vision': {
        stylize: { look: 'night vision', crt: 0.25 },
        light: { exposure: 1.2, bloom: 0.08, bloomThreshold: 0.3 },
        film: { grain: 0.2, grainSize: 1 },
        vignette: { intensity: 0.9, inner: 0.2, outer: 0.85, curvature: 1 }
    },
    'Terminal': {
        stylize: { look: 'ascii', cellSize: 9, crt: 0.5 },
        light: { exposure: 0.4 }
    },
    'Vertigo': {
        dolly: { enabled: true },
        camera: { focalLength: 35 },
        lens: { dof: 'lens', fStop: 2.8 },
        stylize: { letterbox: '1.85' }
    }
};

// Deep-merge `src` into `dst`, but only for keys `dst` already knows about.
// That keeps imported JSON from older/newer versions from injecting junk.
export function mergeInto(dst, src) {
    if (!src || typeof src !== 'object') return dst;
    for (const key of Object.keys(dst)) {
        if (!(key in src)) continue;
        const d = dst[key];
        const s = src[key];
        if (d && typeof d === 'object' && !Array.isArray(d)) {
            mergeInto(d, s);
        } else if (typeof d === typeof s) {
            dst[key] = s;
        }
    }
    return dst;
}

// How you steer is personal, not part of a look: presets leave these alone.
const controlKeys = ['mode', 'sensor', 'moveSpeed', 'lookSpeed', 'smoothing', 'rollSpeed', 'driftSpeed'];

// Builds the full settings for a preset, keeping the loaded splat, scene setup
// and control feel intact.
export function presetSettings(name, current) {
    const s = defaults();
    s.scene = structuredClone(current.scene);
    for (const key of controlKeys) s.camera[key] = current.camera[key];
    s.lens.autofocus = current.lens.autofocus;
    s.lens.focusDistance = current.lens.focusDistance;
    mergeInto(s, presets[name]);
    return s;
}
