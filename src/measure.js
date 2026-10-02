// Measure tool: click two points on the splat, read the distance in scene
// units, enter the real length and let it set Scene > Meters per unit.
// The line is drawn as an SVG layer over the canvas, so DoF and the other
// post effects never blur or distort it.

import * as pc from 'playcanvas';

const SVG = 'http://www.w3.org/2000/svg';
const tmpScreen = new pc.Vec3();
const tmpDelta = new pc.Vec3();

export class MeasureTool {
    constructor(rig, cameraEntity, settings, events) {
        this.rig = rig;
        this.cameraEntity = cameraEntity;
        this.settings = settings;
        this.events = events;              // { onSettingsChanged(), onStatus(text) }
        this.active = false;
        this.points = [];
        this.ui = { units: 0, realLength: 1 };   // shown and edited in the panel

        this.svg = document.createElementNS(SVG, 'svg');
        this.svg.id = 'measure';
        this.line = this.svg.appendChild(document.createElementNS(SVG, 'line'));
        this.dots = [0, 1].map(() => this.svg.appendChild(document.createElementNS(SVG, 'circle')));
        for (const d of this.dots) d.setAttribute('r', 4);
        this.label = this.svg.appendChild(document.createElementNS(SVG, 'text'));
        document.body.appendChild(this.svg);
        this.svg.style.display = 'none';
    }

    toggle() {
        if (this.active) this.stop();
        else this.start();
    }

    start() {
        this.active = true;
        this.points = [];
        this.rig.clickHandler = (x, y) => this.onClick(x, y);
        this.svg.style.display = '';
        this.events.onStatus('measure: click the first point (M or Esc to stop)', true);
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        this.rig.clickHandler = null;
        this.svg.style.display = 'none';
        this.events.onStatus('measure off');
    }

    // returns true: the click is ours, the camera should not focus on it
    onClick(x, y) {
        this.rig.pickAt(x, y).then(point => {
            if (!point) {
                this.events.onStatus('no splat there, try again', true);
                return;
            }
            if (this.points.length === 2) this.points = [];
            this.points.push(point);
            if (this.points.length === 1) {
                this.events.onStatus('measure: click the second point', true);
                return;
            }
            const units = this.points[0].distance(this.points[1]);
            this.ui.units = Math.round(units * 1000) / 1000;
            this.events.onSettingsChanged();
            const meters = units * this.settings.scene.metersPerUnit;
            this.events.onStatus(`${units.toFixed(3)} units ≈ ${meters.toFixed(2)} m · enter the real length, then Set scale`, true);
        });
        return true;
    }

    applyScale() {
        const { units, realLength } = this.ui;
        if (!(units > 0) || !(realLength > 0)) {
            this.events.onStatus('measure two points first');
            return;
        }
        this.settings.scene.metersPerUnit = Math.round(realLength / units * 10000) / 10000;
        this.events.onSettingsChanged();
        this.events.onStatus(`meters per unit: ${this.settings.scene.metersPerUnit}`);
    }

    // keeps the overlay glued to the points while the camera moves
    update() {
        if (!this.active) return;
        const camera = this.cameraEntity.camera;
        const position = this.cameraEntity.getPosition();
        const forward = this.cameraEntity.forward;
        const screen = [];
        for (const p of this.points) {
            const inFront = tmpDelta.sub2(p, position).dot(forward) > camera.nearClip;
            if (!inFront) break;
            camera.worldToScreen(p, tmpScreen);
            screen.push([tmpScreen.x, tmpScreen.y]);
        }

        this.dots.forEach((dot, i) => {
            dot.style.display = screen[i] ? '' : 'none';
            if (screen[i]) {
                dot.setAttribute('cx', screen[i][0]);
                dot.setAttribute('cy', screen[i][1]);
            }
        });

        const both = screen.length === 2;
        this.line.style.display = both ? '' : 'none';
        this.label.style.display = both ? '' : 'none';
        if (both) {
            const [[x1, y1], [x2, y2]] = screen;
            this.line.setAttribute('x1', x1);
            this.line.setAttribute('y1', y1);
            this.line.setAttribute('x2', x2);
            this.line.setAttribute('y2', y2);
            this.label.setAttribute('x', (x1 + x2) / 2 + 8);
            this.label.setAttribute('y', (y1 + y2) / 2 - 8);
            const units = this.points[0].distance(this.points[1]);
            const meters = units * this.settings.scene.metersPerUnit;
            this.label.textContent = `${units.toFixed(3)} u · ${meters.toFixed(2)} m`;
        }
    }
}
