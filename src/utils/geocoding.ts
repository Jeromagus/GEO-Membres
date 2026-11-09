import Papa from 'papaparse';
import { resolveCountry } from './country';
import { geocodeForeign } from './nominatim';

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
}

export interface Correction {
  postalCode: string;
  city: string;
  country: string;
}

// Géocode une adresse corrigée à la main : API Adresse pour la France, Nominatim ailleurs
export async function geocodeOne(
  row: ImportRow,
  corrected: Correction,
  signal: AbortSignal
): Promise<GeocodeResult> {
  const country = resolveCountry(corrected.country, corrected.postalCode);
  try {
    if (country.isFrance) {
      const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(corrected.city)}&postcode=${encodeURIComponent(corrected.postalCode)}&limit=1`, { signal });
      const data = await res.json();
      if (data.features && data.features.length > 0) {
        const [lng, lat] = data.features[0].geometry.coordinates;
        return {
          ...row,
          postalCode: data.features[0].properties.postcode || corrected.postalCode,
          city: data.features[0].properties.city || corrected.city,
          country: country.label,
          lat,
          lng,
          valid: true
        };
      }
    } else {
      const hit = await geocodeForeign(corrected.postalCode, corrected.city, country, signal);
      if (hit) {
        return { ...row, postalCode: hit.postalCode, city: hit.city, country: country.label, lat: hit.lat, lng: hit.lng, valid: true };
      }
    }
  } catch (err: any) {
    if (err.message === 'Aborted' || err.name === 'AbortError' || signal.aborted) throw new Error('Aborted');
    console.error('Geocode error:', err);
  }
  return { ...row, valid: false };
}

export function normalizeCityName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove accents
    .toLowerCase()
    .replace(/[-_']/g, " ") // Replace hyphens, underscores, apostrophes with spaces
    .replace(/\b(st)\b/g, "saint") // Expand "st" to "saint"
    .replace(/\b(ste)\b/g, "sainte") // Expand "ste" to "sainte"
    .replace(/\bcedex\b.*$/g, "") // Remove "cedex" and anything after it
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim();
}

export async function geocodeInChunks(
  rows: ImportRow[],
  onProgress: (count: number) => void,
  onResolve: (row: ImportRow) => Promise<Correction | null>,
  signal: AbortSignal
): Promise<GeocodeResult[]> {
  const chunkSize = 100;
  const results: GeocodeResult[] = [];
  let processed = 0;

  // Le pays de chaque ligne est normalisé une fois : la France passe par l'API Adresse
  // par lots, les autres pays par Nominatim, une adresse à la fois.
  const countryOf = new Map(rows.map(r => [r.index, resolveCountry(r.country, r.postalCode)]));
  const normalized = rows.map(r => ({ ...r, country: countryOf.get(r.index)!.label }));
  const frenchRows = normalized.filter(r => countryOf.get(r.index)!.isFrance);
  const foreignRows = normalized.filter(r => !countryOf.get(r.index)!.isFrance);

  for (let i = 0; i < frenchRows.length; i += chunkSize) {
    if (signal.aborted) {
      throw new Error('Aborted');
    }
    const chunk = frenchRows.slice(i, i + chunkSize);
    
    // Create CSV for this chunk safely using Papa.unparse
    const csvData = chunk.map(r => ({
      id: r.index,
      postcode: r.postalCode,
      city: r.city
    }));
    const csvContent = Papa.unparse(csvData);
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const formData = new FormData();
    formData.append('data', blob, 'search.csv');
    formData.append('columns', 'postcode');
    formData.append('columns', 'city');
    formData.append('postcode', 'postcode');
    
    let retries = 3;
    let success = false;
    let invalidInChunk: ImportRow[] = [];

    while (retries > 0 && !success) {
      try {
        const response = await fetch('https://api-adresse.data.gouv.fr/search/csv/', {
          method: 'POST',
          body: formData,
          signal
        });

        if (!response.ok) throw new Error(`API Error: ${response.status}`);

        const resultCsv = await response.text();
        
        const parsed = Papa.parse(resultCsv, { header: true, skipEmptyLines: true });
        
        invalidInChunk = [];
        
        parsed.data.forEach((row: any) => {
          const lat = parseFloat(row.latitude);
          const lng = parseFloat(row.longitude);
          const valid = !isNaN(lat) && !isNaN(lng);
          const originalRow = chunk.find(r => r.index === parseInt(row.id));
          
          if (valid) {
            results.push({
              ...originalRow,
              index: parseInt(row.id),
              postalCode: row.postcode || originalRow?.postalCode || '',
              city: row.city || originalRow?.city || '',
              country: originalRow?.country || '',
              lat,
              lng,
              valid: true
            });
          } else if (originalRow) {
            invalidInChunk.push(originalRow);
          }
        });
        
        success = true;
      } catch (err: any) {
        if (err.name === 'AbortError' || signal.aborted) {
          throw new Error('Aborted');
        }
        retries--;
        if (retries === 0) {
          console.error('Chunk error:', err);
          invalidInChunk = [...chunk];
        } else {
          // Wait 1 second before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    // Process invalid rows with user resolution
    for (const invalidRow of invalidInChunk) {
      if (signal.aborted) throw new Error('Aborted');
      
      let autoCorrectedCity: string | null = null;
      let autoCorrectedPostalCode: string | null = null;
      
      try {
        // Try to auto-resolve first by postal code
        const res = await fetch(`https://geo.api.gouv.fr/communes?codePostal=${invalidRow.postalCode}&fields=nom,codesPostaux&format=json`, { signal });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            const normalizedInput = normalizeCityName(invalidRow.city);
            
            // 1. Exact match
            let match = data.find((d: any) => normalizeCityName(d.nom) === normalizedInput);
            
            // 2. Contains match (input is contained in official name, or official name is contained in input)
            if (!match) {
               match = data.find((d: any) => {
                 const normalizedOfficial = normalizeCityName(d.nom);
                 return normalizedOfficial.includes(normalizedInput) || normalizedInput.includes(normalizedOfficial);
               });
            }

            if (match) {
              autoCorrectedCity = match.nom;
            } else if (data.length === 1) {
              // 3. Only one city for this postal code
              autoCorrectedCity = data[0].nom;
            }
          }
        }

        // 4. If still not found, try reverse search by city name
        if (!autoCorrectedCity) {
          const normalizedInput = normalizeCityName(invalidRow.city);
          const resCity = await fetch(`https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(normalizedInput)}&fields=nom,codesPostaux&format=json&limit=5`, { signal });
          if (resCity.ok) {
            const dataCity = await resCity.json();
            if (Array.isArray(dataCity) && dataCity.length > 0) {
              // Exact match on name
              const match = dataCity.find((d: any) => normalizeCityName(d.nom) === normalizedInput);
              if (match && match.codesPostaux && match.codesPostaux.length > 0) {
                 autoCorrectedCity = match.nom;
                 autoCorrectedPostalCode = match.codesPostaux[0]; // Take the first postal code
              } else if (dataCity.length === 1 && dataCity[0].codesPostaux && dataCity[0].codesPostaux.length > 0) {
                 autoCorrectedCity = dataCity[0].nom;
                 autoCorrectedPostalCode = dataCity[0].codesPostaux[0];
              }
            }
          }
        }
      } catch (err) {
        console.error('Auto-correction error:', err);
      }

      let corrected: Correction | null = null;

      if (autoCorrectedCity) {
        corrected = {
          postalCode: autoCorrectedPostalCode || invalidRow.postalCode,
          city: autoCorrectedCity,
          country: invalidRow.country
        };
      } else {
        corrected = await onResolve(invalidRow);
      }

      results.push(corrected ? await geocodeOne(invalidRow, corrected, signal) : { ...invalidRow, valid: false });
    }

    processed += chunk.length;
    onProgress(processed);
    
    // Add a small delay between chunks to avoid rate limiting
    if (i + chunkSize < frenchRows.length) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  for (const row of foreignRows) {
    if (signal.aborted) throw new Error('Aborted');
    const hit = await geocodeForeign(row.postalCode, row.city, countryOf.get(row.index)!, signal);

    if (hit) {
      results.push({ ...row, postalCode: hit.postalCode, city: hit.city, lat: hit.lat, lng: hit.lng, valid: true });
    } else {
      const corrected = await onResolve(row);
      results.push(corrected ? await geocodeOne(row, corrected, signal) : { ...row, valid: false });
    }

    processed++;
    onProgress(processed);
  }

  return results;
}
