// Estaciones automáticas (EMA) de la DMC: catastro, cercanía al jardín, estación de respaldo y revisión de cuáles
// están enviando datos.
import { distanceKm } from '../geo';
import { fetchWithTimeout } from '../http';
import type { DmcAuth, DmcConfig } from '../models';
import { textOf } from '../parse';
import { BASE, newestReading, unitNumber } from './api';
import { BACKUP_MAX_KM, LIVE_FRESH_MS } from './constants';
import { DMC_STATIONS_FALLBACK } from './station-catalog';

export interface DmcStation {
  code: string;
  name: string;
  latitude: number;
  longitude: number;
  elevationM: number | null;
}

export interface StationSource {
  code: string;
  name: string;
  distanceKm: number;
}

let stationList: Promise<DmcStation[]> | null = null;

/**
 * Catastro de estaciones automáticas: el que publica la DMC y, si no responde, el incluido en la app. Se pide una
 * sola vez por sesión (elegir una estación lo consulta varias veces).
 */
export function listDmcStations(): Promise<DmcStation[]> {
  stationList ??= fetchStationList();
  return stationList;
}

async function fetchStationList(): Promise<DmcStation[]> {
  try {
    const res = await fetchWithTimeout(`${BASE}/estacionesRedEma`);
    if (res.ok) {
      const json = (await res.json()) as { datosEstacion?: Record<string, unknown>[] };
      const live = (json.datosEstacion ?? []).flatMap((r) => {
        const latitude = unitNumber(r['latitud']);
        const longitude = unitNumber(r['longitud']);
        const code = textOf(r['codigoNacional']);
        if (latitude === null || longitude === null || !code) return [];
        return [
          {
            code,
            name: textOf(r['nombreEstacion']),
            latitude,
            longitude,
            elevationM: unitNumber(r['altura']),
          },
        ];
      });
      if (live.length) return live;
    }
  } catch {
    /* sin servicio: se usa el catastro incluido en la app */
  }
  return catalogStations();
}

/** Estaciones del catastro incluido en la app (no necesita red). */
export function catalogStations(): DmcStation[] {
  return DMC_STATIONS_FALLBACK.map(([code, name, latitude, longitude, elevationM]) => ({ code, name, latitude, longitude, elevationM }));
}

/** Las `n` estaciones más cercanas a un punto, de la más cercana a la más lejana. */
export function nearbyDmcStations(stations: DmcStation[], lat: number, lon: number, n: number): (DmcStation & { distanceKm: number })[] {
  return stations
    .map((s) => ({ ...s, distanceKm: distanceKm(lat, lon, s.latitude, s.longitude) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, n);
}

export function nearestDmcStation(stations: DmcStation[], lat: number, lon: number): (DmcStation & { distanceKm: number }) | null {
  let best: (DmcStation & { distanceKm: number }) | null = null;
  for (const s of stations) {
    const d = distanceKm(lat, lon, s.latitude, s.longitude);
    if (!best || d < best.distanceKm) best = { ...s, distanceKm: d };
  }
  return best;
}

/** Estaciones a revisar al conectar: las `n` más cercanas dentro de `maxKm` (la más cercana siempre). */
export function stationsToCheck(
  stations: DmcStation[],
  lat: number,
  lon: number,
  n = 6,
  maxKm = 40,
): (DmcStation & { distanceKm: number })[] {
  return nearbyDmcStations(stations, lat, lon, n).filter((s, i) => i === 0 || s.distanceKm <= maxKm);
}

/** Estación de respaldo: la más cercana al jardín después de la elegida, dentro de 25 km. */
export function backupStationFor(
  code: string,
  lat: number,
  lon: number,
  stations = catalogStations(),
): (DmcStation & { distanceKm: number }) | null {
  const [st] = nearbyDmcStations(
    stations.filter((s) => s.code !== code),
    lat,
    lon,
    1,
  );
  return st && st.distanceKm <= BACKUP_MAX_KM ? st : null;
}

export interface StationMeta {
  latitude: number;
  elevationM: number;
}

/** Latitud y altura de la estación (de la configuración o del catastro incluido). */
export function stationMeta(cfg: DmcConfig, fallbackLat: number, fallbackElevation: number | null): StationMeta {
  const known = DMC_STATIONS_FALLBACK.find(([code]) => code === cfg.code);
  return {
    latitude: cfg.latitude ?? known?.[2] ?? fallbackLat,
    elevationM: cfg.elevationM ?? known?.[4] ?? fallbackElevation ?? 0,
  };
}

/** live: lectura de hace ≤ 90 min · late: de hace ≤ 24 h · stale: más vieja o sin lecturas · error: no respondió. */
export type StationHealth = 'live' | 'late' | 'stale' | 'error';

export interface StationCheck extends DmcStation {
  distanceKm: number;
  health: StationHealth;
  /** Instante de la lectura más nueva que entrega la DMC (cualquier dato). */
  newest: number | null;
  readings: number;
  /** Por qué no respondió ("HTTP 500", "sin conexión"). */
  error?: string;
  /** Inicio de la respuesta cuando no trae lecturas (sin credenciales): p. ej. un aviso de token inválido. */
  snippet?: string;
}

/** Revisa si una estación está enviando datos: consulta sus lecturas recientes y mira la más nueva. */
export async function checkStation(st: DmcStation & { distanceKm: number }, auth: DmcAuth | undefined, now: number): Promise<StationCheck> {
  const { f, newest } = await newestReading(st.code, auth);
  const base = { ...st, newest, readings: f.samples.length, snippet: f.snippet };
  if (!f.ok) return { ...base, health: 'error', error: f.status ? `HTTP ${f.status}` : 'sin conexión' };
  if (newest === null) return { ...base, health: 'stale' };
  const age = now - newest;
  return { ...base, health: age <= LIVE_FRESH_MS ? 'live' : age <= 24 * 3_600_000 ? 'late' : 'stale' };
}

/** Revisa varias estaciones, de a 3 a la vez, avisando cada resultado (para ir llenando la lista). */
export async function checkStations(
  stations: (DmcStation & { distanceKm: number })[],
  auth: DmcAuth | undefined,
  now: number,
  onResult?: (c: StationCheck) => void,
): Promise<StationCheck[]> {
  const out: StationCheck[] = [];
  let next = 0;
  const worker = async () => {
    while (next < stations.length) {
      const c = await checkStation(stations[next++], auth, now);
      out.push(c);
      onResult?.(c);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

/** La estación que conviene usar: la más cercana al día; si ninguna, la más cercana con datos de las últimas 24 h. */
export function bestStation(checks: StationCheck[]): StationCheck | null {
  const byDistance = [...checks].sort((a, b) => a.distanceKm - b.distanceKm);
  return byDistance.find((c) => c.health === 'live') ?? byDistance.find((c) => c.health === 'late') ?? null;
}
