import { useCallback, useEffect, useRef, useState } from 'react';
import { FILLMODE_FILL_WINDOW, RESOLUTION_AUTO, type BoundingBox } from 'playcanvas';
import { Application } from '@playcanvas/react';
import { loadExperience, type CameraPose, type ExperienceSettings } from './scene/experience';
import { findSplats, splatUrl } from './scene/splats';
import { SplatSetup } from './viewer/SplatSetup';
import { Splat } from './viewer/Splat';
import { ViewerCamera, type ViewRequest } from './viewer/ViewerCamera';
import { FrameStats } from './viewer/FrameStats';
import { useCameraPanel, useLookPanel, useSplatPanel } from './ui/panel';

// A view for a splat without saved camera: look at the middle of its bounds
// from a bit back and up.
function framePose(bounds: BoundingBox | null, fov: number): CameraPose {
    if (!bounds) return { position: [0, 1, 4], target: [0, 0, 0], fov };
    const c = bounds.center;
    const r = Math.max(bounds.halfExtents.length(), 0.5);
    return { position: [c.x, c.y + r * 0.25, c.z + r * 0.8], target: [c.x, c.y, c.z], fov };
}

export function App() {
    const [splats, setSplats] = useState<string[] | null>(null);
    const [loaded, setLoaded] = useState<string | null>(null);
    const [status, setStatus] = useState('');
    const [view, setView] = useState<ViewRequest | null>(null);
    const experience = useRef<ExperienceSettings | null>(null);
    const home = useRef<CameraPose | null>(null);

    useEffect(() => { findSplats().then(setSplats); }, []);

    const look = useLookPanel();
    const camera = useCameraPanel();
    const applyLook = useRef(look.apply);
    applyLook.current = look.apply;
    const fov = useRef(camera.fov);
    fov.current = camera.fov;
    const setCamera = useRef(camera.set);
    setCamera.current = camera.set;

    // settings first, then the splat, so the camera can go straight to its
    // saved view once the splat is there
    const load = useCallback(async (name: string) => {
        if (!name) return;
        setStatus(`loading ${name}…`);
        const result = await loadExperience(splatUrl(name));
        experience.current = result.settings;
        applyLook.current(result.settings);
        if (result.warning) console.warn(result.warning);
        setLoaded(name);
    }, []);

    const unload = useCallback(() => {
        setLoaded(null);
        experience.current = null;
        setStatus('');
    }, []);

    const resetView = useCallback(() => {
        if (home.current) setView({ pose: home.current, id: Date.now() });
    }, []);

    const onReady = useCallback((bounds: BoundingBox | null) => {
        const saved = experience.current?.cameras[0]?.initial;
        if (saved) setCamera.current({ fov: saved.fov });
        const pose = saved ?? framePose(bounds, fov.current);
        home.current = pose;
        setView({ pose, id: Date.now() });
        setStatus(saved ? 'view from settings' : '');
    }, []);

    const onError = useCallback((message: string) => setStatus(`failed: ${message}`), []);

    const splatPanel = useSplatPanel({ splats: splats ?? [], onLoad: load, onUnload: unload, onResetView: resetView });

    const hint = splats === null ? ''
        : splats.length === 0 ? 'No splats found. Put .ply / .sog files in the mounted splats folder.'
        : loaded ? '' : 'Pick a splat and press Load.';

    return (
        <>
            <Application
                className="viewport"
                graphicsDeviceOptions={{ antialias: false }}
                fillMode={FILLMODE_FILL_WINDOW}
                resolutionMode={RESOLUTION_AUTO}
            >
                <SplatSetup />
                <ViewerCamera
                    view={view}
                    fov={camera.fov}
                    tonemapping={look.tonemapping}
                    highPrecision={look.highPrecision}
                    postEffects={look.postEffects}
                    background={look.background}
                />
                {loaded && (
                    <Splat
                        key={loaded}
                        src={splatUrl(loaded)}
                        orientation={splatPanel.orientation}
                        onReady={onReady}
                        onError={onError}
                    />
                )}
                <FrameStats status={status} loaded={loaded} />
            </Application>
            {hint && <div className="hint">{hint}</div>}
        </>
    );
}
