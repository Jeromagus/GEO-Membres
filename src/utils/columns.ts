// Lecture d'un fichier .csv / .xlsx et correspondance entre ses colonnes et les données attendues
// (code postal, ville, pays, et pour les organismes type et nom). La correspondance est devinée
// d'après les intitulés, ou à défaut d'après le contenu, puis ajustable par l'utilisateur.

import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { resolveCountry } from './country';

export type Field = 'postalCode' | 'city' | 'country' | 'type' | 'name';
export type ColumnMapping = Record<Field, number | null>;

export const FIELD_LABELS: Record<Field, string> = {
  postalCode: 'Code postal',
  city: 'Ville',
  country: 'Pays',
  type: 'Type',
  name: 'Nom',
};

export const FIELD_HINTS: Partial<Record<Field, string>> = {
  country: 'vide = France',
  name: 'vide = ville',
};

export function fieldsFor(kind: 'members' | 'organisms'): Field[] {
  return kind === 'members' ? ['postalCode', 'city', 'country'] : ['type', 'name', 'postalCode', 'city', 'country'];
}

export interface Table {
  rows: string[][];
  // Nombre de colonnes (la ligne la plus longue)
  width: number;
  sheetName?: string;
}

export async function readTable(file: File): Promise<Table> {
  const fileName = file.name.toLowerCase();
  let raw: any[][];
  let sheetName: string | undefined;

  if (fileName.endsWith('.csv')) {
    const text = await file.text();
    raw = Papa.parse(text, { header: false, skipEmptyLines: true }).data as any[][];
  } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    sheetName = workbook.SheetNames[0];
    // raw: false → valeur telle qu'affichée dans Excel (code postal 01000 au format « 00000 » gardé)
    raw = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false, defval: '' });
  } else {
    throw new Error('Format de fichier non supporté. Utilisez .csv ou .xlsx');
  }

  const rows = raw
    .map(r => (Array.isArray(r) ? r.map(c => String(c ?? '').trim()) : []))
    .filter(r => r.some(c => c !== ''));
  if (rows.length === 0) throw new Error('Le fichier est vide.');
  return { rows, width: Math.max(...rows.map(r => r.length)), sheetName };
}

// Lettre de colonne façon tableur : 0 → A, 26 → AA
export function columnLetter(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function norm(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Intitulés reconnus pour chaque donnée (forme normalisée)
const HEADER_PATTERNS: Record<Field, RegExp> = {
  postalCode: /^(cp|c p|code|code postal|codepostal|cod postal|zip|zip code|postcode|postal code|npa|plz)$/,
  city: /^(ville|city|commune|localite|locality|town|cite)$/,
  country: /^(pays|country|nation|land)$/,
  type: /^(type|categorie|category|nature|genre)$/,
  name: /^(nom|name|libelle|intitule|organisme|raison sociale|denomination|designation)$/,
};

function headerField(cell: string): Field | null {
  const key = norm(cell);
  for (const field of Object.keys(HEADER_PATTERNS) as Field[]) {
    if (HEADER_PATTERNS[field].test(key)) return field;
  }
  return null;
}

const POSTCODE_LIKE = /^(\d{4,5}|\d{2}\s?\d{3}|[a-z]\d[a-z]\s?\d[a-z]\d|\d{3}\s?\d{2}|\d{4}\s?[a-z]{2})$/i;

function isCountry(value: string): boolean {
  if (!value) return false;
  const ref = resolveCountry(value);
  return ref.code !== null && norm(value).length >= 2;
}

// Part des valeurs non vides d'une colonne qui vérifient le test
function share(rows: string[][], col: number, test: (v: string) => boolean): number {
  const values = rows.map(r => r[col] ?? '').filter(v => v !== '');
  if (values.length === 0) return 0;
  return values.filter(test).length / values.length;
}

export interface MappingGuess {
  hasHeader: boolean;
  mapping: ColumnMapping;
}

export function emptyMapping(): ColumnMapping {
  return { postalCode: null, city: null, country: null, type: null, name: null };
}

export function guessMapping(table: Table, kind: 'members' | 'organisms'): MappingGuess {
  const fields = fieldsFor(kind);
  const mapping = emptyMapping();
  const first = table.rows[0] || [];

  // 1. Intitulés en première ligne
  const byHeader = emptyMapping();
  first.forEach((cell, col) => {
    const field = headerField(cell);
    if (field && byHeader[field] === null) byHeader[field] = col;
  });
  const recognized = fields.filter(f => byHeader[f] !== null).length;
  // Première ligne sans aucun chiffre alors que des codes postaux suivent : en-tête aussi
  const firstHasDigits = first.some(c => /\d/.test(c));
  const hasHeader = recognized > 0 || (!firstHasDigits && table.rows.length > 1);

  if (recognized > 0) {
    for (const f of fields) mapping[f] = byHeader[f];
  }

  // 2. Contenu des colonnes pour ce qui reste
  const sample = table.rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 200);
  const used = new Set(Object.values(mapping).filter((v): v is number => v !== null));
  const free = () => Array.from({ length: table.width }, (_, i) => i).filter(i => !used.has(i));
  const take = (field: Field, col: number | undefined) => {
    if (col === undefined || mapping[field] !== null || !fields.includes(field)) return;
    mapping[field] = col;
    used.add(col);
  };

  const best = (test: (v: string) => boolean, min: number) => {
    let found: number | undefined;
    let score = min;
    for (const col of free()) {
      const s = share(sample, col, test);
      if (s > score) { score = s; found = col; }
    }
    return found;
  };

  take('postalCode', best(v => POSTCODE_LIKE.test(v), 0.6));
  take('country', best(isCountry, 0.6));
  // Colonnes de texte restantes, dans l'ordre : ville juste après le code postal de préférence
  const textCols = () => free().filter(col => share(sample, col, v => /[a-z]/i.test(v) && !/^\d+$/.test(v)) > 0.6);
  if (mapping.city === null) {
    const afterCp = mapping.postalCode !== null ? textCols().find(c => c === mapping.postalCode! + 1) : undefined;
    take('city', afterCp ?? (kind === 'members' ? textCols()[0] : textCols().filter(c => mapping.postalCode === null || c > mapping.postalCode)[0] ?? textCols().slice(-1)[0]));
  }
  if (kind === 'organisms') {
    const rest = textCols();
    if (mapping.type === null && mapping.name === null && rest.length >= 2) {
      take('type', rest[0]);
      take('name', rest[1]);
    } else {
      take('name', rest[0]);
    }
  }

  return { hasHeader, mapping };
}

// Ce qui manque pour lancer l'import, ou null si la correspondance suffit
export function mappingProblem(mapping: ColumnMapping): string | null {
  if (mapping.postalCode === null && mapping.city === null) return 'Choisissez au moins la colonne du code postal ou de la ville.';
  const cols = Object.values(mapping).filter((v): v is number => v !== null);
  if (new Set(cols).size !== cols.length) return 'Une même colonne est attribuée à deux données.';
  return null;
}

export function cell(row: string[], col: number | null): string {
  return col === null ? '' : (row[col] ?? '').trim();
}
