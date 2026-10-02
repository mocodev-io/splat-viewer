import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Splats and their settings are served by nginx from the mounted /splats
// folder, outside the build. In `npm run dev`, point SPLATS_URL at a running
// viewer (or any server with the same JSON folder listing) to use its splats.
const splats = process.env.SPLATS_URL;

export default defineConfig({
    plugins: [react()],
    server: splats ? { proxy: { '/splats': splats } } : undefined,
    build: {
        target: 'es2022',
        chunkSizeWarningLimit: 4000
    }
});
