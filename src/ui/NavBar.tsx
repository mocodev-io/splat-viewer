import { useEffect, useRef } from 'react';
import type { NavMode } from '../viewer/ViewerCamera';

type NavBarProps = {
    mode: NavMode;
    onMode: (mode: NavMode) => void;
    /** fly speed as a power of two of the speed that suits the splat's size */
    speedStep: number;
    onSpeedStep: (step: number) => void;
    onFrame: () => void;
    disabled: boolean;
};

const MODES: { mode: NavMode; label: string; title: string }[] = [
    { mode: 'auto', label: 'Auto', title: 'Left drag / wheel orbits, right drag / WASD flies' },
    { mode: 'orbit', label: 'Orbit', title: 'Left drag turns around the orbit point, Shift or middle drag pans, wheel zooms' },
    { mode: 'fly', label: 'Fly', title: 'Drag looks around, WASD moves, Q / E down / up' }
];

export const SPEED_STEPS = { min: -4, max: 4 };

// The moving tools, as a bar at the top left: orbit / fly (the engine's
// CameraControls, as the SuperSplat viewer uses them), the fly speed, and
// framing the splat. A double click in the image sets the orbit point
// (ScenePointer). F frames the splat.
export function NavBar({ mode, onMode, speedStep, onSpeedStep, onFrame, disabled }: NavBarProps) {
    const handlers = useRef({ onFrame, disabled });
    handlers.current = { onFrame, disabled };

    useEffect(() => {
        const editable = (t: EventTarget | null) =>
            t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
        // Typing in the panel must not fly the camera: CameraControls reads
        // the keys on window, so they stop at the document when they come
        // from a text field.
        const onKeyDown = (e: KeyboardEvent) => {
            if (editable(e.target)) {
                e.stopPropagation();
                return;
            }
            if (e.code === 'KeyF' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !handlers.current.disabled) {
                handlers.current.onFrame();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    const factor = 2 ** speedStep;
    return (
        <div className="navbar" aria-disabled={disabled}>
            <div className="navbar-group" role="radiogroup" aria-label="Navigation">
                {MODES.map(m => (
                    <button
                        key={m.mode}
                        type="button"
                        role="radio"
                        aria-checked={mode === m.mode}
                        className={mode === m.mode ? 'on' : ''}
                        title={m.title}
                        onClick={() => onMode(m.mode)}
                    >
                        {m.label}
                    </button>
                ))}
            </div>
            <label className="navbar-speed" title="Fly speed (Shift faster, Ctrl slower)">
                <span>Speed</span>
                <input
                    type="range"
                    min={SPEED_STEPS.min}
                    max={SPEED_STEPS.max}
                    step={0.25}
                    value={speedStep}
                    onChange={e => onSpeedStep(Number(e.target.value))}
                    onDoubleClick={() => onSpeedStep(0)}
                />
                <span className="navbar-value">×{factor < 1 ? factor.toFixed(2) : factor.toFixed(1)}</span>
            </label>
            <button type="button" title="The whole splat in view (F)" disabled={disabled} onClick={onFrame}>Frame</button>
            <span className="navbar-hint">double click: orbit point</span>
        </div>
    );
}
