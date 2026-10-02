import { useEffect, useRef, type RefObject } from 'react';
import { Mat4, type AppBase } from 'playcanvas';
import { useAppEvent } from '@playcanvas/react/hooks';
import type { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import type { CameraFrame } from 'playcanvas/scripts/esm/camera-frame.mjs';
import type { Lens } from '../scene/experience';
import { StillFrames, apertureSample } from './stillFrames';

/** Aperture samples per still, by quality. */
export const STILL_SAMPLES = { low: 16, medium: 48, high: 128 } as const;

type Mode = 'moving' | 'still' | 'done';

type StillDofOptions = {
    app: AppBase;
    controls: RefObject<CameraControls | null>;
    frame: RefObject<CameraFrame | null>;
    lens: Lens;
    focus: RefObject<number>;            // m
    accumulate: boolean;                 // lens DoF on and the normal image shown
    busy: boolean;                       // a splat is loading: keep rendering
    sceneKey: string;                    // changes whenever what is shown changes
    progress: RefObject<string>;         // short status for the HUD
};

const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
};

// Drives StillFrames and keeps the GPU quiet when nothing changes.
//
// - moving: a normal frame each frame (with the gather DoF when the lens DoF
//   is on);
// - still (nothing changed for a moment, lens DoF on): one aperture sample
//   per frame until the quality's count, fading in over the last moving
//   frame; the camera is moved over the aperture and its frustum sheared so
//   the focus plane stays in place;
// - done, or nothing changed for a second without lens DoF: no rendering at
//   all until something changes (the canvas keeps the last image).
//
// Returns whether this frame is an aperture sample (the gather is off then).
export function useStillDof({ app, controls, frame, lens, focus, accumulate, busy, sceneKey, progress }: StillDofOptions) {
    const still = useRef<StillFrames | null>(null);
    const state = useRef({
        key: '',
        changedAt: 0,
        mode: 'moving' as Mode,
        start: false,
        jitter: null as null | { x: number; y: number; focus: number }
    });
    const live = useRef({ lens, focus, accumulate, busy, sceneKey });
    live.current = { lens, focus, accumulate, busy, sceneKey };

    useEffect(() => {
        const cc = controls.current;
        const cf = frame.current;
        if (!cc || !cf) return;
        const camera = cc.entity.camera!;
        const sf = new StillFrames(app);
        still.current = sf;

        // CameraFrame composes into the camera's render target; it reads the
        // target when it builds its passes, so it is rebuilt once here
        camera.renderTarget = sf.frame;
        cf.enabled = false;
        cf.enabled = true;

        // The aperture sample: the camera moved within the lens plane, and the
        // frustum sheared back so points on the focus plane stay put.
        const offset = new Mat4();
        camera.calculateTransform = (m: Mat4) => {
            m.copy(cc.entity.getWorldTransform());
            const j = state.current.jitter;
            if (j) m.mul(offset.setTranslate(j.x, j.y, 0));
        };
        camera.calculateProjection = (m: Mat4) => {
            m.setPerspective(camera.fov, sf.frame.width / Math.max(sf.frame.height, 1), camera.nearClip, camera.farClip, camera.horizontalFov);
            const j = state.current.jitter;
            if (j) {
                // clip.x += (P00 · dx / S) · clip.w, and the same for y
                m.data[8] += (m.data[0] * j.x / j.focus) * m.data[11];
                m.data[9] += (m.data[5] * j.y / j.focus) * m.data[11];
            }
        };

        return () => {
            const unset = null as never;
            camera.calculateTransform = unset;
            camera.calculateProjection = unset;
            camera.renderTarget = unset;
            cf.enabled = false;
            cf.enabled = true;
            sf.destroy();
            still.current = null;
            app.autoRender = true;
        };
    }, [app, controls, frame]);

    // what changed decides the mode; runs every tick, rendering or not
    useAppEvent('update', () => {
        const cc = controls.current;
        const sf = still.current;
        if (!cc || !sf) return;
        const { focus, accumulate, busy, sceneKey, lens } = live.current;
        const p = cc.entity.getPosition();
        const r = cc.entity.getRotation();
        const key = [p.x, p.y, p.z, r.x, r.y, r.z, r.w].map(v => v.toFixed(5)).join(',')
            + `|${focus.current.toFixed(4)}|${app.graphicsDevice.width}x${app.graphicsDevice.height}|${sceneKey}`;
        const s = state.current;
        const now = performance.now();
        if (key !== s.key || busy) {
            s.key = key;
            s.changedAt = now;
            s.mode = 'moving';
            app.autoRender = true;
        }
        const quiet = now - s.changedAt;
        if (s.mode === 'moving' && accumulate && quiet > 150) {
            s.mode = 'still';
            s.start = true;
        }
        if (s.mode === 'moving' && !accumulate && quiet > 1000) app.autoRender = false;

        const total = STILL_SAMPLES[lens.blurQuality];
        progress.current = s.mode === 'still' ? `still ${sf.count}/${total}` : s.mode === 'done' ? 'still' : '';
    });

    useAppEvent('prerender', () => {
        const sf = still.current;
        if (!sf) return;
        const s = state.current;
        if (sf.resize() && s.mode !== 'moving') s.mode = 'moving';
        s.jitter = null;
        if (s.mode !== 'still') return;
        if (s.start) {
            sf.start();
            s.start = false;
        }
        const { lens, focus } = live.current;
        const [u, v] = apertureSample(sf.count);
        const radius = lens.focalLength / 1000 / lens.fStop / 2 / lens.metersPerUnit;   // aperture, scene units
        s.jitter = { x: u * radius, y: v * radius, focus: focus.current / lens.metersPerUnit };
    });

    useAppEvent('postrender', () => {
        const sf = still.current;
        if (!sf) return;
        const s = state.current;
        if (s.mode === 'still') {
            sf.accumulate();
            sf.present(true, smoothstep(2, 10, sf.count));
            if (sf.count >= STILL_SAMPLES[live.current.lens.blurQuality]) {
                s.mode = 'done';
                app.autoRender = false;
            }
        } else {
            sf.present(s.mode === 'done', 1);
        }
    });

    return state;
}
