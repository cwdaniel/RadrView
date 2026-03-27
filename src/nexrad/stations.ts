import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NexradStation {
  id: string;
  lat: number;
  lon: number;
  elev: number;  // meters ASL
  name: string;
}

const RANGE_KM = 460;  // max reflectivity range

// Load station data from JSON (file lives outside src/ rootDir, so use fs.readFileSync)
const __dirname = dirname(fileURLToPath(import.meta.url));
const stationData: Record<string, { lat: number; lon: number; elev: number; name: string }> =
  JSON.parse(readFileSync(join(__dirname, '../../data/nexrad-stations.json'), 'utf-8'));

const stations: Map<string, NexradStation> = new Map(
  Object.entries(stationData).map(([id, s]) => [id, { id, ...s }])
);

export function getStation(id: string): NexradStation | undefined {
  return stations.get(id);
}

export function getAllStations(): NexradStation[] {
  return [...stations.values()];
}

/** Find stations whose 460km range intersects a geographic bounding box */
export function findStationsForBounds(
  west: number, south: number, east: number, north: number
): NexradStation[] {
  return getAllStations().filter(s => {
    const clampLat = Math.max(south, Math.min(north, s.lat));
    const clampLon = Math.max(west, Math.min(east, s.lon));
    const dist = haversineKm(s.lat, s.lon, clampLat, clampLon);
    return dist <= RANGE_KM;
  });
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
