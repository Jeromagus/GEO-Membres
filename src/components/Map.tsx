import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Circle, useMapEvents, Popup, Pane } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import { Member, MarkerState, Organism, OrganismRadiusState } from '../types';
import { OrganismStats } from './Sidebar';
import * as turf from '@turf/turf';
import { Layers, ChevronDown, ChevronUp } from 'lucide-react';
import CityLabels, { CityDensity } from './CityLabels';

// Fonds de carte gratuits et sans clé. maxNativeZoom : au-delà, les tuiles sont agrandies.
const IGN_WMTS = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
const IGN_ATTRIBUTION = '&copy; <a href="https://geoservices.ign.fr/">IGN</a>';

const BASE_LAYERS = [
  {
    id: 'plan-ign', label: 'Plan IGN',
    url: `${IGN_WMTS}&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png`,
    attribution: `${IGN_ATTRIBUTION} – Plan IGN`, maxNativeZoom: 19,
    // Le plan porte déjà ses propres noms de lieux
    cityNamesByDefault: false,
  },
  {
    // Le Gris clair recoloré dans le navigateur par le filtre SVG #clair-colore (voir ClairColoreFilter)
    id: 'clair-colore', label: 'Clair coloré',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tuiles &copy; Esri – Esri, HERE, Garmin, OpenStreetMap', maxNativeZoom: 16,
    className: 'tiles-clair-colore',
    cityNamesByDefault: true,
  },
];

// Recoloration du Gris clair par niveau de gris (51 paliers, 0 → 1), mesurés sur les tuiles :
// mer ≈ 208, parcs ≈ 225, zones urbaines ≈ 232, terre ≈ 239, routes 255.
// Seule la mer passe en bleu ; villes en crème soutenu, terre en crème, frontières en gris.
const CLAIR_COLORE_R = '0.235 0.245 0.255 0.266 0.276 0.286 0.296 0.306 0.316 0.326 0.336 0.346 0.356 0.366 0.376 0.387 0.397 0.407 0.417 0.427 0.437 0.447 0.457 0.467 0.477 0.487 0.497 0.508 0.518 0.528 0.538 0.548 0.558 0.568 0.578 0.588 0.616 0.643 0.671 0.698 0.671 0.671 0.753 0.918 0.918 0.918 0.918 0.965 0.965 0.976 1.000';
const CLAIR_COLORE_G = '0.251 0.261 0.270 0.280 0.290 0.299 0.309 0.318 0.328 0.338 0.347 0.357 0.367 0.376 0.386 0.396 0.405 0.415 0.424 0.434 0.444 0.453 0.463 0.473 0.482 0.492 0.502 0.511 0.521 0.530 0.540 0.550 0.559 0.569 0.579 0.588 0.620 0.651 0.682 0.714 0.820 0.820 0.846 0.898 0.898 0.898 0.898 0.953 0.953 0.969 1.000';
const CLAIR_COLORE_B = '0.282 0.292 0.301 0.310 0.320 0.329 0.338 0.347 0.357 0.366 0.375 0.385 0.394 0.403 0.413 0.422 0.431 0.440 0.450 0.459 0.468 0.478 0.487 0.496 0.506 0.515 0.524 0.533 0.543 0.552 0.561 0.571 0.580 0.589 0.599 0.608 0.642 0.676 0.711 0.745 0.929 0.929 0.903 0.851 0.851 0.851 0.851 0.918 0.918 0.945 1.000';

function ClairColoreFilter() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      <filter id="clair-colore" colorInterpolationFilters="sRGB">
        <feComponentTransfer>
          <feFuncR type="table" tableValues={CLAIR_COLORE_R} />
          <feFuncG type="table" tableValues={CLAIR_COLORE_G} />
          <feFuncB type="table" tableValues={CLAIR_COLORE_B} />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}

const ADMIN_LIMITS_URL = `${IGN_WMTS}&LAYER=LIMITES_ADMINISTRATIVES_EXPRESS.LATEST&STYLE=normal&FORMAT=image/png`;

// Choix mémorisés dans le navigateur ; le stockage peut être indisponible (navigation privée…)
const STORAGE_BASE = 'geo-membres:fond';
const STORAGE_ADMIN = 'geo-membres:limites';
const STORAGE_DENSITY = 'geo-membres:densite-noms';
const storageCityNames = (baseId: string) => `geo-membres:noms:${baseId}`;

const DENSITIES: { id: CityDensity; label: string }[] = [
  { id: 'peu', label: 'Peu' },
  { id: 'normal', label: 'Normal' },
  { id: 'beaucoup', label: 'Beaucoup' },
];

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* sans mémorisation */ }
}

// Fix Leaflet default icon issue
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const customMarkerIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});

// Ronds : bleu-violet pour les membres seuls, orange (couleur opposée) dès qu'un organisme est au même lieu.
// Paliers de taille et de teinte selon le nombre de membres.
const MEMBER_COLORS = ['bg-indigo-500/80', 'bg-purple-600/80', 'bg-fuchsia-700/80'];
const ORGANISM_COLORS = ['bg-amber-500/90', 'bg-orange-600/90', 'bg-red-700/90'];
const SIZES = ['w-8 h-8 text-xs', 'w-10 h-10 text-sm', 'w-12 h-12 text-base font-bold'];

const BUILDING_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>';

// Rond centré dans une icône de 48 px ; content = nombre de membres, ou bâtiment pour un organisme sans membre
function roundIcon(content: string, memberCount: number, withOrganism: boolean) {
  const tier = memberCount < 10 ? 0 : memberCount < 100 ? 1 : 2;
  const color = (withOrganism ? ORGANISM_COLORS : MEMBER_COLORS)[tier];
  return L.divIcon({
    html: `<div class="w-full h-full flex items-center justify-center">
            <div class="flex items-center justify-center rounded-full shadow-lg border-2 border-white/70 ${SIZES[tier]} ${color} text-white">
              <span class="flex">${content}</span>
            </div>
          </div>`,
    className: 'custom-marker-cluster',
    iconSize: L.point(48, 48),
    iconAnchor: L.point(24, 24),
    popupAnchor: L.point(0, -16),
  });
}

const memberIcon = roundIcon('1', 1, false);
const organismIcon = roundIcon(BUILDING_SVG, 0, true);

// Noms de lieux au-dessus des ronds (markerPane = 600, infobulles = 650) ; les tuiles laissent passer les clics
const LABELS_PANE = 'noms';

interface MapProps {
  members: Member[];
  organisms: Organism[];
  orgRadius: OrganismRadiusState;
  organismStats: OrganismStats;
  marker: MarkerState;
  setMarker: (marker: MarkerState) => void;
  setMembersInRadius: (members: Member[]) => void;
}

function MapEvents({ marker, setMarker }: { marker: MarkerState, setMarker: (m: MarkerState) => void }) {
  useMapEvents({
    click(e) {
      if (marker.enabled) {
        setMarker({ ...marker, lat: e.latlng.lat, lng: e.latlng.lng });
      }
    },
  });
  return null;
}

export default function Map({ members, organisms, orgRadius, organismStats, marker, setMarker, setMembersInRadius }: MapProps) {
  const [map, setMap] = useState<L.Map | null>(null);
  const [baseLayerId, setBaseLayerId] = useState(() => {
    const saved = readStorage(STORAGE_BASE);
    return BASE_LAYERS.some(l => l.id === saved) ? saved! : BASE_LAYERS[0].id;
  });
  const [showAdminLimits, setShowAdminLimits] = useState(() => readStorage(STORAGE_ADMIN) === '1');
  const [layersCollapsed, setLayersCollapsed] = useState(false);
  const baseLayer = BASE_LAYERS.find(l => l.id === baseLayerId) || BASE_LAYERS[0];

  // Noms de villes : affichés ou non selon le fond (mémorisé par fond), densité commune
  const [cityNamesSaved, setCityNamesSaved] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(BASE_LAYERS.map(l => [l.id, readStorage(storageCityNames(l.id))]))
  );
  const savedNames = cityNamesSaved[baseLayer.id];
  const showCityNames = savedNames === null ? baseLayer.cityNamesByDefault : savedNames === '1';
  const [cityDensity, setCityDensity] = useState<CityDensity>(() => {
    const saved = readStorage(STORAGE_DENSITY);
    return DENSITIES.some(d => d.id === saved) ? saved as CityDensity : 'normal';
  });

  const toggleCityNames = (checked: boolean) => {
    const value = checked ? '1' : '0';
    setCityNamesSaved(s => ({ ...s, [baseLayer.id]: value }));
    writeStorage(storageCityNames(baseLayer.id), value);
  };

  const chooseCityDensity = (density: CityDensity) => {
    setCityDensity(density);
    writeStorage(STORAGE_DENSITY, density);
  };

  const chooseBaseLayer = (id: string) => {
    setBaseLayerId(id);
    writeStorage(STORAGE_BASE, id);
  };

  const toggleAdminLimits = (checked: boolean) => {
    setShowAdminLimits(checked);
    writeStorage(STORAGE_ADMIN, checked ? '1' : '0');
  };

  // Calculate members in radius
  useEffect(() => {
    if (!marker.enabled || members.length === 0) {
      setMembersInRadius([]);
      return;
    }

    const center = turf.point([marker.lng, marker.lat]);
    const inRadius: Member[] = [];

    for (const member of members) {
      if (member.lat !== undefined && member.lng !== undefined) {
        const pt = turf.point([member.lng, member.lat]);
        const distance = turf.distance(center, pt, { units: 'kilometers' });
        if (distance <= marker.radiusKm) {
          inRadius.push(member);
        }
      }
    }

    setMembersInRadius(inRadius);
  }, [members, marker.lat, marker.lng, marker.radiusKm, marker.enabled, setMembersInRadius]);

  // Membres et organismes partagent les mêmes groupes : le nombre affiché ne compte que les membres,
  // la couleur passe à l'orange si le groupe contient au moins un organisme
  const createClusterCustomIcon = function (cluster: any) {
    const children: L.Marker[] = cluster.getAllChildMarkers();
    const organismCount = children.filter(m => m.options.icon === organismIcon).length;
    const memberCount = children.length - organismCount;
    return roundIcon(memberCount > 0 ? String(memberCount) : BUILDING_SVG, memberCount, organismCount > 0);
  };

  return (
    <div className="w-full h-full relative">
      <ClairColoreFilter />
      <MapContainer
        center={[46.603354, 1.888334]}
        zoom={6}
        // Zoom continu : la molette avance par fractions de niveau, sans crans
        zoomSnap={0}
        zoomDelta={0.5}
        wheelPxPerZoomLevel={90}
        className="w-full h-full z-0"
        ref={setMap}
      >
        {/* key : l'attribution d'une TileLayer n'est pas mise à jour, on la recrée */}
        <TileLayer
          key={baseLayer.id}
          attribution={baseLayer.attribution}
          url={baseLayer.url}
          maxNativeZoom={baseLayer.maxNativeZoom}
          maxZoom={19}
          className={baseLayer.className}
        />
        {showAdminLimits && (
          <TileLayer
            attribution={`${IGN_ATTRIBUTION} – Limites administratives`}
            url={ADMIN_LIMITS_URL}
            maxZoom={19}
            zIndex={2}
          />
        )}
        <Pane name={LABELS_PANE} style={{ zIndex: 640, pointerEvents: 'none' }} />
        {showCityNames && (
          <CityLabels pane={LABELS_PANE} density={cityDensity} refreshKey={`${members.length}-${organisms.length}`} />
        )}
        
        <MapEvents marker={marker} setMarker={setMarker} />

        {/* Rayons d'attractivité : non interactifs, pour laisser passer les clics vers la carte */}
        {orgRadius.enabled && organisms.map((org) => (
          org.lat && org.lng ? (
            <Circle
              key={`radius-${org.id}`}
              center={[org.lat, org.lng]}
              radius={orgRadius.radiusKm * 1000}
              pathOptions={{ fillColor: '#ea580c', color: '#ea580c', weight: 1.5, fillOpacity: 0.1, interactive: false }}
            />
          ) : null
        ))}

        <MarkerClusterGroup
          chunkedLoading
          iconCreateFunction={createClusterCustomIcon}
          maxClusterRadius={50}
        >
          {members.map((member) => (
            member.lat && member.lng ? (
              <Marker
                key={member.id}
                position={[member.lat, member.lng]}
                icon={memberIcon}
              >
                <Popup>
                  <div className="text-sm min-w-[150px]">
                    <div className="font-bold text-gray-900 mb-1 border-b border-gray-100 pb-1">
                      Membre #{member.originalIndex}
                    </div>
                    <div className="text-gray-700 flex flex-col gap-0.5 mt-2">
                      <span className="flex items-center gap-1">
                        <span className="text-gray-400 text-xs uppercase tracking-wider">CP:</span> 
                        <span className="font-medium">{member.postalCode}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-gray-400 text-xs uppercase tracking-wider">Ville:</span> 
                        <span className="font-medium">{member.city}</span>
                      </span>
                    </div>
                  </div>
                </Popup>
              </Marker>
            ) : null
          ))}
          {organisms.map((org) => (
            org.lat && org.lng ? (
              <Marker
                key={org.id}
                position={[org.lat, org.lng]}
                icon={organismIcon}
              >
                <Popup>
                  <div className="text-sm min-w-[170px]">
                    <div className="font-bold text-gray-900 mb-1 border-b border-gray-100 pb-1">
                      {org.name || 'Organisme sans nom'}
                    </div>
                    <div className="text-gray-700 flex flex-col gap-0.5 mt-2">
                      {org.type && (
                        <span className="flex items-center gap-1">
                          <span className="text-gray-400 text-xs uppercase tracking-wider">Type:</span>
                          <span className="font-medium text-orange-700">{org.type}</span>
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <span className="text-gray-400 text-xs uppercase tracking-wider">Ville:</span>
                        <span className="font-medium">{org.postalCode} {org.city}</span>
                      </span>
                      {orgRadius.enabled && members.length > 0 && (
                        <span className="mt-1 text-orange-700 font-semibold">
                          {organismStats.counts.get(org.id) || 0} membres à moins de {orgRadius.radiusKm} km
                        </span>
                      )}
                    </div>
                  </div>
                </Popup>
              </Marker>
            ) : null
          ))}
        </MarkerClusterGroup>

        {marker.enabled && (
          <>
            <Circle
              center={[marker.lat, marker.lng]}
              radius={marker.radiusKm * 1000}
              pathOptions={{ fillColor: '#4f46e5', color: '#4f46e5', weight: 2, fillOpacity: 0.2 }}
            />
            <Marker
              position={[marker.lat, marker.lng]}
              icon={customMarkerIcon}
              draggable={true}
              eventHandlers={{
                dragend: (e) => {
                  const m = e.target;
                  const position = m.getLatLng();
                  setMarker({ ...marker, lat: position.lat, lng: position.lng });
                },
              }}
            />
          </>
        )}
      </MapContainer>
      
      {!marker.enabled && (
        <div className="absolute top-4 right-4 z-[1000] bg-white/90 backdrop-blur px-4 py-2 rounded-xl shadow-sm border border-gray-200 text-sm font-medium text-gray-700 pointer-events-none">
          Activez le repère pour analyser une zone
        </div>
      )}

      <div className="absolute bottom-6 left-4 z-[1000] w-56 bg-white/95 backdrop-blur rounded-xl shadow-sm border border-gray-200 text-xs text-gray-700">
        <button
          onClick={() => setLayersCollapsed(c => !c)}
          className="w-full flex items-center justify-between px-3 py-2 font-semibold text-gray-900 uppercase tracking-wider"
          title={layersCollapsed ? 'Afficher les calques' : 'Replier les calques'}
        >
          <span className="flex items-center gap-2">
            <Layers className="w-4 h-4" />
            Calques
          </span>
          {layersCollapsed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        {/* La légende reste visible quand les calques sont repliés */}
        <Legend members={members} organisms={organisms} orgRadius={orgRadius} />

        {!layersCollapsed && (
          <div className="px-3 pb-3 pt-2 space-y-3 border-t border-gray-100">
            <div className="space-y-1">
              {BASE_LAYERS.map((layer) => (
                <label key={layer.id} className="flex items-center gap-2 cursor-pointer py-0.5">
                  <input
                    type="radio"
                    name="fond-de-carte"
                    checked={layer.id === baseLayerId}
                    onChange={() => chooseBaseLayer(layer.id)}
                    className="accent-indigo-600"
                  />
                  {layer.label}
                </label>
              ))}
            </div>

            <label className="flex items-center gap-2 cursor-pointer pt-2 border-t border-gray-100">
              <input
                type="checkbox"
                checked={showAdminLimits}
                onChange={(e) => toggleAdminLimits(e.target.checked)}
                className="accent-indigo-600"
              />
              Limites administratives
            </label>

            <div className="pt-2 border-t border-gray-100 space-y-1.5">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showCityNames}
                  onChange={(e) => toggleCityNames(e.target.checked)}
                  className="accent-indigo-600"
                />
                Noms des villes
              </label>
              {showCityNames && (
                <div className="flex rounded-md border border-gray-200 overflow-hidden" role="group" aria-label="Densité des noms de villes">
                  {DENSITIES.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => chooseCityDensity(d.id)}
                      className={`flex-1 py-1 transition-colors ${d.id === cityDensity ? 'bg-indigo-600 text-white font-semibold' : 'bg-white hover:bg-gray-50'}`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

function Legend({ members, organisms, orgRadius }: { members: Member[]; organisms: Organism[]; orgRadius: OrganismRadiusState }) {
  if (members.length === 0 && organisms.length === 0) return null;
  return (
    <div className="px-3 pb-2 space-y-1.5">
      {members.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="flex gap-0.5">
            <span className="w-3 h-3 rounded-full bg-indigo-500" />
            <span className="w-3 h-3 rounded-full bg-purple-600" />
            <span className="w-3 h-3 rounded-full bg-fuchsia-700" />
          </span>
          Membres ({members.length})
        </div>
      )}
      {organisms.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="flex gap-0.5">
            <span className="w-3 h-3 rounded-full bg-amber-500" />
            <span className="w-3 h-3 rounded-full bg-orange-600" />
            <span className="w-3 h-3 rounded-full bg-red-700" />
          </span>
          <span className="whitespace-nowrap">Avec organisme ({organisms.length})</span>
          {orgRadius.enabled && <span className="text-gray-500 whitespace-nowrap">· rayon {orgRadius.radiusKm} km</span>}
        </div>
      )}
    </div>
  );
}
