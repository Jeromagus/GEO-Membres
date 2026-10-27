import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Circle, useMapEvents, Popup } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import { Member, MarkerState, Organism, OrganismRadiusState } from '../types';
import { OrganismStats } from './Sidebar';
import * as turf from '@turf/turf';
import { Layers, ChevronDown, ChevronUp } from 'lucide-react';

// Fonds de carte gratuits et sans clé. maxNativeZoom : au-delà, les tuiles sont agrandies.
const IGN_WMTS = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
const IGN_ATTRIBUTION = '&copy; <a href="https://geoservices.ign.fr/">IGN</a>';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const BASE_LAYERS = [
  {
    id: 'plan-ign', label: 'Plan IGN',
    url: `${IGN_WMTS}&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png`,
    attribution: `${IGN_ATTRIBUTION} – Plan IGN`, maxNativeZoom: 19,
  },
  {
    id: 'gris-clair', label: 'Gris clair',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tuiles &copy; Esri – Esri, HERE, Garmin, OpenStreetMap', maxNativeZoom: 16,
  },
  {
    id: 'photos', label: 'Photos aériennes',
    url: `${IGN_WMTS}&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg`,
    attribution: `${IGN_ATTRIBUTION} – Photographies aériennes`, maxNativeZoom: 19,
  },
  {
    id: 'osm-france', label: 'OpenStreetMap France',
    url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
    attribution: `${OSM_ATTRIBUTION} – tuiles OSM France`, maxNativeZoom: 19,
  },
  {
    id: 'relief', label: 'Relief',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: `${OSM_ATTRIBUTION}, SRTM – style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`, maxNativeZoom: 17,
  },
];

const ADMIN_LIMITS_URL = `${IGN_WMTS}&LAYER=LIMITES_ADMINISTRATIVES_EXPRESS.LATEST&STYLE=normal&FORMAT=image/png`;

// Choix mémorisés dans le navigateur ; le stockage peut être indisponible (navigation privée…)
const STORAGE_BASE = 'geo-membres:fond';
const STORAGE_ADMIN = 'geo-membres:limites';

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

// Membre isolé : même rond que les petits groupes, avec le chiffre 1
const memberIcon = L.divIcon({
  html: `<div class="flex items-center justify-center rounded-full shadow-lg border-2 border-white/50 w-8 h-8 text-xs bg-indigo-500/80 text-white">
          <span>1</span>
        </div>`,
  className: 'custom-marker-cluster',
  iconSize: L.point(32, 32),
  iconAnchor: L.point(16, 16),
  popupAnchor: L.point(0, -16),
});

// Organisme seul : carré émeraude, distinct des épingles des membres
const organismIcon = L.divIcon({
  html: `<div class="w-6 h-6 rounded-md bg-emerald-600 border-2 border-white shadow-lg ring-2 ring-emerald-700/40"></div>`,
  className: 'organism-marker',
  iconSize: L.point(24, 24),
  iconAnchor: L.point(12, 12),
  popupAnchor: L.point(0, -12),
});

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

  const createClusterCustomIcon = function (cluster: any) {
    const count = cluster.getChildCount();
    let size = 'Small';
    let colorClass = 'bg-indigo-500/80 text-white';

    if (count < 10) {
      size = 'w-8 h-8 text-xs';
    } else if (count < 100) {
      size = 'w-10 h-10 text-sm';
      colorClass = 'bg-purple-600/80 text-white';
    } else {
      size = 'w-12 h-12 text-base font-bold';
      colorClass = 'bg-fuchsia-700/80 text-white';
    }

    return L.divIcon({
      html: `<div class="flex items-center justify-center rounded-full shadow-lg border-2 border-white/50 ${size} ${colorClass}">
              <span>${count}</span>
            </div>`,
      className: 'custom-marker-cluster',
      iconSize: L.point(40, 40, true),
    });
  };

  // Dégradé émeraude pour les organismes (le violet reste aux membres)
  const createOrganismClusterIcon = function (cluster: any) {
    const count = cluster.getChildCount();
    let size = 'w-8 h-8 text-xs';
    let colorClass = 'bg-emerald-500/90 text-white';

    if (count >= 100) {
      size = 'w-12 h-12 text-base font-bold';
      colorClass = 'bg-emerald-900/90 text-white';
    } else if (count >= 10) {
      size = 'w-10 h-10 text-sm';
      colorClass = 'bg-emerald-700/90 text-white';
    }

    return L.divIcon({
      html: `<div class="flex items-center justify-center rounded-lg shadow-lg border-2 border-white/70 ${size} ${colorClass}">
              <span>${count}</span>
            </div>`,
      className: 'custom-marker-cluster',
      iconSize: L.point(40, 40, true),
    });
  };

  return (
    <div className="w-full h-full relative">
      <MapContainer
        center={[46.603354, 1.888334]}
        zoom={6}
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
        />
        {showAdminLimits && (
          <TileLayer
            attribution={`${IGN_ATTRIBUTION} – Limites administratives`}
            url={ADMIN_LIMITS_URL}
            maxZoom={19}
            zIndex={2}
          />
        )}
        
        <MapEvents marker={marker} setMarker={setMarker} />

        {/* Rayons d'attractivité : non interactifs, pour laisser passer les clics vers la carte */}
        {orgRadius.enabled && organisms.map((org) => (
          org.lat && org.lng ? (
            <Circle
              key={`radius-${org.id}`}
              center={[org.lat, org.lng]}
              radius={orgRadius.radiusKm * 1000}
              pathOptions={{ fillColor: '#059669', color: '#059669', weight: 1.5, fillOpacity: 0.12, interactive: false }}
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
        </MarkerClusterGroup>

        <MarkerClusterGroup
          iconCreateFunction={createOrganismClusterIcon}
          maxClusterRadius={30}
        >
          {organisms.map((org) => (
            org.lat && org.lng ? (
              <Marker
                key={org.id}
                position={[org.lat, org.lng]}
                icon={organismIcon}
                // Au-dessus des épingles et groupes de membres
                zIndexOffset={10000}
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
                          <span className="font-medium text-emerald-700">{org.type}</span>
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <span className="text-gray-400 text-xs uppercase tracking-wider">Ville:</span>
                        <span className="font-medium">{org.postalCode} {org.city}</span>
                      </span>
                      {orgRadius.enabled && members.length > 0 && (
                        <span className="mt-1 text-emerald-700 font-semibold">
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
        <div className="flex items-center gap-2">
          <span className="flex gap-0.5">
            <span className="w-3 h-3 rounded-sm bg-emerald-500" />
            <span className="w-3 h-3 rounded-sm bg-emerald-700" />
            <span className="w-3 h-3 rounded-sm bg-emerald-900" />
          </span>
          Organismes ({organisms.length})
          {orgRadius.enabled && <span className="text-gray-500">· rayon {orgRadius.radiusKm} km</span>}
        </div>
      )}
    </div>
  );
}
