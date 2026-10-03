// The splats on offer: nginx serves the mounted folder as a JSON listing
// (`autoindex_format json`, see nginx.conf).

const SPLAT_FILE = /\.(ply|sog)$/i;
const SPLAT_META = /^(lod-)?meta\.json$/i;

type ListingEntry = { name: string; type: 'file' | 'directory' };

export async function listFolder(path: string): Promise<ListingEntry[]> {
    try {
        const res = await fetch(path, { headers: { Accept: 'application/json' } });
        if (!res.ok) return [];
        const entries = (await res.json()) as ListingEntry[];
        return entries.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        return [];
    }
}

// Paths relative to /splats/: plain files, plus folders holding unbundled SOG
// or LOD streaming output (recognised by their meta.json).
export async function findSplats(): Promise<string[]> {
    const entries = await listFolder('/splats/');
    const found = entries.filter(e => e.type === 'file' && SPLAT_FILE.test(e.name)).map(e => e.name);
    for (const dir of entries.filter(e => e.type === 'directory')) {
        const inner = await listFolder(`/splats/${encodeURIComponent(dir.name)}/`);
        const meta = inner.find(e => e.type === 'file' && SPLAT_META.test(e.name));
        if (meta) found.push(`${dir.name}/${meta.name}`);
    }
    return found;
}

export const splatUrl = (name: string) => `/splats/${name.split('/').map(encodeURIComponent).join('/')}`;
