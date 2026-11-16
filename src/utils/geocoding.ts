import Papa from 'papaparse';
import { CountryRef, prepareForeign, resolveCountry } from './country';
import { geocodeForeign, ForeignHit } from './nominatim';
import { geocodeGoogle } from './google';
import { Diag, describeError, fetchWithTimeout, wait } from './net';

// Géocodeur français : service de la Géoplateforme IGN, qui remplace l'API Adresse
// (api-adresse.data.gouv.fr, gardée en secours). Mêmes paramètres et mêmes réponses.
const BAN_SERVERS = [
  { name: 'Géoplateforme IGN', search: 'https://data.geopf.fr/geocodage/search', csv: 'https://data.geopf.fr/geocodage/search/csv' },
  { name: 'API Adresse', search: 'https://api-adresse.data.gouv.fr/search/', csv: 'https://api-adresse.data.gouv.fr/search/csv/' },
];
const GEO_API = 'https://geo.api.gouv.fr/communes';
const CSV_TIMEOUT_MS = 45000;
const SEARCH_TIMEOUT_MS = 15000;
const COMMUNES_TIMEOUT_MS = 10000;

// Adresse hors de France : nettoyée, puis Google (par le relais du serveur), ou Nominatim
// si le relais n'est pas disponible. Renvoie aussi le pays retenu (il peut être lu dans la ville).
async function locateForeign(
  postalCode: string,
  city: string,
  declared: CountryRef,
  signal: AbortSignal,
  diag: Diag
): Promise<{ hit: ForeignHit | null; country: CountryRef; city: string; postalCode: string }> {
  const prepared = prepareForeign(postalCode, city, declared);
  let hit = await geocodeGoogle(prepared.postalCode, prepared.city, prepared.country, signal, diag);
  if (hit === undefined) {
    hit = await geocodeForeign(prepared.postalCode, prepared.city, prepared.country, signal, diag);
  }
  if (hit) diag.reason = undefined;
  return { hit, ...prepared };
}

// Exécute les tâches avec au plus `size` en cours à la fois
async function runPool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

export interface ImportRow {
  index: number;
  postalCode: string;
  city: string;
  country: string;
  // Organismes uniquement : conservés tels quels à travers le géocodage
  type?: string;
  name?: string;
}

export interface GeocodeResult extends ImportRow {
  lat?: number;
  lng?: number;
  valid: boolean;
  // Service qui a placé l'adresse (ou qui a été interrogé en dernier)
  source?: string;
  // Pourquoi l'adresse n'est pas placée, ou comment elle a été corrigée
  reason?: string;
  // Saisie d'origine, quand l'adresse a été corrigée (automatiquement ou à la main)
  original?: { postalCode: string; city: string; country: string };
}

export interface Correction {
  postalCode: string;
  city: string;
  country: string;
}

async function searchFrance(city: string, postalCode: string, signal: AbortSignal, diag: Diag): Promise<any | null> {
  const errors: string[] = [];
  for (const server of BAN_SERVERS) {
    try {
      const params = new URLSearchParams({ q: city || postalCode, limit: '1' });
      if (/^\d{5}$/.test(postalCode)) params.set('postcode', postalCode);
      const res = await fetchWithTimeout(`${server.search}?${params}`, {}, signal, SEARCH_TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      diag.source = server.name;
      if (data.features && data.features.length > 0) return data.features[0];
      diag.reason = `${server.name} : aucun résultat pour « ${postalCode} ${city} »`;
      return null;
    } catch (err: any) {
      if (err.message === 'Aborted') throw err;
      errors.push(`${server.name} : ${describeError(err)}`);
    }
  }
  diag.reason = `géocodeur français injoignable (${errors.join(' ; ')})`;
  return null;
}

// Géocode une adresse corrigée à la main : Géoplateforme pour la France, Google ou Nominatim ailleurs
export async function geocodeOne(
  row: ImportRow,
  corrected: Correction,
  signal: AbortSignal
): Promise<GeocodeResult> {
  const country = resolveCountry(corrected.country, corrected.postalCode);
  const diag: Diag = {};
  const original = { postalCode: row.postalCode, city: row.city, country: row.country };
  try {
    if (country.isFrance) {
      const feature = await searchFrance(corrected.city, corrected.postalCode, signal, diag);
      if (feature) {
        const [lng, lat] = feature.geometry.coordinates;
        return {
          ...row,
          postalCode: feature.properties.postcode || corrected.postalCode,
          city: feature.properties.city || corrected.city,
          country: country.label,
          lat,
          lng,
          valid: true,
          source: diag.source,
          original,
        };
      }
    } else {
      const found = await locateForeign(corrected.postalCode, corrected.city, country, signal, diag);
      if (found.hit) {
        const { hit } = found;
        return { ...row, postalCode: hit.postalCode, city: hit.city, country: found.country.label, lat: hit.lat, lng: hit.lng, valid: true, source: diag.source, original };
      }
    }
  } catch (err: any) {
    if (err.message === 'Aborted' || err.name === 'AbortError' || signal.aborted) throw new Error('Aborted');
    console.error('Geocode error:', err);
    diag.reason = describeError(err);
  }
  return {
    ...row,
    valid: false,
    source: diag.source,
    reason: `correction « ${[corrected.postalCode, corrected.city, corrected.country].filter(Boolean).join(' ')} » introuvable : ${diag.reason || 'sans réponse'}`,
  };
}

export function normalizeCityName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // Remove accents
    .toLowerCase()
    .replace(/[-_']/g, " ") // Replace hyphens, underscores, apostrophes with spaces
    .replace(/\b(st)\b/g, "saint") // Expand "st" to "saint"
    .replace(/\b(ste)\b/g, "sainte") // Expand "ste" to "sainte"
    .replace(/\bcedex\b.*$/g, "") // Remove "cedex" and anything after it
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim();
}

// Géocodage d'un lot d'adresses françaises par le service CSV (Géoplateforme, puis API Adresse).
// Renvoie les lignes du CSV de réponse, ou lève une erreur décrivant l'échec des deux serveurs.
async function geocodeFrenchBatch(chunk: ImportRow[], signal: AbortSignal): Promise<{ rows: any[]; source: string }> {
  const csvContent = Papa.unparse(chunk.map(r => ({ id: r.index, postcode: r.postalCode, city: r.city })));
  const errors: string[] = [];

  for (const server of BAN_SERVERS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const formData = new FormData();
      formData.append('data', new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }), 'search.csv');
      formData.append('columns', 'postcode');
      formData.append('columns', 'city');
      formData.append('postcode', 'postcode');
      try {
        const response = await fetchWithTimeout(server.csv, { method: 'POST', body: formData }, signal, CSV_TIMEOUT_MS);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = Papa.parse(await response.text(), { header: true, skipEmptyLines: true });
        return { rows: parsed.data as any[], source: server.name };
      } catch (err: any) {
        if (err.message === 'Aborted') throw err;
        console.error(`${server.name} (essai ${attempt}) :`, err);
        errors.push(`${server.name} essai ${attempt} : ${describeError(err)}`);
        await wait(1000, signal);
      }
    }
  }
  throw new Error(errors.join(' ; '));
}

async function fetchCommunes(params: string, signal: AbortSignal): Promise<any[] | null> {
  const res = await fetchWithTimeout(`${GEO_API}?${params}&fields=nom,codesPostaux&format=json`, {}, signal, COMMUNES_TIMEOUT_MS);
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) ? data : null;
}

export async function geocodeInChunks(
  rows: ImportRow[],
  onProgress: (count: number) => void,
  onResolve: (row: ImportRow, reason: string) => Promise<Correction | null>,
  signal: AbortSignal
): Promise<GeocodeResult[]> {
  const chunkSize = 100;
  const results: GeocodeResult[] = [];
  let processed = 0;

  // Le pays de chaque ligne est normalisé une fois : la France passe par la Géoplateforme
  // par lots, les autres pays par Google ou Nominatim, une adresse à la fois.
  const countryOf = new Map(rows.map(r => [r.index, resolveCountry(r.country, r.postalCode)]));
  const normalized = rows.map(r => ({ ...r, country: countryOf.get(r.index)!.label }));
  const frenchRows = normalized.filter(r => countryOf.get(r.index)!.isFrance);
  const foreignRows = normalized.filter(r => !countryOf.get(r.index)!.isFrance);

  for (let i = 0; i < frenchRows.length; i += chunkSize) {
    if (signal.aborted) throw new Error('Aborted');
    const chunk = frenchRows.slice(i, i + chunkSize);

    // Lignes à reprendre une par une, avec la raison de l'échec du lot
    const invalidInChunk: { row: ImportRow; reason: string }[] = [];

    try {
      const batch = await geocodeFrenchBatch(chunk, signal);
      const seen = new Set<number>();
      for (const row of batch.rows) {
        const index = parseInt(row.id);
        const originalRow = chunk.find(r => r.index === index);
        if (!originalRow) continue;
        seen.add(index);
        const lat = parseFloat(row.latitude);
        const lng = parseFloat(row.longitude);
        if (!isNaN(lat) && !isNaN(lng)) {
          results.push({
            ...originalRow,
            // Saisie conservée (le géocodeur peut renvoyer le CP principal de la commune)
            postalCode: originalRow.postalCode || row.result_postcode || '',
            city: originalRow.city || row.result_city || '',
            lat,
            lng,
            valid: true,
            source: batch.source,
          });
        } else {
          invalidInChunk.push({
            row: originalRow,
            reason: !originalRow.postalCode && !originalRow.city
              ? 'code postal et ville vides'
              : !/^\d{5}$/.test(originalRow.postalCode)
                ? `code postal « ${originalRow.postalCode} » non conforme (5 chiffres attendus en France)`
                : `${batch.source} : « ${originalRow.postalCode} ${originalRow.city} » introuvable${row.result_status && row.result_status !== 'ok' ? ` (${row.result_status})` : ''}`,
          });
        }
      }
      for (const r of chunk) {
        if (!seen.has(r.index)) invalidInChunk.push({ row: r, reason: 'ligne absente de la réponse du géocodeur' });
      }
    } catch (err: any) {
      if (err.message === 'Aborted') throw err;
      for (const r of chunk) invalidInChunk.push({ row: r, reason: `géocodeur français injoignable (${err.message})` });
    }

    // Reprise des lignes non trouvées : correction automatique, sinon demande à l'utilisateur
    for (const { row: invalidRow, reason } of invalidInChunk) {
      if (signal.aborted) throw new Error('Aborted');

      let autoCorrectedCity: string | null = null;
      let autoCorrectedPostalCode: string | null = null;
      let autoNote = '';

      try {
        // 1. Communes du code postal
        if (/^\d{5}$/.test(invalidRow.postalCode)) {
          const data = await fetchCommunes(`codePostal=${invalidRow.postalCode}`, signal);
          if (data && data.length > 0) {
            const normalizedInput = normalizeCityName(invalidRow.city);
            let match = data.find((d: any) => normalizeCityName(d.nom) === normalizedInput);
            if (!match) {
              match = data.find((d: any) => {
                const normalizedOfficial = normalizeCityName(d.nom);
                return normalizedOfficial.includes(normalizedInput) || normalizedInput.includes(normalizedOfficial);
              });
            }
            if (match) {
              autoCorrectedCity = match.nom;
              autoNote = `ville rapprochée de « ${match.nom} » (communes du ${invalidRow.postalCode})`;
            } else if (data.length === 1) {
              autoCorrectedCity = data[0].nom;
              autoNote = `seule commune du ${invalidRow.postalCode} : « ${data[0].nom} »`;
            }
          }
        }

        // 2. Sinon, recherche par nom de ville
        if (!autoCorrectedCity && invalidRow.city) {
          const normalizedInput = normalizeCityName(invalidRow.city);
          const dataCity = await fetchCommunes(`nom=${encodeURIComponent(normalizedInput)}&limit=5`, signal);
          if (dataCity && dataCity.length > 0) {
            const match = dataCity.find((d: any) => normalizeCityName(d.nom) === normalizedInput)
              || (dataCity.length === 1 ? dataCity[0] : null);
            if (match && match.codesPostaux && match.codesPostaux.length > 0) {
              autoCorrectedCity = match.nom;
              autoCorrectedPostalCode = match.codesPostaux[0];
              autoNote = `code postal remplacé par ${match.codesPostaux[0]} (commune « ${match.nom} »)`;
            }
          }
        }
      } catch (err: any) {
        if (err.message === 'Aborted') throw err;
        console.error('Auto-correction error:', err);
        autoNote = `correction automatique impossible (geo.api.gouv.fr : ${describeError(err)})`;
      }

      // 3. Repli : commune du même nom sur la Géoplateforme, de préférence dans le même département
      if (!autoCorrectedCity && invalidRow.city) {
        try {
          const params = new URLSearchParams({ q: invalidRow.city, type: 'municipality', limit: '10' });
          const res = await fetchWithTimeout(`${BAN_SERVERS[0].search}?${params}`, {}, signal, SEARCH_TIMEOUT_MS);
          if (res.ok) {
            const data = await res.json();
            const wanted = normalizeCityName(invalidRow.city);
            const same = (data.features || []).filter((f: any) => normalizeCityName(f.properties?.city || f.properties?.name || '') === wanted);
            const dept = invalidRow.postalCode.slice(0, 2);
            const match = same.find((f: any) => String(f.properties?.postcode || '').startsWith(dept)) || (same.length === 1 ? same[0] : null);
            if (match?.properties?.postcode) {
              autoCorrectedCity = match.properties.city || match.properties.name;
              autoCorrectedPostalCode = match.properties.postcode;
              autoNote = `code postal remplacé par ${match.properties.postcode} (commune « ${autoCorrectedCity} », Géoplateforme)`;
            }
          }
        } catch (err: any) {
          if (err.message === 'Aborted') throw err;
          console.error('Auto-correction (Géoplateforme) error:', err);
        }
      }

      let corrected: Correction | null = null;
      let how = '';
      if (autoCorrectedCity) {
        corrected = {
          postalCode: autoCorrectedPostalCode || invalidRow.postalCode,
          city: autoCorrectedCity,
          country: invalidRow.country
        };
        how = `corrigée automatiquement : ${autoNote}`;
      } else {
        const why = autoNote ? `${reason} ; ${autoNote}` : reason;
        corrected = await onResolve(invalidRow, why);
        if (!corrected) {
          results.push({ ...invalidRow, valid: false, reason: `${why} ; ignorée à la correction` });
        } else {
          how = 'corrigée à la main';
        }
      }

      if (corrected) {
        const result = await geocodeOne(invalidRow, corrected, signal);
        results.push(result.valid ? { ...result, reason: `${reason} → ${how}` } : { ...result, reason: `${reason} ; ${result.reason}` });
      }
    }

    processed += chunk.length;
    onProgress(processed);

    // Petite pause entre les lots pour ne pas saturer le service
    if (i + chunkSize < frenchRows.length) await wait(300, signal);
  }

  // Hors de France : plusieurs recherches à la fois (Google). Les adresses introuvables ne
  // bloquent pas l'import : elles restent invalides, à reprendre par « Corriger les invalides ».
  await runPool(foreignRows, 8, async (row) => {
    if (signal.aborted) throw new Error('Aborted');
    const diag: Diag = {};
    let found: Awaited<ReturnType<typeof locateForeign>> | null = null;
    try {
      found = await locateForeign(row.postalCode, row.city, countryOf.get(row.index)!, signal, diag);
    } catch (err: any) {
      if (err.message === 'Aborted') throw err;
      diag.reason = `erreur : ${describeError(err)}`;
    }

    if (found?.hit) {
      const { hit } = found;
      results.push({ ...row, postalCode: hit.postalCode, city: hit.city, country: found.country.label, lat: hit.lat, lng: hit.lng, valid: true, source: diag.source });
    } else {
      results.push({
        ...row,
        postalCode: found?.postalCode ?? row.postalCode,
        city: found?.city ?? row.city,
        country: found?.country.label ?? row.country,
        valid: false,
        source: diag.source,
        reason: diag.reason || 'introuvable',
      });
    }

    processed++;
    onProgress(processed);
  });

  return results.sort((a, b) => a.index - b.index);
}
