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

// Noms complets des pays (français et anglais) tirés du navigateur, pour reconnaître
// un pays absent de la liste ci-dessus et un pays écrit en fin de ville (« DELMAS HAITI »).
const COUNTRY_NAMES = new Map<string, string>();
try {
  const fr = new Intl.DisplayNames(['fr'], { type: 'region' });
  const en = new Intl.DisplayNames(['en'], { type: 'region' });
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of A) for (const b of A) {
    const iso = a + b;
    for (const dn of [fr, en]) {
      const name = dn.of(iso);
      if (name && name !== iso) {
        const key = normalize(name);
        if (key.length >= 4 && !COUNTRY_NAMES.has(key)) COUNTRY_NAMES.set(key, iso.toLowerCase());
      }
    }
  }
} catch {
  // Intl.DisplayNames indisponible : liste manuelle seulement
}
for (const [alias, code] of ALIAS_TO_CODE) {
  if (alias.length >= 4) COUNTRY_NAMES.set(alias, code);
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

  let code = ALIAS_TO_CODE.get(key) || COUNTRY_NAMES.get(key) || null;
  // Code ISO à deux lettres saisi tel quel (ex. « JP »)
  if (!code && /^[a-z]{2}$/.test(key) && regionNames?.of(key.toUpperCase()) !== key.toUpperCase()) {
    code = key;
  }

  if (code === 'fr') return { code, label: 'France', isFrance: true };
  if (code) return { code, label: labelFor(code), isFrance: false };
  // Pays inconnu de la liste : transmis tel quel à Nominatim
  return { code: null, label: rawCountry.trim(), isFrance: false };
}

// Provinces canadiennes écrites en fin de ville dans les exports (« TROIS RIVIERES  P.Q. »),
// sous forme normalisée (sans points, tirets remplacés par des espaces)
const CA_PROVINCES = new Set([
  'qc', 'pq', 'cq', 'quebec', 'que',
  'on', 'ont', 'ontario',
  'ab', 'alta', 'alberta',
  'bc', 'cb', 'colombie britannique', 'british columbia',
  'mb', 'man', 'manitoba',
  'sk', 'sask', 'saskatchewan',
  'nb', 'n b', 'nouveau brunswick', 'new brunswick',
  'ns', 'nouvelle ecosse', 'nova scotia',
  'pe', 'pei', 'ipe', 'ile du prince edouard', 'prince edward island',
  'nl', 'tnl', 'terre neuve', 'newfoundland',
  'yt', 'yukon', 'nt', 'tno', 'nu', 'nunavut',
]);

const CA_POSTCODE_LOOSE = /([A-Z])\s*([0-9O])\s*([A-Z])\s*([0-9O])\s*([A-Z])\s*([0-9O])/;

export interface PreparedAddress {
  postalCode: string;
  city: string;
  country: CountryRef;
}

// Remet en forme une adresse étrangère issue d'un export : pays écrit à la fin de la ville,
// numéro d'arrondissement final (« ABIDJAN 01 »), province canadienne collée à la ville,
// code postal canadien avec un O à la place d'un zéro ou précédé de la province.
export function prepareForeign(postalCode: string, city: string, country: CountryRef): PreparedAddress {
  let words = city.replace(/[.,;]/g, ' ').replace(/\s+-\s+/g, ' ').trim().split(/\s+/).filter(Boolean);

  // Pays en fin de ville, s'il diffère du pays déclaré
  for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
    const code = COUNTRY_NAMES.get(normalize(words.slice(-n).join(' ')));
    if (code) {
      if (code !== country.code) {
        country = code === 'fr' ? { code, label: 'France', isFrance: true } : { code, label: labelFor(code), isFrance: false };
      }
      words = words.slice(0, -n);
      break;
    }
  }

  // Numéro final (arrondissement, cedex)
  while (words.length > 1 && /^\d+$/.test(words[words.length - 1])) words.pop();

  if (country.code === 'ca') {
    // Province en fin de ville (« P.Q. » devient « P Q », d'où la jonction des lettres isolées)
    for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
      const tail = normalize(words.slice(-n).join(' '));
      if (CA_PROVINCES.has(tail) || CA_PROVINCES.has(tail.replace(/ /g, ''))) {
        words = words.slice(0, -n);
        break;
      }
    }
    words = words.flatMap((w, i) => {
      const up = w.toUpperCase();
      if (up === 'ST') return ['Saint'];
      if (up === 'STE') return ['Sainte'];
      return [w];
    });
    // « MC MASTERVILLE » → « MCMASTERVILLE »
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i].toUpperCase() === 'MC') {
        words.splice(i, 2, words[i] + words[i + 1]);
      }
    }

    const m = postalCode.toUpperCase().match(CA_POSTCODE_LOOSE);
    if (m) {
      const d = (c: string) => c.replace('O', '0');
      postalCode = `${m[1]}${d(m[2])}${m[3]} ${d(m[4])}${m[5]}${d(m[6])}`;
    }
  }

  return { postalCode: postalCode.replace(/\s+/g, ' ').trim(), city: words.join(' '), country };
}

// Libellé du pays à afficher à côté de la ville, vide pour la France
export function foreignCountryLabel(country?: string): string {
  if (!country) return '';
  return resolveCountry(country).isFrance ? '' : country;
}
