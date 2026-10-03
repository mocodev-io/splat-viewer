import { useEffect, useRef } from 'react';
import { useApp } from '@playcanvas/react/hooks';

type ScenePointerProps = {
    measuring: boolean;
    /** a click without dragging, canvas CSS pixels (not while measuring) */
    onClick: (x: number, y: number) => void;
    /** a click without dragging while measuring, canvas CSS pixels */
    onMeasureClick: (x: number, y: number) => void;
    /** a double click (not while measuring), canvas CSS pixels */
    onDoubleClick: (x: number, y: number) => void;
    onCancel: () => void;
};

// Clicks in the image. Dragging stays with CameraControls: a click only
// counts when the pointer did not move between press and release.
export function ScenePointer({ measuring, onClick, onMeasureClick, onDoubleClick, onCancel }: ScenePointerProps) {
    const app = useApp();
    const handlers = useRef({ measuring, onClick, onMeasureClick, onDoubleClick, onCancel });
    handlers.current = { measuring, onClick, onMeasureClick, onDoubleClick, onCancel };

    useEffect(() => {
        const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
        const local = (e: MouseEvent) => {
            const r = canvas.getBoundingClientRect();
            return [e.clientX - r.left, e.clientY - r.top] as const;
        };
        let down: readonly [number, number] | null = null;

        const onDown = (e: PointerEvent) => { if (e.button === 0) down = local(e); };
        const onUp = (e: PointerEvent) => {
            if (e.button !== 0 || !down) return;
            const [x, y] = local(e);
            const still = Math.hypot(x - down[0], y - down[1]) < 4;
            down = null;
            if (!still) return;
            if (handlers.current.measuring) handlers.current.onMeasureClick(x, y);
            else handlers.current.onClick(x, y);
        };
        const onDouble = (e: MouseEvent) => {
            if (e.button !== 0 || handlers.current.measuring) return;
            const [x, y] = local(e);
            handlers.current.onDoubleClick(x, y);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && handlers.current.measuring) handlers.current.onCancel();
        };

        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('dblclick', onDouble);
        window.addEventListener('keydown', onKey);
        return () => {
            canvas.removeEventListener('pointerdown', onDown);
            canvas.removeEventListener('pointerup', onUp);
            canvas.removeEventListener('dblclick', onDouble);
            window.removeEventListener('keydown', onKey);
        };
    }, [app]);

    return null;
}
