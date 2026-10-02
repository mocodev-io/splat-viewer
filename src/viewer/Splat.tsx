import { useEffect, useRef } from 'react';
import { BoundingBox, type Asset, type Entity as PcEntity } from 'playcanvas';
import { Entity } from '@playcanvas/react';
import { GSplat } from '@playcanvas/react/components';
import { useApp, useSplat } from '@playcanvas/react/hooks';

export const ORIENTATIONS = ['none', 'x180', 'z180'] as const;
export type Orientation = typeof ORIENTATIONS[number];

const rotations: Record<Orientation, [number, number, number]> = {
    none: [0, 0, 0],
    x180: [180, 0, 0],      // most COLMAP-based trainers export y-down
    z180: [0, 0, 180]       // what the PlayCanvas splat tutorials apply
};

type SplatProps = {
    src: string;
    orientation: Orientation;
    onReady: (bounds: BoundingBox | null) => void;
    onError: (message: string) => void;
};

// One loaded splat. Unmounting it (Unload, or loading another) also frees its
// GPU memory: useSplat keeps assets in the registry for reuse, so the release
// is done here.
export function Splat({ src, orientation, onReady, onError }: SplatProps) {
    const app = useApp();
    const entityRef = useRef<PcEntity>(null);
    const { asset, error } = useSplat(src);

    useEffect(() => {
        if (error) onError(error);
    }, [error, onError]);

    useEffect(() => {
        if (!asset) return;
        return () => {
            app.assets.remove(asset);
            asset.unload();
        };
    }, [app, asset]);

    // report the world-space bounds once the splat has rendered a frame
    useEffect(() => {
        if (!asset) return;
        const done = () => onReady(worldBounds(entityRef.current, asset));
        app.once('frameend', done);
        return () => { app.off('frameend', done); };
    }, [app, asset, orientation, onReady]);

    if (!asset) return null;
    return (
        <Entity ref={entityRef} name="splat" rotation={rotations[orientation]}>
            {/* @playcanvas/react passes unified=false by default, which selects
                the engine's deprecated legacy splat path (draws nothing here).
                Unified is the engine default: one global sort over all splats. */}
            <GSplat asset={asset} unified />
        </Entity>
    );
}

function worldBounds(entity: PcEntity | null, asset: Asset): BoundingBox | null {
    const local = entity?.gsplat?.customAabb ?? (asset.resource as { aabb?: BoundingBox } | null)?.aabb;
    if (!entity || !local) return null;
    const world = new BoundingBox();
    world.setFromTransformedAabb(local, entity.getWorldTransform());
    return world;
}
