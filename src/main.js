import * as pc from 'playcanvas';
import { defaults } from './settings.js';
import { CameraRig } from './camera.js';
import { Post } from './post.js';
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
device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);

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
function status(text) {
    $('status').textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { $('status').textContent = ''; }, 2500);
}

let panel = null;
const rig = new CameraRig(app, camera, settings, {
    onSettingsChanged: () => panel?.refresh(),
    onStatus: status
});

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

function loadSplat(name) {
    if (!name) return;
    const token = ++loadToken;
    status(`loading ${name}…`);
    const url = `splats/${name.split('/').map(encodeURIComponent).join('/')}`;
    const asset = new pc.Asset(name, 'gsplat', { url });
    asset.on('error', err => {
        if (token === loadToken) status(`failed: ${err}`);
        console.error(err);
    });
    asset.ready(() => {
        if (token !== loadToken) {
            app.assets.remove(asset);
            asset.unload();
            return;
        }
        splatEntity?.destroy();
        if (splatAsset) {
            app.assets.remove(splatAsset);
            splatAsset.unload();
        }
        splatAsset = asset;
        splatEntity = new pc.Entity('splat');
        splatEntity.addComponent('gsplat', { asset });
        app.root.addChild(splatEntity);
        lastFlip = null;
        applySceneSettings();
        settings.scene.splat = name;
        panel?.refresh();

        // frame the splat once its bounds are known
        app.once('frameend', () => {
            const aabb = splatEntity?.gsplat?.customAabb ?? splatAsset.resource?.aabb;
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

let fpsFrames = 0;
let fpsTime = 0;
app.on('update', dt => {
    applySceneSettings();
    rig.update(dt);
    post.update(dt, rig);

    fpsFrames++;
    fpsTime += dt;
    if (fpsTime >= 0.5) {
        $('fps').textContent = `${Math.round(fpsFrames / fpsTime)} fps`;
        const lens = `${Math.round(rig.focalLength)}mm` + (settings.lens.dof === 'lens' ? ` f/${settings.lens.fStop}` : '');
        $('mode').textContent = [settings.camera.mode, lens, settings.dolly.enabled ? 'dolly' : ''].filter(Boolean).join(' · ');
        fpsFrames = 0;
        fpsTime = 0;
    }
});

app.start();

// ------------------------------------------------------------------ boot

await luts.scanFolder();
const splats = await findSplats();
panel = new Panel(settings, {
    splats,
    luts: luts.names(),
    onSplat: loadSplat,
    onResetCamera: () => rig.resetToHome()
});

if (splats.length) {
    loadSplat(splats[0]);
} else {
    $('empty-hint').hidden = false;
}

// handy from the browser console
window.viewer = { app, settings, rig, post };
