import { useEffect, useRef, type RefObject } from 'react';
import { Mat4, Quat, Vec3, type AppBase, type Texture } from 'playcanvas';
import { useAppEvent } from '@playcanvas/react/hooks';
import type { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import type { CameraFrame } from 'playcanvas/scripts/esm/camera-frame.mjs';
import { frameRect, type FrameShape, type Lens } from '../scene/experience';
import { StillFrames, type Finish } from './stillFrames';
import { Aperture, APERTURE_GROUP } from './aperture';
import { cameraFramePass, depthIsReciprocal, engineProblems, stillHooksOk } from './engine';

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
    depthRange: boolean;                 // the normalized depth view is shown: follow the depth range
    busy: boolean;                       // a splat is loading: keep rendering
    sceneKey: string;                    // changes whenever what is shown changes
    progress: RefObject<string>;         // short status for the HUD
    finish: Finish;                      // aberration and grain on the way to the canvas
    shape: FrameShape;                   // where the image lies in the canvas
};

// The camera counts as standing still when the image moves less than this
// from one frame to the next (pixels); the still starts over once it has
// drifted further than DRIFT_PX from where it started. The damped camera
// controls keep easing out for half a second after a move, far below what
// can be seen; this lets the still start as soon as the image looks still.
const STEP_PX = 0.1;
const DRIFT_PX = 0.5;

// Over-blur: while the still builds up, its average gets a little of the
// gather DoF on top (Blender EEVEE does the same), radius overblur / √n (at
// most 1, the moving view) of
// each pixel's blur circle after n samples (`lens.overblur`, 1.5 by default;
// 0 shows the pure accumulation). The few aperture samples of the
// first frames would otherwise show as separate copies, stepped lines along
// sharp edges; the extra blur, about the gap between lens points, runs them
// together (N points over a disc of radius R lie about 2R / √N apart, so the
// blur that closes the gaps is about 1.5 R / √N). It shrinks as the samples
// fill the aperture, so the image refines
// smoothly from the moving view to the exact one; in-focus parts have no blur
// circle and stay sharp.
const overblurFor = (lens: Lens, shown: number) => Math.min(lens.overblur / Math.sqrt(Math.max(shown, 1)), 1);

type Pose = { p: Vec3; r: Quat };
const pose = (): Pose => ({ p: new Vec3(), r: new Quat() });

// Drives StillFrames and keeps the GPU quiet when nothing changes.
//
// - moving: a normal frame each frame (with the gather DoF when the lens DoF
//   is on);
// - still (the image stopped moving, lens DoF on): one aperture sample per
//   frame until the quality's count; the camera is moved over the aperture
//   (its shape gives the bokeh, aperture.ts) and its frustum sheared so the
//   focus plane stays in place; the samples are averaged in HDR inside the
//   frame (stillFrames.ts), with a shrinking over-blur on top;
// - once the last sample is in, the composed average no longer changes:
//   rendering stops and the screen eases in on that frame without it (only
//   the drawing to the canvas runs, on each tick);
// - done, or nothing changed for a second without lens DoF: no rendering at
//   all until something changes (the canvas keeps the last image; moving
//   grain is drawn on it, stillFrames.ts).
//
// Without the engine hooks the still needs (engine.ts), it stays in moving.
//
// Returns the state: the mode, `overblur`, the gather radius scale for this
// frame (1 while moving), and `range`, the depth range for the normalized
// depth view.
export function useStillDof({ app, controls, frame, lens, focus, accumulate, depthRange, busy, sceneKey, progress, finish, shape }: StillDofOptions) {
    const still = useRef<StillFrames | null>(null);
    const state = useRef({
        other: '',                                   // everything but the camera pose that changes the image
        changedAt: 0,
        mode: 'moving' as Mode,
        start: false,
        easing: false,                               // all samples in, easing in without rendering
        prev: pose(),                                // the pose of the previous tick
        anchor: pose(),                              // the pose the still started at
        overblur: 1,
        range: null as null | { texture: Texture; ready: boolean },   // for the normalized depth view
        jitter: null as null | { x: number; y: number; focus: number },
        aperture: null as Aperture | null
    });
    const live = useRef({ lens, focus, accumulate, depthRange, busy, sceneKey, finish, shape });
    live.current = { lens, focus, accumulate, depthRange, busy, sceneKey, finish, shape };

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
        // The camera's angle of view belongs to the frame (the sensor's
        // aspect, fitted into the canvas); the projection widens it over the
        // whole canvas so the frame keeps exactly its own angle and the rest
        // is overscan with the same lens, as a camera view with a
        // passepartout in Blender.
        camera.calculateProjection = (m: Mat4) => {
            const w = sf.frame.width;
            const h = Math.max(sf.frame.height, 1);
            const frameW = frameRect(w, h, live.current.shape).w;
            const fov = 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * w / frameW) * 180 / Math.PI;
            m.setPerspective(fov, w / h, camera.nearClip, camera.farClip, true);
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
        const { focus, busy, sceneKey, lens } = live.current;
        const hooksOk = stillHooksOk();
        const accumulate = live.current.accumulate && hooksOk;
        const s = state.current;
        const now = performance.now();
        const camera = cc.entity.camera!;
        const { width, height } = app.graphicsDevice;

        // How far the image moves between two poses, in pixels: the turn
        // through the focal length in pixels, and the shift as seen at half
        // the focus distance (nearer things move more, far less).
        const focalPx = frameRect(width, height, live.current.shape).w / (2 * Math.tan(camera.fov * Math.PI / 360));
        const reach = Math.max(focus.current / lens.metersPerUnit * 0.5, camera.nearClip);
        const current: Pose = { p: cc.entity.getPosition(), r: cc.entity.getRotation() };
        const movedPx = (a: Pose, b: Pose) => {
            const d = Math.abs(a.r.x * b.r.x + a.r.y * b.r.y + a.r.z * b.r.z + a.r.w * b.r.w);
            const turn = 2 * Math.acos(Math.min(d, 1));
            return (turn + a.p.distance(b.p) / reach) * focalPx;
        };
        const step = movedPx(s.prev, current);
        s.prev.p.copy(current.p);
        s.prev.r.copy(current.r);
        const drift = s.mode === 'moving' ? 0 : movedPx(s.anchor, current);

        const other = `${focus.current.toFixed(4)}|${width}x${height}|${sceneKey}`;
        const moving = other !== s.other || busy || step > STEP_PX || drift > DRIFT_PX;
        if (moving || (!hooksOk && s.mode !== 'moving')) {
            s.other = other;
            s.changedAt = now;
            s.mode = 'moving';
            s.easing = false;
            app.autoRender = true;
        } else if (s.mode === 'moving' && accumulate) {
            s.mode = 'still';
            s.start = true;
            s.anchor.p.copy(current.p);
            s.anchor.r.copy(current.r);
        }
        if (s.mode === 'moving' && !accumulate && now - s.changedAt > 1000) app.autoRender = false;

        const total = STILL_SAMPLES[lens.blurQuality];
        if (s.mode === 'still' && s.easing) {
            // the last average is composed: ease the screen in on it, no render
            sf.present(true, lens.stillFade, live.current.finish);
            if (sf.settled) s.mode = 'done';
        } else if (!app.autoRender && !app.renderNextFrame) {
            // not rendering this frame: keep the grain moving on the last image
            sf.refresh(live.current.finish);
        }

        const problems = engineProblems();
        progress.current = (s.mode === 'still' ? `still ${sf.count}/${total}` : s.mode === 'done' ? 'still' : '')
            + (problems.length ? ` engine hooks missing (${problems.length}, see console)` : '');
    });

    useAppEvent('prerender', () => {
        const sf = still.current;
        if (!sf) return;
        const s = state.current;
        if (sf.resize() && s.mode !== 'moving') s.mode = 'moving';
        s.jitter = null;
        const engine = cameraFramePass(frame.current);
        const camera = controls.current?.entity.camera;
        const reciprocal = depthIsReciprocal(camera);
        const range = live.current.depthRange && camera ? { far: camera.farClip, reciprocal } : null;
        s.range = sf.range;
        if (s.mode !== 'still') {
            // done: a stray render still shows the finished average
            sf.prepare(engine, s.mode === 'done', null, live.current.accumulate, range);
            s.overblur = s.mode === 'done' ? overblurFor(live.current.lens, sf.shown) : 1;
            return;
        }
        if (s.start) {
            sf.start();
            s.start = false;
            s.easing = false;
        }
        const { lens, focus } = live.current;
        // all samples in: keep rendering the average until the screen has eased in
        if (sf.count >= STILL_SAMPLES[lens.blurQuality]) {
            sf.prepare(engine, true, null, false, range);
            s.overblur = overblurFor(lens, sf.shown);
            return;
        }
        if (!s.aperture?.is(lens)) s.aperture = new Aperture(lens);
        const [u, v] = s.aperture.sample(sf.count);
        const radius = lens.focalLength / 1000 / lens.fStop / 2 / lens.metersPerUnit;   // f-stop radius, scene units
        s.jitter = { x: u * radius, y: v * radius, focus: focus.current / lens.metersPerUnit };
        sf.prepare(engine, true, [u, v, lens.catsEye], false, range);
        // the average composed this frame shows the whole groups among count + 1 samples
        const shown = (sf.count + 1) - (sf.count + 1) % APERTURE_GROUP;
        s.overblur = overblurFor(lens, shown);
    });

    useAppEvent('postrender', () => {
        const sf = still.current;
        if (!sf) return;
        const s = state.current;
        const { lens, finish } = live.current;
        if (s.mode === 'still') {
            // whole groups, eased in (stillFrames.ts); done once all are in
            // and the screen has caught up
            sf.present(true, lens.stillFade, finish);
            if (sf.count >= STILL_SAMPLES[lens.blurQuality]) {
                // this frame composed the final average: the rest of the
                // easing in needs no render (see the update handler)
                app.autoRender = false;
                s.easing = true;
                if (sf.settled) s.mode = 'done';
            }
        } else {
            sf.present(false, lens.stillFade, finish);
        }
    });

    return state;
}
