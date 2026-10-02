import { useEffect } from 'react';
import { useApp } from '@playcanvas/react/hooks';
import { installLensDof } from './lensDof';

// Scene-wide splat settings, applied once before anything loads.
// Values follow the SuperSplat viewer (viewer.ts), except sceneDepthWrite.
export function SplatSetup() {
    const app = useApp();

    useEffect(() => {
        const gsplat = app.scene.gsplat;
        // Splats write their (coverage weighted) depth in the scene pass, so
        // depth-based effects (DoF, fog, SSAO) and mixed-in meshes see them.
        // Engine PR #9174; needs CameraFrame without MSAA.
        gsplat.sceneDepthWrite = true;
        // sorting by distance instead of view depth: no unsorted splats at the
        // screen sides while turning on slow devices
        gsplat.radialSorting = true;
        gsplat.minContribution = 1;
        gsplat.alphaClip = 1 / 255;

        // the lens DoF goes into the compose shader before it is first built
        installLensDof(app);

        // handy from the browser console
        (window as unknown as { viewer: unknown }).viewer = { app };
    }, [app]);

    return null;
}
