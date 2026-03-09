import React, { useState } from 'react';
import Sidebar from './components/Sidebar';
import Map from './components/Map';
import { Member, MarkerState } from './types';
import 'leaflet/dist/leaflet.css';

export default function App() {
  const [members, setMembers] = useState<Member[]>([]);
  const [marker, setMarker] = useState<MarkerState>({
    enabled: false,
    lat: 46.603354,
    lng: 1.888334,
    radiusKm: 50,
  });
  const [membersInRadius, setMembersInRadius] = useState<Member[]>([]);

  return (
    <div className="flex h-screen w-full bg-gray-50 overflow-hidden font-sans">
      <div className="w-1/5 min-w-[300px] max-w-[400px] h-full shadow-xl z-10 relative">
        <Sidebar
          members={members}
          setMembers={setMembers}
          marker={marker}
          setMarker={setMarker}
          membersInRadius={membersInRadius}
        />
      </div>
      <div className="flex-1 h-full relative z-0">
        <Map
          members={members}
          marker={marker}
          setMarker={setMarker}
          setMembersInRadius={setMembersInRadius}
        />
      </div>
    </div>
  );
}
