import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppEvent } from '@playcanvas/react/hooks';

type FrameStatsProps = { status: string; loaded: string | null };

// Bottom-left line: frame rate, loaded splat, status. The frame rate is
// written straight to the DOM twice a second instead of through React state,
// so measuring it does not re-render the app every frame.
export function FrameStats({ status, loaded }: FrameStatsProps) {
    const fpsEl = useRef<HTMLSpanElement>(null);
    const acc = useRef({ frames: 0, time: 0 });

    useAppEvent('update', (dt: number) => {
        const a = acc.current;
        a.frames++;
        a.time += dt;
        if (a.time >= 0.5) {
            if (fpsEl.current) fpsEl.current.textContent = `${Math.round(a.frames / a.time)} fps`;
            a.frames = 0;
            a.time = 0;
        }
    });

    return createPortal(
        <div className="hud">
            <span ref={fpsEl}>-- fps</span>
            {loaded && <span className="hud-file">{loaded}</span>}
            {status && <span>{status}</span>}
        </div>,
        document.body
    );
}
