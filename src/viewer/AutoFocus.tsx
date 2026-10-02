import { useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useAppEvent } from '@playcanvas/react/hooks';
import { lensRanges } from '../scene/experience';
import type { CameraApi } from './ViewerCamera';

type AutoFocusProps = {
    active: boolean;
    showFrame: boolean;                  // draw the AF point (focusing goes on without it)
    point: { x: number; y: number };     // AF point, 0..1 over the image
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
export function AutoFocus({ active, showFrame, point, transition, metersPerUnit, trigger, api, focus }: AutoFocusProps) {
    const target = useRef<number | null>(null);
    const last = useRef({ key: '', time: -Infinity, busy: false });
    const label = useRef<HTMLSpanElement>(null);

    useAppEvent('update', (dt: number) => {
        const cam = api.current;
        if (!active || !cam) {
            target.current = null;
            last.current.key = '';
            return;
        }

        const v = cam.getView();
        const key = `${[...v.position, ...v.target].map(n => n.toFixed(4)).join(',')}|${point.x},${point.y}|${metersPerUnit}|${trigger}`;
        const l = last.current;
        const now = performance.now();
        if (key !== l.key && !l.busy && now - l.time >= 250) {
            l.key = key;
            l.time = now;
            l.busy = true;
            cam.pick(point.x * window.innerWidth, point.y * window.innerHeight, true).then(p => {
                l.busy = false;
                if (!p || !api.current) return;    // empty sky: keep the last focus
                const r = lensRanges.focusDistance;
                target.current = Math.min(Math.max(api.current.viewDepth(p) * metersPerUnit, r.min), r.max);
            });
        }

        if (target.current !== null) {
            // exponential approach: about 95 % of the way after `transition`
            const k = transition <= 0 ? 1 : 1 - Math.exp(-3 * dt / transition);
            focus.current += (target.current - focus.current) * k;
        }
        if (label.current) label.current.textContent = `${focus.current.toFixed(2)} m`;
    });

    if (!active || !showFrame) return null;
    return createPortal(
        <div className="af-point" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}>
            <span ref={label} />
        </div>,
        document.body
    );
}
