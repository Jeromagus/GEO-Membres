export interface Member {
  id: string;
  originalIndex: number;
  postalCode: string;
  city: string;
  country?: string;
  lat?: number;
  lng?: number;
}

export interface Organism {
  id: string;
  originalIndex: number;
  type: string;
  name: string;
  postalCode: string;
  city: string;
  country?: string;
  lat?: number;
  lng?: number;
}

export interface OrganismRadiusState {
  enabled: boolean;
  radiusKm: number;
}

export interface MarkerState {
  enabled: boolean;
  lat: number;
  lng: number;
  radiusKm: number;
}
