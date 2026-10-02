// Accumulated depth of field for a still camera.
//
// A real lens is a collection of pinhole cameras spread over its aperture,
// all aimed so that the focus plane lines up. Rendering the scene from many
// points on the aperture and averaging the images gives exact depth of field
// (Haeberli & Akeley, "The Accumulation Buffer", SIGGRAPH 1990): occlusion,
// semi-transparent blurred edges, bokeh and soft splat edges all come out
// right by themselves, with no depth heuristics. The bokeh takes the shape of
// the aperture the points are spread over (aperture.ts).
//
// It costs one render per aperture sample, so it runs only while nothing
// changes: every frame adds one sample until the quality's count is reached,
// then the viewer stops rendering until something changes again. While the
// camera moves, the quick gather DoF (lensDof.ts) stands in.
//
// Cat's eye: off the optical axis, the lens barrel cuts part of the aperture
// away (mechanical vignetting), so a pixel towards the corner sees light only
// through the overlap of the aperture and a second disc shifted towards the
// centre. Its bokeh becomes a tangential oval, the "swirl" of lenses like the
// Helios 44. Each sample is a whole frame seen through one point of the lens,
// so this is exact per pixel: a sample counts for a pixel only where its lens
// point lies inside that pixel's disc. The sum keeps the weight in alpha and
// is divided by it; the brightness stays even (darker corners are the
// vignette effect's job).
//
// The camera renders into `frame` (CameraFrame composes into it), and every
// frame is presented to the canvas from here: the plain frame, or the
// accumulated still, faded in over the first samples from the last moving
// frame (`hold`) so the switch does not flash a sharp image.

import {
    ADDRESS_CLAMP_TO_EDGE, BLENDEQUATION_ADD, BLENDMODE_ONE, BlendState, FILTER_NEAREST,
    PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA8, RenderTarget, SEMANTIC_POSITION, ShaderUtils, Texture,
    drawQuadWithShader, type AppBase, type GraphicsDevice, type Shader
} from 'playcanvas';

// Frames come out of the compose pass gamma encoded; they are summed in linear
// light, weighted, and encoded again for the screen.
const accumulateGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform sampler2D still_frame;
    uniform vec4 still_lens;      // lens point (units of the f-stop radius), cat's eye shift at the corner, aspect
    void main() {
        float w = 1.0;
        if (still_lens.z > 0.0) {
            // pixel position, 1 at the image corner
            vec2 p = (uv0 * 2.0 - 1.0) * vec2(still_lens.w, 1.0) / length(vec2(still_lens.w, 1.0));
            float d = length(still_lens.xy + p * still_lens.z);
            // a soft edge, so neighbouring pixels do not switch samples in visible steps
            w = 1.0 - smoothstep(0.92, 1.08, d);
        }
        gl_FragColor = vec4(pow(texture2D(still_frame, uv0).rgb, vec3(2.2)) * w, w);
    }
`;

const presentGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform sampler2D still_base;      // gamma encoded: the frame, or the held moving frame
    uniform sampler2D still_sum;       // weighted linear sum of the accumulated samples, weight in alpha
    uniform float still_weight;        // weight of the accumulated image
    void main() {
        vec3 base = texture2D(still_base, uv0).rgb;
        vec4 sum = texture2D(still_sum, uv0);
        vec3 still = pow(sum.rgb / max(sum.a, 1e-4), vec3(1.0 / 2.2));
        // a corner pixel can still be without samples in the first few
        gl_FragColor = vec4(mix(base, still, still_weight * step(1e-3, sum.a)), 1.0);
    }
`;

const ADD = new BlendState(true, BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE);

// cat's eye at full strength: the barrel disc is shifted by this many
// aperture radii at the image corner (the overlap there is about 40 %)
const CATS_EYE_SHIFT = 1;

function target(device: GraphicsDevice, name: string, format: number, depth: boolean) {
    const colorBuffer = new Texture(device, {
        name, width: device.width, height: device.height, format, mipmaps: false,
        minFilter: FILTER_NEAREST, magFilter: FILTER_NEAREST,
        addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE
    });
    return new RenderTarget({ name, colorBuffer, depth });
}

function quadShader(device: GraphicsDevice, name: string, fragmentGLSL: string): Shader {
    return ShaderUtils.createShader(device, {
        uniqueName: name,
        attributes: { aPosition: SEMANTIC_POSITION },
        vertexChunk: 'quadVS',
        fragmentGLSL
    });
}

export class StillFrames {
    readonly frame: RenderTarget;          // the camera renders here
    private sum: RenderTarget;             // weighted linear sum of aperture samples
    private hold: RenderTarget;            // the last moving frame
    private accumulateShader: Shader;
    private presentShader: Shader;
    private device: GraphicsDevice;
    /** samples in `sum` */
    count = 0;

    constructor(app: AppBase) {
        const device = this.device = app.graphicsDevice;
        this.frame = target(device, 'StillFrame', PIXELFORMAT_RGBA8, true);
        this.sum = target(device, 'StillSum', PIXELFORMAT_RGBA16F, false);
        this.hold = target(device, 'StillHold', PIXELFORMAT_RGBA8, false);
        this.accumulateShader = quadShader(device, 'StillAccumulate', accumulateGLSL);
        this.presentShader = quadShader(device, 'StillPresent', presentGLSL);
    }

    /** Follows the canvas size; returns true when it changed (the still starts over). */
    resize() {
        const { width, height } = this.device;
        if (this.frame.width === width && this.frame.height === height) return false;
        for (const rt of [this.frame, this.sum, this.hold]) rt.resize(width, height);
        this.count = 0;
        return true;
    }

    /** Keeps the frame now in `frame` (the last moving one) to fade from, and empties the sum. */
    start() {
        this.draw(this.hold, this.frame, 0, BlendState.NOBLEND);
        this.count = 0;
    }

    /**
     * Adds the frame just rendered as one aperture sample, seen through lens
     * point (x, y) in units of the f-stop radius; `catsEye` 0–1.
     */
    accumulate(x: number, y: number, catsEye: number) {
        const scope = this.device.scope;
        scope.resolve('still_frame').setValue(this.frame.colorBuffer);
        scope.resolve('still_lens').setValue([x, y, catsEye * CATS_EYE_SHIFT, this.frame.width / Math.max(this.frame.height, 1)]);
        this.device.setBlendState(this.count === 0 ? BlendState.NOBLEND : ADD);
        drawQuadWithShader(this.device, this.sum, this.accumulateShader);
        this.count++;
    }

    /** To the canvas: the frame as rendered, or the still faded in by `weight` over the held frame. */
    present(still: boolean, weight: number) {
        if (still && this.count > 0) this.draw(null, this.hold, weight, BlendState.NOBLEND);
        else this.draw(null, this.frame, 0, BlendState.NOBLEND);
    }

    private draw(dest: RenderTarget | null, base: RenderTarget, weight: number, blend: BlendState) {
        const scope = this.device.scope;
        scope.resolve('still_base').setValue(base.colorBuffer);
        scope.resolve('still_sum').setValue(this.sum.colorBuffer);
        scope.resolve('still_weight').setValue(weight);
        this.device.setBlendState(blend);
        drawQuadWithShader(this.device, dest, this.presentShader);
    }

    destroy() {
        for (const rt of [this.frame, this.sum, this.hold]) {
            rt.destroyTextureBuffers();
            rt.destroy();
        }
    }
}
