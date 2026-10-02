import { useEffect, useMemo } from 'react';
import { BLEND_NONE, BLEND_NORMAL, Color, StandardMaterial } from 'playcanvas';
import { Entity } from '@playcanvas/react';
import { Light, Render } from '@playcanvas/react/components';
import { useApp } from '@playcanvas/react/hooks';
import type { Lighting, SceneObject, Vec3Tuple } from '../scene/experience';

const hex = (c: Vec3Tuple) =>
    '#' + c.map(v => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, '0')).join('');
const color = (c: Vec3Tuple) => new Color(c[0], c[1], c[2]);

// One object. React owns it like any other component: it appears, changes
// and disappears with the scene data.
function SceneObjectView({ object }: { object: SceneObject }) {
    const m = object.material;
    const transparent = m.opacity < 1;

    // A plain engine material, owned here. (useMaterial from @playcanvas/react
    // drops blendType and depthWrite, so transparent objects came out opaque.)
    const material = useMemo(() => new StandardMaterial(), []);
    useEffect(() => () => material.destroy(), [material]);

    useEffect(() => {
        material.diffuse = color(m.color);
        material.emissive = color(m.emissive);
        material.useMetalness = true;
        material.metalness = m.metalness;
        material.gloss = m.gloss;
        material.opacity = m.opacity;
        material.blendType = transparent ? BLEND_NORMAL : BLEND_NONE;
        material.depthWrite = !transparent;
        // whether depth effects (DoF, fog, SSAO) see this object; see experience.ts
        material.sceneTexturesWrite = m.writeDepth ?? !transparent;
        material.update();
    }, [material, m.color, m.emissive, m.metalness, m.gloss, m.opacity, m.writeDepth, transparent]);

    return (
        <Entity name={object.id} position={object.position} rotation={object.rotation} scale={object.scale}>
            <Render type={object.type} material={material} />
        </Entity>
    );
}

export function SceneObjects({ objects }: { objects: SceneObject[] }) {
    return <>{objects.map(o => <SceneObjectView key={o.id} object={o} />)}</>;
}

// The light the objects need; it has no effect on the splats.
export function SceneLighting({ lighting }: { lighting: Lighting }) {
    const app = useApp();
    const { ambient, sun } = lighting;

    useEffect(() => {
        const [r, g, b] = ambient.color;
        app.scene.ambientLight = new Color(r * ambient.intensity, g * ambient.intensity, b * ambient.intensity);
    }, [app, ambient.color[0], ambient.color[1], ambient.color[2], ambient.intensity]);

    return (
        <Entity name="sun" rotation={[sun.pitch, sun.yaw, 0]}>
            <Light type="directional" color={hex(sun.color)} intensity={sun.intensity} />
        </Entity>
    );
}
