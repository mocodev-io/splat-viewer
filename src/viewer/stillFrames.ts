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
// The samples are averaged in linear HDR, as a camera sensor collects light,
// before tone mapping and the other effects: a pass of our own runs inside
// CameraFrame right after the scene pass, adds the scene texture to `sum`
// and writes the average to `avg`; the bloom downsample, the engine's DoF
// passes and the compose pass then read `avg` instead of the scene texture.
// So a bright highlight spread over a bokeh disc stays bright, and tone
// mapping, grading, vignette, sharpening and bloom all work on the averaged
// image, in their own order. CameraFrame rebuilds its passes when its
// options change, so the hook is checked every frame.
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
// frame is presented to the canvas from here: the frame as composed, faded in
// over the first samples from the last moving frame (`hold`) so the switch
// to the still does not flash a sharp image.

import {
    ADDRESS_CLAMP_TO_EDGE, BLENDEQUATION_ADD, BLENDMODE_ONE, BlendState, FILTER_LINEAR, FILTER_NEAREST,
    FramePass, PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA8, RenderTarget, SEMANTIC_POSITION, ShaderUtils, Texture,
    drawQuadWithShader, type AppBase, type GraphicsDevice, type Shader
} from 'playcanvas';

// One aperture sample from the scene texture (linear HDR), weighted by the
// cat's eye mask, into the sum.
const accumulateGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform sampler2D still_scene;
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
        gl_FragColor = vec4(texture2D(still_scene, uv0).rgb * w, w);
    }
`;

// The weighted average, for the passes after the scene pass. Its alpha is
// the coverage of the current sample, which the DoF needs to correct the
// splat depth (lensDof.ts) for the over-blur.
const averageGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform sampler2D still_sum;
    uniform sampler2D still_scene;
    void main() {
        vec4 sum = texture2D(still_sum, uv0);
        vec4 scene = texture2D(still_scene, uv0);
        // a corner pixel can still be without samples in the first few
        vec3 c = sum.a > 1e-3 ? sum.rgb / sum.a : scene.rgb;
        gl_FragColor = vec4(c, scene.a);
    }
`;

// To the canvas: the composed frame, faded in over the held one.
const presentGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform sampler2D still_base;      // the held moving frame
    uniform sampler2D still_frame;     // the frame as composed
    uniform float still_weight;
    void main() {
        gl_FragColor = vec4(mix(texture2D(still_base, uv0).rgb, texture2D(still_frame, uv0).rgb, still_weight), 1.0);
    }
`;

const ADD = new BlendState(true, BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE);

// cat's eye at full strength: the barrel disc is shifted by this many
// aperture radii at the image corner (the overlap there is about 40 %)
const CATS_EYE_SHIFT = 1;

function target(device: GraphicsDevice, name: string, format: number, depth: boolean, filter: number = FILTER_NEAREST) {
    const colorBuffer = new Texture(device, {
        name, width: device.width, height: device.height, format, mipmaps: false,
        minFilter: filter, magFilter: filter,
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

// What we use of the engine's FramePassCameraFrame (not in its public types).
type CameraFramePass = FramePass & {
    rt: RenderTarget | null;
    scenePass: FramePass | null;
    scenePassTransparent: FramePass | null;
    composePass: { sceneTexture: Texture } | null;
    scenePassHalf: { setSourceTexture(t: Texture): void } | null;
    dofPass: { setSceneTexture(t: Texture): void } | null;
};
const HOOKED = Symbol('stillFrames');

// Runs right after the scene pass: adds the sample, writes the average.
class AccumulatePass extends FramePass {
    constructor(device: GraphicsDevice, private still: StillFrames) {
        super(device);
        this.name = 'StillAccumulate';
    }

    execute() {
        this.still.runPass();
    }
}

export class StillFrames {
    readonly frame: RenderTarget;          // the camera composes here
    private hold: RenderTarget;            // the last moving frame
    private sum: RenderTarget;             // weighted sum of aperture samples, linear HDR
    private avg: RenderTarget;             // their average, read by the passes after the scene pass
    private pass: AccumulatePass;
    private accumulateShader: Shader;
    private averageShader: Shader;
    private presentShader: Shader;
    private device: GraphicsDevice;
    private scene: Texture | null = null;  // the scene texture of this frame
    private sample: [number, number, number] | null = null;
    private active = false;
    /** samples in `sum` */
    count = 0;

    constructor(app: AppBase) {
        const device = this.device = app.graphicsDevice;
        this.frame = target(device, 'StillFrame', PIXELFORMAT_RGBA8, true);
        this.hold = target(device, 'StillHold', PIXELFORMAT_RGBA8, false);
        this.sum = target(device, 'StillSum', PIXELFORMAT_RGBA16F, false);
        this.avg = target(device, 'StillAverage', PIXELFORMAT_RGBA16F, false, FILTER_LINEAR);
        this.pass = new AccumulatePass(device, this);
        this.accumulateShader = quadShader(device, 'StillAccumulate', accumulateGLSL);
        this.averageShader = quadShader(device, 'StillAverage', averageGLSL);
        this.presentShader = quadShader(device, 'StillPresent', presentGLSL);
    }

    /** Follows the canvas size; returns true when it changed (the still starts over). */
    resize() {
        const { width, height } = this.device;
        if (this.frame.width === width && this.frame.height === height) return false;
        for (const rt of [this.frame, this.hold]) rt.resize(width, height);
        this.count = 0;
        return true;
    }

    /** Keeps the frame now in `frame` (the last moving one) to fade from, and empties the sum. */
    start() {
        const scope = this.device.scope;
        scope.resolve('still_base').setValue(this.frame.colorBuffer);
        scope.resolve('still_frame').setValue(this.frame.colorBuffer);
        scope.resolve('still_weight').setValue(0);
        this.device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(this.device, this.hold, this.presentShader);
        this.count = 0;
    }

    /**
     * Sets up this frame, before it renders: whether the passes after the
     * scene pass read the average (`active`), and the aperture sample to add,
     * if any: lens point (x, y) in units of the f-stop radius, `catsEye` 0–1.
     */
    prepare(cameraFrame: { renderPassCamera: unknown } | undefined, active: boolean, sample: [number, number, number] | null) {
        this.active = active;
        this.sample = active ? sample : null;
        const rpc = cameraFrame?.renderPassCamera as CameraFramePass | null | undefined;
        if (rpc) this.hook(rpc);
    }

    // Wraps the camera frame pass's frameUpdate, which runs before its passes
    // are collected each frame: keeps our pass right after the scene pass
    // and, for a still, points the passes that read the scene at `avg`.
    private hook(rpc: CameraFramePass) {
        const tagged = rpc as CameraFramePass & { [HOOKED]?: StillFrames };
        if (tagged[HOOKED] === this) return;
        tagged[HOOKED] = this;
        const original = rpc.frameUpdate.bind(rpc);
        rpc.frameUpdate = () => {
            original();
            if (tagged[HOOKED] !== this) return;
            const passes = rpc.beforePasses;
            const at = passes.indexOf(this.pass);
            const after = passes.indexOf(rpc.scenePassTransparent ?? rpc.scenePass!);
            if (at !== after + 1) {
                if (at >= 0) passes.splice(at, 1);
                passes.splice(passes.indexOf(rpc.scenePassTransparent ?? rpc.scenePass!) + 1, 0, this.pass);
            }
            this.scene = rpc.rt?.colorBuffer ?? null;
            this.pass.enabled = this.active && !!this.scene;
            if (!this.pass.enabled) return;
            const avg = this.avg.colorBuffer;
            rpc.composePass!.sceneTexture = avg;
            rpc.scenePassHalf?.setSourceTexture(avg);
            rpc.dofPass?.setSceneTexture(avg);
        };
    }

    /** Our pass, inside the frame: adds this frame's sample, writes the average. */
    runPass() {
        const scene = this.scene;
        if (!scene) return;
        if (this.sum.width !== scene.width || this.sum.height !== scene.height) {
            this.sum.resize(scene.width, scene.height);
            this.avg.resize(scene.width, scene.height);
            this.count = 0;
        }
        const scope = this.device.scope;
        if (this.sample) {
            const [x, y, catsEye] = this.sample;
            scope.resolve('still_scene').setValue(scene);
            scope.resolve('still_lens').setValue([x, y, catsEye * CATS_EYE_SHIFT, scene.width / Math.max(scene.height, 1)]);
            this.device.setBlendState(this.count === 0 ? BlendState.NOBLEND : ADD);
            drawQuadWithShader(this.device, this.sum, this.accumulateShader);
            this.count++;
            this.sample = null;
        }
        scope.resolve('still_sum').setValue(this.sum.colorBuffer);
        scope.resolve('still_scene').setValue(scene);
        this.device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(this.device, this.avg, this.averageShader);
    }

    /** To the canvas: the frame as composed, faded in by `weight` over the held frame when `fade`. */
    present(fade: boolean, weight: number) {
        const scope = this.device.scope;
        scope.resolve('still_base').setValue((fade ? this.hold : this.frame).colorBuffer);
        scope.resolve('still_frame').setValue(this.frame.colorBuffer);
        scope.resolve('still_weight').setValue(fade ? weight : 1);
        this.device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(this.device, null, this.presentShader);
    }

    destroy() {
        this.active = false;
        this.pass.enabled = false;
        for (const rt of [this.frame, this.hold, this.sum, this.avg]) {
            rt.destroyTextureBuffers();
            rt.destroy();
        }
    }
}
