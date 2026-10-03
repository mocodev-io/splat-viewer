import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FILLMODE_FILL_WINDOW, RESOLUTION_AUTO, type BoundingBox } from 'playcanvas';
import { Application } from '@playcanvas/react';
import {
    defaultExperience, focusRatio, frameShape, lensRanges, sceneLens, sceneLighting, sceneObjects, sceneViewport, verticalFov,
    type CameraPose, type ExperienceSettings, type SceneObject, type Vec3Tuple
} from './scene/experience';
import { findSplats, splatUrl } from './scene/splats';
import { findPresets, loadPreset, presetName, savePreset } from './scene/presets';
import { SplatSetup } from './viewer/SplatSetup';
import { ORIENTATIONS, Splat, type Orientation } from './viewer/Splat';
import { SceneLighting, SceneObjects } from './viewer/SceneObjects';
import { ViewerCamera, type CameraApi, type NavMode, type ViewRequest } from './viewer/ViewerCamera';
import { FrameStats } from './viewer/FrameStats';
import { ScenePointer } from './viewer/ScenePointer';
import { AutoFocus } from './viewer/AutoFocus';
import { MeasureOverlay, measuredLength } from './viewer/MeasureOverlay';
import { useDebugPanel, useLensPanel, useLookPanel, useScenePanel } from './ui/panel';
import { NavBar } from './ui/NavBar';

type Framing = { pose: CameraPose; radius: number };

// The view a splat opens with (and Frame goes back to): the middle of its
// bounds, from a bit back and up.
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

// what else the loaded file keeps under `extras.look`, so saving keeps it
function lookExtras(s: ExperienceSettings): Record<string, unknown> {
    const look = s.extras?.look;
    return typeof look === 'object' && look !== null && !Array.isArray(look) ? { ...look } : {};
}

// how the splat stands, kept under `extras.scene`
function sceneOrientation(s: ExperienceSettings): Orientation | undefined {
    const scene = s.extras?.scene;
    const o = typeof scene === 'object' && scene !== null ? (scene as { orientation?: unknown }).orientation : undefined;
    return ORIENTATIONS.includes(o as Orientation) ? o as Orientation : undefined;
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
    const [presets, setPresets] = useState<string[]>([]);
    const [navMode, setNavMode] = useState<NavMode>('auto');
    const [speedStep, setSpeedStep] = useState(0);
    const cameraApi = useRef<CameraApi>(null);
    // the focus distance the lens uses, m: the slider in manual, autofocus in auto
    const focus = useRef(3);

    useEffect(() => {
        findSplats().then(setSplats);
        findPresets().then(setPresets);
    }, []);

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
    const live = useRef({ look, lensPanel, experience, framing, measurePoints, presets, loaded });
    live.current = { look, lensPanel, experience, framing, measurePoints, presets, loaded };
    // the splat panel is made further down (its buttons need the handlers)
    const splatRef = useRef<ReturnType<typeof useScenePanel> | null>(null);

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

    // A splat loads on its own: the settings stay as they are (until the
    // page is reloaded), the camera frames the new splat.
    const load = useCallback((name: string) => {
        if (!name || name === live.current.loaded) return;
        setStatus(`loading ${name}…`);
        setFraming(null);
        setLoaded(name);
    }, []);

    const unload = useCallback(() => {
        setLoaded(null);
        setMeasuring(false);
        setMeasurePoints([]);
        setFraming(null);
        setStatus('');
    }, []);

    // the whole splat in view
    const frame = useCallback(() => {
        const pose = live.current.framing?.pose;
        if (pose) setView({ pose, id: Date.now() });
    }, []);

    // double click: turn towards that point and orbit around it
    const setOrbitPoint = useCallback(async (x: number, y: number) => {
        const api = cameraApi.current;
        const p = await api?.pick(x, y);
        if (p) api?.lookAt(p);
    }, []);

    // Settings files: everything in the panels, for any splat. Loading one
    // puts it into the panels; objects, lights and whatever else the file
    // holds (annotations, tracks, other extras) are kept for saving.
    const loadSettings = useCallback(async (name: string) => {
        if (!name) {
            setStatus('no settings saved yet');
            return;
        }
        const result = await loadPreset(name);
        if (result.error) {
            console.warn(result.error);
            setStatus(result.error);
            return;
        }
        const s = result.settings;
        live.current.look.apply(s);
        splatRef.current?.apply({ background: s.background.color, orientation: sceneOrientation(s) });
        const sceneLensSettings = sceneLens(s);
        live.current.lensPanel.apply(sceneLensSettings);
        live.current.lensPanel.applyViewport(sceneViewport(s));
        focus.current = sceneLensSettings.focusDistance;
        setExperience(s);
        setStatus(`settings ${name}`);
    }, []);

    // the panels as Experience Settings v2, under a name in the settings folder
    const pendingPreset = useRef<string | null>(null);
    const saveSettings = useCallback(async (typed: string) => {
        const name = presetName(typed);
        if (!name) {
            setStatus('type a name to save under');
            return;
        }
        if (live.current.presets.includes(name) && !window.confirm(`Overwrite the settings "${name}"?`)) return;
        const { look, lensPanel: { lens, viewport }, experience } = live.current;
        const scene = splatRef.current;
        const out: ExperienceSettings = {
            ...experience,
            tonemapping: look.tonemapping,
            highPrecisionRendering: look.highPrecision,
            background: { color: scene?.background ?? experience.background.color },
            postEffectSettings: look.postEffects,
            extras: {
                ...experience.extras,
                lens: { ...lens, focusDistance: focus.current },
                look: {
                    ...lookExtras(experience),
                    grain: look.grain,
                    halation: look.halation,
                    film: look.film.id,
                    filmFilter: look.film.filter,
                    filmStrength: look.film.strength,
                    vignette: look.lensVignette
                },
                viewport,
                scene: { orientation: scene?.orientation }
            }
        };
        const error = await savePreset(name, out);
        if (error) {
            setStatus(error);
            return;
        }
        pendingPreset.current = name;
        setPresets(await findPresets());
        setStatus(`settings saved as ${name}`);
    }, []);

    const onReady = useCallback((bounds: BoundingBox | null) => {
        const fit = frameBounds(bounds, verticalFov(live.current.lensPanel.lens));
        setFraming(fit);
        setView({ pose: fit.pose, id: Date.now() });
        setStatus('');
    }, []);

    const onError = useCallback((message: string) => setStatus(`failed: ${message}`), []);

    const splatPanel = useScenePanel({
        splats: splats ?? [], presets, onLoad: load, onUnload: unload, onLoadSettings: loadSettings, onSaveSettings: saveSettings
    });

    // a saved file is chosen in the list once the list has it
    useEffect(() => {
        const name = pendingPreset.current;
        if (name && presets.includes(name)) {
            pendingPreset.current = null;
            splatRef.current?.choosePreset(name);
        }
    }, [presets]);

    // the fly speed suits the splat's size; the bar scales it in powers of two
    const navigation = useMemo(
        () => ({ mode: navMode, speed: Math.max(framing?.radius ?? 5, 0.5) * 0.5 * 2 ** speedStep }),
        [navMode, speedStep, framing]
    );

    const objects = useMemo(() => {
        const list = sceneObjects(experience);
        const home = framing?.pose;
        if (debug.testObjects && home) list.push(...testObjects(home));
        return list;
    }, [experience, debug.testObjects, framing]);
    const lighting = useMemo(() => sceneLighting(experience), [experience]);

    // what the camera shows besides itself and the lens: a change restarts the
    // still DoF and wakes the renderer up
    splatRef.current = splatPanel;
    const sceneKey = JSON.stringify([loaded, splatPanel.orientation, objects, lighting]);
    const stillProgress = useRef('');

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
                graphicsDeviceOptions={{ antialias: false, alpha: false }}
                fillMode={FILLMODE_FILL_WINDOW}
                resolutionMode={RESOLUTION_AUTO}
            >
                <SplatSetup />
                <ViewerCamera
                    view={view}
                    navigation={navigation}
                    lens={lensPanel.lens}
                    focus={focus}
                    farClip={farClip}
                    debugView={debug.view}
                    depthRange={debug.depthRange}
                    api={cameraApi}
                    tonemapping={look.tonemapping}
                    highPrecision={look.highPrecision}
                    postEffects={look.postEffects}
                    grain={look.grain}
                    halation={look.halation}
                    film={look.film}
                    lensVignette={look.lensVignette}
                    viewport={lensPanel.viewport}
                    background={splatPanel.background}
                    sceneKey={sceneKey}
                    busy={!!loaded && !framing}
                    progress={stillProgress}
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
                    onDoubleClick={setOrbitPoint}
                    onCancel={stopMeasure}
                />
                <AutoFocus
                    active={!!loaded && lens.dof && lens.focusMode === 'auto'}
                    showFrame={lens.afFrame}
                    frameShape={frameShape(lens, lensPanel.viewport.frameStyle)}
                    focusRatioAt={(qx, qy) => focusRatio(lens, qx, qy)}
                    point={afPoint}
                    transition={lens.afTransition}
                    metersPerUnit={lens.metersPerUnit}
                    trigger={loaded ?? ''}
                    api={cameraApi}
                    focus={focus}
                />
                <MeasureOverlay points={measurePoints} metersPerUnit={lensPanel.lens.metersPerUnit} api={cameraApi} />
                <FrameStats status={status} loaded={loaded} progress={stillProgress} />
            </Application>
            <NavBar
                mode={navMode}
                onMode={setNavMode}
                speedStep={speedStep}
                onSpeedStep={setSpeedStep}
                onFrame={frame}
                disabled={!framing}
            />
            {hint && <div className="hint">{hint}</div>}
        </>
    );
}
