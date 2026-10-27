import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';

export type CityDensity = 'peu' | 'normal' | 'beaucoup';

// [nom, lat, lng, population], communes de 2 000 habitants et plus, triées par population décroissante
// (source : geo.api.gouv.fr, Licence Ouverte)
type City = [string, number, number, number];

// Population minimale affichée au zoom 6, divisée par ~2,2 à chaque niveau de zoom
const DENSITY_BASE: Record<CityDensity, number> = { peu: 120000, normal: 40000, beaucoup: 12000 };
const MIN_POPULATION = 2000;
const FONT_FAMILY = 'ui-sans-serif, system-ui, sans-serif';

interface Box { x1: number; y1: number; x2: number; y2: number; }

const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

function fontFor(population: number) {
  if (population >= 200000) return { font: `700 13px ${FONT_FAMILY}`, size: 13 };
  if (population >= 50000) return { font: `600 12px ${FONT_FAMILY}`, size: 12 };
  return { font: `500 11px ${FONT_FAMILY}`, size: 11 };
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let citiesCache: City[] | null = null;

// Noms de villes posés au-dessus des ronds sans les recouvrir : un nom qui tomberait sur un rond
// est décalé dessous, dessus ou à côté ; s'il n'y a pas la place, il n'est pas affiché.
export default function CityLabels({ pane, density, refreshKey }: { pane: string; density: CityDensity; refreshKey: string }) {
  const map = useMap();

  useEffect(() => {
    const group = L.layerGroup().addTo(map);
    const measure = document.createElement('canvas').getContext('2d')!;
    let cancelled = false;
    let timer: number | undefined;

    const draw = () => {
      if (!citiesCache) return;
      group.clearLayers();

      const minPopulation = Math.max(MIN_POPULATION, DENSITY_BASE[density] * Math.pow(0.45, map.getZoom() - 6));
      const bounds = map.getBounds().pad(0.05);
      const origin = map.getContainer().getBoundingClientRect();

      const circles: Box[] = [];
      map.getPanes().markerPane.querySelectorAll('.custom-marker-cluster .rounded-full').forEach((el) => {
        const r = el.getBoundingClientRect();
        circles.push({ x1: r.left - origin.left - 1, y1: r.top - origin.top - 1, x2: r.right - origin.left + 1, y2: r.bottom - origin.top + 1 });
      });
      const taken = [...circles];

      for (const [name, lat, lng, population] of citiesCache) {
        if (population < minPopulation) break;
        if (!bounds.contains([lat, lng])) continue;

        const { font, size } = fontFor(population);
        measure.font = font;
        const w = Math.ceil(measure.measureText(name).width) + 6;
        const h = size + 4;
        const p = map.latLngToContainerPoint([lat, lng]);

        const centered = { x1: p.x - w / 2, y1: p.y - h / 2, x2: p.x + w / 2, y2: p.y + h / 2 };
        const candidates = [centered];
        const hit = circles.find(c => overlaps(centered, c));
        if (hit) {
          candidates.push(
            { x1: p.x - w / 2, y1: hit.y2, x2: p.x + w / 2, y2: hit.y2 + h },
            { x1: p.x - w / 2, y1: hit.y1 - h, x2: p.x + w / 2, y2: hit.y1 },
            { x1: hit.x2, y1: p.y - h / 2, x2: hit.x2 + w, y2: p.y + h / 2 },
            { x1: hit.x1 - w, y1: p.y - h / 2, x2: hit.x1, y2: p.y + h / 2 },
            { x1: hit.x2 - 4, y1: hit.y2 - 4, x2: hit.x2 - 4 + w, y2: hit.y2 - 4 + h },
            { x1: hit.x2 - 4, y1: hit.y1 + 4 - h, x2: hit.x2 - 4 + w, y2: hit.y1 + 4 },
            { x1: hit.x1 + 4 - w, y1: hit.y2 - 4, x2: hit.x1 + 4, y2: hit.y2 - 4 + h },
            { x1: hit.x1 + 4 - w, y1: hit.y1 + 4 - h, x2: hit.x1 + 4, y2: hit.y1 + 4 },
          );
        }
        const spot = candidates.find(b => !taken.some(t => overlaps(b, t)));
        if (!spot) continue;
        taken.push(spot);

        L.marker([lat, lng], {
          pane,
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: 'city-label',
            html: `<span style="font:${font}">${escapeHtml(name)}</span>`,
            iconSize: L.point(w, h),
            iconAnchor: L.point(p.x - spot.x1, p.y - spot.y1),
          }),
        }).addTo(group);
      }
    };

    // Attend que les regroupements de ronds soient recalculés (animation ~250 ms)
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(draw, 350);
    };

    map.on('moveend', schedule);
    if (citiesCache) {
      schedule();
    } else {
      import('../data/villes.json').then((m) => {
        citiesCache = m.default as City[];
        if (!cancelled) draw();
      });
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      map.off('moveend', schedule);
      group.remove();
    };
  }, [map, pane, density, refreshKey]);

  return null;
}
