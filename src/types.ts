export interface Member {
  id: string;
  originalIndex: number;
  postalCode: string;
  city: string;
  country?: string;
  lat?: number;
  lng?: number;
}

export interface MarkerState {
  enabled: boolean;
  lat: number;
  lng: number;
  radiusKm: number;
  focusTrigger?: number;
}
