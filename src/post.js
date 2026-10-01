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
            'time', 'res', 'exposure', 'flicker', 'distortion', 'crt', 'gateWeave', 'glitch', 'pixelate',
            'motionBlur', 'reproject', 'camMotion', 'kuwahara', 'halation', 'anamorphic', 'anamorphicTint',
            'dirt', 'lightLeak', 'posterize', 'look', 'lookMix', 'cell', 'duoDark', 'duoLight', 'paper',
            'outline', 'outlineColor', 'grain', 'grainSize', 'letterbox'
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
        f.dof.enabled = s.lens.dof;
        f.dof.focusDistance = rig.focus;
        f.dof.focusRange = s.lens.focusRange;
        f.dof.blurRadius = s.lens.blurRadius;
        f.dof.nearBlur = s.lens.nearBlur;
        f.fringing.intensity = s.lens.fringing;

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
        u.letterbox.setValue(st.letterbox === 'off' ? 0 : parseFloat(st.letterbox));
    }
}
