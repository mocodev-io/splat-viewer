// The control panel. lil-gui edits the shared settings object in place; the
// camera and post modules read it every frame, so there is nothing to sync.

import GUI from 'lil-gui';
import { presets, presetSettings, mergeInto } from './settings.js';
import { looks, letterboxes } from './post.js';

export class Panel {
    constructor(settings, { splats, luts, onSplat, onResetCamera }) {
        this.settings = settings;
        this.onSplat = onSplat;
        this.refreshQueued = false;
        this.preset = { name: 'Clean' };

        const gui = new GUI({ title: 'Splat Viewer', width: 300 });
        this.gui = gui;
        const s = settings;

        // ---- top level
        gui.add(this.preset, 'name', Object.keys(presets)).name('Preset').onChange(name => {
            mergeInto(s, presetSettings(name, s));
            this.refresh();
        });
        this.splatCtrl = gui.add(s.scene, 'splat', splats).name('Splat').onChange(v => onSplat(v));
        gui.add({ reset: onResetCamera }, 'reset').name('Reset camera (R)');
        gui.add({ save: () => this.exportJson() }, 'save').name('Export settings');
        gui.add({ load: () => this.importJson() }, 'load').name('Import settings');

        // ---- camera
        const cam = gui.addFolder('Camera');
        cam.add(s.camera, 'mode', ['fly', 'orbit']).name('Mode (O)');
        cam.add(s.camera, 'fov', 5, 150, 1).name('Field of view');
        cam.add(s.dolly, 'enabled').name('Dolly zoom (V)');
        cam.add(s.camera, 'roll', -180, 180, 0.1).name('Roll (Z / C)');
        cam.add(s.camera, 'fisheye', 0, 1, 0.01).name('Fisheye projection');
        cam.add(s.camera, 'moveSpeed', 0.01, 50, 0.01).name('Move speed');
        cam.add(s.camera, 'lookSpeed', 0.02, 1, 0.01).name('Look speed');
        cam.add(s.camera, 'smoothing', 0, 1, 0.01).name('Smoothing');
        cam.add(s.camera, 'rollSpeed', 5, 180, 1).name('Roll speed');
        cam.add(s.camera, 'drift').name('Drift (auto orbit)');
        cam.add(s.camera, 'driftSpeed', -45, 45, 0.5).name('Drift speed');

        const shake = gui.addFolder('Camera shake');
        shake.add(s.shake, 'style', ['off', 'handheld', 'walk', 'run', 'vehicle', 'earthquake']).name('Style');
        shake.add(s.shake, 'amount', 0, 3, 0.01).name('Amount');
        shake.add(s.shake, 'speed', 0.1, 3, 0.01).name('Speed');
        shake.close();

        // ---- lens
        const lens = gui.addFolder('Lens');
        lens.add(s.lens, 'autofocus', ['off', 'click', 'center']).name('Autofocus');
        lens.add(s.lens, 'focusSpeed', 0.5, 20, 0.1).name('Focus pull speed');
        lens.add(s.lens, 'dof').name('Depth of field');
        lens.add(s.lens, 'focusDistance', 0.05, 100, 0.01).name('Focus distance');
        lens.add(s.lens, 'focusRange', 0.01, 20, 0.01).name('Focus range');
        lens.add(s.lens, 'blurRadius', 1, 12, 0.1).name('Bokeh size');
        lens.add(s.lens, 'nearBlur').name('Blur foreground');
        lens.add(s.lens, 'distortion', -0.3, 0.5, 0.005).name('Distortion (+barrel)');
        lens.add(s.lens, 'fringing', 0, 40, 0.1).name('Chromatic aberration');
        lens.add(s.lens, 'anamorphic', 0, 2, 0.01).name('Anamorphic streaks');
        lens.addColor(s.lens, 'anamorphicTint').name('Streak colour');
        lens.add(s.lens, 'dirt', 0, 2, 0.01).name('Lens dirt');
        lens.close();

        // ---- light
        const light = gui.addFolder('Light');
        light.add(s.light, 'exposure', -4, 4, 0.01).name('Exposure (EV)');
        light.add(s.light, 'toneMapping', ['LINEAR', 'FILMIC', 'HEJL', 'ACES', 'ACES2', 'NEUTRAL']).name('Tone mapping');
        light.add(s.light, 'bloom', 0, 0.5, 0.001).name('Bloom');
        light.add(s.light, 'bloomThreshold', 0, 2, 0.01).name('Bloom threshold');
        light.add(s.light, 'bloomBlur', 1, 32, 1).name('Bloom size');
        light.add(s.light, 'halation', 0, 2, 0.01).name('Halation');
        light.add(s.light, 'lightLeak', 0, 2, 0.01).name('Light leak');
        light.add(s.ssao, 'enabled').name('Ambient occlusion');
        light.add(s.ssao, 'intensity', 0, 1, 0.01).name('AO intensity');
        light.add(s.ssao, 'radius', 1, 100, 1).name('AO radius');
        light.close();

        const fog = gui.addFolder('Fog & sun');
        fog.add(s.fog, 'enabled').name('Volumetric fog');
        fog.add(s.fog, 'density', 0, 0.5, 0.001).name('Density');
        fog.add(s.fog, 'heightBase', -20, 20, 0.01).name('Height');
        fog.add(s.fog, 'heightFalloff', 0, 2, 0.001).name('Height falloff');
        fog.add(s.fog, 'anisotropy', 0, 0.95, 0.01).name('Forward scatter');
        fog.add(s.fog, 'intensity', 0, 5, 0.01).name('Intensity');
        fog.addColor(s.fog, 'tint').name('Fog colour');
        fog.add(s.fog, 'ambient', 0, 0.5, 0.001).name('Ambient');
        fog.add(s.fog, 'sunYaw', -180, 180, 1).name('Sun direction');
        fog.add(s.fog, 'sunPitch', -90, 0, 1).name('Sun height');
        fog.addColor(s.fog, 'sunColor').name('Sun colour');
        fog.add(s.fog, 'sunIntensity', 0, 10, 0.01).name('Sun intensity');
        fog.add(s.fog, 'shafts').name('Light shafts (slow)');
        fog.close();

        // ---- colour
        const color = gui.addFolder('Colour');
        color.add(s.color, 'lut', luts).name('Look (LUT)');
        color.add(s.color, 'lutIntensity', 0, 1, 0.01).name('LUT amount');
        color.add(s.color, 'grading').name('Grading');
        color.add(s.color, 'brightness', 0, 3, 0.01).name('Brightness');
        color.add(s.color, 'contrast', 0, 3, 0.01).name('Contrast');
        color.add(s.color, 'saturation', 0, 3, 0.01).name('Saturation');
        color.addColor(s.color, 'tint').name('Tint');
        color.add(s.color, 'enhance').name('Colour enhance');
        color.add(s.color, 'shadows', -1, 1, 0.01).name('Shadows');
        color.add(s.color, 'midtones', -1, 1, 0.01).name('Midtones');
        color.add(s.color, 'highlights', -1, 1, 0.01).name('Highlights');
        color.add(s.color, 'vibrance', -1, 1, 0.01).name('Vibrance');
        color.add(s.color, 'dehaze', -1, 1, 0.01).name('Dehaze');
        color.close();

        const vig = gui.addFolder('Vignette');
        vig.add(s.vignette, 'intensity', 0, 1, 0.01).name('Intensity');
        vig.add(s.vignette, 'inner', 0, 2, 0.01).name('Inner');
        vig.add(s.vignette, 'outer', 0, 3, 0.01).name('Outer');
        vig.add(s.vignette, 'curvature', 0.01, 3, 0.01).name('Roundness');
        vig.addColor(s.vignette, 'color').name('Colour');
        vig.close();

        // ---- film
        const film = gui.addFolder('Film');
        film.add(s.film, 'grain', 0, 0.5, 0.001).name('Grain');
        film.add(s.film, 'grainSize', 1, 6, 0.1).name('Grain size');
        film.add(s.film, 'flicker', 0, 1, 0.01).name('Flicker');
        film.add(s.film, 'gateWeave', 0, 2, 0.01).name('Gate weave');
        film.add(s.film, 'sharpen', 0, 1, 0.01).name('Sharpen');
        film.add(s.film, 'taa').name('Temporal AA');
        film.close();

        // ---- stylize
        const sty = gui.addFolder('Stylize');
        sty.add(s.stylize, 'motionBlur', 0, 1, 0.01).name('Motion blur (shutter)');
        sty.add(s.stylize, 'letterbox', letterboxes).name('Aspect ratio');
        sty.add(s.stylize, 'look', looks).name('Look');
        sty.add(s.stylize, 'lookMix', 0, 1, 0.01).name('Look amount');
        sty.add(s.stylize, 'cellSize', 3, 24, 1).name('Halftone / ascii cell');
        sty.addColor(s.stylize, 'duoDark').name('Duotone dark');
        sty.addColor(s.stylize, 'duoLight').name('Duotone light');
        sty.add(s.stylize, 'pixelate', 0, 32, 1).name('Pixelate');
        sty.add(s.stylize, 'posterize', 0, 16, 1).name('Posterize');
        sty.add(s.stylize, 'kuwahara', 0, 8, 0.1).name('Oil paint');
        sty.add(s.stylize, 'outline', 0, 1, 0.01).name('Outlines');
        sty.addColor(s.stylize, 'outlineColor').name('Outline colour');
        sty.add(s.stylize, 'paper', 0, 1, 0.01).name('Paper');
        sty.add(s.stylize, 'glitch', 0, 1, 0.01).name('Glitch');
        sty.add(s.stylize, 'crt', 0, 1, 0.01).name('CRT');
        sty.close();

        // ---- scene
        const scene = gui.addFolder('Scene');
        scene.add(s.scene, 'flip').name('Flip upside down');
        scene.addColor(s.scene, 'background').name('Background');
        scene.add(s.scene, 'renderScale', 0.25, 1, 0.05).name('Render scale');
        scene.add(s.scene, 'antiAlias').name('Splat anti-aliasing');
        scene.close();

        this.fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
        this.fileInput.addEventListener('change', () => this.readImport());
    }

    setSplats(list) {
        this.splatCtrl = this.splatCtrl.options(list).onChange(v => this.onSplat(v));
        this.splatCtrl.name('Splat');
        this.splatCtrl.updateDisplay();
    }

    // Repaint every control from the settings object, at most once per frame.
    refresh() {
        if (this.refreshQueued) return;
        this.refreshQueued = true;
        requestAnimationFrame(() => {
            this.refreshQueued = false;
            for (const c of this.gui.controllersRecursive()) c.updateDisplay();
        });
    }

    exportJson() {
        const blob = new Blob([JSON.stringify(this.settings, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `splat-viewer-${this.preset.name.toLowerCase().replace(/\W+/g, '-')}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    importJson() {
        this.fileInput.value = '';
        this.fileInput.click();
    }

    async readImport() {
        const file = this.fileInput.files[0];
        if (!file) return;
        try {
            const previousSplat = this.settings.scene.splat;
            mergeInto(this.settings, JSON.parse(await file.text()));
            this.refresh();
            if (this.settings.scene.splat !== previousSplat) this.onSplat(this.settings.scene.splat);
        } catch (err) {
            console.warn('import failed', err);
        }
    }
}
