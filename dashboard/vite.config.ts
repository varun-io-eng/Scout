import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3847',
        changeOrigin: true,
        // Avoid noisy ECONNREFUSED spam if API briefly restarts under tsx watch
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            console.warn(`[vite] api proxy: ${err.message}`);
            if (res && !res.headersSent && typeof res.writeHead === 'function') {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Scout API unavailable — wait for server restart' }));
            }
          });
        },
      },
    },
  },
});
