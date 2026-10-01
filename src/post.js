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
export const dofModes = ['off', 'lens', 'fast'];
const dofModeIds = { off: 0, fast: 1, lens: 2 };   // must match sv_dofMode in compose.js
export const bokehShapes = ['round', 'hexagon', 'octagon', 'anamorphic', 'swirl'];
export const letterboxes = ['off', '1', '1.33', '1.85', '2', '2.39', '2.76'];

// sRGB hex -> linear rgb array
function linear(hex) {
    const c = new pc.Color().fromString(hex);
    return [c.r ** 2.2, c.g ** 2.2, c.b ** 2.2];
}
function linearColor(hex, out = new pc.Color()) {
    const [r, g, b] = linear(hex);
    return out.set(r, g, b, 1);
}

export class Post {
    constructor(app, cameraEntity, sunEntity, settings, luts) {
        this.app = app;
        this.camera = cameraEntity.camera;
        this.settings = settings;
        this.sun = sunEntity;
        this.luts = luts;
        this.lutName = null;
        this.time = 0;

        // the custom compose shader must be registered before CameraFrame builds it
        pc.ShaderChunks.get(app.graphicsDevice, pc.SHADERLANGUAGE_GLSL).set('composePS', composePS);

        // splats write depth so DoF, fog, SSAO and TAA see them
        app.scene.gsplat.sceneDepthWrite = true;

        const frame = new pc.CameraFrame(app, cameraEntity.camera);
        frame.rendering.samples = 1;       // MSAA makes splats several times more expensive
        this.frame = frame;

        const scope = app.graphicsDevice.scope;
        this.u = {};
        for (const name of [
            'time', 'res', 'exposure', 'flicker', 'distortion', 'crt', 'gateWeave', 'glitch', 'pixelate', 'fringing',
            'motionBlur', 'reproject', 'camMotion', 'kuwahara', 'halation', 'anamorphic', 'anamorphicTint',
            'dirt', 'lightLeak', 'posterize', 'look', 'lookMix', 'cell', 'duoDark', 'duoLight', 'paper',
            'outline', 'outlineColor', 'grain', 'grainSize', 'grainAnimated', 'letterbox',
            'dofMode', 'depthMode', 'far', 'focus', 'aperture', 'dofMaxRadius', 'nearBlur', 'bokeh', 'dofSeed'
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

    update(dt, rig) {
        const s = this.settings;
        const f = this.frame;
        const app = this.app;
        this.time += dt;

        this.updateLut();

        // ---- scene / splat rendering
        f.rendering.renderTargetScale = s.scene.renderScale;
        f.rendering.toneMapping = toneMappings[s.light.toneMapping] ?? pc.TONEMAP_ACES2;
        f.rendering.sharpness = s.film.sharpen;
        app.scene.gsplat.fisheye = s.camera.fisheye;
        app.scene.gsplat.antiAlias = s.scene.antiAlias;

        // ---- lens
        // "lens" is our own thin-lens DoF in the compose shader. It still keeps
        // the engine DoF switched on, at its cheapest, because that is what
        // makes the engine render the scene depth texture we read.
        const dofMode = s.lens.dof;
        const fast = dofMode === 'fast';
        f.dof.enabled = dofMode !== 'off';
        f.dof.focusDistance = rig.focus;
        f.dof.focusRange = s.lens.focusRange;
        f.dof.blurRadius = fast ? s.lens.blurRadius : 1;
        f.dof.nearBlur = fast && s.lens.nearBlur;
        f.dof.highQuality = fast;
        f.dof.blurRings = fast ? 4 : 1;
        f.dof.blurRingPoints = fast ? 5 : 1;
        f.fringing.intensity = 0;          // our own chromatic aberration replaces it

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
        this.sun.setEulerAngles(fog.sunPitch, fog.sunYaw, 0);
        linearColor(fog.sunColor, this.sun.light.color);
        this.sun.light.intensity = fog.sunIntensity;
        this.sun.light.castShadows = fog.enabled && fog.shafts;
        this.sun.enabled = fog.enabled;

        // ---- ssao
        f.ssao.type = s.ssao.enabled ? pc.SSAOTYPE_COMBINE : pc.SSAOTYPE_NONE;
        f.ssao.intensity = s.ssao.intensity;
        f.ssao.radius = s.ssao.radius;

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
        u.time.setValue(this.time);
        u.res.setValue([device.width, device.height]);
        u.exposure.setValue(s.light.exposure);
        u.flicker.setValue(s.film.flicker);
        u.distortion.setValue(s.lens.distortion);
        u.crt.setValue(st.crt);
        u.gateWeave.setValue(s.film.gateWeave);
        u.glitch.setValue(st.glitch);
        u.pixelate.setValue(st.pixelate >= 2 ? st.pixelate * (device.width / device.clientRect.width) : 0);
        u.motionBlur.setValue(st.motionBlur * rig.blurScale);
        u.reproject.setValue(rig.reproject.data);
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
        u.cell.setValue(Math.max(3, st.cellSize * (device.width / device.clientRect.width)));
        u.duoDark.setValue(linear(st.duoDark));
        u.duoLight.setValue(linear(st.duoLight));
        u.paper.setValue(st.paper);
        u.outline.setValue(st.outline);
        u.outlineColor.setValue(linear(st.outlineColor));
        u.grain.setValue(s.film.grain);
        u.grainSize.setValue(Math.max(1, s.film.grainSize));
        u.grainAnimated.setValue(s.film.grainAnimated ? 1 : 0);
        u.fringing.setValue(s.lens.fringing / 2048);
        u.letterbox.setValue(st.letterbox === 'off' ? 0 : parseFloat(st.letterbox));

        // Lens DoF. Thin lens: a point at infinity blurs into a circle of
        // f² / (N · (S − f)) mm on the sensor (f focal length, N f-stop,
        // S focus distance); nearer points scale that by (1 − S/D). The shader
        // gets the infinity radius in scene-texture pixels.
        const params = this.camera.shaderParams;
        const depthMode = !params.sceneDepthMapLinear || params.sceneDepthMapPacked ? 0
            : params.sceneDepthMapReciprocal ? 2 : 1;
        const sceneWidth = device.width * s.scene.renderScale;
        const sceneHeight = device.height * s.scene.renderScale;
        const focal = rig.focalLength;
        const focusMm = Math.max(rig.focus * s.scene.metersPerUnit * 1000, focal * 1.05);
        const cocMm = (focal * focal) / (Math.max(s.lens.fStop, 0.5) * (focusMm - focal));
        const aperture = (cocMm / 2) / rig.sensorWidth * sceneWidth;
        u.dofMode.setValue(dofModeIds[dofMode] ?? 0);
        u.depthMode.setValue(depthMode);
        u.far.setValue(this.camera.farClip);
        u.focus.setValue(rig.focus);
        u.aperture.setValue(aperture);
        u.dofMaxRadius.setValue(Math.min(aperture * (s.lens.nearBlur ? 1.5 : 1), 0.08 * sceneHeight));
        u.nearBlur.setValue(s.lens.nearBlur ? 1 : 0);
        u.bokeh.setValue(Math.max(0, bokehShapes.indexOf(s.lens.bokeh)));
        u.dofSeed.setValue(s.film.taa ? (this.time * 997) % 1000 : 0);
    }
}
