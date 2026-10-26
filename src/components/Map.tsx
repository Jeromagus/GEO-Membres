import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Circle, useMapEvents, Popup } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import { Member, MarkerState } from '../types';
import * as turf from '@turf/turf';

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

interface MapProps {
  members: Member[];
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

export default function Map({ members, marker, setMarker, setMembersInRadius }: MapProps) {
  const [map, setMap] = useState<L.Map | null>(null);

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

  return (
    <div className="w-full h-full relative">
      <MapContainer
        center={[46.603354, 1.888334]}
        zoom={6}
        className="w-full h-full z-0"
        ref={setMap}
      >
        <TileLayer
          attribution='&copy; <a href="https://geoservices.ign.fr/">IGN</a> – Plan IGN'
          url="https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/png&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}"
          maxZoom={19}
        />
        
        <MapEvents marker={marker} setMarker={setMarker} />

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
    </div>
  );
}
