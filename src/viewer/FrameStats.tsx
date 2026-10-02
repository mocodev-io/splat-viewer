import { useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useAppEvent } from '@playcanvas/react/hooks';

type FrameStatsProps = { status: string; loaded: string | null; progress: RefObject<string> };

// Bottom-left line: frame rate, still progress, loaded splat, status. Frames
// are counted as they are rendered (the viewer stops rendering when nothing
// changes, which shows as "idle"); written straight to the DOM twice a second
// instead of through React state, so measuring does not re-render the app.
export function FrameStats({ status, loaded, progress }: FrameStatsProps) {
    const fpsEl = useRef<HTMLSpanElement>(null);
    const stillEl = useRef<HTMLSpanElement>(null);
    const acc = useRef({ frames: 0, time: 0 });

    useAppEvent('postrender', () => { acc.current.frames++; });

    useAppEvent('update', (dt: number) => {
        const a = acc.current;
        a.time += dt;
        if (a.time >= 0.5) {
            if (fpsEl.current) fpsEl.current.textContent = a.frames ? `${Math.round(a.frames / a.time)} fps` : 'idle';
            a.frames = 0;
            a.time = 0;
        }
        if (stillEl.current) stillEl.current.textContent = progress.current;
    });

    return createPortal(
        <div className="hud">
            <span ref={fpsEl}>-- fps</span>
            <span ref={stillEl} />
            {loaded && <span className="hud-file">{loaded}</span>}
            {status && <span>{status}</span>}
        </div>,
        document.body
    );
}
