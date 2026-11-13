// Géocodage hors de France par Google Geocoding, via le relais du serveur
// (/geo-membres/api/geocode : nginx en production, Vite en développement), qui ajoute la clé.
// Les coordonnées sont gardées 30 jours au plus dans le navigateur (conditions Google).

import { CountryRef } from './country';
import type { ForeignHit } from './nominatim';

const ENDPOINT = '/geo-membres/api/geocode';
const CACHE_KEY = 'geo-membres:google:v1';
const TTL_MS = 30 * 24 * 3600 * 1000;

// Résultats trop vagues pour placer un membre (le pays ou la province entière)
const TOO_VAGUE = new Set(['country', 'administrative_area_level_1', 'political']);

interface Stored extends ForeignHit { t: number }

const hits = new Map<string, Stored>();
const misses = new Set<string>();
let unavailable = false;

try {
  const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, Stored>;
  const now = Date.now();
  for (const [k, v] of Object.entries(stored)) {
    if (v && typeof v.t === 'number' && now - v.t < TTL_MS) hits.set(k, v);
  }
} catch {
  // stockage indisponible : cache en mémoire seulement
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(hits)));
    } catch {
      // quota dépassé ou stockage bloqué : sans gravité
    }
  }, 500);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function pick(components: any[], ...types: string[]): string {
  for (const type of types) {
    const c = components.find((x: any) => Array.isArray(x.types) && x.types.includes(type));
    if (c) return c.long_name;
  }
  return '';
}

export function isGoogleUnavailable(): boolean {
  return unavailable;
}

// Renvoie le point trouvé, null si l'adresse est introuvable, undefined si le relais
// Google n'est pas disponible (pas de clé, clé refusée) : l'appelant passe alors à Nominatim.
export async function geocodeGoogle(
  postalCode: string,
  city: string,
  country: CountryRef,
  signal: AbortSignal
): Promise<ForeignHit | null | undefined> {
  if (unavailable) return undefined;

  const address = [postalCode, city, country.code ? '' : country.label].filter(Boolean).join(' ');
  const components = country.code ? `country:${country.code.toUpperCase()}` : '';
  const cacheKey = `${components}|${address.toUpperCase().replace(/\s+/g, ' ')}`;
  const cached = hits.get(cacheKey);
  if (cached) return cached;
  if (misses.has(cacheKey)) return null;

  const url = `${ENDPOINT}?${new URLSearchParams({ address, components })}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { signal });
    } catch (err: any) {
      if (err.name === 'AbortError' || signal.aborted) throw new Error('Aborted');
      console.error('Google geocode error:', err);
      if (attempt === 3) return undefined;
      await wait(1000, signal);
      continue;
    }

    // Trop de requêtes, ou erreur passagère du relais ou de Google (connexion coupée…) :
    // on retente cette adresse, sans renoncer à Google pour les suivantes
    if (response.status === 429 || response.status === 500 || response.status === 502 || response.status === 504) {
      if (attempt === 3) return undefined;
      await wait(1000 * (attempt + 1), signal);
      continue;
    }

    let data: any = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok || !data || typeof data.status !== 'string') {
      // 503 (pas de clé), 404 ou page HTML : relais absent, Nominatim pour toute la suite
      unavailable = true;
      console.warn(`Relais Google indisponible (HTTP ${response.status}) : repli sur Nominatim`);
      return undefined;
    }

    switch (data.status) {
      case 'OK': {
        const result = data.results?.[0];
        const types: string[] = result?.types || [];
        if (!result || types.every(t => TOO_VAGUE.has(t))) {
          misses.add(cacheKey);
          return null;
        }
        const comps = result.address_components || [];
        const hit: Stored = {
          lat: result.geometry.location.lat,
          lng: result.geometry.location.lng,
          postalCode: postalCode || pick(comps, 'postal_code'),
          city: pick(comps, 'locality', 'postal_town', 'administrative_area_level_3', 'sublocality') || city,
          t: Date.now(),
        };
        hits.set(cacheKey, hit);
        persist();
        return hit;
      }
      case 'ZERO_RESULTS':
      case 'INVALID_REQUEST':
        misses.add(cacheKey);
        return null;
      case 'OVER_QUERY_LIMIT':
        await wait(2000 * (attempt + 1), signal);
        continue;
      default:
        // REQUEST_DENIED (clé refusée, API non activée, IP non autorisée), UNKNOWN_ERROR…
        console.error('Google geocode:', data.status, data.error_message || '');
        if (data.status === 'UNKNOWN_ERROR') {
          await wait(1000, signal);
          continue;
        }
        unavailable = true;
        return undefined;
    }
  }
  // Tentatives épuisées (quota du jour atteint…) : Nominatim pour cette adresse
  return undefined;
}
