// Reconnaissance de la colonne PAYS : la France (et les départements d'outre-mer couverts par
// la Base Adresse Nationale) part vers l'API Adresse ; le reste vers Nominatim.

export interface CountryRef {
  // Code ISO 3166-1 alpha-2 en minuscules, ou null si le pays saisi n'est pas reconnu
  code: string | null;
  // Libellé affiché et conservé sur le membre / l'organisme
  label: string;
  // Vrai si l'adresse est géocodée par l'API Adresse française
  isFrance: boolean;
}

const ALIASES: Record<string, string[]> = {
  fr: ['france', 'fr', 'fra', 'france metropolitaine', 'metropole', 'guadeloupe', 'martinique', 'guyane', 'guyane francaise',
    'reunion', 'la reunion', 'ile de la reunion', 'mayotte', 'saint pierre et miquelon', 'saint barthelemy', 'saint martin', 'dom', 'dom tom'],
  ca: ['canada', 'ca', 'can', 'quebec', 'qc', 'ontario', 'nouveau brunswick', 'new brunswick', 'colombie britannique',
    'british columbia', 'alberta', 'manitoba', 'saskatchewan', 'nouvelle ecosse', 'nova scotia'],
  be: ['belgique', 'belgium', 'belgie', 'bel'],
  ch: ['suisse', 'switzerland', 'schweiz', 'svizzera', 'che'],
  lu: ['luxembourg', 'lux'],
  mc: ['monaco'],
  de: ['allemagne', 'germany', 'deutschland'],
  es: ['espagne', 'spain', 'espana'],
  it: ['italie', 'italy', 'italia'],
  pt: ['portugal'],
  nl: ['pays bas', 'netherlands', 'hollande', 'nederland'],
  gb: ['royaume uni', 'united kingdom', 'uk', 'angleterre', 'england', 'ecosse', 'scotland', 'pays de galles', 'wales', 'grande bretagne'],
  ie: ['irlande', 'ireland'],
  us: ['etats unis', 'etats unis d amerique', 'usa', 'united states', 'amerique'],
  ma: ['maroc', 'morocco'],
  dz: ['algerie', 'algeria'],
  tn: ['tunisie', 'tunisia'],
  sn: ['senegal'],
  ci: ['cote d ivoire', 'ivory coast'],
  cm: ['cameroun', 'cameroon'],
  cd: ['rdc', 'republique democratique du congo'],
  cg: ['congo', 'congo brazzaville'],
  mu: ['maurice', 'ile maurice'],
  ht: ['haiti'],
  br: ['bresil', 'brazil'],
  nc: ['nouvelle caledonie'],
  pf: ['polynesie', 'polynesie francaise', 'tahiti'],
  wf: ['wallis et futuna'],
};

const ALIAS_TO_CODE = new Map<string, string>();
for (const [code, names] of Object.entries(ALIASES)) {
  for (const name of names) ALIAS_TO_CODE.set(name, code);
}

// Code postal canadien (ex. H2X 1Y4) : reconnu même si la colonne PAYS est vide
const CANADIAN_POSTCODE = /^[abceghj-nprstvxy]\d[abceghj-nprstv-z]\s?\d[abceghj-nprstv-z]\d$/i;

let regionNames: Intl.DisplayNames | null = null;
try {
  regionNames = new Intl.DisplayNames(['fr'], { type: 'region' });
} catch {
  regionNames = null;
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function labelFor(code: string): string {
  const name = regionNames?.of(code.toUpperCase());
  return name && name.toLowerCase() !== code ? name : code.toUpperCase();
}

export function resolveCountry(rawCountry: string, postalCode = ''): CountryRef {
  const key = normalize(rawCountry || '');

  if (!key) {
    if (CANADIAN_POSTCODE.test(postalCode.trim())) return { code: 'ca', label: labelFor('ca'), isFrance: false };
    return { code: 'fr', label: 'France', isFrance: true };
  }

  let code = ALIAS_TO_CODE.get(key) || null;
  // Code ISO à deux lettres saisi tel quel (ex. « JP »)
  if (!code && /^[a-z]{2}$/.test(key) && regionNames?.of(key.toUpperCase()) !== key.toUpperCase()) {
    code = key;
  }

  if (code === 'fr') return { code, label: 'France', isFrance: true };
  if (code) return { code, label: labelFor(code), isFrance: false };
  // Pays inconnu de la liste : transmis tel quel à Nominatim
  return { code: null, label: rawCountry.trim(), isFrance: false };
}

// Libellé du pays à afficher à côté de la ville, vide pour la France
export function foreignCountryLabel(country?: string): string {
  if (!country) return '';
  return resolveCountry(country).isFrance ? '' : country;
}
