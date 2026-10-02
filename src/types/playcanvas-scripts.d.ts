// The engine's ready-made scripts ship as plain .mjs without typings. These
// declare just the parts this app uses.

declare module 'playcanvas/scripts/esm/camera-controls.mjs' {
    import { Script, Vec3 } from 'playcanvas';

    export class CameraControls extends Script {
        static scriptName: string;
        enableFly: boolean;
        enableOrbit: boolean;
        enablePan: boolean;
        moveSpeed: number;
        moveFastSpeed: number;
        moveSlowSpeed: number;
        rotateSpeed: number;
        zoomSpeed: number;
        /** Animate to look at `focus` from `position`. */
        reset(focus: Vec3, position: Vec3): void;
        focus(point: Vec3, resetZoom?: boolean): void;
    }
}

declare module 'playcanvas/scripts/esm/camera-frame.mjs' {
    import { Color, Script } from 'playcanvas';

    export class CameraFrame extends Script {
        static scriptName: string;
        rendering: {
            toneMapping: 'linear' | 'filmic' | 'hejl' | 'aces' | 'aces2' | 'neutral';
            sharpness: number;
            samples: number;
            renderTargetScale: number;
            renderFormat: 'rgba8' | 'rg11b10' | 'rgba16' | 'rgba32';
            renderFormatFallback0: 'rgba8' | 'rg11b10' | 'rgba16' | 'rgba32';
            renderFormatFallback1: 'rgba8' | 'rg11b10' | 'rgba16' | 'rgba32';
        };
        bloom: { enabled: boolean; intensity: number; blurLevel: number; threshold: number };
        grading: { enabled: boolean; brightness: number; contrast: number; saturation: number; tint: Color };
        vignette: { enabled: boolean; intensity: number; inner: number; outer: number; curvature: number; color: Color };
        fringing: { enabled: boolean; intensity: number };
    }
}
