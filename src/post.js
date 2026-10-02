// Maps the settings object onto the engine's CameraFrame and the extra
// uniforms of the custom compose shader. Called once per frame.

import * as pc from 'playcanvas';
import { composePS } from './compose.js';

const toneMappings = {
    LINEAR: pc.TONEMAP_LINEAR,
    FILMIC: pc.TONEMAP_FILMIC,
    HEJL: pc.TONEMAP_HEJL,
    ACES: pc.TONEMAP_ACES,
    ACES2: pc.TONEMAP_ACES2,
    NEUTRAL: pc.TONEMAP_NEUTRAL
};

export const looks = ['none', 'duotone', 'thermal', 'night vision', 'halftone', 'ascii'];
export const bokehShapes = ['round', 'hexagon', 'octagon', 'anamorphic', 'swirl'];
export const letterboxes = ['off', '1', '1.33', '1.85', '2', '2.39', '2.76'];

// The engine only renders the splats' depth texture when one of its own
// effects (TAA, its DoF, fog, SSAO) asks for it. Our DoF lives in the compose
// shader, so this adds one more reason: `options.composeDepth`. It only ever
// asks for the cheap path (depth written by the scene pass itself); if the
// device cannot do that, there is no depth rather than an extra depth prepass
// that would render every splat twice.
const sanitizeOptions = pc.FramePassCameraFrame.prototype.sanitizeOptions;
pc.FramePassCameraFrame.prototype.sanitizeOptions = function (options) {
    const out = sanitizeOptions.call(this, options);
    if (options.composeDepth && !out.sceneTextureDepth && !out.prepassEnabled &&
        pc.FramePassCameraFrame.isSceneTextureDepthSupported(this.device) &&
        !this.sceneTexturesUnsupportedReason(out)) {
        out.sceneTextureDepth = true;
    }
    return out;
};

// sRGB hex -> linear rgb, cached (these are read every frame)
const linearCache = new Map();
function linear(hex) {
    let v = linearCache.get(hex);
    if (!v) {
        const c = new pc.Color().fromString(hex);
        v = [c.r ** 2.2, c.g ** 2.2, c.b ** 2.2];
        linearCache.set(hex, v);
    }
    return v;
}
function linearColor(hex, out) {
    const [r, g, b] = linear(hex);
    return out.set(r, g, b, 1);
}

export class Post {
    constructor(app, cameraEntity, sunEntity, settings, luts, events) {
        this.app = app;
        this.camera = cameraEntity.camera;
        this.settings = settings;
        this.sun = sunEntity;
        this.luts = luts;
        this.events = events;
        this.lutName = null;
        this.time = 0;
        this.warnedNoDepth = false;

        // the custom compose shader must be registered before CameraFrame builds it
        pc.ShaderChunks.get(app.graphicsDevice, pc.SHADERLANGUAGE_GLSL).set('composePS', composePS);

        // splats write their depth so DoF, fog, SSAO and TAA see them
        app.scene.gsplat.sceneDepthWrite = true;

        const frame = new pc.CameraFrame(app, cameraEntity.camera);
        frame.rendering.samples = 1;        // MSAA makes splats several times more expensive
        frame.rendering.renderTargetScale = 1;   // resolution is handled for the whole canvas (perf.js)
        frame.dof.enabled = false;          // replaced by the thin-lens DoF in compose.js
        frame.fringing.intensity = 0;       // replaced by our own chromatic aberration
        this.frame = frame;

        const scope = app.graphicsDevice.scope;
        this.u = {};
        for (const name of [
            'time', 'res', 'exposure', 'flicker', 'distortion', 'crt', 'gateWeave', 'glitch', 'pixelate', 'fringing',
            'motionBlur', 'motionBlurSamples', 'reproject', 'reprojectFull', 'tanHalf', 'camMotion', 'kuwahara', 'halation', 'anamorphic',
            'anamorphicTint', 'dirt', 'lightLeak', 'posterize', 'look', 'lookMix', 'cell', 'duoDark', 'duoLight',
            'paper', 'outline', 'outlineColor', 'grain', 'grainSize', 'grainAnimated', 'letterbox',
            'depthMode', 'far', 'focus', 'aperture', 'dofMaxRadius', 'bokeh', 'dofSeed', 'dofSamples', 'dofProbes'
        ]) {
            this.u[name] = scope.resolve(`sv_${name}`);
        }
    }

    async updateLut() {
        const name = this.settings.color.lut;
        if (name === this.lutName) return;
        this.lutName = name;
        try {
            this.frame.colorLUT.texture = await this.luts.get(name);
        } catch (err) {
            console.warn(err);
            this.frame.colorLUT.texture = null;
        }
    }

    update(dt, rig, level) {
        const s = this.settings;
        const f = this.frame;
        const app = this.app;
        this.time += dt;

        this.updateLut();

        // ---- rendering
        f.rendering.toneMapping = toneMappings[s.light.toneMapping] ?? pc.TONEMAP_ACES2;
        f.rendering.sharpness = s.film.sharpen;
        // the compose shader reads the splat depth for DoF and exact motion blur
        f.options.composeDepth = s.lens.dof || s.stylize.motionBlur > 0;
        app.scene.gsplat.fisheye = s.camera.fisheye;

        // ---- light
        const bloomNeeded = s.light.bloom > 0 || s.light.halation > 0 || s.lens.anamorphic > 0 || s.lens.dirt > 0;
        f.bloom.intensity = bloomNeeded ? Math.max(s.light.bloom, 1e-4) : 0;
        f.bloom.threshold = s.light.bloomThreshold;
        f.bloom.blurLevel = s.light.bloomBlur;

        // ---- fog + sun
        const fog = s.fog;
        f.volumetricFog.enabled = fog.enabled;
        f.volumetricFog.light = this.sun.light;   // the LightComponent, not the entity
        f.volumetricFog.density = fog.density;
        f.volumetricFog.heightBase = fog.heightBase;
        f.volumetricFog.heightFalloff = fog.heightFalloff;
        f.volumetricFog.anisotropy = fog.anisotropy;
        f.volumetricFog.intensity = fog.intensity;
        linearColor(fog.tint, f.volumetricFog.tint);
        f.volumetricFog.ambientIntensity = fog.ambient;
        f.volumetricFog.steps = level.fogSteps;
        f.volumetricFog.scale = level.fogScale;
        this.sun.setEulerAngles(fog.sunPitch, fog.sunYaw, 0);
        linearColor(fog.sunColor, this.sun.light.color);
        this.sun.light.intensity = fog.sunIntensity;
        this.sun.light.castShadows = fog.enabled && fog.shafts;
        this.sun.enabled = fog.enabled;

        // ---- ssao
        f.ssao.type = s.ssao.enabled ? pc.SSAOTYPE_COMBINE : pc.SSAOTYPE_NONE;
        f.ssao.intensity = s.ssao.intensity;
        f.ssao.radius = s.ssao.radius;
        f.ssao.samples = level.ssaoSamples;
        f.ssao.scale = level.ssaoScale;

        // ---- colour
        const c = s.color;
        f.grading.enabled = c.grading;
        f.grading.brightness = c.brightness;
        f.grading.contrast = c.contrast;
        f.grading.saturation = c.saturation;
        linearColor(c.tint, f.grading.tint);
        f.colorEnhance.enabled = c.enhance;
        f.colorEnhance.shadows = c.shadows;
        f.colorEnhance.midtones = c.midtones;
        f.colorEnhance.highlights = c.highlights;
        f.colorEnhance.vibrance = c.vibrance;
        f.colorEnhance.dehaze = c.dehaze;
        f.colorLUT.intensity = c.lutIntensity;

        const v = s.vignette;
        f.vignette.intensity = v.intensity;
        f.vignette.inner = v.inner;
        f.vignette.outer = v.outer;
        f.vignette.curvature = v.curvature;
        linearColor(v.color, f.vignette.color);

        f.taa.enabled = s.film.taa;

        f.update();

        // ---- compose shader uniforms
        const u = this.u;
        const st = s.stylize;
        const device = app.graphicsDevice;
        const cssToPx = device.width / Math.max(device.clientRect.width, 1);
        u.time.setValue(this.time);
        u.res.setValue([device.width, device.height]);
        u.exposure.setValue(s.light.exposure);
        u.flicker.setValue(s.film.flicker);
        u.distortion.setValue(s.lens.distortion);
        u.fringing.setValue(s.lens.fringing / 2048);
        u.crt.setValue(st.crt);
        u.gateWeave.setValue(s.film.gateWeave);
        u.glitch.setValue(st.glitch);
        u.pixelate.setValue(st.pixelate >= 2 ? st.pixelate * cssToPx : 0);
        u.motionBlur.setValue(st.motionBlur * rig.blurScale);
        u.motionBlurSamples.setValue(level.motionBlurSamples);
        u.reproject.setValue(rig.reproject.data);
        u.reprojectFull.setValue(rig.reprojectFull.data);
        u.tanHalf.setValue(rig.tanHalf);
        u.camMotion.setValue(rig.camMotion);
        u.kuwahara.setValue(st.kuwahara);
        u.halation.setValue(s.light.halation);
        u.anamorphic.setValue(s.lens.anamorphic);
        u.anamorphicTint.setValue(linear(s.lens.anamorphicTint));
        u.dirt.setValue(s.lens.dirt);
        u.lightLeak.setValue(s.light.lightLeak);
        u.posterize.setValue(st.posterize >= 2 ? st.posterize : 0);
        u.look.setValue(Math.max(0, looks.indexOf(st.look)));
        u.lookMix.setValue(st.lookMix);
        u.cell.setValue(Math.max(3, st.cellSize * cssToPx));
        u.duoDark.setValue(linear(st.duoDark));
        u.duoLight.setValue(linear(st.duoLight));
        u.paper.setValue(st.paper);
        u.outline.setValue(st.outline);
        u.outlineColor.setValue(linear(st.outlineColor));
        u.grain.setValue(s.film.grain);
        u.grainSize.setValue(Math.max(1, s.film.grainSize));
        u.grainAnimated.setValue(s.film.grainAnimated ? 1 : 0);
        u.letterbox.setValue(st.letterbox === 'off' ? 0 : parseFloat(st.letterbox));

        this.updateDof(rig, level);
    }

    // Thin lens. A point at infinity blurs into a circle of f² / (N · (S − f))
    // on the sensor (f focal length, N f-stop, S focus distance, all in mm);
    // a point at depth D gets that times |1 − S/D| (compose.js). The sensor
    // width maps to the image width, so the shader gets the infinity blur as
    // a radius in pixels.
    updateDof(rig, level) {
        const s = this.settings;
        const u = this.u;
        const device = this.app.graphicsDevice;
        const params = this.camera.shaderParams;
        const depthMode = !params.sceneDepthMapLinear || params.sceneDepthMapPacked ? 0
            : params.sceneDepthMapReciprocal ? 2 : 1;

        // give the camera frame a moment to set up its depth before judging
        if (s.lens.dof && depthMode === 0 && this.time > 1 && !this.warnedNoDepth) {
            this.warnedNoDepth = true;
            this.events.onStatus('depth of field is not available on this device');
        }

        const focal = rig.focalLength;
        const focusMm = Math.max(rig.focus * s.scene.metersPerUnit * 1000, focal * 1.05);
        const infinityMm = (focal * focal) / (s.lens.fStop * (focusMm - focal));
        const aperture = (infinityMm / 2) / rig.sensorWidth * device.width;

        u.depthMode.setValue(depthMode);
        u.far.setValue(this.camera.farClip);
        u.focus.setValue(rig.focus);
        u.aperture.setValue(aperture);
        // Physically the blur in front of the focus plane has no limit; this
        // cap only keeps the gather affordable (10% of the frame height).
        u.dofMaxRadius.setValue(s.lens.dof ? 0.1 * device.height : 0);
        u.dofSamples.setValue(level.dofSamples);
        u.dofProbes.setValue(level.dofProbes);
        u.bokeh.setValue(Math.max(0, bokehShapes.indexOf(s.lens.bokeh)));
        u.dofSeed.setValue(s.film.taa ? (this.time * 997) % 1000 : 0);
    }
}
