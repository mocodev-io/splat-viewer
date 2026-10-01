// Colour lookup tables for CameraFrame. The engine wants a 256x16 sRGB strip:
// 16 slices of 16x16, blue picks the slice, red runs along x, green along y.
//
// Built-in looks are generated in code. User LUTs come from the mounted luts/
// folder: .cube files (any size) and PNG strips (N*N x N, e.g. 256x16 or 1024x32).

import * as pc from 'playcanvas';

const N = 16;

const clamp01 = v => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a + (b - a) * t;
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const smooth = t => t * t * (3 - 2 * t);

function saturate([r, g, b], s) {
    const l = luma(r, g, b);
    return [mix(l, r, s), mix(l, g, s), mix(l, b, s)];
}

function contrast([r, g, b], c) {
    return [(r - 0.5) * c + 0.5, (g - 0.5) * c + 0.5, (b - 0.5) * c + 0.5];
}

// All functions take and return sRGB-encoded colour in 0..1.
export const builtinLuts = {
    'teal & orange': (r, g, b) => {
        const l = luma(r, g, b);
        const sh = (1 - l) ** 2;
        const hi = l ** 1.5;
        let c = [r - 0.05 * sh + 0.07 * hi, g + 0.03 * sh + 0.02 * hi, b + 0.07 * sh - 0.07 * hi];
        return saturate(contrast(c, 1.08), 1.1);
    },
    'bleach bypass': (r, g, b) => {
        const l = luma(r, g, b);
        const overlay = v => (l < 0.5 ? 2 * v * l : 1 - 2 * (1 - v) * (1 - l));
        const c = [overlay(r), overlay(g), overlay(b)];
        return saturate(contrast(c, 1.15), 0.45);
    },
    'cross process': (r, g, b) => [
        smooth(clamp01(r * 1.1 - 0.03)),
        clamp01(mix(g, smooth(g), 0.6) * 1.04),
        0.18 + b * 0.62
    ],
    'faded film': (r, g, b) => {
        const c = saturate([r, g, b], 0.8).map(v => 0.07 + v * 0.86);
        return [c[0] + 0.02, c[1] + 0.01, c[2] - 0.01];
    },
    'sepia': (r, g, b) => [
        0.393 * r + 0.769 * g + 0.189 * b,
        0.349 * r + 0.686 * g + 0.168 * b,
        0.272 * r + 0.534 * g + 0.131 * b
    ],
    'warm vintage': (r, g, b) => {
        const c = contrast([r * 1.06 + 0.02, g * 1.0 + 0.01, b * 0.86 + 0.03], 1.05);
        return saturate(c, 1.12);
    },
    'cold steel': (r, g, b) => {
        const c = saturate([r, g, b], 0.6);
        return contrast([c[0] * 0.92, c[1] * 0.98, c[2] * 1.08 + 0.03], 1.1);
    },
    'neon night': (r, g, b) => {
        const l = luma(r, g, b);
        const sh = (1 - l) ** 2;
        const hi = l ** 2;
        const c = [r + 0.1 * sh - 0.05 * hi, g - 0.04 * sh + 0.06 * hi, b + 0.14 * sh + 0.08 * hi];
        return saturate(contrast(c, 1.12), 1.35);
    },
    'matrix': (r, g, b) => {
        const l = luma(r, g, b);
        return contrast([l * 0.55, mix(l, g, 0.3) * 1.1, l * 0.5], 1.15);
    },
    'golden hour': (r, g, b) => {
        const l = luma(r, g, b);
        const c = [r + 0.08 * l + 0.02, g + 0.03 * l + 0.01, b - 0.06 * l];
        return saturate(c, 1.1);
    }
};

function makeTexture(device, name, data) {
    const texture = new pc.Texture(device, {
        name,
        width: N * N,
        height: N,
        format: pc.PIXELFORMAT_SRGBA8,
        mipmaps: false,
        minFilter: pc.FILTER_LINEAR,
        magFilter: pc.FILTER_LINEAR,
        addressU: pc.ADDRESS_CLAMP_TO_EDGE,
        addressV: pc.ADDRESS_CLAMP_TO_EDGE
    });
    texture.lock().set(data);
    texture.unlock();
    return texture;
}

// sample(r, g, b) -> [r, g, b], inputs on the 0..1 grid
function bakeStrip(sample) {
    const data = new Uint8Array(N * N * N * 4);
    for (let g = 0; g < N; g++) {
        for (let b = 0; b < N; b++) {
            for (let r = 0; r < N; r++) {
                const out = sample(r / (N - 1), g / (N - 1), b / (N - 1));
                const i = (g * N * N + b * N + r) * 4;
                data[i] = Math.round(clamp01(out[0]) * 255);
                data[i + 1] = Math.round(clamp01(out[1]) * 255);
                data[i + 2] = Math.round(clamp01(out[2]) * 255);
                data[i + 3] = 255;
            }
        }
    }
    return data;
}

// Trilinear lookup into a size^3 table stored red-fastest (the .cube order).
function cubeSampler(size, table) {
    const at = (r, g, b, c) => table[((b * size + g) * size + r) * 3 + c];
    return (r, g, b) => {
        const fr = r * (size - 1), fg = g * (size - 1), fb = b * (size - 1);
        const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
        const r1 = Math.min(r0 + 1, size - 1), g1 = Math.min(g0 + 1, size - 1), b1 = Math.min(b0 + 1, size - 1);
        const tr = fr - r0, tg = fg - g0, tb = fb - b0;
        const out = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
            const c00 = mix(at(r0, g0, b0, c), at(r1, g0, b0, c), tr);
            const c10 = mix(at(r0, g1, b0, c), at(r1, g1, b0, c), tr);
            const c01 = mix(at(r0, g0, b1, c), at(r1, g0, b1, c), tr);
            const c11 = mix(at(r0, g1, b1, c), at(r1, g1, b1, c), tr);
            out[c] = mix(mix(c00, c10, tg), mix(c01, c11, tg), tb);
        }
        return out;
    };
}

function parseCube(text) {
    let size = 0;
    let min = [0, 0, 0];
    let max = [1, 1, 1];
    const values = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split(/\s+/);
        const key = parts[0].toUpperCase();
        if (key === 'LUT_3D_SIZE') size = parseInt(parts[1], 10);
        else if (key === 'DOMAIN_MIN') min = parts.slice(1, 4).map(Number);
        else if (key === 'DOMAIN_MAX') max = parts.slice(1, 4).map(Number);
        else if (/^[-+.\d]/.test(parts[0]) && parts.length >= 3) {
            values.push(+parts[0], +parts[1], +parts[2]);
        }
    }
    if (!size || values.length !== size * size * size * 3) {
        throw new Error('not a 3D .cube LUT');
    }
    const lookup = cubeSampler(size, values);
    return (r, g, b) => lookup(
        (mix(min[0], max[0], r) - min[0]) / (max[0] - min[0]),
        (mix(min[1], max[1], g) - min[1]) / (max[1] - min[1]),
        (mix(min[2], max[2], b) - min[2]) / (max[2] - min[2])
    );
}

async function parseStripImage(blob) {
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
    const size = bitmap.height;
    if (bitmap.width !== size * size) {
        throw new Error(`PNG LUT must be a strip of ${size * size}x${size}`);
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    // image row 0 is the top; in the strip convention green 0 is the bottom row
    const table = new Float32Array(size * size * size * 3);
    for (let g = 0; g < size; g++) {
        const y = size - 1 - g;
        for (let b = 0; b < size; b++) {
            for (let r = 0; r < size; r++) {
                const src = (y * size * size + b * size + r) * 4;
                const dst = ((b * size + g) * size + r) * 3;
                table[dst] = pixels[src] / 255;
                table[dst + 1] = pixels[src + 1] / 255;
                table[dst + 2] = pixels[src + 2] / 255;
            }
        }
    }
    return cubeSampler(size, table);
}

export class LutLibrary {
    constructor(device) {
        this.device = device;
        this.cache = new Map();
        this.userFiles = [];
    }

    names() {
        return ['none', ...Object.keys(builtinLuts), ...this.userFiles];
    }

    async scanFolder() {
        this.userFiles = (await listFolder('luts/'))
            .filter(e => e.type === 'file' && /\.(cube|png)$/i.test(e.name))
            .map(e => e.name);
    }

    async get(name) {
        if (!name || name === 'none') return null;
        if (this.cache.has(name)) return this.cache.get(name);
        let sample;
        if (builtinLuts[name]) {
            sample = builtinLuts[name];
        } else {
            const res = await fetch(`luts/${encodeURIComponent(name)}`);
            if (!res.ok) throw new Error(`LUT ${name}: HTTP ${res.status}`);
            sample = /\.cube$/i.test(name) ? parseCube(await res.text()) : await parseStripImage(await res.blob());
        }
        const texture = makeTexture(this.device, `lut-${name}`, bakeStrip(sample));
        this.cache.set(name, texture);
        return texture;
    }
}

// nginx `autoindex_format json` listing: [{ name, type: 'file' | 'directory' }],
// sorted by name, or [] when the folder is missing.
export async function listFolder(path) {
    try {
        const res = await fetch(path, { headers: { Accept: 'application/json' } });
        if (!res.ok) return [];
        const entries = await res.json();
        return entries
            .map(e => ({ name: e.name, type: e.type }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        return [];
    }
}
