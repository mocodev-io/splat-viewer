// Settings files: everything set in the panels, saved under a name in the
// mounted settings folder and loaded from it again, for any splat. nginx
// lists the folder as JSON and takes PUT for `.json` files directly in it
// (see nginx.conf).

import { defaultExperience, parseExperience, type ExperienceSettings } from './experience';
import { listFolder } from './splats';

const SETTINGS = '/settings/';
const SETTINGS_FILE = /\.json$/i;

/** The names of the saved settings (without `.json`), sorted. */
export async function findPresets(): Promise<string[]> {
    const entries = await listFolder(SETTINGS);
    return entries.filter(e => e.type === 'file' && SETTINGS_FILE.test(e.name)).map(e => e.name.replace(SETTINGS_FILE, ''));
}

/** A name as a file name: letters, digits, space, `-`, `_` and `.`; empty when nothing is left. */
export function presetName(name: string): string {
    return name.replace(SETTINGS_FILE, '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().replace(/^\.+/, '');
}

const presetUrl = (name: string) => `${SETTINGS}${encodeURIComponent(name)}.json`;

export async function loadPreset(name: string): Promise<{ settings: ExperienceSettings; error?: string }> {
    try {
        const res = await fetch(presetUrl(name), { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!res.ok) return { settings: defaultExperience(), error: `could not read ${name} (${res.status})` };
        const { settings, warning } = parseExperience(await res.json());
        return { settings, error: warning };
    } catch (err) {
        return { settings: defaultExperience(), error: `could not read ${name}: ${String(err)}` };
    }
}

/** Writes the settings under the name; returns an error message, or null. */
export async function savePreset(name: string, settings: ExperienceSettings): Promise<string | null> {
    try {
        const res = await fetch(presetUrl(name), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings, null, 2)
        });
        if (res.ok) return null;
        if (res.status === 405) return 'the server does not take saves (settings folder not set up)';
        if (res.status === 403 || res.status === 500) return 'the settings folder is not writable';
        return `save failed (${res.status})`;
    } catch (err) {
        return `save failed: ${String(err)}`;
    }
}
