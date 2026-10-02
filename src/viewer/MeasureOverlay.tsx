import { useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useAppEvent } from '@playcanvas/react/hooks';
import type { Vec3Tuple } from '../scene/experience';
import type { CameraApi } from './ViewerCamera';

type MeasureOverlayProps = {
    points: Vec3Tuple[];          // 0, 1 or 2 picked points
    metersPerUnit: number;
    api: RefObject<CameraApi | null>;
};

export const measuredLength = (points: Vec3Tuple[]) => {
    if (points.length < 2) return null;
    const [a, b] = points;
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};

// The measuring line, drawn over the image. The points live in the world;
// their place on screen is updated every frame, straight in the DOM.
export function MeasureOverlay({ points, metersPerUnit, api }: MeasureOverlayProps) {
    const dots = [useRef<SVGCircleElement>(null), useRef<SVGCircleElement>(null)];
    const line = useRef<SVGLineElement>(null);
    const label = useRef<HTMLDivElement>(null);

    useAppEvent('postrender', () => {
        const cam = api.current;
        if (!cam) return;
        const screen = points.map(p => cam.toScreen(p));
        screen.forEach((s, i) => {
            const el = dots[i].current;
            if (!el) return;
            el.setAttribute('cx', String(s.x));
            el.setAttribute('cy', String(s.y));
            el.style.display = s.behind ? 'none' : '';
        });
        if (screen.length === 2 && line.current && label.current) {
            const [a, b] = screen;
            line.current.setAttribute('x1', String(a.x));
            line.current.setAttribute('y1', String(a.y));
            line.current.setAttribute('x2', String(b.x));
            line.current.setAttribute('y2', String(b.y));
            const hidden = a.behind || b.behind;
            line.current.style.display = hidden ? 'none' : '';
            label.current.style.display = hidden ? 'none' : '';
            label.current.style.transform = `translate(${(a.x + b.x) / 2}px, ${(a.y + b.y) / 2}px)`;
        }
    });

    const units = measuredLength(points);

    return createPortal(
        <>
            <svg className="measure">
                {points.length === 2 && <line ref={line} />}
                {points.map((_, i) => <circle key={i} ref={dots[i]} r={4} />)}
            </svg>
            {units !== null && (
                <div ref={label} className="measure-label">
                    {units.toFixed(3)} units · {(units * metersPerUnit).toFixed(2)} m
                </div>
            )}
        </>,
        document.body
    );
}
