import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FILLMODE_FILL_WINDOW, RESOLUTION_AUTO, type BoundingBox } from 'playcanvas';
import { Application } from '@playcanvas/react';
import {
    defaultExperience, lensRanges, loadExperience, sceneLens, sceneLighting, sceneObjects, settingsUrlFor, verticalFov,
    type CameraPose, type ExperienceSettings, type SceneObject, type Vec3Tuple
} from './scene/experience';
import { findSplats, splatUrl } from './scene/splats';
import { SplatSetup } from './viewer/SplatSetup';
import { Splat } from './viewer/Splat';
import { SceneLighting, SceneObjects } from './viewer/SceneObjects';
import { ViewerCamera, type CameraApi, type ViewRequest } from './viewer/ViewerCamera';
import { FrameStats } from './viewer/FrameStats';
import { ScenePointer } from './viewer/ScenePointer';
import { AutoFocus } from './viewer/AutoFocus';
import { MeasureOverlay, measuredLength } from './viewer/MeasureOverlay';
import { useDebugPanel, useLensPanel, useLookPanel, useSplatPanel } from './ui/panel';

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
    const [measuring, setMeasuring] = useState(false);
    const [measurePoints, setMeasurePoints] = useState<Vec3Tuple[]>([]);
    const [afPoint, setAfPoint] = useState({ x: 0.5, y: 0.5 });
    const cameraApi = useRef<CameraApi>(null);
    // the focus distance the lens uses, m: the slider in manual, autofocus in auto
    const focus = useRef(3);

    useEffect(() => { findSplats().then(setSplats); }, []);

    // a click in the image moves the AF point (autofocus only, as on a camera)
    const imageClick = useCallback((x: number, y: number) => {
        if (live.current.lensPanel.lens.focusMode !== 'auto') return;
        setAfPoint({ x: x / window.innerWidth, y: y / window.innerHeight });
    }, []);

    // autofocus on the middle of the image
    const afCenter = useCallback(() => {
        setAfPoint({ x: 0.5, y: 0.5 });
        live.current.lensPanel.apply({ focusMode: 'auto' });
    }, []);

    const startMeasure = useCallback(() => {
        setMeasuring(true);
        setMeasurePoints([]);
        setStatus('measure: click two points · Esc stops');
    }, []);

    const stopMeasure = useCallback(() => {
        setMeasuring(false);
        setMeasurePoints([]);
        setStatus('');
    }, []);

    // a third click starts a new measurement
    const measureClick = useCallback(async (x: number, y: number) => {
        const p = await cameraApi.current?.pick(x, y);
        if (!p) {
            setStatus('nothing to measure there');
            return;
        }
        setMeasurePoints(pts => (pts.length >= 2 ? [p] : [...pts, p]));
    }, []);

    const applyScale = useCallback((realLength: number) => {
        const units = measuredLength(live.current.measurePoints);
        if (!units) {
            setStatus('measure two points first');
            return;
        }
        const r = lensRanges.metersPerUnit;
        const mpu = Math.min(Math.max(realLength / units, r.min), r.max);
        live.current.lensPanel.apply({ metersPerUnit: mpu });
        setStatus(`scale ${mpu.toFixed(3)} m per unit`);
    }, []);

    const look = useLookPanel();
    const lensPanel = useLensPanel({ onAfCenter: afCenter, onMeasure: startMeasure, onApplyScale: applyScale });
    const debug = useDebugPanel();

    // panel callbacks change identity every render; the handlers below read
    // the current ones through refs so they can stay stable
    const live = useRef({ look, lensPanel, experience, framing, measurePoints });
    live.current = { look, lensPanel, experience, framing, measurePoints };

    // Manual focus follows the slider. Switching from auto to manual keeps
    // the distance autofocus had reached, as a camera does.
    const lens = lensPanel.lens;
    const prevMode = useRef(lens.focusMode);
    if (lens.focusMode === 'manual' && prevMode.current === 'manual') focus.current = lens.focusDistance;
    useEffect(() => {
        if (prevMode.current === 'auto' && lens.focusMode === 'manual') {
            const r = lensRanges.focusDistance;
            live.current.lensPanel.apply({ focusDistance: Math.min(Math.max(focus.current, r.min), r.max) });
        }
        prevMode.current = lens.focusMode;
    }, [lens.focusMode]);
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
        const sceneLensSettings = sceneLens(result.settings);
        live.current.lensPanel.apply(sceneLensSettings);
        focus.current = sceneLensSettings.focusDistance;
        setExperience(result.settings);
        setFraming(null);
        setLoaded(name);
    }, []);

    const unload = useCallback(() => {
        setLoaded(null);
        setMeasuring(false);
        setMeasurePoints([]);
        setExperience(defaultExperience());
        setFraming(null);
        setStatus('');
    }, []);

    const resetView = useCallback(() => {
        const { experience, framing } = live.current;
        const pose = experience.cameras[0]?.initial ?? framing?.pose;
        if (pose) setView({ pose, id: Date.now() });
    }, []);

    // the current look, view and lens as Experience Settings v2; everything
    // else in the loaded file (annotations, tracks, other extras) is kept
    const save = useCallback(() => {
        const name = loadedRef.current;
        const v = cameraApi.current?.getView();
        if (!name || !v) {
            setStatus('load a splat first');
            return;
        }
        const { look, lensPanel: { lens }, experience } = live.current;
        // `fov` stays filled for SuperSplat; the lens is the real source
        const pose: CameraPose = { position: v.position, target: v.target, fov: verticalFov(lens) };
        const out: ExperienceSettings = {
            ...experience,
            tonemapping: look.tonemapping,
            highPrecisionRendering: look.highPrecision,
            background: { color: look.background },
            postEffectSettings: look.postEffects,
            cameras: [{ initial: pose }, ...experience.cameras.slice(1)],
            extras: { ...experience.extras, lens: { ...lens, focusDistance: focus.current } }
        };
        download(settingsUrlFor(splatUrl(name)).split('/').pop()!, out);
        setStatus('settings saved (download) · put the file next to the splat');
    }, []);

    const onReady = useCallback((bounds: BoundingBox | null) => {
        const { experience, lensPanel } = live.current;
        const saved = experience.cameras[0]?.initial;
        const fit = frameBounds(bounds, verticalFov(lensPanel.lens));
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
                    lens={lensPanel.lens}
                    focus={focus}
                    farClip={farClip}
                    debugView={debug.view}
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
                <ScenePointer
                    measuring={measuring}
                    onClick={imageClick}
                    onMeasureClick={measureClick}
                    onCancel={stopMeasure}
                />
                <AutoFocus
                    active={!!loaded && lens.dof && lens.focusMode === 'auto'}
                    point={afPoint}
                    transition={lens.afTransition}
                    metersPerUnit={lens.metersPerUnit}
                    trigger={loaded ?? ''}
                    api={cameraApi}
                    focus={focus}
                />
                <MeasureOverlay points={measurePoints} metersPerUnit={lensPanel.lens.metersPerUnit} api={cameraApi} />
                <FrameStats status={status} loaded={loaded} />
            </Application>
            {hint && <div className="hint">{hint}</div>}
        </>
    );
}
