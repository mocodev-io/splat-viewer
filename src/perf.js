// Quality levels and resolution control, so one viewer runs on a 4K desktop GPU
// as well as on integrated graphics at 1080p.
//
// Resolution applies to the whole pipeline: the canvas backbuffer shrinks and
// the browser scales the finished frame up, so splats *and* every post effect
// get cheaper. In "auto" the scale follows the measured frame rate.

export const qualityLevels = {
    low: {
        pixelRatio: 1,          // ignore HiDPI / scaled displays
        dofSamples: 24,         // lens DoF gather samples
        dofProbes: 6,           // neighbour probes that size the gather
        motionBlurSamples: 6,
        fogSteps: 12,
        fogScale: 0.25,
        ssaoSamples: 6,
        ssaoScale: 0.5,
        minPixelSize: 3,        // skip splats smaller than this on screen
        minContribution: 6,     // skip splats that hardly add to the image
        pickScale: 0.125        // autofocus depth read resolution
    },
    medium: {
        pixelRatio: 1,
        dofSamples: 48,
        dofProbes: 8,
        motionBlurSamples: 8,
        fogSteps: 16,
        fogScale: 0.5,
        ssaoSamples: 8,
        ssaoScale: 0.5,
        minPixelSize: 2,
        minContribution: 3,
        pickScale: 0.25
    },
    high: {
        pixelRatio: 1.5,
        dofSamples: 96,
        dofProbes: 12,
        motionBlurSamples: 12,
        fogSteps: 24,
        fogScale: 0.5,
        ssaoSamples: 12,
        ssaoScale: 1,
        minPixelSize: 2,
        minContribution: 3,
        pickScale: 0.25
    },
    ultra: {
        pixelRatio: 2,
        dofSamples: 160,
        dofProbes: 16,
        motionBlurSamples: 16,
        fogSteps: 32,
        fogScale: 0.75,
        ssaoSamples: 16,
        ssaoScale: 1,
        minPixelSize: 1,
        minContribution: 2,
        pickScale: 0.5
    }
};

const MIN_SCALE = 0.35;

export class Performance {
    constructor(app, settings, events) {
        this.app = app;
        this.device = app.graphicsDevice;
        this.settings = settings;
        this.events = events;          // { onSettingsChanged() }
        this.frames = 0;
        this.time = 0;
        this.steadyChecks = 0;
        this.holdUp = 0;               // seconds before auto may scale up again
        this.appliedRatio = 0;
        this.splatParams = {};
        this.fps = 0;
    }

    get level() {
        return qualityLevels[this.settings.performance.quality] ?? qualityLevels.medium;
    }

    update(dt) {
        const p = this.settings.performance;

        // frame rate over one-second windows; ignore hitches like tab switches
        if (dt < 0.25) {
            this.frames++;
            this.time += dt;
        }
        if (this.time >= 1) {
            this.fps = this.frames / this.time;
            if (p.resolution === 'auto') this.adjust(this.fps);
            this.frames = 0;
            this.time = 0;
        }
        this.holdUp = Math.max(0, this.holdUp - dt);

        this.applyResolution();
        this.applySplatQuality();
    }

    // Down quickly when too slow, up carefully when there is headroom.
    adjust(fps) {
        const p = this.settings.performance;
        const target = p.targetFps;
        let scale = p.scale;
        if (fps < target * 0.9) {
            scale *= Math.min(Math.max(fps / target, 0.7), 0.95);
            this.steadyChecks = 0;
            this.holdUp = 4;
        } else if (fps >= target * 0.97 && scale < 1 && this.holdUp <= 0) {
            if (++this.steadyChecks >= 3) {
                scale *= 1.1;
                this.steadyChecks = 0;
            }
        } else {
            this.steadyChecks = 0;
        }
        scale = Math.round(Math.min(Math.max(scale, MIN_SCALE), 1) * 20) / 20;
        if (scale !== p.scale) {
            p.scale = scale;
            this.events.onSettingsChanged();
        }
    }

    applyResolution() {
        const ratio = Math.min(window.devicePixelRatio || 1, this.level.pixelRatio) * this.settings.performance.scale;
        if (Math.abs(ratio - this.appliedRatio) > 0.01) {
            this.appliedRatio = ratio;
            this.device.maxPixelRatio = ratio;
            this.app.resizeCanvas();
        }
    }

    // gsplat material setters recompile/update the material, so only touch
    // them when the value really changes
    applySplatQuality() {
        const gs = this.app.scene.gsplat;
        const level = this.level;
        const wanted = {
            minPixelSize: level.minPixelSize,
            minContribution: level.minContribution,
            antiAlias: this.settings.scene.antiAlias
        };
        for (const [key, value] of Object.entries(wanted)) {
            if (this.splatParams[key] !== value) {
                this.splatParams[key] = value;
                gs[key] = value;
            }
        }
    }
}
