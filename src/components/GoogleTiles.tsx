// Fond de carte Google (Map Tiles API) servi par le relais du serveur, qui ajoute la clé.
// La session de tuiles est ouverte une fois puis réutilisée jusqu'à son expiration ;
// les mentions de droits de la zone visible et le logo Google sont affichés (obligatoires).

import { useEffect, useRef, useState } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';

// Variantes ouvertes par le relais (nginx.conf / vite.config.ts) : plan standard, plan épuré
// (sans lieux ni transports), plan gris, relief. Le satellite est refusé aux comptes de l'EEE.
export type GoogleMapType = 'roadmap' | 'epure' | 'gris' | 'terrain';

const API = '/geo-membres/api/tiles';
// Logo en couleurs, pour la bande claire des mentions de Leaflet
const GOOGLE_LOGO = '<img src="https://maps.gstatic.com/mapfiles/api-3/images/google4_hdpi.png" alt="Google" style="height:13px;display:inline;vertical-align:-3px;margin-right:4px">';
// Une session dure environ deux semaines : on la renouvelle un jour avant
const RENEW_MARGIN_S = 24 * 3600;

// v2 : sessions en tuiles haute définition (scaleFactor2x + highDpi), à rouvrir
const storageKey = (type: GoogleMapType) => `geo-membres:google-session:v2:${type}`;

// Zoom progressif. Google ne dessine que des niveaux entiers : entre deux, Leaflet agrandit
// ou réduit les tuiles du niveau le plus proche (bascule à +0,5). Réduites de 30 %, les noms
// deviennent illisibles ; agrandies de 41 %, la carte est floue. Ici, la bascule se fait à +0,7 :
// les tuiles ne sont jamais réduites sous 81 %, et leur agrandissement (jusqu'à 162 %) reste net
// grâce aux tuiles haute définition (512 px affichées sur 256).
const SWITCH_AT = 0.7;

const ProgressiveTileLayer = L.TileLayer.extend({
  _setView(this: any, center: L.LatLng, zoom: number, noPrune?: boolean, noUpdate?: boolean) {
    // Leaflet prend Math.round(zoom) comme niveau de tuiles : on lui passe le niveau voulu,
    // puis on rétablit l'échelle d'affichage du zoom réel
    const level = Math.floor(zoom + 1 - SWITCH_AT);
    (L.TileLayer.prototype as any)._setView.call(this, center, level, noPrune, noUpdate);
    if (level !== zoom) this._setZoomTransforms(center, zoom);
  },
});

async function getSession(type: GoogleMapType, signal: AbortSignal): Promise<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(type)) || 'null');
    if (saved?.session && Number(saved.expiry) - RENEW_MARGIN_S > Date.now() / 1000) return saved.session;
  } catch {
    // stockage indisponible : nouvelle session
  }

  const res = await fetch(`${API}/session?type=${type}`, { signal });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.session) {
    const reason = data?.error?.message || (res.status === 503 ? 'clé Google absente du serveur' : `HTTP ${res.status}`);
    throw new Error(reason);
  }
  try {
    localStorage.setItem(storageKey(type), JSON.stringify({ session: data.session, expiry: data.expiry }));
  } catch {
    // sans mémorisation
  }
  return data.session;
}

export default function GoogleTiles({ type, onError }: { type: GoogleMapType; onError: (message: string) => void }) {
  const map = useMap();
  const [session, setSession] = useState<string | null>(null);
  const attributionRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSession(null);
    getSession(type, controller.signal)
      .then(setSession)
      .catch(err => {
        if (!controller.signal.aborted) onError(err.message || String(err));
      });
    return () => controller.abort();
  }, [type]);

  // Mentions de droits de la zone visible, mises à jour après chaque déplacement
  useEffect(() => {
    if (!session) return;
    const control = map.attributionControl;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const setAttribution = (text: string) => {
      if (attributionRef.current) control?.removeAttribution(attributionRef.current);
      attributionRef.current = `${GOOGLE_LOGO}${text}`;
      control?.addAttribution(attributionRef.current);
    };

    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      const b = map.getBounds();
      const params = new URLSearchParams({
        session,
        zoom: String(Math.round(map.getZoom())),
        north: String(Math.min(85, b.getNorth())),
        south: String(Math.max(-85, b.getSouth())),
        east: String(Math.min(180, b.getEast())),
        west: String(Math.max(-180, b.getWest())),
      });
      fetch(`${API}/viewport?${params}`, { signal: controller.signal })
        .then(r => (r.ok ? r.json() : null))
        .then(d => setAttribution(d?.copyright || `Données cartographiques ©${new Date().getFullYear()} Google`))
        .catch(() => {});
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    };

    setAttribution(`Données cartographiques ©${new Date().getFullYear()} Google`);
    refresh();
    map.on('moveend', schedule);
    return () => {
      map.off('moveend', schedule);
      if (timer) clearTimeout(timer);
      controller?.abort();
      if (attributionRef.current) control?.removeAttribution(attributionRef.current);
      attributionRef.current = null;
    };
  }, [map, session]);

  useEffect(() => {
    if (!session) return;
    const layer = new (ProgressiveTileLayer as any)(`${API}/{z}/{x}/{y}?session=${session}`, {
      // Le relief n'est détaillé que jusqu'au niveau 15 environ : agrandi au-delà
      maxNativeZoom: type === 'terrain' ? 15 : 21,
      maxZoom: 19,
    }) as L.TileLayer;
    layer.addTo(map);
    return () => {
      layer.remove();
    };
  }, [map, session, type]);

  return null;
}
