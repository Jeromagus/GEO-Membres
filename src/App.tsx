import React, { useMemo, useState } from 'react';
import * as turf from '@turf/turf';
import Sidebar, { OrganismInRadius, OrganismStats } from './components/Sidebar';
import Map from './components/Map';
import { Member, MarkerState, Organism, OrganismRadiusState } from './types';
import 'leaflet/dist/leaflet.css';

export default function App() {
  const [members, setMembers] = useState<Member[]>([]);
  const [organisms, setOrganisms] = useState<Organism[]>([]);
  const [orgRadius, setOrgRadius] = useState<OrganismRadiusState>({
    enabled: true,
    radiusKm: 30,
  });
  const [marker, setMarker] = useState<MarkerState>({
    enabled: false,
    lat: 46.603354,
    lng: 1.888334,
    radiusKm: 50,
  });
  const [membersInRadius, setMembersInRadius] = useState<Member[]>([]);

  // Membres à moins du rayon d'attractivité de chaque organisme
  const organismStats = useMemo<OrganismStats>(() => {
    const counts = new globalThis.Map<string, number>();
    const covered = new Set<string>();
    if (!orgRadius.enabled) return { counts, coveredCount: 0 };

    // Préfiltre grossier en latitude (1° ≈ 111 km) avant le calcul exact
    const maxLatDelta = orgRadius.radiusKm / 111;

    for (const org of organisms) {
      if (org.lat === undefined || org.lng === undefined) continue;
      let count = 0;
      for (const member of members) {
        if (member.lat === undefined || member.lng === undefined) continue;
        if (Math.abs(member.lat - org.lat) > maxLatDelta) continue;
        const distance = turf.distance([org.lng, org.lat], [member.lng, member.lat], { units: 'kilometers' });
        if (distance <= orgRadius.radiusKm) {
          count++;
          covered.add(member.id);
        }
      }
      counts.set(org.id, count);
    }

    return { counts, coveredCount: covered.size };
  }, [organisms, members, orgRadius.enabled, orgRadius.radiusKm]);

  // Organismes dans le rayon du repère, du plus proche au plus éloigné
  const organismsInRadius = useMemo<OrganismInRadius[]>(() => {
    if (!marker.enabled) return [];
    const inRadius: OrganismInRadius[] = [];
    for (const organism of organisms) {
      if (organism.lat === undefined || organism.lng === undefined) continue;
      const distanceKm = turf.distance([marker.lng, marker.lat], [organism.lng, organism.lat], { units: 'kilometers' });
      if (distanceKm <= marker.radiusKm) {
        inRadius.push({ organism, distanceKm });
      }
    }
    return inRadius.sort((a, b) => a.distanceKm - b.distanceKm);
  }, [organisms, marker.enabled, marker.lat, marker.lng, marker.radiusKm]);

  return (
    <div className="flex h-screen w-full bg-gray-50 overflow-hidden font-sans">
      <div className="w-1/5 min-w-[300px] max-w-[400px] h-full shadow-xl z-10 relative">
        <Sidebar
          members={members}
          setMembers={setMembers}
          organisms={organisms}
          setOrganisms={setOrganisms}
          orgRadius={orgRadius}
          setOrgRadius={setOrgRadius}
          organismStats={organismStats}
          marker={marker}
          setMarker={setMarker}
          membersInRadius={membersInRadius}
          organismsInRadius={organismsInRadius}
        />
      </div>
      <div className="flex-1 h-full relative z-0">
        <Map
          members={members}
          organisms={organisms}
          orgRadius={orgRadius}
          organismStats={organismStats}
          marker={marker}
          setMarker={setMarker}
          setMembersInRadius={setMembersInRadius}
        />
      </div>
    </div>
  );
}
