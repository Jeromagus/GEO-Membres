// Géocodage hors de France par Google Geocoding, via le relais du serveur
// (/geo-membres/api/geocode : nginx en production, Vite en développement), qui ajoute la clé.
// Les coordonnées sont gardées 30 jours au plus dans le navigateur (conditions Google).

import { CountryRef } from './country';
import type { ForeignHit } from './nominatim';
import { Diag, describeError, fetchWithTimeout, wait } from './net';

const ENDPOINT = '/geo-membres/api/geocode';
const CACHE_KEY = 'geo-membres:google:v1';
const TTL_MS = 30 * 24 * 3600 * 1000;
const TIMEOUT_MS = 15000;

// Résultats trop vagues pour placer un membre (le pays ou la province entière)
const TOO_VAGUE = new Set(['country', 'administrative_area_level_1', 'political']);

interface Stored extends ForeignHit { t: number }

const hits = new Map<string, Stored>();
// Adresses introuvables, avec la raison (pour la session seulement)
const misses = new Map<string, string>();
let unavailable = false;
let unavailableReason = '';

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
  signal: AbortSignal,
  diag: Diag = {}
): Promise<ForeignHit | null | undefined> {
  if (unavailable) {
    diag.reason = unavailableReason;
    return undefined;
  }
  const giveUp = (reason: string) => {
    unavailable = true;
    unavailableReason = `Google indisponible : ${reason}`;
    diag.reason = unavailableReason;
    return undefined;
  };
  const miss = (reason: string) => {
    misses.set(cacheKey, reason);
    diag.source = 'Google';
    diag.reason = reason;
    return null;
  };

  const address = [postalCode, city, country.code ? '' : country.label].filter(Boolean).join(' ');
  const components = country.code ? `country:${country.code.toUpperCase()}` : '';
  const cacheKey = `${components}|${address.toUpperCase().replace(/\s+/g, ' ')}`;
  const cached = hits.get(cacheKey);
  if (cached) {
    diag.source = 'Google (cache)';
    return cached;
  }
  if (misses.has(cacheKey)) {
    diag.source = 'Google';
    diag.reason = misses.get(cacheKey);
    return null;
  }

  const url = `${ENDPOINT}?${new URLSearchParams({ address, components })}`;

  let lastProblem = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response;
    try {
      response = await fetchWithTimeout(url, {}, signal, TIMEOUT_MS);
    } catch (err: any) {
      if (err.message === 'Aborted') throw err;
      lastProblem = `relais : ${describeError(err)}`;
      console.error('Google geocode error:', err);
      if (attempt === 3) break;
      await wait(1000, signal);
      continue;
    }

    // Trop de requêtes, ou erreur passagère du relais ou de Google (connexion coupée…) :
    // on retente cette adresse, sans renoncer à Google pour les suivantes
    if (response.status === 429 || response.status === 500 || response.status === 502 || response.status === 504) {
      lastProblem = response.status === 429 ? 'trop de requêtes (HTTP 429)' : `erreur passagère du relais (HTTP ${response.status})`;
      if (attempt === 3) break;
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
      console.warn(`Relais Google indisponible (HTTP ${response.status}) : repli sur Nominatim`);
      return giveUp(response.status === 503 ? 'pas de clé sur le serveur (HTTP 503)' : `relais absent (HTTP ${response.status})`);
    }

    switch (data.status) {
      case 'OK': {
        const result = data.results?.[0];
        const types: string[] = result?.types || [];
        if (!result || types.every(t => TOO_VAGUE.has(t))) {
          return miss(`Google : résultat trop vague (seulement « ${result?.formatted_address || 'pays'} »)`);
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
        diag.source = 'Google';
        return hit;
      }
      case 'ZERO_RESULTS':
        return miss('Google : aucun résultat pour ce code postal et cette ville');
      case 'INVALID_REQUEST':
        return miss('Google : requête invalide (code postal et ville vides ?)');
      case 'OVER_QUERY_LIMIT':
        lastProblem = 'quota Google atteint (OVER_QUERY_LIMIT)';
        await wait(2000 * (attempt + 1), signal);
        continue;
      default:
        // REQUEST_DENIED (clé refusée, API non activée, IP non autorisée), UNKNOWN_ERROR…
        console.error('Google geocode:', data.status, data.error_message || '');
        if (data.status === 'UNKNOWN_ERROR') {
          lastProblem = 'erreur inconnue côté Google (UNKNOWN_ERROR)';
          await wait(1000, signal);
          continue;
        }
        return giveUp(`${data.status}${data.error_message ? ` (${data.error_message})` : ''}`);
    }
  }
  // Tentatives épuisées (quota du jour atteint…) : Nominatim pour cette adresse
  diag.reason = `Google sans réponse après 4 essais : ${lastProblem}`;
  return undefined;
}
