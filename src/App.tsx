import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FILLMODE_FILL_WINDOW, RESOLUTION_AUTO, type BoundingBox } from 'playcanvas';
import { Application } from '@playcanvas/react';
import {
    defaultExperience, loadExperience, sceneLighting, sceneObjects, settingsUrlFor,
    type CameraPose, type ExperienceSettings, type SceneObject
} from './scene/experience';
import { findSplats, splatUrl } from './scene/splats';
import { SplatSetup } from './viewer/SplatSetup';
import { Splat } from './viewer/Splat';
import { SceneLighting, SceneObjects } from './viewer/SceneObjects';
import { ViewerCamera, type CameraApi, type ViewRequest } from './viewer/ViewerCamera';
import { FrameStats } from './viewer/FrameStats';
import { useCameraPanel, useDebugPanel, useLookPanel, useSplatPanel } from './ui/panel';

type Framing = { pose: CameraPose; radius: number };

// A view for a splat without saved camera: look at the middle of its bounds
// from a bit back and up.
function frameBounds(bounds: BoundingBox | null, fov: number): Framing {
    if (!bounds) return { pose: { position: [0, 1, 4], target: [0, 0, 0], fov }, radius: 5 };
    const c = bounds.center;
    const r = Math.max(bounds.halfExtents.length(), 0.5);
    return { pose: { position: [c.x, c.y + r * 0.25, c.z + r * 0.8], target: [c.x, c.y, c.z], fov }, radius: r };
}

// Two objects where the start view looks, to check how objects and splats
// share depth: an opaque box, and a glass sphere that does not write depth.
function testObjects(pose: CameraPose): SceneObject[] {
    const [x, y, z] = pose.target;
    const [px, py, pz] = pose.position;
    const s = Math.hypot(x - px, y - py, z - pz) * 0.06;
    return [
        {
            id: 'test-opaque-box', type: 'box', position: [x - s, y, z], rotation: [0, 30, 0], scale: [s, s, s],
            material: { color: [0.85, 0.2, 0.15], opacity: 1, emissive: [0, 0, 0], metalness: 0, gloss: 0.5 }
        },
        {
            id: 'test-glass-sphere', type: 'sphere', position: [x + s, y, z], rotation: [0, 0, 0], scale: [s, s, s],
            material: { color: [0.3, 0.6, 1], opacity: 0.4, emissive: [0, 0, 0], metalness: 0, gloss: 0.9 }
        }
    ];
}

function download(name: string, data: unknown) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function App() {
    const [splats, setSplats] = useState<string[] | null>(null);
    const [loaded, setLoaded] = useState<string | null>(null);
    const [experience, setExperience] = useState<ExperienceSettings>(defaultExperience);
    const [framing, setFraming] = useState<Framing | null>(null);
    const [status, setStatus] = useState('');
    const [view, setView] = useState<ViewRequest | null>(null);
    const cameraApi = useRef<CameraApi>(null);

    useEffect(() => { findSplats().then(setSplats); }, []);

    const look = useLookPanel();
    const camera = useCameraPanel();
    const debug = useDebugPanel();

    // panel callbacks change identity every render; the handlers below read
    // the current ones through refs so they can stay stable
    const live = useRef({ look, camera, experience, framing });
    live.current = { look, camera, experience, framing };
    const loadedRef = useRef(loaded);
    loadedRef.current = loaded;

    // settings first, then the splat, so the camera can go straight to its
    // saved view once the splat is there
    const load = useCallback(async (name: string) => {
        if (!name) return;
        setStatus(`loading ${name}…`);
        const result = await loadExperience(splatUrl(name));
        if (result.warning) console.warn(result.warning);
        live.current.look.apply(result.settings);
        setExperience(result.settings);
        setFraming(null);
        setLoaded(name);
    }, []);

    const unload = useCallback(() => {
        setLoaded(null);
        setExperience(defaultExperience());
        setFraming(null);
        setStatus('');
    }, []);

    const resetView = useCallback(() => {
        const { experience, framing } = live.current;
        const pose = experience.cameras[0]?.initial ?? framing?.pose;
        if (pose) setView({ pose, id: Date.now() });
    }, []);

    // the current look and view as Experience Settings v2; everything else in
    // the loaded file (annotations, tracks, extras) is kept as it was
    const save = useCallback(() => {
        const name = loadedRef.current;
        const pose = cameraApi.current?.getPose();
        if (!name || !pose) {
            setStatus('load a splat first');
            return;
        }
        const { look, experience } = live.current;
        const out: ExperienceSettings = {
            ...experience,
            tonemapping: look.tonemapping,
            highPrecisionRendering: look.highPrecision,
            background: { color: look.background },
            postEffectSettings: look.postEffects,
            cameras: [{ initial: pose }, ...experience.cameras.slice(1)]
        };
        download(settingsUrlFor(splatUrl(name)).split('/').pop()!, out);
        setStatus('settings saved (download) · put the file next to the splat');
    }, []);

    const onReady = useCallback((bounds: BoundingBox | null) => {
        const { experience, camera } = live.current;
        const saved = experience.cameras[0]?.initial;
        const fit = frameBounds(bounds, camera.fov);
        if (saved) camera.set({ fov: saved.fov });
        setFraming(fit);
        setView({ pose: saved ?? fit.pose, id: Date.now() });
        setStatus(saved ? 'view from settings' : '');
    }, []);

    const onError = useCallback((message: string) => setStatus(`failed: ${message}`), []);

    const splatPanel = useSplatPanel({
        splats: splats ?? [], onLoad: load, onUnload: unload, onResetView: resetView, onSave: save
    });

    const objects = useMemo(() => {
        const list = sceneObjects(experience);
        const home = experience.cameras[0]?.initial ?? framing?.pose;
        if (debug.testObjects && home) list.push(...testObjects(home));
        return list;
    }, [experience, debug.testObjects, framing]);
    const lighting = useMemo(() => sceneLighting(experience), [experience]);

    // far plane just beyond the scene: more depth precision, and a depth view
    // that uses its whole range
    const farClip = framing ? framing.radius * 6 : 1000;

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
                    farClip={farClip}
                    depthView={debug.depthView}
                    api={cameraApi}
                    tonemapping={look.tonemapping}
                    highPrecision={look.highPrecision}
                    postEffects={look.postEffects}
                    background={look.background}
                />
                <SceneLighting lighting={lighting} />
                {loaded && (
                    <Splat
                        key={loaded}
                        src={splatUrl(loaded)}
                        orientation={splatPanel.orientation}
                        onReady={onReady}
                        onError={onError}
                    />
                )}
                {loaded && <SceneObjects objects={objects} />}
                <FrameStats status={status} loaded={loaded} />
            </Application>
            {hint && <div className="hint">{hint}</div>}
        </>
    );
}
