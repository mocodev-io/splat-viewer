import { useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useAppEvent } from '@playcanvas/react/hooks';
import { frameRect, lensRanges } from '../scene/experience';
import type { CameraApi } from './ViewerCamera';

type AutoFocusProps = {
    active: boolean;
    showFrame: boolean;                  // draw the AF point (focusing goes on without it)
    point: { x: number; y: number };     // AF point, 0..1 over the window; kept inside the frame
    frameAspect: number;                 // the frame's aspect (the sensor's)
    transition: number;                  // s to (nearly) reach a new distance
    metersPerUnit: number;
    trigger: string;                     // a change forces a new measurement (another splat, say)
    api: RefObject<CameraApi | null>;
    focus: RefObject<number>;            // the live focus distance it drives, m
};

// Continuous autofocus (AF-C) on one point of the image. It measures what is
// under the AF point only when something changed (camera, AF point, scene),
// at most four times a second, and moves the focus towards each measurement
// over `transition` seconds, like a lens motor.
export function AutoFocus({ active, showFrame, point, frameAspect, transition, metersPerUnit, trigger, api, focus }: AutoFocusProps) {
    const target = useRef<number | null>(null);
    const last = useRef({ key: '', time: -Infinity, busy: false });
    const label = useRef<HTMLSpanElement>(null);
    const box = useRef<HTMLDivElement>(null);

    // the AF point in CSS pixels, inside the frame as a camera's AF points are
    const inFrame = () => {
        const r = frameRect(window.innerWidth, window.innerHeight, frameAspect);
        const x = Math.min(Math.max(point.x * window.innerWidth, r.x), r.x + r.w);
        const y = Math.min(Math.max(point.y * window.innerHeight, r.y), r.y + r.h);
        return { x, y };
    };

    useAppEvent('update', (dt: number) => {
        const cam = api.current;
        if (!active || !cam) {
            target.current = null;
            last.current.key = '';
            return;
        }

        const v = cam.getView();
        const at = inFrame();
        const key = `${[...v.position, ...v.target].map(n => n.toFixed(4)).join(',')}|${at.x},${at.y}|${metersPerUnit}|${trigger}`;
        const l = last.current;
        const now = performance.now();
        if (key !== l.key && !l.busy && now - l.time >= 250) {
            l.key = key;
            l.time = now;
            l.busy = true;
            cam.pick(at.x, at.y, true).then(p => {
                l.busy = false;
                if (!p || !api.current) return;    // empty sky: keep the last focus
                const r = lensRanges.focusDistance;
                target.current = Math.min(Math.max(api.current.viewDepth(p) * metersPerUnit, r.min), r.max);
            });
        }

        if (target.current !== null) {
            // Exponential approach, about 95 % of the way after `transition`,
            // in 1 / distance: that is what the focus ring moves (the lens
            // extension) and what the blur follows, so a pull runs the same
            // way towards the camera and away from it. In meters, a pull
            // outwards would cover nearly all of its blur in the first frames.
            const k = transition <= 0 ? 1 : 1 - Math.exp(-3 * dt / transition);
            const inv = 1 / focus.current + (1 / target.current - 1 / focus.current) * k;
            focus.current = 1 / inv;
        }
        if (label.current) label.current.textContent = `${focus.current.toFixed(2)} m`;
        // follows the frame when the window or the sensor changes
        if (box.current) {
            box.current.style.left = `${at.x}px`;
            box.current.style.top = `${at.y}px`;
        }
    });

    if (!active || !showFrame) return null;
    return createPortal(
        <div className="af-point" ref={box} style={{ left: `${inFrame().x}px`, top: `${inFrame().y}px` }}>
            <span ref={label} />
        </div>,
        document.body
    );
}
