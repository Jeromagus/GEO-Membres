import React, { useRef, useState, useMemo, useEffect } from 'react';
import { Upload, MapPin, Settings2, Users, FileSpreadsheet, AlertCircle, Edit3, Building2, ChevronDown, ChevronRight, ScrollText, Download } from 'lucide-react';
import { Member, MarkerState, Organism, OrganismRadiusState } from '../types';
import { geocodeInChunks, geocodeOne, Correction, GeocodeResult, ImportRow } from '../utils/geocoding';
import { foreignCountryLabel, resolveCountry } from '../utils/country';
import { cell, ColumnMapping, columnLetter, FIELD_HINTS, FIELD_LABELS, fieldsFor, guessMapping, mappingProblem, readTable, Table } from '../utils/columns';

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
  organismsInRadius: OrganismInRadius[];
  // Appelé à la fin d'un import, pour recadrer la carte sur les points
  onImported: () => void;
}

export interface OrganismInRadius {
  organism: Organism;
  // Distance au repère
  distanceKm: number;
}

type ImportKind = 'members' | 'organisms';

// Une ligne du fichier : la saisie d'origine et ce qu'elle est devenue
interface LogEntry {
  input: ImportRow;
  result: GeocodeResult;
}

interface ImportResults {
  valid: number;
  invalid: number;
  invalidData: GeocodeResult[];
  // Journal de l'import : toutes les lignes lues, placées ou non, avec la raison des rejets
  log: LogEntry[];
  fileName: string;
  date: Date;
  mappingSummary: string;
}

interface StagedFile {
  file: File;
  kind: ImportKind;
  table: Table;
  mapping: ColumnMapping;
  hasHeader: boolean;
}

// Colonnes habituelles : CP,VILLE,PAYS (membres) ; TYPE,NOM,CP,VILLE,PAYS (organismes).
// PAYS vide = France. L'ordre réel est confirmé à chaque import (correspondance des colonnes).
const IMPORT_CONFIG: Record<ImportKind, { label: string; columns: string; entity: string }> = {
  members: { label: 'Importer Membres', columns: 'CP,VILLE,PAYS', entity: 'membres' },
  organisms: { label: 'Importer Organismes', columns: 'TYPE,NOM,CP,VILLE,PAYS', entity: 'organismes' },
};

function logStatus(e: LogEntry): string {
  if (!e.result.valid) return 'rejetée';
  return e.result.original || e.result.reason ? 'corrigée' : 'placée';
}

function describeMapping(staged: StagedFile): string {
  const parts = fieldsFor(staged.kind).map(f => {
    const col = staged.mapping[f];
    const head = staged.hasHeader && col !== null ? staged.table.rows[0]?.[col] : '';
    return `${FIELD_LABELS[f]} = ${col === null ? 'aucune' : `${columnLetter(col)}${head ? ` (${head})` : ''}`}`;
  });
  return `Colonnes : ${parts.join(', ')} ; ${staged.hasHeader ? 'ligne 1 = intitulés' : 'sans ligne d\'intitulés'}`;
}

// Journal au format CSV pour Excel (séparateur ;, BOM UTF-8)
function downloadLog(results: ImportResults, kind: ImportKind) {
  const withOrg = kind === 'organisms';
  const header = ['Ligne', 'Statut', ...(withOrg ? ['Type', 'Nom'] : []), 'CP saisi', 'Ville saisie', 'Pays saisi',
    'CP retenu', 'Ville retenue', 'Pays retenu', 'Latitude', 'Longitude', 'Service', 'Raison / correction'];
  const esc = (v: unknown) => {
    const t = v === undefined || v === null ? '' : String(v);
    return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = results.log.map(e => [
    e.input.index, logStatus(e), ...(withOrg ? [e.input.type, e.input.name] : []),
    e.input.postalCode, e.input.city, e.input.country,
    e.result.valid ? e.result.postalCode : '', e.result.valid ? e.result.city : '', e.result.valid ? e.result.country : '',
    e.result.lat !== undefined ? String(e.result.lat).replace('.', ',') : '',
    e.result.lng !== undefined ? String(e.result.lng).replace('.', ',') : '',
    e.result.source, e.result.reason,
  ].map(esc).join(';'));
  const meta = esc(`Fichier : ${results.fileName} ; import du ${results.date.toLocaleString('fr-FR')} ; ${results.mappingSummary}`);
  const blob = new Blob(['﻿' + [meta, header.join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const base = results.fileName.replace(/\.[^.]+$/, '');
  const d = results.date;
  const pad = (n: number) => String(n).padStart(2, '0');
  a.href = url;
  a.download = `journal-import-${base}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Correspondance des colonnes du fichier avec les données attendues, avant l'analyse
function ColumnMappingModal({ staged, onChange, notice, onCancel, onConfirm }: {
  staged: StagedFile;
  onChange: (next: StagedFile) => void;
  notice?: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { table, mapping, hasHeader, kind, file } = staged;
  const fields = fieldsFor(kind);
  const headerRow = table.rows[0] || [];
  const dataRows = table.rows.slice(hasHeader ? 1 : 0);
  const columns = Array.from({ length: table.width }, (_, i) => i);
  const problem = mappingProblem(mapping);

  const columnName = (col: number) => {
    const head = hasHeader ? headerRow[col] : '';
    const example = dataRows.find(r => (r[col] ?? '') !== '')?.[col] ?? '';
    return `${columnLetter(col)}${head ? ` · ${head}` : ''}${example ? ` (ex. ${example.slice(0, 24)})` : ''}`;
  };

  return (
    <div className="fixed inset-0 bg-gray-900/40 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl animate-in zoom-in-95 duration-200">
        <h3 className="text-lg font-bold text-gray-900 mb-1">Correspondance des colonnes</h3>
        <p className="text-sm text-gray-600 mb-4">
          <span className="font-semibold text-gray-900">{file.name}</span> ({IMPORT_CONFIG[kind].entity}) :
          {' '}{dataRows.length} ligne{dataRows.length > 1 ? 's' : ''}, {table.width} colonne{table.width > 1 ? 's' : ''}{table.sheetName ? `, feuille « ${table.sheetName} »` : ''}.
          {' '}Vérifiez quelle colonne contient quelle donnée.
        </p>

        <label className="flex items-center gap-2 text-sm text-gray-700 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={hasHeader}
            onChange={(e) => onChange({ ...staged, hasHeader: e.target.checked })}
            className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          La première ligne contient les intitulés (elle ne sera pas importée)
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          {fields.map(field => (
            <div key={field}>
              <label htmlFor={`map-${field}`} className="block text-xs font-medium text-gray-700 mb-1">
                {FIELD_LABELS[field]}
                {FIELD_HINTS[field] && <span className="font-normal text-gray-400"> ({FIELD_HINTS[field]})</span>}
              </label>
              <select
                id={`map-${field}`}
                value={mapping[field] ?? ''}
                onChange={(e) => onChange({ ...staged, mapping: { ...mapping, [field]: e.target.value === '' ? null : Number(e.target.value) } })}
                className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="">— aucune —</option>
                {columns.map(col => <option key={col} value={col}>{columnName(col)}</option>)}
              </select>
            </div>
          ))}
        </div>

        <div className="mb-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Aperçu des premières lignes</p>
          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">Ligne</th>
                  {fields.map(f => <th key={f} className="px-2 py-1.5 text-left font-medium">{FIELD_LABELS[f]}</th>)}
                </tr>
              </thead>
              <tbody>
                {dataRows.slice(0, 4).map((row, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td className="px-2 py-1 text-gray-400">{i + (hasHeader ? 2 : 1)}</td>
                    {fields.map(f => {
                      const v = cell(row, mapping[f]);
                      const fallback = f === 'country' ? 'France' : f === 'name' ? cell(row, mapping.city) : '';
                      return (
                        <td key={f} className={`px-2 py-1 ${v ? 'text-gray-900' : 'text-gray-400 italic'}`}>
                          {v || fallback || '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {notice}

        {problem && (
          <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg mb-4">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <p>{problem}</p>
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            Annuler
          </button>
          <button
            onClick={onConfirm}
            disabled={!!problem}
            className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            Débuter l'importation
          </button>
        </div>
      </div>
    </div>
  );
}

// Journal du dernier import : lignes rejetées ou corrigées, avec la raison
function ImportLogModal({ results, kind, onClose }: { results: ImportResults; kind: ImportKind; onClose: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const rejected = results.log.filter(e => !e.result.valid);
  const corrected = results.log.filter(e => logStatus(e) === 'corrigée');
  const shown = showAll ? results.log : results.log.filter(e => logStatus(e) !== 'placée');
  const statusClass: Record<string, string> = {
    'rejetée': 'bg-red-100 text-red-800',
    'corrigée': 'bg-amber-100 text-amber-800',
    'placée': 'bg-emerald-100 text-emerald-800',
  };

  return (
    <div className="fixed inset-0 bg-gray-900/40 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl animate-in zoom-in-95 duration-200">
        <h3 className="text-lg font-bold text-gray-900 mb-1">Journal d'import ({IMPORT_CONFIG[kind].entity})</h3>
        <p className="text-sm text-gray-600 mb-1">
          <span className="font-semibold text-gray-900">{results.fileName}</span>, le {results.date.toLocaleString('fr-FR')} :
          {' '}{results.log.length} lignes lues, {results.log.length - rejected.length} placées
          {corrected.length > 0 && ` (dont ${corrected.length} corrigées)`}, {rejected.length} rejetées.
        </p>
        <p className="text-xs text-gray-500 mb-3">{results.mappingSummary}</p>

        <label className="flex items-center gap-2 text-xs text-gray-600 mb-2 cursor-pointer">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="rounded border-gray-300" />
          Afficher aussi les lignes placées sans correction
        </label>

        <div className="flex-1 min-h-0 overflow-auto border border-gray-200 rounded-lg custom-scrollbar">
          {shown.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">Toutes les lignes ont été placées sans correction.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-600 sticky top-0">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">Ligne</th>
                  <th className="px-2 py-1.5 text-left font-medium">Statut</th>
                  <th className="px-2 py-1.5 text-left font-medium">Saisie</th>
                  <th className="px-2 py-1.5 text-left font-medium">Raison / correction</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(e => {
                  const status = logStatus(e);
                  return (
                    <tr key={e.input.index} className="border-t border-gray-100 align-top">
                      <td className="px-2 py-1.5 text-gray-500">{e.input.index}</td>
                      <td className="px-2 py-1.5"><span className={`px-1.5 py-0.5 rounded font-medium ${statusClass[status]}`}>{status}</span></td>
                      <td className="px-2 py-1.5 text-gray-900">
                        {kind === 'organisms' && (e.input.type || e.input.name) && <span className="block text-gray-500">{[e.input.type, e.input.name].filter(Boolean).join(' · ')}</span>}
                        {[e.input.postalCode, e.input.city].filter(Boolean).join(' ') || <span className="italic text-gray-400">vide</span>}
                        {e.input.country && <span className="text-gray-500"> · {e.input.country}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-gray-700">
                        {e.result.reason || (e.result.valid ? `placée par ${e.result.source || '?'}` : 'introuvable')}
                        {e.result.valid && e.result.original && <span className="block text-gray-500">→ {e.result.postalCode} {e.result.city}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-4">
          <button
            onClick={() => downloadLog(results, kind)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
          >
            <Download className="w-4 h-4" />
            Télécharger le journal (.csv)
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

// Bornes du rayon d'attractivité (km), communes au curseur et au champ de saisie
const ORG_RADIUS_MIN = 1;
const ORG_RADIUS_MAX = 200;
const MARKER_RADIUS_MIN = 1;
const MARKER_RADIUS_MAX = 200;

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
  reason,
  initialOptions,
  onResolve
}: {
  row: { index: number; postalCode: string; city: string; country: string };
  reason?: string;
  initialOptions: string[];
  onResolve: (result: Correction | null) => void
}) {
  const [postalCode, setPostalCode] = useState(row.postalCode);
  const [city, setCity] = useState(initialOptions.length === 1 ? initialOptions[0] : row.city);
  const [country, setCountry] = useState(row.country || 'France');
  const [options, setOptions] = useState<string[]>(initialOptions);
  const isFrance = resolveCountry(country, postalCode).isFrance;

  useEffect(() => {
    if (!isFrance) {
      setOptions([]);
      return;
    }
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
  }, [postalCode, row.postalCode, isFrance]);

  return (
    <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200">
        <h3 className="text-lg font-bold text-gray-900 mb-2">Localisation introuvable</h3>
        <p className="text-sm text-gray-600 mb-4">
          Ligne {row.index} : la combinaison Code Postal / Ville / Pays n'a pas été trouvée.
        </p>
        {reason && (
          <p className="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2 mb-4">Raison : {reason}</p>
        )}
        
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
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Pays</label>
            <input
              type="text"
              className="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            />
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
            onClick={() => onResolve({ postalCode, city, country })}
            className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
          >
            Valider
          </button>
        </div>
      </div>
    </div>
  );
}

type Accent = 'indigo' | 'orange';

// Classes complètes (Tailwind ne génère que les noms écrits en entier)
const ACCENT = {
  indigo: {
    switchOn: 'peer-checked:bg-indigo-600 peer-focus:ring-indigo-300',
    tile: 'border-indigo-100', icon: 'bg-indigo-100 text-indigo-600', value: 'text-indigo-600', bar: 'bg-indigo-600',
    tab: 'border-indigo-600 text-indigo-700', badge: 'bg-indigo-100 text-indigo-700',
    input: 'text-indigo-700 focus:ring-indigo-500 focus:border-indigo-500', unit: 'text-indigo-600',
  },
  orange: {
    switchOn: 'peer-checked:bg-orange-600 peer-focus:ring-orange-300',
    tile: 'border-orange-100', icon: 'bg-orange-100 text-orange-600', value: 'text-orange-600', bar: 'bg-orange-500',
    tab: 'border-orange-500 text-orange-700', badge: 'bg-orange-100 text-orange-700',
    input: 'text-orange-700 focus:ring-orange-500 focus:border-orange-500', unit: 'text-orange-600',
  },
};

// Section repliable : le titre replie, l'interrupteur éventuel reste accessible à droite
function Section({ icon, title, summary, open, onToggle, action, children }: {
  icon: React.ReactNode; title: string; summary?: string; open: boolean; onToggle: () => void;
  action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="border-b border-gray-200 shrink-0">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button onClick={onToggle} className="flex-1 min-w-0 flex items-center gap-2 text-left" aria-expanded={open}>
          {open ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />}
          <span className="text-sm font-semibold text-gray-900 uppercase tracking-wider flex items-center gap-2 shrink-0">
            {icon}
            {title}
          </span>
          {summary && <span className="text-xs text-gray-500 truncate">{summary}</span>}
        </button>
        {action}
      </div>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

function Switch({ checked, onChange, color, title }: { checked: boolean; onChange: (checked: boolean) => void; color: Accent; title: string }) {
  return (
    <label className="relative inline-flex items-center cursor-pointer shrink-0" title={title}>
      <input type="checkbox" className="sr-only peer" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div className={`w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all ${ACCENT[color].switchOn}`}></div>
    </label>
  );
}

function StatTile({ icon, label, value, total, color }: { icon: React.ReactNode; label: string; value: number; total: number; color: Accent }) {
  const accent = ACCENT[color];
  return (
    <div className={`bg-white rounded-xl p-3 shadow-sm border ${accent.tile}`}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-600">
        <span className={`w-6 h-6 rounded-full flex items-center justify-center ${accent.icon}`}>{icon}</span>
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className={`text-2xl font-black ${accent.value}`}>{value}</span>
        <span className="text-xs font-medium text-gray-500">/ {total}</span>
      </div>
      {total > 0 && (
        <div className="mt-1.5 w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
          <div className={`${accent.bar} h-1.5 rounded-full transition-all duration-500`} style={{ width: `${Math.min(100, (value / total) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

function ResultTab({ active, onClick, color, children }: { active: boolean; onClick: () => void; color: Accent; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2 border-b-2 -mb-px transition-colors ${active ? ACCENT[color].tab : 'border-transparent text-gray-500 hover:text-gray-700'}`}
    >
      {children}
    </button>
  );
}

function ListRow({ title, subtitle, badge, badgeTitle, color }: {
  title: string; subtitle: React.ReactNode; badge?: string; badgeTitle?: string; color: Accent;
}) {
  return (
    <div className="flex items-center justify-between text-sm bg-gray-50 px-2 py-1.5 rounded-lg border border-gray-100">
      <div className="flex flex-col overflow-hidden pr-2 min-w-0">
        <span className="font-medium text-gray-900 truncate">{title}</span>
        <span className="text-xs text-gray-500 truncate">{subtitle}</span>
      </div>
      {badge !== undefined && (
        <span className={`py-0.5 px-2 rounded-md font-bold text-xs shrink-0 ${ACCENT[color].badge}`} title={badgeTitle}>{badge}</span>
      )}
    </div>
  );
}

// Saisie libre d'un rayon en km : le brouillon peut être vide ou hors bornes pendant la frappe,
// seule une valeur entière valide est appliquée ; il est recalé à la sortie du champ.
function KmInput({ id, value, min, max, onChange, color }: {
  id: string; value: number; min: number; max: number; onChange: (km: number) => void; color: Accent;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const handleDraft = (text: string) => {
    setDraft(text);
    const km = Number(text);
    if (Number.isInteger(km) && km >= min && km <= max) onChange(km);
  };

  const commit = () => {
    const km = Math.round(Number(draft));
    if (!Number.isFinite(km) || draft.trim() === '') {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, km));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <span className={`flex items-center gap-1 text-sm font-semibold shrink-0 ${ACCENT[color].unit}`}>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={1}
        inputMode="numeric"
        value={draft}
        onChange={(e) => handleDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        className={`w-14 border border-gray-300 rounded-md px-1.5 py-0.5 text-right font-semibold focus:ring-2 ${ACCENT[color].input}`}
      />
      km
    </span>
  );
}

function EmptyList({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-gray-400 text-center py-6">{children}</p>;
}

export default function Sidebar({
  members, setMembers, organisms, setOrganisms, orgRadius, setOrgRadius, organismStats,
  marker, setMarker, membersInRadius, organismsInRadius, onImported
}: SidebarProps) {
  const fileInputRefs = {
    members: useRef<HTMLInputElement>(null),
    organisms: useRef<HTMLInputElement>(null),
  };
  const reimportInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [draggingKind, setDraggingKind] = useState<ImportKind | null>(null);
  const [stagedFile, setStagedFile] = useState<StagedFile | null>(null);
  const [isReimporting, setIsReimporting] = useState(false);
  const [logKind, setLogKind] = useState<ImportKind | null>(null);

  const [resolvingRow, setResolvingRow] = useState<{
    row: ImportRow;
    reason?: string;
    options: string[];
    resolve: (value: Correction | null) => void;
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
      handleResolveRequest(rowToCorrect, rowToCorrect.reason).then(async (result) => {
        if (result) {
          // Attempt to geocode the corrected result
          try {
            const corrected = await geocodeOne(rowToCorrect, result, new AbortController().signal);
            const updateLog = (log: LogEntry[]) => log.map(e => e.input.index !== rowToCorrect.index ? e : {
              ...e,
              result: corrected.valid
                ? { ...corrected, reason: `${rowToCorrect.reason || 'introuvable'} → corrigée à la main` }
                : { ...rowToCorrect, reason: `${rowToCorrect.reason || 'introuvable'} ; ${corrected.reason}` },
            });

            if (!corrected.valid) {
              setImportState(prev => {
                const current = prev.results[kind];
                if (!current) return prev;
                return { ...prev, results: { ...prev.results, [kind]: { ...current, log: updateLog(current.log) } } };
              });
            }

            if (corrected.valid) {
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
                    [kind]: {
                      ...current,
                      valid: current.valid + 1,
                      invalid: current.invalid - 1,
                      invalidData: current.invalidData.filter(r => r.index !== rowToCorrect.index),
                      log: updateLog(current.log),
                    }
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
    const groups = new Map<string, { key: string; cp: string; city: string; country: string; count: number }>();
    for (const m of membersInRadius) {
      const country = foreignCountryLabel(m.country);
      const key = `${m.postalCode}-${m.city}-${country}`;
      if (!groups.has(key)) {
        groups.set(key, { key, cp: m.postalCode, city: m.city, country, count: 0 });
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

  // Lecture du fichier et correspondance des colonnes devinée, soumise ensuite à l'utilisateur
  const stageFile = async (file: File, kind: ImportKind, reimport: boolean) => {
    setError(null);
    try {
      const table = await readTable(file);
      const guess = guessMapping(table, kind);
      setIsReimporting(reimport);
      setStagedFile({ file, kind, table, mapping: guess.mapping, hasHeader: guess.hasHeader });
    } catch (err: any) {
      console.error('Lecture du fichier impossible :', err);
      setError(`Lecture de « ${file.name} » impossible : ${err.message || err}`);
      resetFileInputs();
    }
  };

  const handleFileSelect = (kind: ImportKind) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) stageFile(file, kind, false);
  };

  const handleReimportSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) stageFile(file, 'members', true);
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
      stageFile(file, kind, false);
    } else {
      setError('Format de fichier non supporté. Utilisez .csv ou .xlsx');
    }
  };

  const handleResolveRequest = async (row: ImportRow, reason?: string) => {
    return new Promise<Correction | null>(async (resolve) => {
      let options: string[] = [];
      // Suggestions de communes : France uniquement, et sans attendre plus de 8 s
      if (resolveCountry(row.country, row.postalCode).isFrance && /^\d{5}$/.test(row.postalCode)) try {
        const res = await fetch(`https://geo.api.gouv.fr/communes?codePostal=${row.postalCode}&fields=nom&format=json`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) options = data.map((d: any) => d.nom);
        }
      } catch (err) {
        console.error('Suggestions de communes indisponibles :', err);
      }

      setResolvingRow({ row, reason, options, resolve });
    });
  };

  const confirmImport = async () => {
    if (!stagedFile) return;
    const staged = stagedFile;
    const { file, kind, table, mapping, hasHeader } = staged;
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

    const startedAt = new Date();
    const mappingSummary = describeMapping(staged);
    // Lignes lues : saisie d'origine (avant tout nettoyage), pour le journal
    const inputs: ImportRow[] = [];
    const skipped: GeocodeResult[] = [];

    try {
      const startIndex = hasHeader ? 1 : 0;
      const rowsToProcess: ImportRow[] = [];
      for (let i = startIndex; i < table.rows.length; i++) {
        const row = table.rows[i];
        const country = cell(row, mapping.country);
        const city = cell(row, mapping.city);
        let cp = cell(row, mapping.postalCode);

        const importRow: ImportRow = { index: i + 1, postalCode: cp, city, country };
        if (kind === 'organisms') {
          importRow.type = cell(row, mapping.type);
          importRow.name = cell(row, mapping.name) || city;
        }
        inputs.push({ ...importRow });

        if (!cp && !city) {
          skipped.push({ ...importRow, valid: false, reason: 'ni code postal ni ville dans les colonnes choisies' });
          continue;
        }

        // Code postal français tronqué par le tableur (1000 → 01000), pas ailleurs :
        // la Belgique, la Suisse ou le Luxembourg ont des codes à 4 chiffres
        if (/^\d{1,4}$/.test(cp) && resolveCountry(country, cp).isFrance) {
          cp = cp.padStart(5, '0');
          importRow.postalCode = cp;
        }
        rowsToProcess.push(importRow);
      }

      if (rowsToProcess.length === 0) {
        throw new Error('Aucune ligne avec un code postal ou une ville : vérifiez la correspondance des colonnes.');
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
      const invalidRows = [...geocoded.filter(g => !g.valid), ...skipped].sort((a, b) => a.index - b.index);

      // Journal : chaque ligne lue avec son résultat
      const byIndex = new globalThis.Map<number, GeocodeResult>([...geocoded, ...skipped].map(g => [g.index, g]));
      const log: LogEntry[] = inputs.map(input => ({
        input,
        result: byIndex.get(input.index) || { ...input, valid: false, reason: 'ligne perdue pendant l\'analyse' },
      }));
      if (invalidRows.length > 0) {
        console.groupCollapsed(`GEO Membres : ${invalidRows.length} ligne(s) rejetée(s) dans ${file.name}`);
        console.table(invalidRows.map(r => ({ ligne: r.index, cp: r.postalCode, ville: r.city, pays: r.country, service: r.source, raison: r.reason })));
        console.groupEnd();
      }

      if (kind === 'members') {
        const validMembers = validRows.map(g => toMember(g, `member-${timestamp}-${g.index}`));
        setMembers(appending ? [...members, ...validMembers] : validMembers);
      } else {
        setOrganisms(validRows.map(g => toOrganism(g, `organism-${timestamp}-${g.index}`)));
      }
      if (validRows.length > 0) onImported();

      setImportState(prev => ({
        ...prev,
        isAnalyzing: false,
        results: {
          ...prev.results,
          [kind]: {
            valid: (appending ? prev.results[kind]?.valid || 0 : 0) + validRows.length,
            invalid: invalidRows.length,
            invalidData: invalidRows,
            log,
            fileName: file.name,
            date: startedAt,
            mappingSummary,
          }
        }
      }));
      // Des rejets : le journal s'ouvre de lui-même pour en donner les raisons
      if (invalidRows.length > 0) setLogKind(kind);

      resetFileInputs();
    } catch (err: any) {
      if (err.message === 'Aborted') {
        setImportState(prev => ({ ...prev, isAnalyzing: false, showCancelConfirm: false }));
      } else {
        console.error(`GEO Membres : import de ${file.name} interrompu`, err);
        setError(`Import de « ${file.name} » interrompu : ${err.message || err}`);
        setImportState(prev => ({ ...prev, isAnalyzing: false }));
      }
      resetFileInputs();
    }
  };

  // Sections repliables et onglet des résultats du repère
  const [openSections, setOpenSections] = useState({ import: true, organisms: true, marker: true });
  const toggleSection = (key: keyof typeof openSections) => setOpenSections(s => ({ ...s, [key]: !s[key] }));
  const [showOrganismList, setShowOrganismList] = useState(true);
  const [resultTab, setResultTab] = useState<'villes' | 'organismes'>('villes');


  // Une fois un fichier importé, sa zone se réduit à une ligne (toujours cliquable et déposable pour remplacer)
  const renderImportZone = (kind: ImportKind) => {
    const config = IMPORT_CONFIG[kind];
    const results = importState.results[kind];
    const isMembers = kind === 'members';
    const isDragging = draggingKind === kind;
    const zoneColors = isMembers
      ? (isDragging ? 'border-indigo-500 bg-indigo-100' : 'border-indigo-200 bg-indigo-50 hover:bg-indigo-100')
      : (isDragging ? 'border-orange-500 bg-orange-100' : 'border-orange-200 bg-orange-50 hover:bg-orange-100');
    const textColor = isMembers ? 'text-indigo-700' : 'text-orange-700';
    const Icon = isMembers ? Upload : Building2;

    return (
      <div className="space-y-1.5">
        <div
          onDragOver={handleDragOver(kind)}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop(kind)}
          onClick={() => !importState.isAnalyzing && fileInputRefs[kind].current?.click()}
          title={`Colonne : ${config.columns}`}
          className={`cursor-pointer border-2 border-dashed rounded-xl transition-colors ${zoneColors} ${
            results ? 'px-3 py-2' : 'p-3 text-center'
          } ${importState.isAnalyzing ? 'opacity-50 pointer-events-none' : ''}`}
        >
          {results ? (
            <div className="flex items-center gap-2 text-sm">
              <Icon className={`w-4 h-4 shrink-0 ${textColor}`} />
              <span className={`font-medium ${textColor}`}>{isMembers ? 'Membres' : 'Organismes'}</span>
              <span className="bg-emerald-100 text-emerald-800 py-0.5 px-2 rounded-full font-bold text-xs" title="Listés">{results.valid}</span>
              {results.invalid > 0 && (
                <span className="bg-red-100 text-red-800 py-0.5 px-2 rounded-full font-bold text-xs" title="Non listés (invalides)">{results.invalid} invalides</span>
              )}
              <span className="ml-auto text-xs text-gray-500 underline decoration-dotted">Remplacer</span>
            </div>
          ) : (
            <>
              <div className={`flex items-center justify-center gap-2 font-medium ${textColor}`}>
                <Icon className="w-5 h-5" />
                {config.label}
              </div>
              <p className="mt-1 text-xs text-gray-500">Colonne : {config.columns}</p>
              <p className="text-[11px] text-gray-400">Cliquez ou déposez un fichier .csv / .xlsx</p>
            </>
          )}
        </div>
        <input
          type="file"
          ref={fileInputRefs[kind]}
          onChange={handleFileSelect(kind)}
          accept=".csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
          className="hidden"
        />

        {results && (
          <div className="flex gap-1.5">
            {results.invalid > 0 && (
              <button
                onClick={() => startCorrection(kind)}
                className="flex-1 flex items-center justify-center gap-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 py-1.5 rounded-lg transition-colors"
              >
                <Edit3 className="w-3.5 h-3.5" />
                Corriger les invalides ({results.invalid})
              </button>
            )}
            <button
              onClick={() => setLogKind(kind)}
              title="Lignes rejetées ou corrigées, avec la raison ; téléchargeable en CSV"
              className={`flex items-center justify-center gap-1.5 text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 py-1.5 px-3 rounded-lg transition-colors ${results.invalid > 0 ? '' : 'flex-1'}`}
            >
              <ScrollText className="w-3.5 h-3.5" />
              Journal
            </button>
          </div>
        )}
      </div>
    );
  };

  const importSummary = [
    members.length > 0 && `${members.length} membres`,
    organisms.length > 0 && `${organisms.length} organismes`,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <div className="w-full h-full bg-white border-r border-gray-200 flex flex-col overflow-y-auto custom-scrollbar">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-3 shrink-0">
          <div className="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center shadow-sm shrink-0">
            <MapPin className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-gray-900 tracking-tight leading-tight">GEO Membres</h1>
            <p className="text-xs text-gray-500 truncate">Cartographie et analyse de densité</p>
          </div>
        </div>

        <Section
          icon={<FileSpreadsheet className="w-4 h-4" />}
          title="Importation"
          summary={importSummary}
          open={openSections.import}
          onToggle={() => toggleSection('import')}
        >
          <div className="space-y-2">
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
        </Section>

        {organisms.length > 0 && (
          <Section
            icon={<Building2 className="w-4 h-4" />}
            title="Organismes"
            summary={orgRadius.enabled ? `rayon ${orgRadius.radiusKm} km` : 'rayon masqué'}
            open={openSections.organisms}
            onToggle={() => toggleSection('organisms')}
            action={
              <Switch
                checked={orgRadius.enabled}
                onChange={(checked) => setOrgRadius({ ...orgRadius, enabled: checked })}
                color="orange"
                title="Afficher le rayon d'attractivité"
              />
            }
          >
            <div className="space-y-3">
              {orgRadius.enabled && (
                <>
                  <div className="flex items-center gap-3">
                    <label htmlFor="org-radius-km" className="text-sm text-gray-700 shrink-0">Rayon</label>
                    <input
                      type="range"
                      min={ORG_RADIUS_MIN}
                      max={ORG_RADIUS_MAX}
                      value={orgRadius.radiusKm}
                      onChange={(e) => setOrgRadius({ ...orgRadius, radiusKm: parseInt(e.target.value) })}
                      className="flex-1 min-w-0 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-orange-600"
                      aria-label="Rayon d'attractivité"
                    />
                    <KmInput
                      id="org-radius-km"
                      value={orgRadius.radiusKm}
                      min={ORG_RADIUS_MIN}
                      max={ORG_RADIUS_MAX}
                      onChange={(km) => setOrgRadius({ ...orgRadius, radiusKm: km })}
                      color="orange"
                    />
                  </div>

                  {members.length > 0 && (
                    <div className="flex justify-between items-baseline text-sm bg-orange-50 px-3 py-2 rounded-lg border border-orange-100">
                      <span className="font-medium text-gray-700">Membres couverts</span>
                      <span>
                        <span className="text-base font-black text-orange-700">{organismStats.coveredCount}</span>
                        <span className="text-gray-500"> / {members.length}</span>
                      </span>
                    </div>
                  )}
                </>
              )}

              <div>
                <button
                  onClick={() => setShowOrganismList(v => !v)}
                  className="flex items-center gap-1 text-xs font-semibold text-gray-500 uppercase tracking-wider hover:text-gray-700"
                >
                  {showOrganismList ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  Liste des organismes ({organisms.length})
                </button>
                {showOrganismList && (
                  <div className="mt-2 max-h-48 overflow-y-auto pr-1 space-y-1.5 custom-scrollbar">
                    {sortedOrganisms.map((org) => (
                      <React.Fragment key={org.id}>
                        <ListRow
                          title={org.name || 'Sans nom'}
                          subtitle={<>{org.type && <span className="text-orange-700 font-medium">{org.type} · </span>}{org.postalCode} {org.city}{foreignCountryLabel(org.country) && ` · ${org.country}`}</>}
                          badge={orgRadius.enabled && members.length > 0 ? String(organismStats.counts.get(org.id) || 0) : undefined}
                          badgeTitle={`Membres à moins de ${orgRadius.radiusKm} km`}
                          color="orange"
                        />
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Section>
        )}

        <Section
          icon={<Settings2 className="w-4 h-4" />}
          title="Repère"
          summary={marker.enabled ? `rayon ${marker.radiusKm} km` : 'désactivé'}
          open={openSections.marker}
          onToggle={() => toggleSection('marker')}
          action={
            <Switch
              checked={marker.enabled}
              onChange={(checked) => setMarker({ ...marker, enabled: checked })}
              color="indigo"
              title="Activer le repère"
            />
          }
        >
          {marker.enabled ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <label htmlFor="marker-radius-km" className="text-sm text-gray-700 shrink-0">Rayon</label>
                <input
                  type="range"
                  min={MARKER_RADIUS_MIN}
                  max={MARKER_RADIUS_MAX}
                  value={marker.radiusKm}
                  onChange={(e) => setMarker({ ...marker, radiusKm: parseInt(e.target.value) })}
                  className="flex-1 min-w-0 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                  aria-label="Rayon de recherche"
                />
                <KmInput
                  id="marker-radius-km"
                  value={marker.radiusKm}
                  min={MARKER_RADIUS_MIN}
                  max={MARKER_RADIUS_MAX}
                  onChange={(km) => setMarker({ ...marker, radiusKm: km })}
                  color="indigo"
                />
              </div>
              <p className="text-xs text-gray-500">Déplacez le marqueur ou cliquez sur la carte pour ajuster la zone.</p>
            </div>
          ) : (
            <p className="text-xs text-gray-500">Activez le repère pour compter membres et organismes dans une zone.</p>
          )}
        </Section>

        {/* Résultats du repère : occupe la hauteur restante, seule la liste défile */}
        {marker.enabled && (
          <div className="flex-1 min-h-[260px] flex flex-col bg-indigo-50/50 p-4 gap-3">
            <div className="grid grid-cols-2 gap-2 shrink-0">
              <StatTile
                icon={<Building2 className="w-4 h-4" />}
                label="Organismes"
                value={organismsInRadius.length}
                total={organisms.length}
                color="orange"
              />
              <StatTile
                icon={<Users className="w-4 h-4" />}
                label="Membres"
                value={membersInRadius.length}
                total={members.length}
                color="indigo"
              />
            </div>

            <div className="flex-1 min-h-0 flex flex-col bg-white rounded-xl border border-gray-200 shadow-sm">
              <div className="flex border-b border-gray-100 shrink-0 text-xs font-semibold">
                <ResultTab active={resultTab === 'villes'} onClick={() => setResultTab('villes')} color="indigo">
                  Villes ({groupedMembers.length})
                </ResultTab>
                <ResultTab active={resultTab === 'organismes'} onClick={() => setResultTab('organismes')} color="orange">
                  Organismes ({organismsInRadius.length})
                </ResultTab>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1.5 custom-scrollbar">
                {resultTab === 'villes' && (groupedMembers.length > 0 ? groupedMembers.map((group) => (
                  <React.Fragment key={group.key}>
                    <ListRow
                      title={group.city || 'Inconnue'}
                      subtitle={[group.cp || 'CP inconnu', group.country].filter(Boolean).join(' · ')}
                      badge={String(group.count)}
                      color="indigo"
                    />
                  </React.Fragment>
                )) : <EmptyList>Aucun membre dans la zone</EmptyList>)}
                {resultTab === 'organismes' && (organismsInRadius.length > 0 ? organismsInRadius.map(({ organism, distanceKm }) => (
                  <React.Fragment key={organism.id}>
                    <ListRow
                      title={organism.name || 'Sans nom'}
                      subtitle={<>{organism.type && <span className="text-orange-700 font-medium">{organism.type} · </span>}{organism.postalCode} {organism.city}{foreignCountryLabel(organism.country) && ` · ${organism.country}`}</>}
                      badge={`${Math.round(distanceKm)} km`}
                      badgeTitle="Distance au repère"
                      color="orange"
                    />
                  </React.Fragment>
                )) : <EmptyList>Aucun organisme dans la zone</EmptyList>)}
              </div>
            </div>
          </div>
        )}
      </div>

      {resolvingRow && (
        <ResolutionModal
          row={resolvingRow.row}
          reason={resolvingRow.reason}
          initialOptions={resolvingRow.options}
          onResolve={(result) => {
            resolvingRow.resolve(result);
            setResolvingRow(null);
          }}
        />
      )}

      {stagedFile && !importState.isAnalyzing && !resolvingRow && (
        <ColumnMappingModal
          staged={stagedFile}
          onChange={setStagedFile}
          notice={(stagedFile.kind === 'organisms' && organisms.length > 0) || isReimporting ? (
            <p className="text-sm font-medium mb-4">
              {stagedFile.kind === 'organisms' && organisms.length > 0 && (
                <span className="block text-orange-700">Les organismes déjà importés seront remplacés.</span>
              )}
              {isReimporting && (
                <span className="block text-indigo-600">Les membres valides seront ajoutés à la liste existante.</span>
              )}
            </p>
          ) : undefined}
          onCancel={() => { setStagedFile(null); resetFileInputs(); }}
          onConfirm={confirmImport}
        />
      )}

      {logKind && importState.results[logKind] && !importState.isAnalyzing && !resolvingRow && (
        <ImportLogModal
          results={importState.results[logKind]!}
          kind={logKind}
          onClose={() => setLogKind(null)}
        />
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
