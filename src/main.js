import * as pc from 'playcanvas';
import { defaults } from './settings.js';
import { CameraRig } from './camera.js';
import { Post } from './post.js';
import { Performance } from './perf.js';
import { LutLibrary, listFolder } from './luts.js';
import { Panel } from './ui.js';

const SPLAT_FILE = /\.(ply|sog)$/i;
const SPLAT_META = /^(lod-)?meta\.json$/i;

const $ = id => document.getElementById(id);
const settings = defaults();

// ------------------------------------------------------------------ app

const canvas = $('canvas');
const device = await pc.createGraphicsDevice(canvas, {
    deviceTypes: ['webgl2'],   // the custom compose shader is GLSL
    antialias: false,
    depth: false,
    stencil: false,
    alpha: false,
    powerPreference: 'high-performance'
});
device.maxPixelRatio = 1;      // perf.js takes over from the first frame

const options = new pc.AppOptions();
options.graphicsDevice = device;
options.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem, pc.LightComponentSystem, pc.GSplatComponentSystem];
options.resourceHandlers = [pc.TextureHandler, pc.GSplatHandler];

const app = new pc.AppBase(canvas);
app.init(options);
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
window.addEventListener('resize', () => app.resizeCanvas());

const camera = new pc.Entity('camera');
camera.addComponent('camera', {
    clearColor: new pc.Color(0, 0, 0),
    nearClip: 0.02,
    farClip: 2000
});
app.root.addChild(camera);

const sun = new pc.Entity('sun');
sun.addComponent('light', {
    type: 'directional',
    castShadows: false,
    shadowResolution: 2048,
    shadowDistance: 60,
    shadowBias: 0.2,
    normalOffsetBias: 0.05
});
sun.enabled = false;
app.root.addChild(sun);

// ------------------------------------------------------------------ hud

let statusTimer = 0;
function status(text, sticky = false) {
    $('status').textContent = text;
    clearTimeout(statusTimer);
    if (!sticky) statusTimer = setTimeout(() => { $('status').textContent = ''; }, 2500);
}

function hint(text) {
    $('empty-hint').textContent = text;
    $('empty-hint').hidden = !text;
}

let panel = null;
const events = {
    onSettingsChanged: () => panel?.refresh(),
    onStatus: status
};
const rig = new CameraRig(app, camera, settings, events);
const perf = new Performance(app, settings, events);
const luts = new LutLibrary(device);
const post = new Post(app, camera, sun, settings, luts);

// ------------------------------------------------------------------ splats

let splatEntity = null;
let splatAsset = null;
let loadToken = 0;

async function findSplats() {
    const entries = await listFolder('splats/');
    const found = entries.filter(e => e.type === 'file' && SPLAT_FILE.test(e.name)).map(e => e.name);
    // unbundled SOG / LOD streaming output lives in a folder with a meta.json
    for (const dir of entries.filter(e => e.type === 'directory')) {
        const inner = await listFolder(`splats/${encodeURIComponent(dir.name)}/`);
        const meta = inner.find(e => e.type === 'file' && SPLAT_META.test(e.name));
        if (meta) found.push(`${dir.name}/${meta.name}`);
    }
    return found;
}

function releaseSplat() {
    splatEntity?.destroy();
    splatEntity = null;
    if (splatAsset) {
        app.assets.remove(splatAsset);
        splatAsset.unload();
        splatAsset = null;
    }
}

function loadSplat(name) {
    if (!name) return;
    const token = ++loadToken;
    status(`loading ${name}…`, true);
    hint('');
    const url = `splats/${name.split('/').map(encodeURIComponent).join('/')}`;
    const asset = new pc.Asset(name, 'gsplat', { url });
    asset.on('error', err => {
        if (token !== loadToken) return;
        status(`failed: ${err}`);
        hint(splatEntity ? '' : 'Loading failed, see the browser console.');
        console.error(err);
    });
    asset.ready(() => {
        if (token !== loadToken) {
            app.assets.remove(asset);
            asset.unload();
            return;
        }
        releaseSplat();
        splatAsset = asset;
        splatEntity = new pc.Entity('splat');
        splatEntity.addComponent('gsplat', { asset });
        app.root.addChild(splatEntity);
        lastFlip = null;
        applySceneSettings();

        // frame the splat once its bounds are known
        app.once('frameend', () => {
            const aabb = splatEntity?.gsplat?.customAabb ?? splatAsset?.resource?.aabb;
            if (aabb) {
                const world = new pc.BoundingBox();
                world.setFromTransformedAabb(aabb, splatEntity.getWorldTransform());
                rig.setHome(world);
            }
            status(name);
        });
    });
    app.assets.add(asset);
    app.assets.load(asset);
}

function unloadSplat() {
    loadToken++;                     // also cancels a load in progress
    if (!splatEntity && !splatAsset) return;
    releaseSplat();
    status('unloaded');
    hint('Pick a splat and press Load.');
}

let lastFlip = null;
const clearColor = new pc.Color();
function applySceneSettings() {
    const s = settings.scene;
    camera.camera.clearColor = clearColor.fromString(s.background);
    if (splatEntity) {
        if (s.flip !== lastFlip) {
            splatEntity.setLocalEulerAngles(s.flip ? 180 : 0, 0, 0);
            lastFlip = s.flip;
        }
        splatEntity.gsplat.castShadows = settings.fog.enabled && settings.fog.shafts;
    }
}

// ------------------------------------------------------------------ keys

window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === 'KeyH') document.body.classList.toggle('ui-hidden');
    if (e.key === '?') $('help').hidden = !$('help').hidden;
    if (e.code === 'Escape') $('help').hidden = true;
});

// ------------------------------------------------------------------ frame loop

let hudTime = 0;
app.on('update', dt => {
    perf.update(dt);
    applySceneSettings();
    rig.pickScale = perf.level.pickScale;
    rig.update(dt);
    post.update(dt, rig, perf.level);

    hudTime += dt;
    if (hudTime >= 0.5) {
        hudTime = 0;
        const p = settings.performance;
        $('fps').textContent = `${Math.round(perf.fps)} fps · ${p.quality} · ${Math.round(p.scale * 100)}%`;
        const lens = `${Math.round(rig.focalLength)}mm` + (settings.lens.dof === 'lens' ? ` f/${settings.lens.fStop}` : '');
        $('mode').textContent = [settings.camera.mode, lens, settings.dolly.enabled ? 'dolly' : ''].filter(Boolean).join(' · ');
    }
});

app.start();

// ------------------------------------------------------------------ boot

await luts.scanFolder();
const splats = await findSplats();
settings.scene.splat = splats[0] ?? '';
panel = new Panel(settings, {
    splats,
    luts: luts.names(),
    onLoad: () => loadSplat(settings.scene.splat),
    onUnload: unloadSplat,
    onResetCamera: () => rig.resetToHome()
});

hint(splats.length
    ? 'Pick a splat and press Load.'
    : 'No splats found. Put .ply / .sog files in the mounted splats folder.');

// handy from the browser console
window.viewer = { app, settings, rig, post, perf, loadSplat, unloadSplat };
