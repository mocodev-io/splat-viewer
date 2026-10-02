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
// The over-blur on the average (useStillDof.ts) needs the scene depth, but
// each aperture sample sees the scene from another point of the lens, so its
// depth is shifted by up to the blur radius and the over-blur would shake
// from sample to sample. While the camera moves the pass therefore keeps the
// depth and coverage of every frame (`geo`, one copy); during the still they
// are put back into the scene depth after each sample, so the over-blur and
// the depth views see the unshifted view the still started from.
//
// The lens points come in symmetric groups of eight (aperture.ts), and the
// still shows whole groups only: each shown average is centred, round and of
// the right size. A new group eases in over a few frames (`display`) instead
// of switching at once, so the still refines as one calm sharpening; until
// the first group is in, the last moving frame stays on screen.
//
// The camera renders into `frame` (CameraFrame composes into it), and every
// frame is presented to the canvas from here.

import { APERTURE_GROUP } from './aperture';
import {
    ADDRESS_CLAMP_TO_EDGE, BLENDEQUATION_ADD, BLENDMODE_ONE, BlendState, FILTER_LINEAR, FILTER_NEAREST,
    FramePass, PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F, PIXELFORMAT_RGBA8, RenderTarget, SEMANTIC_POSITION, ShaderUtils, Texture,
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
// the coverage of the held view (see `geo`), which the DoF needs to correct
// the splat depth (lensDof.ts) for the over-blur.
const averageGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform sampler2D still_sum;
    uniform sampler2D still_scene;
    uniform highp sampler2D still_geo;
    uniform float still_geoValid;
    void main() {
        vec4 sum = texture2D(still_sum, uv0);
        vec4 scene = texture2D(still_scene, uv0);
        // a corner pixel can still be without samples in the first few
        vec3 c = sum.a > 1e-3 ? sum.rgb / sum.a : scene.rgb;
        gl_FragColor = vec4(c, still_geoValid > 0.5 ? texture2D(still_geo, uv0).g : scene.a);
    }
`;

// A plain copy.
const copyGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform sampler2D still_source;
    void main() {
        gl_FragColor = texture2D(still_source, uv0);
    }
`;

// The scene depth and coverage of a moving frame, kept for the still.
const captureGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform highp sampler2D still_depth;
    uniform sampler2D still_scene;
    void main() {
        gl_FragColor = vec4(texture2D(still_depth, uv0).r, texture2D(still_scene, uv0).a, 0.0, 1.0);
    }
`;

// The depth range of the image for the normalized depth view (lensDof.ts):
// nearest and farthest depth over a 32 x 32 grid, only where the coverage is
// above a half (a faint soft edge has an unreliable depth of its own), eased
// from the previous frame's range so the view does not jump as the grid
// lands on other surfaces while the camera moves. One pixel.
const rangeGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform highp sampler2D still_depth;
    uniform sampler2D still_scene;
    uniform highp sampler2D still_prev;
    uniform vec4 still_range;     // far, reciprocal depth (1) or linear (0), easing (0 takes the new range), -
    void main() {
        float far = still_range.x;
        float dMin = 1e30;
        float dMax = 0.0;
        for (int gy = 0; gy < 32; gy++) {
            for (int gx = 0; gx < 32; gx++) {
                vec2 g = (vec2(float(gx), float(gy)) + 0.5) / 32.0;
                float v = texture2DLod(still_depth, g, 0.0).r;
                float d = v;
                if (still_range.y > 0.5) {
                    float a = texture2DLod(still_scene, g, 0.0).a;
                    float s = v - (1.0 - a) / far;
                    d = a > 0.5 && s > 1e-7 ? min(a / s, far) : far;
                }
                if (d < far * 0.999) {
                    dMin = min(dMin, d);
                    dMax = max(dMax, d);
                }
            }
        }
        vec4 prev = texture2DLod(still_prev, vec2(0.5), 0.0);
        bool found = dMax > 0.0;
        bool eased = still_range.z > 0.0 && prev.b > 0.5;
        vec2 range = found ? vec2(dMin, dMax) : prev.rg;
        if (found && eased) range = mix(prev.rg, range, still_range.z);
        gl_FragColor = vec4(range, found || eased ? 1.0 : 0.0, 1.0);
    }
`;

// ... and put back into the scene depth for every aperture sample.
const restoreGLSL = /* glsl */ `
    varying vec2 uv0;
    uniform highp sampler2D still_geo;
    void main() {
        gl_FragColor = vec4(texture2D(still_geo, uv0).r, 0.0, 0.0, 1.0);
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

// How much of the way to a new group's image the screen goes each frame,
// and after how many frames since the last group it counts as settled.
const EASE = 0.35;
const SETTLE_FRAMES = 10;

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
    sceneDepthTexture: Texture | null;
    scenePass: FramePass | null;
    scenePassTransparent: FramePass | null;
    composePass: { sceneTexture: Texture } | null;
    scenePassHalf: { setSourceTexture(t: Texture): void } | null;
    dofPass: { setSceneTexture(t: Texture): void } | null;
};
const HOOKED = Symbol('stillFrames');

// Runs right after the scene pass: keeps the depth of a moving frame, or for
// a still puts it back, adds the sample and writes the average.
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
    private display: [RenderTarget, RenderTarget];   // what is on screen during the still, and the next
    private sum: RenderTarget;             // weighted sum of aperture samples, linear HDR
    private groups: RenderTarget;          // the sum as it was after the last whole group of samples
    private lastShown = 0;                 // samples in the group being eased in
    private sinceGroup = 0;                // frames since that group came in
    private avg: RenderTarget;             // their average, read by the passes after the scene pass
    private geo: RenderTarget;             // depth and coverage of the last moving frame
    private geoValid = false;
    private ranges: [RenderTarget, RenderTarget];   // depth range, this frame's and the previous (1 x 1)
    private rangeFrames = 0;               // frames the range has been followed
    private rangeOptions: { far: number; reciprocal: boolean } | null = null;
    private depthTarget: RenderTarget | null = null;   // writes into the scene depth texture
    private pass: AccumulatePass;
    private accumulateShader: Shader;
    private averageShader: Shader;
    private copyShader: Shader;
    private rangeShader: Shader;
    private captureShader: Shader;
    private restoreShader: Shader;
    private presentShader: Shader;
    private device: GraphicsDevice;
    private scene: Texture | null = null;  // the scene texture of this frame
    private depth: Texture | null = null;  // the scene depth texture of this frame
    private sample: [number, number, number] | null = null;
    private active = false;
    private capture = false;
    /** samples in `sum` */
    count = 0;

    /** The depth range for the normalized depth view, and whether it holds one yet. */
    get range() {
        // after a frame the newest range is the second of the pair
        return { texture: this.ranges[1].colorBuffer, ready: this.rangeFrames > 0 };
    }

    /** Samples the still shows: whole groups. */
    get shown() {
        return this.count - this.count % APERTURE_GROUP;
    }

    /** Whether the screen has caught up with the last group. */
    get settled() {
        return this.shown > 0 && this.sinceGroup >= SETTLE_FRAMES;
    }

    constructor(app: AppBase) {
        const device = this.device = app.graphicsDevice;
        this.frame = target(device, 'StillFrame', PIXELFORMAT_RGBA8, true);
        this.display = [target(device, 'StillDisplayA', PIXELFORMAT_RGBA8, false), target(device, 'StillDisplayB', PIXELFORMAT_RGBA8, false)];
        this.sum = target(device, 'StillSum', PIXELFORMAT_RGBA16F, false);
        this.groups = target(device, 'StillGroups', PIXELFORMAT_RGBA16F, false);
        this.avg = target(device, 'StillAverage', PIXELFORMAT_RGBA16F, false, FILTER_LINEAR);
        this.geo = target(device, 'StillGeometry', PIXELFORMAT_RGBA32F, false);
        this.pass = new AccumulatePass(device, this);
        this.accumulateShader = quadShader(device, 'StillAccumulate', accumulateGLSL);
        this.averageShader = quadShader(device, 'StillAverage', averageGLSL);
        this.copyShader = quadShader(device, 'StillCopy', copyGLSL);
        this.rangeShader = quadShader(device, 'StillRange', rangeGLSL);
        const range = (name: string) => {
            const colorBuffer = new Texture(device, {
                name, width: 1, height: 1, format: PIXELFORMAT_RGBA32F, mipmaps: false,
                minFilter: FILTER_NEAREST, magFilter: FILTER_NEAREST,
                addressU: ADDRESS_CLAMP_TO_EDGE, addressV: ADDRESS_CLAMP_TO_EDGE
            });
            return new RenderTarget({ name, colorBuffer, depth: false });
        };
        this.ranges = [range('StillRangeA'), range('StillRangeB')];
        this.captureShader = quadShader(device, 'StillCapture', captureGLSL);
        this.restoreShader = quadShader(device, 'StillRestore', restoreGLSL);
        this.presentShader = quadShader(device, 'StillPresent', presentGLSL);
    }

    /** Follows the canvas size; returns true when it changed (the still starts over). */
    resize() {
        const { width, height } = this.device;
        if (this.frame.width === width && this.frame.height === height) return false;
        for (const rt of [this.frame, ...this.display]) rt.resize(width, height);
        this.count = 0;
        return true;
    }

    /** Keeps the frame now in `frame` (the last moving one) on screen, and empties the sum. */
    start() {
        this.mix(this.display[0], this.frame, this.frame, 0);
        this.count = 0;
        this.lastShown = 0;
        this.sinceGroup = 0;
    }

    /**
     * Sets up this frame, before it renders: whether the passes after the
     * scene pass read the average (`active`), the aperture sample to add, if
     * any: lens point (x, y) in units of the f-stop radius, `catsEye` 0–1,
     * for a moving frame whether to keep its depth for a coming still, and
     * whether to follow the depth range for the normalized depth view.
     */
    prepare(cameraFrame: { renderPassCamera: unknown } | undefined, active: boolean, sample: [number, number, number] | null,
        capture: boolean, range: { far: number; reciprocal: boolean } | null) {
        this.active = active;
        this.sample = active ? sample : null;
        this.capture = !active && capture;
        if (!range) this.rangeFrames = 0;
        this.rangeOptions = range;
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
            this.depth = rpc.sceneDepthTexture;
            this.pass.enabled = (this.active || this.capture || !!this.rangeOptions) && !!this.scene;
            if (!this.pass.enabled || !this.active) return;
            const avg = this.avg.colorBuffer;
            rpc.composePass!.sceneTexture = avg;
            rpc.scenePassHalf?.setSourceTexture(avg);
            rpc.dofPass?.setSceneTexture(avg);
        };
    }

    /** Our pass, inside the frame: keeps or puts back the depth, adds this frame's sample, writes the average. */
    runPass() {
        const scene = this.scene;
        if (!scene) return;
        if (this.sum.width !== scene.width || this.sum.height !== scene.height) {
            for (const rt of [this.sum, this.groups, this.avg, this.geo]) rt.resize(scene.width, scene.height);
            this.count = 0;
            this.geoValid = false;
        }
        const scope = this.device.scope;
        const depth = this.depth;
        this.device.setBlendState(BlendState.NOBLEND);

        // the depth range for the normalized depth view
        const range = this.rangeOptions;
        if (range && depth) {
            const [next, prev] = this.ranges;
            scope.resolve('still_depth').setValue(depth);
            scope.resolve('still_scene').setValue(scene);
            scope.resolve('still_prev').setValue(prev.colorBuffer);
            scope.resolve('still_range').setValue([range.far, range.reciprocal ? 1 : 0, this.rangeFrames > 0 ? 0.15 : 0, 0]);
            drawQuadWithShader(this.device, next, this.rangeShader);
            this.ranges = [prev, next];
            this.rangeFrames++;
        }

        // moving: keep this frame's depth and coverage
        if (!this.active) {
            if (!depth || !this.capture) return;
            scope.resolve('still_depth').setValue(depth);
            scope.resolve('still_scene').setValue(scene);
            drawQuadWithShader(this.device, this.geo, this.captureShader);
            this.geoValid = true;
            return;
        }

        // still: the unshifted depth back into the scene depth
        const restore = this.geoValid && !!depth;
        if (restore) {
            if (this.depthTarget?.colorBuffer !== depth) {
                this.depthTarget?.destroy();
                this.depthTarget = new RenderTarget({ name: 'StillDepthRestore', colorBuffer: depth!, depth: false });
            }
            scope.resolve('still_geo').setValue(this.geo.colorBuffer);
            drawQuadWithShader(this.device, this.depthTarget, this.restoreShader);
        }

        if (this.sample) {
            const [x, y, catsEye] = this.sample;
            scope.resolve('still_scene').setValue(scene);
            scope.resolve('still_lens').setValue([x, y, catsEye * CATS_EYE_SHIFT, scene.width / Math.max(scene.height, 1)]);
            this.device.setBlendState(this.count === 0 ? BlendState.NOBLEND : ADD);
            drawQuadWithShader(this.device, this.sum, this.accumulateShader);
            this.count++;
            this.sample = null;
            // the still shows whole groups only
            if (this.count % APERTURE_GROUP === 0) {
                scope.resolve('still_source').setValue(this.sum.colorBuffer);
                this.device.setBlendState(BlendState.NOBLEND);
                drawQuadWithShader(this.device, this.groups, this.copyShader);
            }
        }
        scope.resolve('still_sum').setValue(this.groups.colorBuffer);
        scope.resolve('still_scene').setValue(scene);
        scope.resolve('still_geo').setValue(this.geo.colorBuffer);
        scope.resolve('still_geoValid').setValue(restore ? 1 : 0);
        this.device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(this.device, this.avg, this.averageShader);
    }

    /**
     * To the canvas: the frame as composed, or for a still building up, the
     * screen eased a step towards the newest whole group (the last moving
     * frame until the first group is in).
     */
    present(still: boolean) {
        if (!still) {
            this.mix(null, this.frame, this.frame, 1);
            return;
        }
        if (this.shown > 0) {
            if (this.shown !== this.lastShown) {
                this.lastShown = this.shown;
                this.sinceGroup = 0;
            }
            const [current, next] = this.display;
            this.mix(next, current, this.frame, EASE);
            this.display = [next, current];
            this.sinceGroup++;
        }
        this.mix(null, this.display[0], this.display[0], 0);
    }

    private mix(dest: RenderTarget | null, base: RenderTarget, frame: RenderTarget, weight: number) {
        const scope = this.device.scope;
        scope.resolve('still_base').setValue(base.colorBuffer);
        scope.resolve('still_frame').setValue(frame.colorBuffer);
        scope.resolve('still_weight').setValue(weight);
        this.device.setBlendState(BlendState.NOBLEND);
        drawQuadWithShader(this.device, dest, this.presentShader);
    }

    destroy() {
        this.active = false;
        this.pass.enabled = false;
        for (const rt of [this.frame, ...this.display, this.sum, this.groups, this.avg, this.geo, ...this.ranges]) {
            rt.destroyTextureBuffers();
            rt.destroy();
        }
        this.depthTarget?.destroy();
    }
}
