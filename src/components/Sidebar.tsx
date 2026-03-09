import React, { useRef, useState, useMemo, useEffect } from 'react';
import { Upload, MapPin, Settings2, Users, FileSpreadsheet, AlertCircle, Download, RefreshCw, Edit3 } from 'lucide-react';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { Member, MarkerState } from '../types';
import { geocodeInChunks, GeocodeResult } from '../utils/geocoding';

interface SidebarProps {
  members: Member[];
  setMembers: React.Dispatch<React.SetStateAction<Member[]>>;
  marker: MarkerState;
  setMarker: (marker: MarkerState) => void;
  membersInRadius: Member[];
}

function ResolutionModal({ 
  row, 
  initialOptions, 
  onResolve 
}: { 
  row: { index: number; postalCode: string; city: string; country: string }; 
  initialOptions: string[]; 
  onResolve: (result: { postalCode: string; city: string } | null) => void 
}) {
  const [postalCode, setPostalCode] = useState(row.postalCode);
  const [city, setCity] = useState(initialOptions.length === 1 ? initialOptions[0] : row.city);
  const [options, setOptions] = useState<string[]>(initialOptions);

  useEffect(() => {
    if (postalCode !== row.postalCode && postalCode.length === 5) {
      fetch(`https://geo.api.gouv.fr/communes?codePostal=${postalCode}&fields=nom&format=json`)
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) {
            setOptions(data.map((d: any) => d.nom));
          }
        })
        .catch(() => setOptions([]));
    }
  }, [postalCode, row.postalCode]);

  return (
    <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200">
        <h3 className="text-lg font-bold text-gray-900 mb-2">Localisation introuvable</h3>
        <p className="text-sm text-gray-600 mb-4">
          Ligne {row.index} : la combinaison Code Postal / Ville n'a pas été trouvée.
        </p>
        
        <div className="space-y-4 mb-6">
          <div className="flex gap-3">
            <div className="w-1/3">
              <label className="block text-xs font-medium text-gray-700 mb-1">Code Postal</label>
              <input 
                type="text" 
                className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)}
              />
            </div>
            <div className="w-2/3">
              <label className="block text-xs font-medium text-gray-700 mb-1">Ville</label>
              <input 
                type="text" 
                className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                value={city}
                onChange={(e) => setCity(e.target.value)}
              />
            </div>
          </div>
          
          {options.length > 0 && (
            <div className="pt-3 border-t border-gray-100">
              <label className="block text-xs font-medium text-indigo-700 mb-2">Villes officielles pour {postalCode}</label>
              <div className="flex flex-wrap gap-2">
                {options.map(opt => (
                  <button
                    key={opt}
                    onClick={() => setCity(opt)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      city.toLowerCase() === opt.toLowerCase() 
                        ? 'bg-indigo-600 text-white' 
                        : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3">
          <button 
            onClick={() => onResolve(null)}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            Ignorer
          </button>
          <button 
            onClick={() => onResolve({ postalCode, city })}
            className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
          >
            Valider
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Sidebar({ members, setMembers, marker, setMarker, membersInRadius }: SidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reimportInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [isReimporting, setIsReimporting] = useState(false);
  
  const [resolvingRow, setResolvingRow] = useState<{
    row: { index: number; postalCode: string; city: string; country: string };
    options: string[];
    resolve: (value: { postalCode: string; city: string } | null) => void;
  } | null>(null);
  
  const [importState, setImportState] = useState<{
    isAnalyzing: boolean;
    analyzedCount: number;
    totalCount: number;
    showCancelConfirm: boolean;
    results: { valid: number; invalid: number; invalidData: GeocodeResult[] } | null;
  }>({
    isAnalyzing: false,
    analyzedCount: 0,
    totalCount: 0,
    showCancelConfirm: false,
    results: null
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  const handleCorrectNext = (currentIndex: number, invalidData: GeocodeResult[]) => {
    const nextIndex = currentIndex + 1;
    if (nextIndex < invalidData.length) {
      const rowToCorrect = invalidData[nextIndex];
      
      // Open the resolution modal for this row
      handleResolveRequest(rowToCorrect).then(async (result) => {
        if (result) {
          // Attempt to geocode the corrected result
          try {
            const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(result.city)}&postcode=${encodeURIComponent(result.postalCode)}&limit=1`);
            const data = await res.json();
            
            if (data.features && data.features.length > 0) {
              const [lng, lat] = data.features[0].geometry.coordinates;
              const timestamp = Date.now();
              const newMember: Member = {
                id: `member-${timestamp}-${rowToCorrect.index}`,
                originalIndex: rowToCorrect.index,
                postalCode: data.features[0].properties.postcode || result.postalCode,
                city: data.features[0].properties.city || result.city,
                country: rowToCorrect.country,
                lat,
                lng
              };
              
              // Add to members
              setMembers(prev => [...prev, newMember]);
              
              // Update import state
              setImportState(prev => {
                if (!prev.results) return prev;
                return {
                  ...prev,
                  results: {
                    ...prev.results,
                    valid: prev.results.valid + 1,
                    invalid: prev.results.invalid - 1
                  }
                };
              });
            }
          } catch (err) {
            console.error("Failed to geocode corrected address", err);
          }
        }
        
        // Move to the next one automatically
        handleCorrectNext(nextIndex, invalidData);
      });
    }
  };

  const startCorrection = () => {
    if (importState.results?.invalidData) {
      handleCorrectNext(-1, importState.results.invalidData);
    }
  };

  const [isEditingRadius, setIsEditingRadius] = useState(false);
  const [tempRadius, setTempRadius] = useState("");
  
  const [searchCP, setSearchCP] = useState("");
  const [searchCityOptions, setSearchCityOptions] = useState<string[]>([]);
  const [isSearchingCity, setIsSearchingCity] = useState(false);

  useEffect(() => {
    if (searchCP.length === 5) {
      setIsSearchingCity(true);
      fetch(`https://geo.api.gouv.fr/communes?codePostal=${searchCP}&fields=nom&format=json`)
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) {
            setSearchCityOptions(data.map((d: any) => d.nom));
          }
        })
        .catch(() => setSearchCityOptions([]))
        .finally(() => setIsSearchingCity(false));
    } else {
      setSearchCityOptions([]);
    }
  }, [searchCP]);

  const handleCitySelect = async (city: string) => {
    try {
      const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(city)}&postcode=${encodeURIComponent(searchCP)}&limit=1`);
      const data = await res.json();
      if (data.features && data.features.length > 0) {
        const [lng, lat] = data.features[0].geometry.coordinates;
        setMarker({ ...marker, lat, lng, focusTrigger: Date.now() });
        setSearchCP("");
        setSearchCityOptions([]);
      }
    } catch (err) {
      console.error("Failed to geocode city", err);
    }
  };

  const handleRadiusSubmit = () => {
    const val = parseInt(tempRadius);
    if (!isNaN(val) && val > 0) {
      setMarker({ ...marker, radiusKm: val, focusTrigger: Date.now() });
    }
    setIsEditingRadius(false);
  };

  const groupedMembers = useMemo(() => {
    const groups = new Map<string, { cp: string; city: string; count: number }>();
    for (const m of membersInRadius) {
      const key = `${m.postalCode}-${m.city}`;
      if (!groups.has(key)) {
        groups.set(key, { cp: m.postalCode, city: m.city, count: 0 });
      }
      groups.get(key)!.count++;
    }
    return Array.from(groups.values()).sort((a, b) => b.count - a.count);
  }, [membersInRadius]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setIsReimporting(false);
      setStagedFile(file);
    }
  };

  const handleReimportSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setIsReimporting(true);
      setStagedFile(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && (file.name.endsWith('.csv') || file.name.endsWith('.xlsx') || file.name.endsWith('.xls'))) {
      setIsReimporting(false);
      setStagedFile(file);
    } else {
      setError('Format de fichier non supporté. Utilisez .csv ou .xlsx');
    }
  };

  const handleResolveRequest = async (row: { index: number; postalCode: string; city: string; country: string }) => {
    return new Promise<{ postalCode: string; city: string } | null>(async (resolve) => {
      let options: string[] = [];
      try {
        const res = await fetch(`https://geo.api.gouv.fr/communes?codePostal=${row.postalCode}&fields=nom&format=json`);
        if (res.ok) {
          const data = await res.json();
          options = data.map((d: any) => d.nom);
        }
      } catch (err) {
        console.error(err);
      }
      
      setResolvingRow({ row, options, resolve });
    });
  };

  const confirmImport = async () => {
    if (!stagedFile) return;
    const file = stagedFile;
    const appending = isReimporting;
    setStagedFile(null);
    setError(null);
    setImportState(prev => ({
      ...prev,
      isAnalyzing: false,
      analyzedCount: 0,
      totalCount: 0,
      showCancelConfirm: false,
      results: appending ? prev.results : null
    }));

    try {
      let rawData: any[][] = [];

      if (file.name.endsWith('.csv')) {
        const text = await file.text();
        const result = Papa.parse(text, { header: false, skipEmptyLines: true });
        rawData = result.data as any[][];
      } else if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      } else {
        throw new Error('Format de fichier non supporté. Utilisez .csv ou .xlsx');
      }

      if (rawData.length === 0) {
        throw new Error('Le fichier est vide.');
      }

      // Skip header if first row doesn't look like data (e.g., doesn't start with a number for CP)
      let startIndex = 0;
      if (rawData.length > 0 && !/^\d+$/.test(String(rawData[0][0]).trim())) {
        startIndex = 1;
      }

      const rowsToProcess = [];
      for (let i = startIndex; i < rawData.length; i++) {
        const row = rawData[i];
        if (!row || row.length === 0) continue;
        
        let cp = String(row[0] || '').trim();
        let city = String(row[1] || '').trim();
        let country = String(row[2] || '').trim();

        if (!cp && !city) continue;

        // Pad postal code to 5 digits if it's numeric and less than 5 digits
        if (/^\d{1,4}$/.test(cp)) {
          cp = cp.padStart(5, '0');
        }

        rowsToProcess.push({ index: i + 1, postalCode: cp, city, country });
      }

      if (rowsToProcess.length === 0) {
        throw new Error('Aucune donnée valide trouvée dans le fichier.');
      }

      setImportState(prev => ({
        ...prev,
        isAnalyzing: true,
        analyzedCount: 0,
        totalCount: rowsToProcess.length,
        showCancelConfirm: false
      }));

      abortControllerRef.current = new AbortController();

      const geocoded = await geocodeInChunks(
        rowsToProcess,
        (count) => setImportState(prev => ({ ...prev, analyzedCount: count })),
        handleResolveRequest,
        abortControllerRef.current.signal
      );
      
      const timestamp = Date.now();
      const validMembers: Member[] = geocoded.filter(g => g.valid).map(g => ({
        id: `member-${timestamp}-${g.index}`,
        originalIndex: g.index,
        postalCode: g.postalCode,
        city: g.city,
        country: g.country,
        lat: g.lat,
        lng: g.lng
      }));

      const invalidRows = geocoded.filter(g => !g.valid);

      if (appending) {
        setMembers([...members, ...validMembers]);
        setImportState(prev => ({
          ...prev,
          isAnalyzing: false,
          results: {
            valid: (prev.results?.valid || 0) + validMembers.length,
            invalid: invalidRows.length,
            invalidData: invalidRows
          }
        }));
      } else {
        setMembers(validMembers);
        setImportState(prev => ({
          ...prev,
          isAnalyzing: false,
          results: {
            valid: validMembers.length,
            invalid: invalidRows.length,
            invalidData: invalidRows
          }
        }));
      }

      if (fileInputRef.current) fileInputRef.current.value = '';
      if (reimportInputRef.current) reimportInputRef.current.value = '';
    } catch (err: any) {
      if (err.message === 'Aborted') {
        setImportState(prev => ({ ...prev, isAnalyzing: false, showCancelConfirm: false }));
      } else {
        setError(err.message || 'Erreur lors de l\'importation');
        setImportState(prev => ({ ...prev, isAnalyzing: false }));
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (reimportInputRef.current) reimportInputRef.current.value = '';
    }
  };

  const downloadInvalids = () => {
    if (!importState.results?.invalidData || importState.results.invalidData.length === 0) return;
    
    const csvContent = "Ligne,CP,VILLE,PAYS\n" + 
      importState.results.invalidData.map(row => 
        `${row.index},"${row.postalCode}","${row.city}","${row.country}"`
      ).join("\n");
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'membres_invalides.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <>
      <div className="w-full h-full bg-white border-r border-gray-200 flex flex-col overflow-y-auto">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-sm">
              <MapPin className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-bold text-gray-900 tracking-tight">GEO Membres</h1>
          </div>
          <p className="text-sm text-gray-500">Cartographie et analyse de densité</p>
        </div>

        <div className="p-4 border-b border-gray-200 space-y-3">
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4" />
            Importation
          </h2>
          
          <div className="space-y-2">
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`relative border-2 border-dashed rounded-xl transition-colors ${
                isDragging ? 'border-indigo-500 bg-indigo-50' : 'border-transparent'
              }`}
            >
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={importState.isAnalyzing}
                className="w-full flex items-center justify-center gap-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 px-3 py-2 rounded-xl font-medium transition-colors disabled:opacity-50 text-sm"
              >
                <Upload className="w-4 h-4" />
                Importer CSV / Excel
              </button>
            </div>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileSelect}
              accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
              className="hidden"
            />
            <input
              type="file"
              ref={reimportInputRef}
              onChange={handleReimportSelect}
              accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
              className="hidden"
            />
            {error && (
              <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <p>{error}</p>
              </div>
            )}
            
            {importState.results && (
              <div className="bg-gray-50 rounded-xl p-3 space-y-2 border border-gray-100">
                <h4 className="text-xs font-semibold text-gray-900 mb-2">Résultats de l'analyse</h4>
                <div className="flex justify-between text-xs items-center">
                  <span className="text-emerald-700 font-medium">Membres listés</span>
                  <span className="bg-emerald-100 text-emerald-800 py-0.5 px-2 rounded-full font-bold">{importState.results.valid}</span>
                </div>
                <div className="flex justify-between text-xs items-center">
                  <span className="text-red-700 font-medium">Non listés (invalides)</span>
                  <span className="bg-red-100 text-red-800 py-0.5 px-2 rounded-full font-bold">{importState.results.invalid}</span>
                </div>
                {importState.results.invalid > 0 && (
                  <button
                    onClick={startCorrection}
                    className="mt-2 w-full flex items-center justify-center gap-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 py-1.5 rounded-lg transition-colors"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    Corriger les invalides ({importState.results.invalid})
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="p-6 border-b border-gray-200 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider flex items-center gap-2">
              <Settings2 className="w-4 h-4" />
              Repère
            </h2>
            <label className="relative inline-flex items-center cursor-pointer">
              <input 
                type="checkbox" 
                className="sr-only peer"
                checked={marker.enabled}
                onChange={(e) => setMarker({ ...marker, enabled: e.target.checked })}
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
            </label>
          </div>

          {marker.enabled && (
            <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-700 flex justify-between items-center">
                  <span>Rayon de recherche</span>
                  {isEditingRadius ? (
                    <input
                      type="number"
                      autoFocus
                      className="w-16 text-right border border-indigo-300 rounded px-1 text-sm text-indigo-600 font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      value={tempRadius}
                      onChange={(e) => setTempRadius(e.target.value)}
                      onBlur={handleRadiusSubmit}
                      onKeyDown={(e) => e.key === 'Enter' && handleRadiusSubmit()}
                    />
                  ) : (
                    <span 
                      className="text-indigo-600 font-semibold cursor-pointer hover:underline"
                      onDoubleClick={() => {
                        setTempRadius(marker.radiusKm.toString());
                        setIsEditingRadius(true);
                      }}
                    >
                      {marker.radiusKm} km
                    </span>
                  )}
                </label>
                <input
                  type="range"
                  min="1"
                  max="500"
                  value={marker.radiusKm}
                  onChange={(e) => {
                    setMarker({ ...marker, radiusKm: parseInt(e.target.value) });
                  }}
                  onMouseUp={() => setMarker({ ...marker, focusTrigger: Date.now() })}
                  onTouchEnd={() => setMarker({ ...marker, focusTrigger: Date.now() })}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                />
              </div>
              
              <div className="pt-3 border-t border-gray-100 space-y-2">
                <label className="text-xs font-medium text-gray-700">Centrer sur une ville</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Code Postal"
                    className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                    value={searchCP}
                    onChange={(e) => setSearchCP(e.target.value)}
                    maxLength={5}
                  />
                </div>
                {isSearchingCity && <p className="text-xs text-gray-500">Recherche...</p>}
                {searchCityOptions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {searchCityOptions.map(city => (
                      <button
                        key={city}
                        onClick={() => handleCitySelect(city)}
                        className="px-2 py-1 text-xs font-medium bg-gray-100 hover:bg-indigo-100 text-gray-700 hover:text-indigo-700 rounded-md transition-colors"
                      >
                        {city}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {marker.enabled && (
          <div className="p-6 bg-indigo-50/50 flex-1">
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-indigo-100">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-8 h-8 bg-indigo-100 rounded-full flex items-center justify-center">
                  <Users className="w-4 h-4 text-indigo-600" />
                </div>
                <h3 className="text-sm font-medium text-gray-700">Membres dans la zone</h3>
              </div>
              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-4xl font-black text-indigo-600">{membersInRadius.length}</span>
                <span className="text-sm font-medium text-gray-500">
                  / {members.length}
                </span>
              </div>
              {members.length > 0 && (
                <div className="mt-3 w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                  <div 
                    className="bg-indigo-600 h-2 rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(100, (membersInRadius.length / members.length) * 100)}%` }}
                  />
                </div>
              )}

              {membersInRadius.length > 0 && (
                <div className="mt-5 pt-4 border-t border-indigo-50">
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                    Répartition par ville
                  </h4>
                  <div className="max-h-[35vh] overflow-y-auto pr-2 space-y-2 custom-scrollbar">
                    {groupedMembers.map((group) => (
                      <div key={`${group.cp}-${group.city}`} className="flex items-center justify-between text-sm bg-gray-50 p-2 rounded-lg border border-gray-100">
                        <div className="flex flex-col overflow-hidden pr-2">
                          <span className="font-medium text-gray-900 truncate">{group.city || 'Inconnue'}</span>
                          <span className="text-xs text-gray-500">{group.cp || 'CP inconnu'}</span>
                        </div>
                        <span className="bg-indigo-100 text-indigo-700 py-1 px-2.5 rounded-md font-bold text-xs shrink-0">
                          {group.count}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {resolvingRow && (
        <ResolutionModal 
          row={resolvingRow.row}
          initialOptions={resolvingRow.options}
          onResolve={(result) => {
            resolvingRow.resolve(result);
            setResolvingRow(null);
          }}
        />
      )}

      {stagedFile && !importState.isAnalyzing && !resolvingRow && (
        <div className="fixed inset-0 bg-gray-900/40 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200">
            <h3 className="text-lg font-bold text-gray-900 mb-2">Confirmer l'importation</h3>
            <p className="text-sm text-gray-600 mb-6">
              Voulez-vous débuter l'analyse du fichier <span className="font-semibold text-gray-900">{stagedFile.name}</span> ?
              {isReimporting && (
                <span className="block mt-2 text-indigo-600 font-medium">Les membres valides seront ajoutés à la liste existante.</span>
              )}
            </p>
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => { setStagedFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; if (reimportInputRef.current) reimportInputRef.current.value = ''; }}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                Annuler
              </button>
              <button 
                onClick={confirmImport}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
              >
                Débuter l'importation
              </button>
            </div>
          </div>
        </div>
      )}

      {importState.isAnalyzing && !resolvingRow && (
        <div className="fixed inset-0 bg-gray-900/40 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200">
            <h3 className="text-lg font-bold text-gray-900 mb-4">Analyse du fichier</h3>
            
            {!importState.showCancelConfirm ? (
              <>
                <div className="mb-2 flex justify-between text-sm font-medium text-gray-700">
                  <span>Progression</span>
                  <span>{importState.analyzedCount} / {importState.totalCount} entrées</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-3 mb-6 overflow-hidden">
                  <div 
                    className="bg-indigo-600 h-full rounded-full transition-all duration-300 relative overflow-hidden" 
                    style={{ width: `${Math.max(0, Math.min(100, (importState.analyzedCount / importState.totalCount) * 100))}%` }}
                  >
                    <div className="absolute inset-0 bg-white/20 animate-[shimmer_1s_infinite] -skew-x-12 translate-x-[-100%]"></div>
                  </div>
                </div>
                <div className="flex justify-end">
                  <button 
                    onClick={() => setImportState(prev => ({ ...prev, showCancelConfirm: true }))}
                    className="px-4 py-2 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors"
                  >
                    Annuler l'importation
                  </button>
                </div>
              </>
            ) : (
              <div className="animate-in fade-in slide-in-from-right-4 duration-200">
                <div className="flex items-center gap-3 mb-4 text-amber-600 bg-amber-50 p-3 rounded-lg">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <p className="text-sm font-medium">Êtes-vous sûr de vouloir annuler l'importation en cours ?</p>
                </div>
                <div className="flex justify-end gap-3">
                  <button 
                    onClick={() => setImportState(prev => ({ ...prev, showCancelConfirm: false }))}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                  >
                    Non, continuer
                  </button>
                  <button 
                    onClick={() => abortControllerRef.current?.abort()}
                    className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
                  >
                    Oui, annuler
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
