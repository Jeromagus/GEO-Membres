import Papa from 'papaparse';

export interface GeocodeResult {
  index: number;
  postalCode: string;
  city: string;
  country: string;
  lat?: number;
  lng?: number;
  valid: boolean;
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
  rows: { index: number; postalCode: string; city: string; country: string }[],
  onProgress: (count: number) => void,
  onResolve: (row: { index: number; postalCode: string; city: string; country: string }) => Promise<{ postalCode: string; city: string } | null>,
  signal: AbortSignal
): Promise<GeocodeResult[]> {
  const chunkSize = 100;
  const results: GeocodeResult[] = [];
  let processed = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    if (signal.aborted) {
      throw new Error('Aborted');
    }
    const chunk = rows.slice(i, i + chunkSize);
    
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
    let invalidInChunk: { index: number; postalCode: string; city: string; country: string }[] = [];

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

      let corrected: { postalCode: string; city: string } | null = null;

      if (autoCorrectedCity) {
        corrected = { 
          postalCode: autoCorrectedPostalCode || invalidRow.postalCode, 
          city: autoCorrectedCity 
        };
      } else {
        corrected = await onResolve(invalidRow);
      }
      
      if (corrected) {
        try {
          const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(corrected.city)}&postcode=${encodeURIComponent(corrected.postalCode)}&limit=1`, { signal });
          const data = await res.json();
          
          if (data.features && data.features.length > 0) {
            const [lng, lat] = data.features[0].geometry.coordinates;
            results.push({
              index: invalidRow.index,
              postalCode: data.features[0].properties.postcode || corrected.postalCode,
              city: data.features[0].properties.city || corrected.city,
              country: invalidRow.country,
              lat,
              lng,
              valid: true
            });
          } else {
            results.push({ ...invalidRow, valid: false });
          }
        } catch (err) {
          results.push({ ...invalidRow, valid: false });
        }
      } else {
        results.push({ ...invalidRow, valid: false });
      }
    }

    processed += chunk.length;
    onProgress(processed);
    
    // Add a small delay between chunks to avoid rate limiting
    if (i + chunkSize < rows.length) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  return results;
}
