import React, { useRef, useState, useMemo, useEffect } from 'react';
import { Upload, MapPin, Settings2, Users, FileSpreadsheet, AlertCircle, Edit3, Building2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { Member, MarkerState, Organism, OrganismRadiusState } from '../types';
import { geocodeInChunks, GeocodeResult, ImportRow } from '../utils/geocoding';

export interface OrganismStats {
  // Nombre de membres à moins du rayon d'attractivité, par id d'organisme
  counts: Map<string, number>;
  // Membres couverts par au moins un organisme
  coveredCount: number;
}

interface SidebarProps {
  members: Member[];
  setMembers: React.Dispatch<React.SetStateAction<Member[]>>;
  organisms: Organism[];
  setOrganisms: React.Dispatch<React.SetStateAction<Organism[]>>;
  orgRadius: OrganismRadiusState;
  setOrgRadius: (state: OrganismRadiusState) => void;
  organismStats: OrganismStats;
  marker: MarkerState;
  setMarker: (marker: MarkerState) => void;
  membersInRadius: Member[];
}

type ImportKind = 'members' | 'organisms';

interface ImportResults {
  valid: number;
  invalid: number;
  invalidData: GeocodeResult[];
}

// Colonnes attendues : CP,VILLE,PAYS (membres) ; TYPE,NOM,CP,VILLE,PAYS (organismes)
const IMPORT_CONFIG: Record<ImportKind, { label: string; columns: string; cpColumn: number; entity: string }> = {
  members: { label: 'Importer Membres', columns: 'CP,VILLE,PAYS', cpColumn: 0, entity: 'membres' },
  organisms: { label: 'Importer Organismes', columns: 'TYPE,NOM,CP,VILLE,PAYS', cpColumn: 2, entity: 'organismes' },
};

function toMember(g: GeocodeResult, id: string): Member {
  return { id, originalIndex: g.index, postalCode: g.postalCode, city: g.city, country: g.country, lat: g.lat, lng: g.lng };
}

function toOrganism(g: GeocodeResult, id: string): Organism {
  return {
    id, originalIndex: g.index, type: g.type || '', name: g.name || '',
    postalCode: g.postalCode, city: g.city, country: g.country, lat: g.lat, lng: g.lng
  };
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

export default function Sidebar({
  members, setMembers, organisms, setOrganisms, orgRadius, setOrgRadius, organismStats,
  marker, setMarker, membersInRadius
}: SidebarProps) {
  const fileInputRefs = {
    members: useRef<HTMLInputElement>(null),
    organisms: useRef<HTMLInputElement>(null),
  };
  const reimportInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [draggingKind, setDraggingKind] = useState<ImportKind | null>(null);
  const [stagedFile, setStagedFile] = useState<{ file: File; kind: ImportKind } | null>(null);
  const [isReimporting, setIsReimporting] = useState(false);

  const [resolvingRow, setResolvingRow] = useState<{
    row: ImportRow;
    options: string[];
    resolve: (value: { postalCode: string; city: string } | null) => void;
  } | null>(null);

  const [importState, setImportState] = useState<{
    isAnalyzing: boolean;
    kind: ImportKind;
    analyzedCount: number;
    totalCount: number;
    showCancelConfirm: boolean;
    results: Record<ImportKind, ImportResults | null>;
  }>({
    isAnalyzing: false,
    kind: 'members',
    analyzedCount: 0,
    totalCount: 0,
    showCancelConfirm: false,
    results: { members: null, organisms: null }
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  const resetFileInputs = () => {
    if (fileInputRefs.members.current) fileInputRefs.members.current.value = '';
    if (fileInputRefs.organisms.current) fileInputRefs.organisms.current.value = '';
    if (reimportInputRef.current) reimportInputRef.current.value = '';
  };

  const handleCorrectNext = (currentIndex: number, invalidData: GeocodeResult[], kind: ImportKind) => {
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
              const corrected: GeocodeResult = {
                ...rowToCorrect,
                postalCode: data.features[0].properties.postcode || result.postalCode,
                city: data.features[0].properties.city || result.city,
                lat,
                lng,
                valid: true
              };
              const id = `${kind}-${Date.now()}-${rowToCorrect.index}`;

              if (kind === 'members') {
                setMembers(prev => [...prev, toMember(corrected, id)]);
              } else {
                setOrganisms(prev => [...prev, toOrganism(corrected, id)]);
              }

              // Update import state
              setImportState(prev => {
                const current = prev.results[kind];
                if (!current) return prev;
                return {
                  ...prev,
                  results: {
                    ...prev.results,
                    [kind]: { ...current, valid: current.valid + 1, invalid: current.invalid - 1 }
                  }
                };
              });
            }
          } catch (err) {
            console.error("Failed to geocode corrected address", err);
          }
        }

        // Move to the next one automatically
        handleCorrectNext(nextIndex, invalidData, kind);
      });
    }
  };

  const startCorrection = (kind: ImportKind) => {
    const invalidData = importState.results[kind]?.invalidData;
    if (invalidData) {
      handleCorrectNext(-1, invalidData, kind);
    }
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

  const sortedOrganisms = useMemo(() => {
    return [...organisms].sort((a, b) =>
      (organismStats.counts.get(b.id) || 0) - (organismStats.counts.get(a.id) || 0)
    );
  }, [organisms, organismStats]);

  const handleFileSelect = (kind: ImportKind) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setIsReimporting(false);
      setStagedFile({ file, kind });
    }
  };

  const handleReimportSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setIsReimporting(true);
      setStagedFile({ file, kind: 'members' });
    }
  };

  const handleDragOver = (kind: ImportKind) => (e: React.DragEvent) => {
    e.preventDefault();
    setDraggingKind(kind);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDraggingKind(null);
  };

  const handleDrop = (kind: ImportKind) => (e: React.DragEvent) => {
    e.preventDefault();
    setDraggingKind(null);
    const file = e.dataTransfer.files?.[0];
    const name = file?.name.toLowerCase() || '';
    if (file && (name.endsWith('.csv') || name.endsWith('.xlsx') || name.endsWith('.xls'))) {
      setIsReimporting(false);
      setStagedFile({ file, kind });
    } else {
      setError('Format de fichier non supporté. Utilisez .csv ou .xlsx');
    }
  };

  const handleResolveRequest = async (row: ImportRow) => {
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
    const { file, kind } = stagedFile;
    const { cpColumn } = IMPORT_CONFIG[kind];
    const appending = isReimporting;
    setStagedFile(null);
    setError(null);
    setImportState(prev => ({
      ...prev,
      kind,
      isAnalyzing: false,
      analyzedCount: 0,
      totalCount: 0,
      showCancelConfirm: false,
      results: { ...prev.results, [kind]: appending ? prev.results[kind] : null }
    }));

    try {
      let rawData: any[][] = [];
      const fileName = file.name.toLowerCase();

      if (fileName.endsWith('.csv')) {
        const text = await file.text();
        const result = Papa.parse(text, { header: false, skipEmptyLines: true });
        rawData = result.data as any[][];
      } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
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

      // Skip header if first row doesn't look like data (e.g., doesn't have a number in the CP column)
      let startIndex = 0;
      if (rawData.length > 0 && !/^\d+$/.test(String(rawData[0][cpColumn]).trim())) {
        startIndex = 1;
      }

      const rowsToProcess: ImportRow[] = [];
      for (let i = startIndex; i < rawData.length; i++) {
        const row = rawData[i];
        if (!row || row.length === 0) continue;

        let cp = String(row[cpColumn] || '').trim();
        let city = String(row[cpColumn + 1] || '').trim();
        let country = String(row[cpColumn + 2] || '').trim();

        if (!cp && !city) continue;

        // Pad postal code to 5 digits if it's numeric and less than 5 digits
        if (/^\d{1,4}$/.test(cp)) {
          cp = cp.padStart(5, '0');
        }

        const importRow: ImportRow = { index: i + 1, postalCode: cp, city, country };
        if (kind === 'organisms') {
          importRow.type = String(row[0] || '').trim();
          importRow.name = String(row[1] || '').trim();
        }
        rowsToProcess.push(importRow);
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
      const validRows = geocoded.filter(g => g.valid);
      const invalidRows = geocoded.filter(g => !g.valid);

      if (kind === 'members') {
        const validMembers = validRows.map(g => toMember(g, `member-${timestamp}-${g.index}`));
        setMembers(appending ? [...members, ...validMembers] : validMembers);
      } else {
        setOrganisms(validRows.map(g => toOrganism(g, `organism-${timestamp}-${g.index}`)));
      }

      setImportState(prev => ({
        ...prev,
        isAnalyzing: false,
        results: {
          ...prev.results,
          [kind]: {
            valid: (appending ? prev.results[kind]?.valid || 0 : 0) + validRows.length,
            invalid: invalidRows.length,
            invalidData: invalidRows
          }
        }
      }));

      resetFileInputs();
    } catch (err: any) {
      if (err.message === 'Aborted') {
        setImportState(prev => ({ ...prev, isAnalyzing: false, showCancelConfirm: false }));
      } else {
        setError(err.message || 'Erreur lors de l\'importation');
        setImportState(prev => ({ ...prev, isAnalyzing: false }));
      }
      resetFileInputs();
    }
  };

  const renderImportZone = (kind: ImportKind) => {
    const config = IMPORT_CONFIG[kind];
    const results = importState.results[kind];
    const isMembers = kind === 'members';
    const isDragging = draggingKind === kind;

    return (
      <div className="space-y-2">
        <div
          onDragOver={handleDragOver(kind)}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop(kind)}
          onClick={() => !importState.isAnalyzing && fileInputRefs[kind].current?.click()}
          className={`cursor-pointer border-2 border-dashed rounded-xl p-3 text-center transition-colors ${
            isMembers
              ? (isDragging ? 'border-indigo-500 bg-indigo-100' : 'border-indigo-200 bg-indigo-50 hover:bg-indigo-100')
              : (isDragging ? 'border-emerald-500 bg-emerald-100' : 'border-emerald-200 bg-emerald-50 hover:bg-emerald-100')
          } ${importState.isAnalyzing ? 'opacity-50 pointer-events-none' : ''}`}
        >
          <div className={`flex items-center justify-center gap-2 font-medium ${isMembers ? 'text-indigo-700' : 'text-emerald-700'}`}>
            {isMembers ? <Upload className="w-5 h-5" /> : <Building2 className="w-5 h-5" />}
            {config.label}
          </div>
          <p className="mt-1 text-xs text-gray-500">Colonne : {config.columns}</p>
          <p className="text-[11px] text-gray-400">Cliquez ou déposez un fichier .csv / .xlsx</p>
        </div>
        <input
          type="file"
          ref={fileInputRefs[kind]}
          onChange={handleFileSelect(kind)}
          accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
          className="hidden"
        />

        {results && (
          <div className="bg-gray-50 rounded-xl p-3 space-y-2 border border-gray-100">
            <div className="flex justify-between text-sm items-center">
              <span className="text-emerald-700 font-medium">{isMembers ? 'Membres listés' : 'Organismes listés'}</span>
              <span className="bg-emerald-100 text-emerald-800 py-0.5 px-2 rounded-full font-bold">{results.valid}</span>
            </div>
            <div className="flex justify-between text-sm items-center">
              <span className="text-red-700 font-medium">Non listés (invalides)</span>
              <span className="bg-red-100 text-red-800 py-0.5 px-2 rounded-full font-bold">{results.invalid}</span>
            </div>
            {results.invalid > 0 && (
              <button
                onClick={() => startCorrection(kind)}
                className="mt-1 w-full flex items-center justify-center gap-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 py-2 rounded-lg transition-colors"
              >
                <Edit3 className="w-3.5 h-3.5" />
                Corriger les invalides ({results.invalid})
              </button>
            )}
          </div>
        )}
      </div>
    );
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

        <div className="p-6 border-b border-gray-200 space-y-4">
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4" />
            Importation
          </h2>

          <div className="space-y-4">
            {renderImportZone('members')}
            {renderImportZone('organisms')}
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
          </div>
        </div>

        {organisms.length > 0 && (
          <div className="p-6 border-b border-gray-200 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider flex items-center gap-2">
                <Building2 className="w-4 h-4" />
                Organismes
              </h2>
              <label className="relative inline-flex items-center cursor-pointer" title="Afficher le rayon d'attractivité">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={orgRadius.enabled}
                  onChange={(e) => setOrgRadius({ ...orgRadius, enabled: e.target.checked })}
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-emerald-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
              </label>
            </div>

            {orgRadius.enabled && (
              <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700 flex justify-between">
                    <span>Rayon d'attractivité</span>
                    <span className="text-emerald-600 font-semibold">{orgRadius.radiusKm} km</span>
                  </label>
                  <input
                    type="range"
                    min="1"
                    max="150"
                    value={orgRadius.radiusKm}
                    onChange={(e) => setOrgRadius({ ...orgRadius, radiusKm: parseInt(e.target.value) })}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                  />
                </div>

                {members.length > 0 && (
                  <div className="flex justify-between items-baseline text-sm bg-emerald-50 p-3 rounded-lg border border-emerald-100">
                    <span className="font-medium text-gray-700">Membres couverts</span>
                    <span>
                      <span className="text-lg font-black text-emerald-700">{organismStats.coveredCount}</span>
                      <span className="text-gray-500"> / {members.length}</span>
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="max-h-[30vh] overflow-y-auto pr-2 space-y-2 custom-scrollbar">
              {sortedOrganisms.map((org) => (
                <div key={org.id} className="flex items-center justify-between text-sm bg-gray-50 p-2 rounded-lg border border-gray-100">
                  <div className="flex flex-col overflow-hidden pr-2">
                    <span className="font-medium text-gray-900 truncate">{org.name || 'Sans nom'}</span>
                    <span className="text-xs text-gray-500 truncate">
                      {org.type && <span className="text-emerald-700 font-medium">{org.type} · </span>}
                      {org.postalCode} {org.city}
                    </span>
                  </div>
                  {orgRadius.enabled && members.length > 0 && (
                    <span className="bg-emerald-100 text-emerald-700 py-1 px-2.5 rounded-md font-bold text-xs shrink-0" title={`Membres à moins de ${orgRadius.radiusKm} km`}>
                      {organismStats.counts.get(org.id) || 0}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

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
                <label className="text-sm font-medium text-gray-700 flex justify-between">
                  <span>Rayon de recherche</span>
                  <span className="text-indigo-600 font-semibold">{marker.radiusKm} km</span>
                </label>
                <input
                  type="range"
                  min="1"
                  max="500"
                  value={marker.radiusKm}
                  onChange={(e) => setMarker({ ...marker, radiusKm: parseInt(e.target.value) })}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                />
              </div>

              <p className="text-xs text-gray-500 bg-gray-50 p-3 rounded-lg border border-gray-100">
                Déplacez le marqueur sur la carte pour ajuster la zone de recherche.
              </p>
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
              Voulez-vous débuter l'analyse du fichier <span className="font-semibold text-gray-900">{stagedFile.file.name}</span> ({IMPORT_CONFIG[stagedFile.kind].entity}) ?
              {stagedFile.kind === 'organisms' && organisms.length > 0 && (
                <span className="block mt-2 text-emerald-700 font-medium">Les organismes déjà importés seront remplacés.</span>
              )}
              {isReimporting && (
                <span className="block mt-2 text-indigo-600 font-medium">Les membres valides seront ajoutés à la liste existante.</span>
              )}
            </p>
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => { setStagedFile(null); resetFileInputs(); }}
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
