// Umbral de riego automático (FAO-56, cap. 8): cuánta agua útil guarda el suelo donde están las raíces y qué parte
// puede gastar el pasto antes de sufrir. Se calcula con la textura del suelo (elegida a mano o detectada con el mapa
// de suelos SoilGrids de ISRIC), la etapa del pasto y el consumo del día. Funciones puras más el cliente de
// SoilGrids (sin dependencias): las usan la app y el worker en segundo plano.
import type { LawnStage, Settings, SoilInfo, SoilTexture } from './models';
import { SLOW_TIMEOUT_MS, fetchWithTimeout } from './http';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Agua útil (% del volumen) de cada textura según la tabla 19 de FAO-56: valor típico y rango. */
export const TEXTURES: Record<SoilTexture, { label: string; hint: string; awcPct: number; min: number; max: number }> = {
  sand: { label: 'Arenoso', hint: 'se desarma al apretarlo, no mancha', awcPct: 8, min: 5, max: 12 },
  sandyLoam: { label: 'Franco arenoso', hint: 'áspero, forma una bola frágil', awcPct: 13, min: 11, max: 15 },
  loam: { label: 'Franco', hint: 'suave, forma una bola que se agrieta', awcPct: 15, min: 13, max: 19 },
  clay: { label: 'Arcilloso', hint: 'pegajoso, forma una cinta larga', awcPct: 16, min: 12, max: 20 },
};

/** Profundidad (cm) de las raíces que aprovechan el agua: pasto nuevo o establecido (ballica/festuca). */
export const ROOT_DEPTH_CM: Record<LawnStage, number> = { young: 10, established: 15 };

export const DEFAULT_TEXTURE: SoilTexture = 'loam';
export const DEFAULT_STAGE: LawnStage = 'established';

/** Fracción del agua útil que el pasto de clima templado gasta sin estrés (FAO-56, tabla 22), con 5 mm/día de consumo. */
export const TURF_P = 0.4;
const P_REFERENCE_ETC_MM = 5;

/** Límites del umbral automático (mm): ni riegos diminutos a diario ni esperas que estresen al pasto. */
export const AUTO_THRESHOLD_MIN_MM = 3;
export const AUTO_THRESHOLD_MAX_MM = 14;

/** Agua útil total en la zona de raíces (mm): % del volumen × profundidad. */
export function totalAvailableWater(awcPct: number, rootDepthCm: number): number {
  return (awcPct / 100) * rootDepthCm * 10;
}

/**
 * Fracción agotable p con la corrección de FAO-56 por consumo: los días de mucho consumo el pasto sufre antes, así
 * que se riega con menos déficit (p = 0,40 + 0,04 × (5 − ETc), entre 0,2 y 0,6). Sin consumo, la p de la tabla.
 */
export function depletionFraction(etcMm?: number): number {
  if (etcMm === undefined || !Number.isFinite(etcMm)) return TURF_P;
  return clamp(TURF_P + 0.04 * (P_REFERENCE_ETC_MM - etcMm), 0.2, 0.6);
}

/** Umbral (mm de déficit) = p × agua útil en la zona de raíces, con 0,1 mm de precisión. */
export function autoThreshold(awcPct: number, rootDepthCm: number, etcMm?: number): number {
  const mm = depletionFraction(etcMm) * totalAvailableWater(awcPct, rootDepthCm);
  return round1(clamp(mm, AUTO_THRESHOLD_MIN_MM, AUTO_THRESHOLD_MAX_MM));
}

/** Suelo de los ajustes (sin elegir: franco, con su agua útil típica). */
export function soilOf(settings: Pick<Settings, 'soil'>): SoilInfo {
  return settings.soil ?? { texture: DEFAULT_TEXTURE, awcPct: TEXTURES[DEFAULT_TEXTURE].awcPct, source: 'manual' };
}

export function rootDepthOf(settings: Pick<Settings, 'lawnStage'>): number {
  return ROOT_DEPTH_CM[settings.lawnStage ?? DEFAULT_STAGE];
}

export type ThresholdSettings = Pick<Settings, 'thresholdMm' | 'thresholdAuto' | 'soil' | 'lawnStage'>;

/**
 * Umbral de riego según los ajustes: el fijado a mano o, en modo automático, el del suelo y las raíces. Con `etcMm`
 * (consumo del día) se aplica la corrección por consumo; sin él, la p de la tabla: un valor estable para calibrar el
 * sensor o mostrar en Ajustes.
 */
export function baseThreshold(settings: ThresholdSettings, etcMm?: number): number {
  if (!settings.thresholdAuto) return settings.thresholdMm;
  return autoThreshold(soilOf(settings).awcPct, rootDepthOf(settings), etcMm);
}

// ───────────── SoilGrids (ISRIC): mapa mundial de suelos, celdas de 250 m, sin clave ─────────────

export const SOILGRIDS_URL = 'https://rest.isric.org/soilgrids/v2.0/properties/query';
const PROPERTIES = ['clay', 'sand', 'silt', 'wv0033', 'wv1500'];
const DEPTHS = ['0-5cm', '5-15cm', '15-30cm'];

/** Consulta de los primeros 30 cm. La ubicación va redondeada a dos decimales (~1 km): no se envía la exacta. */
export function soilGridsUrl(lat: number, lon: number): string {
  const query = [
    `lon=${lon.toFixed(2)}`,
    `lat=${lat.toFixed(2)}`,
    ...PROPERTIES.map((p) => `property=${p}`),
    ...DEPTHS.map((d) => `depth=${d}`),
    'value=mean',
  ];
  return `${SOILGRIDS_URL}?${query.join('&')}`;
}

export interface SoilSample {
  sandPct: number;
  clayPct: number;
  /** Agua útil según la retención de agua de SoilGrids (33 kPa − 1500 kPa), o null si no la entrega. */
  awcPct: number | null;
}

interface SoilGridsLayer {
  name?: string;
  unit_measure?: { d_factor?: number };
  depths?: { range?: { top_depth?: number; bottom_depth?: number }; values?: { mean?: number | null } }[];
}

/**
 * Composición y agua útil de los primeros 30 cm (promedio ponderado por el espesor de cada capa). null si el punto
 * no tiene datos: SoilGrids no mapea zonas urbanas ni cuerpos de agua.
 */
export function parseSoilGrids(json: unknown): SoilSample | null {
  const layers = (json as { properties?: { layers?: SoilGridsLayer[] } } | null)?.properties?.layers;
  if (!Array.isArray(layers)) throw new Error('Respuesta de SoilGrids sin capas');
  const average = (name: string): number | null => {
    const layer = layers.find((l) => l.name === name);
    const d = layer?.unit_measure?.d_factor;
    const factor = typeof d === 'number' && d > 0 ? d : 1;
    let sum = 0;
    let weight = 0;
    for (const d of layer?.depths ?? []) {
      const v = d.values?.mean;
      const top = d.range?.top_depth;
      const bottom = d.range?.bottom_depth;
      if (typeof v !== 'number' || typeof top !== 'number' || typeof bottom !== 'number' || bottom <= top) continue;
      sum += (v / factor) * (bottom - top);
      weight += bottom - top;
    }
    return weight ? sum / weight : null;
  };
  const sand = average('sand');
  const clay = average('clay');
  if (sand === null || clay === null) return null;
  const fieldCapacity = average('wv0033');
  const wiltingPoint = average('wv1500');
  return {
    sandPct: round1(sand),
    clayPct: round1(clay),
    awcPct: fieldCapacity !== null && wiltingPoint !== null && fieldCapacity > wiltingPoint ? round1(fieldCapacity - wiltingPoint) : null,
  };
}

/** Grupo de textura (triángulo USDA simplificado a los grupos de la tabla de FAO-56). */
export function textureOf(sandPct: number, clayPct: number): SoilTexture {
  if (clayPct >= 27) return 'clay';
  if (sandPct >= 70 && clayPct < 15) return 'sand';
  if (sandPct >= 52 && clayPct < 20) return 'sandyLoam';
  return 'loam';
}

/** Suelo a partir de una muestra de SoilGrids: su agua útil, acotada al rango de FAO-56 para esa textura. */
export function soilFromSample(sample: SoilSample): SoilInfo {
  const texture = textureOf(sample.sandPct, sample.clayPct);
  const t = TEXTURES[texture];
  return {
    texture,
    awcPct: sample.awcPct === null ? t.awcPct : round1(clamp(sample.awcPct, t.min, t.max)),
    source: 'soilgrids',
    sandPct: sample.sandPct,
    clayPct: sample.clayPct,
  };
}

/** Puntos a probar: el del jardín y, si no tiene datos (zona urbana), cuatro vecinos a ~2 km. */
const OFFSETS: [number, number][] = [
  [0, 0],
  [0.02, 0],
  [-0.02, 0],
  [0, 0.02],
  [0, -0.02],
];

/**
 * Suelo de la zona según SoilGrids: el del punto del jardín o, si es urbano (sin datos), el del primer vecino que
 * tenga. null si ninguno tiene. A lo más cinco consultas, una tras otra (SoilGrids admite pocas por minuto).
 */
export async function detectSoil(lat: number, lon: number): Promise<{ soil: SoilInfo; nearby: boolean } | null> {
  for (const [i, [dLat, dLon]] of OFFSETS.entries()) {
    const res = await fetchWithTimeout(soilGridsUrl(lat + dLat, lon + dLon), {}, SLOW_TIMEOUT_MS);
    if (res.status === 429) throw new Error('SoilGrids está recibiendo demasiadas consultas; prueba en un minuto');
    if (!res.ok) throw new Error(`SoilGrids HTTP ${res.status}`);
    const sample = parseSoilGrids(await res.json());
    if (sample) return { soil: soilFromSample(sample), nearby: i > 0 };
  }
  return null;
}
