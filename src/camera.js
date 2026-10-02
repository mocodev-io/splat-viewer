// The camera emulator: fly/orbit controls with smoothing, roll, shake, drift,
// dolly zoom, autofocus by picking the splat, and the per-frame motion data
// the compose shader uses for motion blur.
//
// The pose is a plain {position, yaw, pitch, roll, focal length, focus} so a
// keyframed camera path can drive the same rig later.

import * as pc from 'playcanvas';

const DEG = Math.PI / 180;

// sensor widths in mm; the field of view follows from focal length + sensor
export const sensors = {
    'full frame': 36,
    'super 35': 24.89,
    'aps-c': 23.5,
    'micro 4/3': 17.3
};
const tmpV = new pc.Vec3();
const tmpV2 = new pc.Vec3();
const tmpM = new pc.Mat4();
const tmpM2 = new pc.Mat4();
const tmpM3 = new pc.Mat4();
const tmpFwd = new pc.Vec3();
const tmpRight = new pc.Vec3();
const tmpMove = new pc.Vec3();

function forwardFrom(yaw, pitch, out) {
    const cp = Math.cos(pitch * DEG);
    return out.set(-Math.sin(yaw * DEG) * cp, Math.sin(pitch * DEG), -Math.cos(yaw * DEG) * cp);
}

// exponential smoothing factor; smoothing 0 = snap, 1 = ~0.5 s lag
function follow(smoothing, dt) {
    const tau = smoothing * smoothing * 0.5;
    return tau < 1e-4 ? 1 : 1 - Math.exp(-dt / tau);
}

// --- noise for shake: smooth 1D value noise, a handful of independent channels

function hash(n) {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return s - Math.floor(s);
}
function noise(x, seed) {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return pc.math.lerp(hash(i + seed * 57.3), hash(i + 1 + seed * 57.3), u) * 2 - 1;
}
function fbm(x, seed) {
    return noise(x, seed) * 0.65 + noise(x * 2.3, seed + 11) * 0.25 + noise(x * 5.1, seed + 23) * 0.1;
}

// rotation in degrees (pitch, yaw, roll), position relative to the focus distance
const shakeStyles = {
    handheld:   { freq: 0.7, rot: [0.7, 0.7, 0.5], pos: [0.004, 0.004, 0.002], bob: 0, step: 0 },
    walk:       { freq: 0.6, rot: [0.4, 0.4, 0.3], pos: [0.003, 0.003, 0.002], bob: 0.012, step: 1.8 },
    run:        { freq: 1.0, rot: [0.9, 0.8, 0.6], pos: [0.006, 0.006, 0.003], bob: 0.03, step: 2.7 },
    vehicle:    { freq: 7.0, rot: [0.25, 0.15, 0.2], pos: [0.002, 0.004, 0.001], bob: 0, step: 0 },
    earthquake: { freq: 11.0, rot: [1.2, 0.8, 1.5], pos: [0.02, 0.025, 0.01], bob: 0, step: 0 }
};

export class CameraRig {
    constructor(app, entity, settings, events) {
        this.app = app;
        this.entity = entity;
        this.camera = entity.camera;
        this.settings = settings;
        this.events = events;           // { onSettingsChanged(), onStatus(text) }
        this.canvas = app.graphicsDevice.canvas;

        // target = where input wants the camera, current = smoothed
        this.target = { position: new pc.Vec3(0, 0, 5), yaw: 0, pitch: 0, pivot: new pc.Vec3(), distance: 5 };
        this.current = { position: new pc.Vec3(0, 0, 5), yaw: 0, pitch: 0, pivot: new pc.Vec3(), distance: 5 };
        this.home = { pivot: new pc.Vec3(), distance: 5, yaw: 0, pitch: -10 };

        this.focus = settings.lens.focusDistance;   // smoothed focus distance
        this.focalLength = settings.camera.focalLength;   // effective, dolly zoom moves it
        this.fov = 60;                                    // vertical, derived from the lens
        this.time = 0;

        this.keys = new Set();
        this.pointers = new Map();
        this.pinchDistance = 0;
        this.clickStart = null;

        this.dolly = null;              // { subject, d0, focal0 } while dolly zoom is active
        this.lastMode = settings.camera.mode;

        // motion blur
        this.prevRotation = new pc.Mat4();
        this.prevProjection = new pc.Mat4();
        this.prevView = new pc.Mat4();
        this.prevPosition = new pc.Vec3();
        this.hasPrev = false;
        this.reproject = new pc.Mat4();      // rotation only: clip(now) -> clip(prev)
        this.reprojectFull = new pc.Mat4();  // view(now) -> clip(prev), with real depth
        this.tanHalf = new Float32Array(2);  // view-space extent of the frame at depth 1
        this.camMotion = new Float32Array(3);
        this.blurScale = 0;

        // set by the measure tool: gets first say on a click
        this.clickHandler = null;

        // picking for autofocus / pivot
        this.picker = null;
        this.pickBusy = false;
        this.pickTimer = 0;
        this.pickScale = 0.25;          // set from the quality level
        this.lastPickPose = new pc.Mat4();

        this.bindInput();
    }

    // ------------------------------------------------------------------ input

    bindInput() {
        const c = this.canvas;
        c.addEventListener('contextmenu', e => e.preventDefault());
        c.addEventListener('pointerdown', e => this.onPointerDown(e));
        c.addEventListener('pointermove', e => this.onPointerMove(e));
        c.addEventListener('pointerup', e => this.onPointerUp(e));
        c.addEventListener('pointercancel', e => this.onPointerUp(e));
        c.addEventListener('wheel', e => this.onWheel(e), { passive: false });
        c.addEventListener('dblclick', e => this.onDoubleClick(e));
        window.addEventListener('keydown', e => this.onKey(e, true));
        window.addEventListener('keyup', e => this.onKey(e, false));
        window.addEventListener('blur', () => this.keys.clear());
    }

    onKey(e, down) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
        if (down) this.keys.add(e.code);
        else this.keys.delete(e.code);
        if (!down) return;
        if (e.code === 'KeyO') {
            this.setMode(this.settings.camera.mode === 'fly' ? 'orbit' : 'fly');
            this.events.onSettingsChanged();
        } else if (e.code === 'KeyV') {
            this.settings.dolly.enabled = !this.settings.dolly.enabled;
            this.events.onSettingsChanged();
        } else if (e.code === 'KeyR') {
            this.resetToHome();
        }
    }

    onPointerDown(e) {
        this.canvas.setPointerCapture(e.pointerId);
        this.canvas.focus();
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
        if (this.pointers.size === 1) {
            this.clickStart = { x: e.clientX, y: e.clientY, t: performance.now() };
        } else {
            this.clickStart = null;
            this.pinchDistance = this.pointerSpread();
        }
    }

    onPointerMove(e) {
        const p = this.pointers.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;

        if (this.pointers.size === 1) {
            const pan = p.button === 2 || p.button === 1 || e.shiftKey;
            if (pan) this.pan(dx, dy);
            else this.look(dx, dy);
        } else if (this.pointers.size === 2) {
            // two fingers: pinch = dolly/zoom, shared movement = pan
            const n = this.pointers.size;
            this.pan(dx / n, dy / n);
            p.x = e.clientX;
            p.y = e.clientY;
            const spread = this.pointerSpread();
            if (this.pinchDistance > 0) this.zoom((this.pinchDistance - spread) * 4);
            this.pinchDistance = spread;
            return;
        }
        p.x = e.clientX;
        p.y = e.clientY;
    }

    onPointerUp(e) {
        const p = this.pointers.get(e.pointerId);
        this.pointers.delete(e.pointerId);
        if (!p) return;
        const start = this.clickStart;
        if (start && this.pointers.size === 0) {
            const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
            const quick = performance.now() - start.t < 350;
            if (moved < 5 && quick && p.button === 0) {
                if (this.clickHandler?.(e.clientX, e.clientY)) {
                    // handled by the measure tool
                } else if (this.settings.lens.autofocus === 'click') {
                    this.pickAt(e.clientX, e.clientY).then(point => {
                        if (point) this.setFocusPoint(point);
                    });
                }
            }
        }
        if (this.pointers.size < 2) this.pinchDistance = 0;
        this.clickStart = null;
    }

    onWheel(e) {
        e.preventDefault();
        const steps = e.deltaY / (e.deltaMode === 1 ? 3 : 100);
        if (this.settings.camera.mode === 'fly') {
            const cam = this.settings.camera;
            cam.moveSpeed = pc.math.clamp(cam.moveSpeed * Math.pow(1.15, -steps), 0.01, 500);
            this.events.onSettingsChanged();
            this.events.onStatus(`speed ${cam.moveSpeed.toPrecision(3)}`);
        } else {
            this.zoom(steps * 100);
        }
    }

    async onDoubleClick(e) {
        if (this.clickHandler) return;      // measuring: clicks are points
        const point = await this.pickAt(e.clientX, e.clientY);
        if (!point) return;
        // orbit around the point we clicked, without moving the camera
        const position = this.current.position;
        this.target.pivot.copy(point);
        this.current.pivot.copy(point);
        const d = position.distance(point);
        this.target.distance = this.current.distance = d;
        const dir = tmpV.sub2(point, position).normalize();
        const yaw = Math.atan2(-dir.x, -dir.z) / DEG;
        const pitch = Math.asin(pc.math.clamp(dir.y, -1, 1)) / DEG;
        this.target.yaw = this.unwrapNear(yaw, this.current.yaw);
        this.target.pitch = pitch;
        this.settings.camera.mode = 'orbit';
        this.lastMode = 'orbit';
        this.setFocusPoint(point);
        this.events.onSettingsChanged();
    }

    pointerSpread() {
        const [a, b] = [...this.pointers.values()];
        return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    }

    unwrapNear(angle, reference) {
        return angle + Math.round((reference - angle) / 360) * 360;
    }

    look(dx, dy) {
        const s = this.settings.camera.lookSpeed;
        const fovScale = this.fov / 60;    // aim slower when zoomed in, like a real lens
        this.target.yaw -= dx * s * fovScale;
        this.target.pitch = pc.math.clamp(this.target.pitch - dy * s * fovScale, -89, 89);
    }

    pan(dx, dy) {
        const orbit = this.settings.camera.mode === 'orbit';
        const scale = orbit ? this.target.distance * 0.0015 : this.settings.camera.moveSpeed * 0.004;
        const right = this.entity.right;
        const up = this.entity.up;
        const move = tmpV.copy(right).mulScalar(-dx * scale).add(tmpV2.copy(up).mulScalar(dy * scale));
        this.target.pivot.add(move);
        this.target.position.add(move);
    }

    zoom(amount) {
        if (this.settings.camera.mode === 'orbit') {
            this.target.distance = pc.math.clamp(this.target.distance * Math.pow(1.1, amount / 100), 0.01, 1e5);
        } else {
            const fwd = forwardFrom(this.target.yaw, this.target.pitch, tmpV);
            this.target.position.add(fwd.mulScalar(-amount * this.settings.camera.moveSpeed * 0.002));
        }
    }

    // ------------------------------------------------------------ mode + pose

    setMode(mode) {
        const cam = this.settings.camera;
        if (mode === 'orbit') {
            // orbit around whatever is in focus straight ahead
            const d = Math.max(this.focus, 0.05);
            const fwd = forwardFrom(this.current.yaw, this.current.pitch, tmpV);
            this.current.pivot.copy(this.current.position).add(fwd.mulScalar(d));
            this.target.pivot.copy(this.current.pivot);
            this.current.distance = this.target.distance = d;
            this.target.yaw = this.current.yaw;
            this.target.pitch = this.current.pitch;
        } else {
            this.target.position.copy(this.current.position);
        }
        cam.mode = mode;
        this.lastMode = mode;
    }

    setHome(aabb) {
        this.home.pivot.copy(aabb.center);
        this.home.distance = Math.max(aabb.halfExtents.length() * 0.6, 0.5);
        this.resetToHome();
    }

    resetToHome() {
        const h = this.home;
        for (const s of [this.target, this.current]) {
            s.pivot.copy(h.pivot);
            s.distance = h.distance;
            s.yaw = h.yaw;
            s.pitch = h.pitch;
            s.position.copy(h.pivot).sub(forwardFrom(h.yaw, h.pitch, tmpV).mulScalar(h.distance));
        }
        this.settings.camera.roll = 0;
        this.focus = this.settings.lens.focusDistance = h.distance;
        this.hasPrev = false;
        this.events.onSettingsChanged();
    }

    // -------------------------------------------------------------- autofocus

    async pickAt(clientX, clientY) {
        if (this.pickBusy) return null;
        this.pickBusy = true;
        try {
            const app = this.app;
            const canvas = this.canvas;
            const rect = canvas.getBoundingClientRect();
            const scale = this.pickScale;
            const w = Math.max(1, Math.floor(canvas.width * scale));
            const h = Math.max(1, Math.floor(canvas.height * scale));
            if (!this.picker) this.picker = new pc.Picker(app, w, h, true);
            this.picker.resize(w, h);
            const worldLayer = app.scene.layers.getLayerByName('World');
            const x = (clientX - rect.left) / rect.width * w;
            const y = (clientY - rect.top) / rect.height * h;
            // the splat pick data can lag a frame behind (first pick, camera
            // just moved), so a miss gets one retry on the next frame
            for (let attempt = 0; attempt < 2; attempt++) {
                this.picker.prepare(this.camera, app.scene, [worldLayer]);
                const point = await this.picker.getWorldPointAsync(x, y);
                if (point) return point;
                await new Promise(resolve => app.once('frameend', resolve));
            }
            return null;
        } catch (err) {
            console.warn('pick failed', err);
            return null;
        } finally {
            this.pickBusy = false;
        }
    }

    // Focus distance is depth along the view axis, as the lens formula wants.
    setFocusPoint(point, quiet = false) {
        const fwd = this.entity.forward;
        const depth = tmpV.sub2(point, this.entity.getPosition()).dot(fwd);
        if (depth > 0) {
            this.settings.lens.focusDistance = depth;
            this.events.onSettingsChanged();
            if (!quiet) this.events.onStatus(`focus ${depth.toPrecision(3)}`);
        }
    }

    // ----------------------------------------------------------------- update

    update(dt) {
        const s = this.settings;
        const cam = s.camera;
        this.time += dt;

        if (cam.mode !== this.lastMode) this.setMode(cam.mode);
        if (cam.drift && cam.mode !== 'orbit') {
            this.setMode('orbit');
            this.events.onSettingsChanged();
        }

        // keyboard
        const k = this.keys;
        const ax = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
        const ay = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
        const az = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
        const fast = k.has('ShiftLeft') || k.has('ShiftRight');
        const slow = k.has('ControlLeft') || k.has('ControlRight');
        if (ax || ay || az) {
            const speed = cam.moveSpeed * (fast ? 4 : 1) * (slow ? 0.25 : 1) * dt;
            const fwd = forwardFrom(this.target.yaw, this.target.pitch, tmpFwd);
            const right = tmpRight.cross(fwd, pc.Vec3.UP).normalize();
            const move = tmpMove.copy(fwd).mulScalar(az).add(right.mulScalar(ax));
            move.y += ay;
            if (move.lengthSq() > 1) move.normalize();
            move.mulScalar(speed);
            this.target.position.add(move);
            this.target.pivot.add(move);
        }
        const rollInput = (k.has('KeyC') ? 1 : 0) - (k.has('KeyZ') ? 1 : 0);
        if (rollInput) {
            cam.roll = pc.math.clamp(cam.roll - rollInput * cam.rollSpeed * dt, -180, 180);
            this.events.onSettingsChanged(true);
        }

        if (cam.drift) this.target.yaw += cam.driftSpeed * dt;

        // smoothing
        const a = follow(cam.smoothing, dt);
        const cur = this.current;
        const tgt = this.target;
        cur.yaw = pc.math.lerp(cur.yaw, tgt.yaw, a);
        cur.pitch = pc.math.lerp(cur.pitch, tgt.pitch, a);
        if (cam.mode === 'orbit') {
            tgt.position.copy(tgt.pivot).sub(forwardFrom(tgt.yaw, tgt.pitch, tmpV).mulScalar(tgt.distance));
            cur.pivot.lerp(cur.pivot, tgt.pivot, a);
            cur.distance = pc.math.lerp(cur.distance, tgt.distance, a);
            cur.position.copy(cur.pivot).sub(forwardFrom(cur.yaw, cur.pitch, tmpV).mulScalar(cur.distance));
        } else {
            cur.position.lerp(cur.position, tgt.position, a);
        }

        this.updateDolly();

        // focus pull
        const lens = s.lens;
        // Continuous autofocus renders the scene again to read depth, so it
        // only does that while the camera moves (plus a slow refresh).
        if (lens.autofocus === 'center') {
            this.pickTimer -= dt;
            const pose = this.entity.getWorldTransform().data;
            const last = this.lastPickPose.data;
            let moved = false;
            for (let i = 0; i < 16; i++) {
                if (Math.abs(pose[i] - last[i]) > 1e-3) { moved = true; break; }
            }
            if (this.pickTimer <= 0 && !this.pickBusy && (moved || this.pickTimer < -1.5)) {
                this.pickTimer = 0.2;
                this.lastPickPose.copy(this.entity.getWorldTransform());
                const r = this.canvas.getBoundingClientRect();
                this.pickAt(r.left + r.width / 2, r.top + r.height / 2).then(p => p && this.setFocusPoint(p, true));
            }
        }
        const fa = 1 - Math.exp(-dt * lens.focusSpeed);
        this.focus = this.dolly ? lens.focusDistance : pc.math.lerp(this.focus, lens.focusDistance, fa);

        // pose + roll + shake
        this.entity.setPosition(cur.position);
        this.entity.setEulerAngles(cur.pitch, cur.yaw, 0);
        this.entity.rotateLocal(0, 0, cam.roll);
        this.applyShake();

        // Focal length + sensor width give the horizontal field of view, like a
        // real camera filling the frame width. The camera gets it horizontally
        // (the engine's fisheye projection sizes itself on camera.fov and clips
        // the wider axis otherwise); the rig keeps the vertical angle too.
        const aspect = this.camera.aspectRatio || 16 / 9;
        const hfov = 2 * Math.atan(this.sensorWidth / (2 * this.focalLength)) / DEG;
        this.fov = 2 * Math.atan(Math.tan(hfov * DEG / 2) / aspect) / DEG;
        this.camera.horizontalFov = true;
        this.camera.fov = Math.min(hfov, 175);
        this.updateMotion(dt);
    }

    get sensorWidth() {
        return sensors[this.settings.camera.sensor] ?? sensors['full frame'];
    }

    // Dolly zoom: the subject keeps its size when the focal length scales with
    // the distance to it.
    updateDolly() {
        const s = this.settings;
        if (s.dolly.enabled && !this.dolly) {
            const d0 = Math.max(this.focus, 0.05);
            const fwd = forwardFrom(this.current.yaw, this.current.pitch, new pc.Vec3());
            this.dolly = {
                subject: this.current.position.clone().add(fwd.mulScalar(d0)),
                d0,
                focal0: s.camera.focalLength
            };
            this.events.onStatus('dolly zoom: move forward / back');
        } else if (!s.dolly.enabled && this.dolly) {
            s.camera.focalLength = Math.round(this.focalLength);
            this.dolly = null;
            this.events.onSettingsChanged();
        }

        if (this.dolly) {
            const { subject, d0, focal0 } = this.dolly;
            const d = Math.max(this.current.position.distance(subject), 0.01);
            this.focalLength = pc.math.clamp(focal0 * d / d0, 4, 600);
            // focus stays on the subject, measured along the view axis
            const fwd = forwardFrom(this.current.yaw, this.current.pitch, tmpFwd);
            s.lens.focusDistance = Math.max(tmpV.sub2(subject, this.current.position).dot(fwd), 0.01);
        } else {
            this.focalLength = s.camera.focalLength;
        }
    }

    applyShake() {
        const { style, amount, speed } = this.settings.shake;
        const p = shakeStyles[style];
        if (!p || amount <= 0) return;
        const t = this.time * speed;
        const f = p.freq;
        let pitch = fbm(t * f, 1) * p.rot[0];
        let yaw = fbm(t * f, 2) * p.rot[1];
        let roll = fbm(t * f, 3) * p.rot[2];
        const scale = Math.max(this.focus, 0.2);
        let px = fbm(t * f, 4) * p.pos[0];
        let py = fbm(t * f, 5) * p.pos[1];
        const pz = fbm(t * f, 6) * p.pos[2];
        if (p.step) {
            // footsteps: bob twice per stride, sway and roll once
            const phase = t * p.step * Math.PI;
            py += Math.abs(Math.sin(phase)) * p.bob - p.bob * 0.5;
            px += Math.sin(phase * 0.5) * p.bob * 0.6;
            roll += Math.sin(phase * 0.5) * p.bob * 40;
            pitch += Math.sin(phase * 2) * p.bob * 15;
        }
        const e = this.entity;
        const offset = tmpMove.copy(e.right).mulScalar(px * scale * amount)
            .add(tmpV.copy(e.up).mulScalar(py * scale * amount))
            .add(tmpV2.copy(e.forward).mulScalar(pz * scale * amount));
        e.translate(offset);
        e.rotateLocal(pitch * amount, yaw * amount, roll * amount);
    }

    // Per-pixel motion of the last frame for motion blur. With the scene depth
    // the shader reprojects every pixel exactly (reprojectFull). Without it,
    // rotation is still exact (reproject) and translation is estimated with
    // the focus distance as the depth (camMotion).
    updateMotion(dt) {
        const e = this.entity;
        const world = e.getWorldTransform();
        const rotation = tmpM.setTRS(pc.Vec3.ZERO, e.getRotation(), pc.Vec3.ONE);
        const projection = this.camera.projectionMatrix;
        const aspect = this.camera.aspectRatio || 1;
        const tanHalf = Math.tan(this.fov * DEG / 2);
        this.tanHalf[0] = tanHalf * aspect;
        this.tanHalf[1] = tanHalf;

        if (!this.hasPrev || dt <= 0) {
            this.prevRotation.copy(rotation);
            this.prevProjection.copy(projection);
            this.prevView.copy(world).invert();
            this.prevPosition.copy(e.getPosition());
            this.hasPrev = true;
            this.reproject.setIdentity();
            this.reprojectFull.copy(projection);
            this.camMotion.fill(0);
            this.blurScale = 0;
            return;
        }

        // view(now) -> world -> view(prev) -> clip(prev)
        this.reprojectFull.copy(this.prevProjection).mul(this.prevView).mul(world);

        // clip(now) -> view(now) -> world -> view(prev) -> clip(prev), rotation only
        const invProjection = tmpM2.copy(projection).invert();
        const prevViewRot = tmpM3.copy(this.prevRotation).transpose();
        this.reproject.copy(this.prevProjection).mul(prevViewRot).mul(rotation).mul(invProjection);

        const delta = tmpV.sub2(e.getPosition(), this.prevPosition);
        const depth = Math.max(this.focus, 0.1);
        this.camMotion[0] = -delta.dot(e.right) / (depth * 2 * tanHalf * aspect);
        this.camMotion[1] = -delta.dot(e.up) / (depth * 2 * tanHalf);
        this.camMotion[2] = delta.dot(e.forward) / depth;

        // shutter relative to a 1/24 s frame, so the blur does not depend on fps
        this.blurScale = Math.min((1 / 24) / dt, 6);

        this.prevRotation.copy(rotation);
        this.prevProjection.copy(projection);
        this.prevView.copy(world).invert();
        this.prevPosition.copy(e.getPosition());
    }
}
