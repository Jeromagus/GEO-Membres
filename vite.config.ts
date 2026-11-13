import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    // Servie sur vm01 sous https://app.omonville.fgl/geo-membres/ (pas de StripPrefix côté Traefik).
    base: '/geo-membres/',
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Même relais Google qu'en production (nginx.conf), clé lue dans .env.local.
      // Sans clé, aucun relais : l'application se rabat sur Nominatim.
      proxy: env.GOOGLE_MAPS_KEY ? {
        '/geo-membres/api/geocode': {
          target: 'https://maps.googleapis.com',
          changeOrigin: true,
          rewrite: (p: string) => {
            const query = new URLSearchParams(p.split('?')[1] || '');
            const out = new URLSearchParams({
              address: query.get('address') || '',
              components: query.get('components') || '',
              language: 'fr',
            });
            return `/maps/api/geocode/json?${out}`;
          },
          // La clé n'est ajoutée qu'à la requête sortante : les erreurs de proxy que Vite
          // journalise citent l'adresse réécrite, qui ne la contient donc pas.
          configure: (proxy: any) => {
            proxy.on('proxyReq', (proxyReq: any) => {
              proxyReq.path += `&key=${encodeURIComponent(env.GOOGLE_MAPS_KEY)}`;
            });
          },
        },
      } : undefined,
    },
  };
});
