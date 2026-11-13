import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv, type Plugin} from 'vite';

// Même relais Google qu'en production (nginx.conf), pour `npm run dev` : la clé est lue
// dans .env.local et n'est ajoutée qu'aux requêtes vers Google, jamais journalisée.
// Sans clé, les routes répondent 503 et l'application se rabat sur Nominatim / Plan IGN.
function googleRelay(key: string | undefined): Plugin {
  // Plan routier en français (le satellite est refusé aux comptes de l'EEE)
  const SESSION_BODY = { mapType: 'roadmap', language: 'fr-FR', region: 'FR' };

  return {
    name: 'google-relay',
    configureServer(server) {
      server.middlewares.use('/geo-membres/api', async (req, res) => {
        if (!key) {
          res.statusCode = 503;
          res.end();
          return;
        }
        const url = new URL(req.url || '/', 'http://relais');
        const q = url.searchParams;
        const k = encodeURIComponent(key);
        let target: string;
        let init: RequestInit = {};
        let tile: RegExpMatchArray | null = null;

        if (url.pathname === '/geocode') {
          const out = new URLSearchParams({ address: q.get('address') || '', components: q.get('components') || '', language: 'fr' });
          target = `https://maps.googleapis.com/maps/api/geocode/json?${out}&key=${k}`;
        } else if (url.pathname === '/tiles/session') {
          target = `https://tile.googleapis.com/v1/createSession?key=${k}`;
          init = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(SESSION_BODY),
          };
        } else if (url.pathname === '/tiles/viewport') {
          const out = new URLSearchParams();
          for (const p of ['session', 'zoom', 'north', 'south', 'east', 'west']) out.set(p, q.get(p) || '');
          target = `https://tile.googleapis.com/tile/v1/viewport?${out}&key=${k}`;
        } else if ((tile = url.pathname.match(/^\/tiles\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})$/))) {
          const session = q.get('session') || '';
          if (!/^[A-Za-z0-9_-]{8,512}$/.test(session)) {
            res.statusCode = 400;
            res.end();
            return;
          }
          target = `https://tile.googleapis.com/v1/2dtiles/${tile[1]}/${tile[2]}/${tile[3]}?session=${session}&key=${k}`;
        } else {
          res.statusCode = 404;
          res.end();
          return;
        }

        try {
          const upstream = await fetch(target, init);
          res.statusCode = upstream.status;
          for (const h of ['content-type', 'cache-control', 'expires', 'etag']) {
            const v = upstream.headers.get(h);
            if (v) res.setHeader(h, v);
          }
          res.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (err: any) {
          // Message d'erreur sans l'URL appelée (qui contient la clé)
          server.config.logger.warn(`relais Google ${url.pathname} : ${err?.cause?.code || err?.message || err}`);
          res.statusCode = 502;
          res.end();
        }
      });
    },
  };
}

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    // Servie sur vm01 sous https://app.omonville.fgl/geo-membres/ (pas de StripPrefix côté Traefik).
    base: '/geo-membres/',
    plugins: [react(), tailwindcss(), googleRelay(env.GOOGLE_MAPS_KEY)],
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
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
