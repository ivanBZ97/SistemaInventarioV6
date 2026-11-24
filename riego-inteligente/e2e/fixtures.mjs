// Datos de prueba y servicios simulados para las pruebas de extremo a extremo: un jardín en Buin con estación,
// sensor de suelo e historial, visto el lunes 9 de noviembre de 2026 a las 10:00 (hora de Chile).

export const NOW = Date.parse('2026-11-09T10:00:00-03:00');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Fecha local de Chile (UTC−3 en noviembre) de un instante. */
const isoDate = (ms) => new Date(ms - 3 * HOUR).toISOString().slice(0, 10);
/** Fecha a `n` días de hoy. */
export const day = (n) => isoDate(NOW + n * DAY);
export const TODAY = day(0);

/** Lo que la app tiene guardado al abrirse (claves de Capacitor Preferences). */
export function seed() {
  const weather = (n, extra = {}) => ({
    date: day(n),
    et0Mm: 4.6 + (n % 3) * 0.4,
    precipitationMm: 0,
    precipitationProbMax: 5,
    tempMaxC: 27 + n,
    windMaxKmh: 14,
    ...extra,
  });
  const days = [
    weather(-2),
    weather(-1),
    weather(0),
    weather(1),
    weather(2, { precipitationMm: 6, precipitationProbMax: 75 }),
    weather(3),
    weather(4),
    weather(5),
    weather(6),
  ];
  const settings = {
    thresholdMm: 8,
    sprinklerRateMmMin: 0.6,
    lawnAreaM2: 24,
    latitude: -33.7316,
    longitude: -70.7665,
    useGps: false,
    locationSet: true,
    placeName: 'Buin, Región Metropolitana de Santiago',
    morningTime: '06:45',
    quietOkAlerts: true,
    dmc: { code: '330160', name: 'El Milagro', distanceKm: 4.2, latitude: -33.75, longitude: -70.72, elevationM: 480 },
    soilSensor: {
      region: 'us',
      accessId: 'demoaccessid',
      accessSecret: 'demosecret',
      deviceId: 'demodevice',
      wetPct: 100,
      dryPct: 52,
      enabled: false,
    },
  };
  const history = [];
  for (let n = -12; n < 0; n++) history.push({ date: day(n), etcMm: 3.4 + ((n + 20) % 4) * 0.3, effectiveRainMm: n === -9 ? 5.6 : 0 });
  // Estación: lecturas cada 10 min de las últimas 11 h, con 0,6 mm de lluvia esta mañana.
  const pts = [];
  for (let t = NOW - 11 * HOUR; t <= NOW - 30 * 60_000; t += 10 * 60_000)
    pts.push([t, t > NOW - 3 * HOUR && t < NOW - 2 * HOUR ? 0.4 : t >= NOW - 2 * HOUR ? 0.6 : 0]);
  // Sensor: 49 % antes del riego del lunes pasado, 100 % toda la semana y 92 % hoy.
  const reports = [-170, -168, -165, -150, -140, -128, -120, -110, -98, -80, -60, -58, -40, -20, -1];
  const soil = [49, 49, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 92];
  return {
    settings,
    state: { deficitMm: 6.4, asOf: TODAY, source: 'manual', resetDate: day(-3), resetAt: NOW - 3 * DAY },
    history,
    irrigations: [-10, -6, -3].map((n) => ({
      date: day(n),
      at: new Date(NOW + n * DAY - 3 * HOUR).toISOString(),
      mm: 8,
      source: 'manual',
    })),
    rainOverrides: {},
    weatherCache: {
      fetchedAt: new Date(NOW - 10 * 60_000).toISOString(),
      lat: settings.latitude,
      lon: settings.longitude,
      modelDays: days,
      elevationM: 458,
    },
    dmcStore: {
      code: '330160',
      field: 'aguaCaida24Horas',
      kind: 'accumulated',
      attemptAt: NOW - 60_000,
      ok: true,
      pts,
      summaryAt: NOW - 60_000,
    },
    sensorHistory: reports.map((h, i) => ({ t: NOW + h * HOUR, soil: soil[i], tempC: 18 + (i % 5) * 3, battery: 100 })),
  };
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

/**
 * Escenarios de lluvia de los ensambles por día (0 = hoy): qué % de los 100 escenarios llueve y cuántos mm. Por
 * defecto, casi nada hoy y una lluvia probable pasado mañana (como el pronóstico sembrado).
 */
export const ENSEMBLE = { 0: [5, 6], 2: [80, 8] };

/** Respuesta del servicio de ensambles de Open-Meteo: un control y 99 miembros por día. */
function ensembleBody(spec) {
  const time = [0, 1, 2, 3, 4, 5, 6].map((n) => day(n));
  const daily = { time };
  for (let i = 0; i < 100; i++) {
    const key = i
      ? `precipitation_sum_member${String(i).padStart(2, '0')}_ecmwf_ifs025_ensemble`
      : 'precipitation_sum_ecmwf_ifs025_ensemble';
    daily[key] = time.map((_, n) => {
      const [wet, mm] = spec[n] ?? [0, 0];
      return i < wet ? mm : 0;
    });
  }
  return { daily };
}

/** Respuesta de SoilGrids: suelo franco arenoso (como cerca de Buin), o una celda urbana sin datos. */
function soilGridsBody(urban) {
  const values = {
    clay: [176, 178, 181],
    sand: [567, 563, 565],
    silt: [257, 259, 255],
    wv0033: [297, 300, 305],
    wv1500: [132, 132, 137],
  };
  const depths = [
    [0, 5],
    [5, 15],
    [15, 30],
  ];
  return {
    properties: {
      layers: Object.entries(values).map(([name, means]) => ({
        name,
        unit_measure: { d_factor: 10 },
        depths: depths.map(([top, bottom], i) => ({
          range: { top_depth: top, bottom_depth: bottom, unit_depth: 'cm' },
          values: { mean: urban ? null : means[i] },
        })),
      })),
    },
  };
}

/**
 * Ninguna prueba sale a internet: la nube de Tuya, GitHub, los ensambles de Open-Meteo y SoilGrids se simulan, y
 * cualquier otra consulta se corta (la app debe funcionar con lo que tiene guardado). `ensemble: null` simula que
 * el servicio de ensambles no responde.
 */
export async function mockNetwork(page, { ensemble = ENSEMBLE } = {}) {
  const json = (route, body) =>
    route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let soilQueries = 0;
  await page.route(/^https?:\/\/(?!localhost)/, (route) => {
    const request = route.request();
    const url = request.url();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (url.includes('ensemble-api.open-meteo.com')) return ensemble ? json(route, ensembleBody(ensemble)) : route.abort();
    // El punto del jardín es urbano (sin datos): la app prueba un vecino.
    if (url.includes('rest.isric.org')) return json(route, soilGridsBody(++soilQueries === 1));
    if (url.includes('tuyaus.com')) {
      if (url.includes('/token')) return json(route, { success: true, result: { access_token: 'TOKEN', expire_time: 7200 } });
      if (url.includes('/shadow/properties')) {
        return json(route, {
          success: true,
          result: {
            properties: [
              { code: 'humidity', value: 92, time: NOW - HOUR },
              { code: 'temp_current', value: 254, time: NOW - 20 * 60_000 },
              { code: 'battery_percentage', value: 100, time: NOW - HOUR },
            ],
          },
        });
      }
      if (url.includes('logs')) return json(route, { success: true, result: { has_more: false, logs: [] } });
      return json(route, {
        success: true,
        result: {
          name: 'SRW-PM01',
          online: true,
          update_time: Math.round((NOW - HOUR) / 1000),
          status: [
            { code: 'humidity', value: 92 },
            { code: 'temp_current', value: 254 },
            { code: 'battery_percentage', value: 100 },
          ],
        },
      });
    }
    if (url.includes('api.github.com'))
      return json(route, { target_commitish: 'dev', name: 'Riego Inteligente · build 1', body: 'build 1 · dev' });
    return route.abort();
  });
}
