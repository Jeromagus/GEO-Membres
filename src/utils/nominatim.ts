// Géocodage hors de France via Nominatim (OpenStreetMap).
// Règles d'usage : 1 requête par seconde au plus, et mise en cache des résultats.
// https://operations.osmfoundation.org/policies/nominatim/

import { CountryRef } from './country';
import { Diag, describeError, fetchWithTimeout, wait } from './net';

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const MIN_INTERVAL_MS = 1100;
const CACHE_KEY = 'geo-membres:nominatim:v1';
const TIMEOUT_MS = 15000;

export interface ForeignHit {
  lat: number;
  lng: number;
  postalCode: string;
  city: string;
}

// Cache des réponses : les succès persistent dans le navigateur (réimporter le même fichier
// ne relance pas les requêtes), les échecs ne valent que pour la session.
const hits = new Map<string, ForeignHit>();
const misses = new Map<string, string>();

try {
  const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  for (const [k, v] of Object.entries(stored)) hits.set(k, v as ForeignHit);
} catch {
  // stockage indisponible ou illisible : cache en mémoire seulement
}

function persist() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(hits)));
  } catch {
    // quota dépassé ou stockage bloqué : sans gravité
  }
}

let nextSlotAt = 0;

async function search(params: Record<string, string>, country: CountryRef, signal: AbortSignal): Promise<ForeignHit | null> {
  const query = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', limit: '1', 'accept-language': 'fr', ...params });
  if (country.code) query.set('countrycodes', country.code);
  else query.set('country', country.label);

  // Créneau réservé avant d'attendre : reste à 1 requête/s même avec des appels simultanés
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + MIN_INTERVAL_MS;
  if (slot > now) await wait(slot - now, signal);

  const response = await fetchWithTimeout(`${ENDPOINT}?${query}`, {}, signal, TIMEOUT_MS);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  const place = data[0];
  const lat = parseFloat(place.lat);
  const lng = parseFloat(place.lon);
  if (isNaN(lat) || isNaN(lng)) return null;

  const a = place.address || {};
  return {
    lat,
    lng,
    postalCode: a.postcode || '',
    city: a.city || a.town || a.village || a.municipality || a.hamlet || '',
  };
}

// Essais successifs : code postal + ville, puis ville seule, puis code postal seul.
// (Les codes postaux complets sont rares dans OpenStreetMap pour certains pays, dont le Canada.)
export async function geocodeForeign(
  postalCode: string,
  city: string,
  country: CountryRef,
  signal: AbortSignal,
  diag: Diag = {}
): Promise<ForeignHit | null> {
  const cacheKey = [country.code || country.label.toLowerCase(), postalCode.toUpperCase().replace(/\s+/g, ''), city.toLowerCase().trim()].join('|');
  const cached = hits.get(cacheKey);
  diag.source = 'Nominatim';
  if (cached) return cached;
  if (misses.has(cacheKey)) {
    diag.reason = misses.get(cacheKey);
    return null;
  }

  const attempts: Record<string, string>[] = [];
  if (postalCode && city) attempts.push({ postalcode: postalCode, city });
  if (city) attempts.push({ city });
  if (postalCode) attempts.push({ postalcode: postalCode });

  const errors: string[] = [];
  for (const params of attempts) {
    let hit: ForeignHit | null = null;
    // Une seconde tentative en cas d'erreur réseau ou de refus temporaire
    for (let retry = 0; retry < 2; retry++) {
      try {
        hit = await search(params, country, signal);
        break;
      } catch (err: any) {
        if (err.message === 'Aborted') throw err;
        console.error('Nominatim error:', err);
        if (retry === 1) errors.push(describeError(err));
        if (retry === 0) await wait(2000, signal);
      }
    }
    if (hit) {
      // On garde la saisie d'origine quand elle existe, Nominatim complète les vides
      const result = { ...hit, postalCode: postalCode || hit.postalCode, city: city || hit.city };
      hits.set(cacheKey, result);
      persist();
      return result;
    }
  }

  const tried = attempts.map(a => Object.keys(a).map(k => (k === 'postalcode' ? 'CP' : 'ville')).join(' + ')).join(', ');
  const reason = errors.length > 0
    ? `Nominatim en erreur : ${errors[errors.length - 1]}`
    : `Nominatim : introuvable (essayé ${tried || 'rien : CP et ville vides'})`;
  diag.reason = previousReason(diag, reason);
  // Une erreur réseau n'est pas mémorisée : un nouvel essai pourra réussir
  if (errors.length === 0) misses.set(cacheKey, diag.reason);
  return null;
}

// Garde la raison de Google (quand Google a été tenté avant) devant celle de Nominatim
function previousReason(diag: Diag, reason: string): string {
  return diag.reason ? `${diag.reason} ; ${reason}` : reason;
}
