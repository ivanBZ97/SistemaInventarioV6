// Sensor de humedad de suelo Tuya / Smart Life leído desde la nube de Tuya (OpenAPI, iot.tuya.com): firma
// HMAC-SHA256, token y estado del dispositivo. Funciones sin dependencias de Angular: las usan la app y el worker.
import { fetchWithTimeout } from './http';
import { hex, hmacSha256, sha256, utf8 } from './sha256';
import type { SoilSensorConfig, TuyaRegion } from './models';

export const TUYA_REGIONS: Record<TuyaRegion, { label: string; url: string }> = {
  us: { label: 'América (oeste) · Chile', url: 'https://openapi.tuyaus.com' },
  ueaz: { label: 'América (este)', url: 'https://openapi-ueaz.tuyaus.com' },
  eu: { label: 'Europa central', url: 'https://openapi.tuyaeu.com' },
  weaz: { label: 'Europa occidental', url: 'https://openapi-weaz.tuyaeu.com' },
  cn: { label: 'China', url: 'https://openapi.tuyacn.com' },
  in: { label: 'India', url: 'https://openapi.tuyain.com' },
};

const EMPTY_BODY_SHA256 = hex(sha256(new Uint8Array()));

/**
 * Firma de la OpenAPI de Tuya: HMAC-SHA256 con el Access Secret de
 * client_id + [access_token] + t + nonce + (método \n SHA-256 del cuerpo \n encabezados firmados \n ruta?query).
 */
export function tuyaSign(o: {
  accessId: string;
  secret: string;
  t: string;
  nonce?: string;
  method: string;
  path: string;
  body?: string;
  accessToken?: string;
}): string {
  const bodyHash = o.body ? hex(sha256(utf8(o.body))) : EMPTY_BODY_SHA256;
  const stringToSign = `${o.method}\n${bodyHash}\n\n${o.path}`;
  const str = o.accessId + (o.accessToken ?? '') + o.t + (o.nonce ?? '') + stringToSign;
  return hex(hmacSha256(utf8(o.secret), utf8(str))).toUpperCase();
}

export class TuyaError extends Error {
  constructor(
    readonly code: number | string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** Código propio (no de Tuya): el dispositivo respondió, pero no trae un dato de humedad reconocible. */
export const NO_HUMIDITY = 'no-humidity';

/** Errores de Tuya en palabras simples (los más comunes al configurar). */
export function tuyaErrorText(e: unknown): string {
  if (e instanceof TuyaError) {
    if (e.code === NO_HUMIDITY) return e.message;
    const code = Number(e.code);
    if (code === 1004) return 'firma inválida: revisa el Access Secret';
    if (code === 1005 || code === 2009) return 'Access ID inválido o de otro centro de datos (revisa la región)';
    if (code === 1010 || code === 1011) return 'el token venció; vuelve a intentar';
    if (code === 1106 || code === 2017) return 'sin permiso para ese sensor: vincula tu cuenta de Smart Life al proyecto y revisa el ID';
    if (code === 28841105 || code === 28841002) return 'el proyecto no tiene autorizada la API "IoT Core" (o venció su periodo de prueba)';
    return `Tuya respondió: ${e.message}${e.code !== undefined ? ` (código ${e.code})` : ''}`;
  }
  return e instanceof Error ? `sin conexión con Tuya (${e.message})` : 'sin conexión con Tuya';
}

async function call(cfg: SoilSensorConfig, path: string, now: number, accessToken?: string): Promise<Record<string, unknown>> {
  const t = String(now);
  const sign = tuyaSign({ accessId: cfg.accessId.trim(), secret: cfg.accessSecret.trim(), t, method: 'GET', path, accessToken });
  const headers: Record<string, string> = { client_id: cfg.accessId.trim(), sign, t, sign_method: 'HMAC-SHA256' };
  if (accessToken) headers['access_token'] = accessToken;
  const res = await fetchWithTimeout(TUYA_REGIONS[cfg.region].url + path, { headers });
  if (!res.ok) throw new TuyaError(res.status, `HTTP ${res.status}`);
  const json = (await res.json()) as { success?: boolean; code?: number; msg?: string; result?: Record<string, unknown> };
  if (!json.success) throw new TuyaError(json.code, json.msg ?? 'error');
  return json.result ?? {};
}

export interface TuyaToken {
  accessToken: string;
  expiresAt: number;
}

export async function tuyaToken(cfg: SoilSensorConfig, now: number): Promise<TuyaToken> {
  const r = await call(cfg, '/v1.0/token?grant_type=1', now);
  const ttl = typeof r['expire_time'] === 'number' ? (r['expire_time']) : 7200;
  return { accessToken: String(r['access_token']), expiresAt: now + ttl * 1000 - 120_000 };
}

export interface SoilStatus {
  name: string;
  online: boolean;
  /** Último reporte del sensor (ms), o null si Tuya no lo informa. */
  updatedAt: number | null;
  soilPct: number | null;
  tempC: number | null;
  battery: number | null;
  /** Código de la humedad y de la temperatura en este modelo (para pedir su historial a Tuya). */
  soilCode: string | null;
  tempCode: string | null;
  /** Códigos que entrega el sensor (para el diagnóstico si cambia el modelo). */
  codes: string[];
}

interface TuyaDp { code?: string; value?: unknown; time?: unknown }

const SOIL_CODES = ['humidity', 'soil_humidity', 'soil_moisture', 'moisture', 'humidity_value', 'va_humidity'];
const TEMP_CODES = ['temp_current', 'soil_temp', 'temperature', 'temp_value', 'va_temperature'];

/** Algunos modelos informan la humedad en décimas (p. ej. 355 = 35,5 %) y la temperatura en décimas de °C. */
export const normSoil = (v: number) => (v > 100 ? v / 10 : v);
export const normTemp = (v: number) => (Math.abs(v) > 60 ? v / 10 : v);
const toMs = (v: unknown) => (typeof v === 'number' && v > 0 ? (v < 1e12 ? v * 1000 : v) : null);

/**
 * Lee el estado del sensor de suelo (los códigos varían algo entre modelos; se prueban los habituales).
 * `shadow`: propiedades de /v2.0/cloud/thing/{id}/shadow/properties, que traen la hora exacta en que el sensor
 * informó cada dato; si no están, se usa el estado y la `update_time` del dispositivo.
 */
export function parseSoilDevice(result: Record<string, unknown>, shadow?: TuyaDp[] | null): SoilStatus {
  const status = (shadow?.length ? shadow : Array.isArray(result['status']) ? result['status'] : []) as TuyaDp[];
  const find = (codes: string[]) => {
    for (const code of codes) {
      const dp = status.find((s) => s.code === code);
      if (typeof dp?.value === 'number' && Number.isFinite(dp.value)) return dp;
    }
    return null;
  };
  const num = (...codes: string[]) => (find(codes)?.value as number | undefined) ?? null;
  const soilDp = find(SOIL_CODES);
  // Último reporte del sensor: el dato más nuevo de cualquier código. Muchos sensores solo envían lo que cambió,
  // así que la humedad puede seguir igual (y con su hora vieja) mientras la temperatura se informa cada rato.
  const measured = new Set([...SOIL_CODES, ...TEMP_CODES, 'battery_percentage', 'battery', 'va_battery']);
  const times = status.filter((dp) => measured.has(String(dp.code))).map((dp) => toMs(dp.time)).filter((t): t is number => t !== null);
  const lastReport = times.length ? Math.max(...times) : null;
  const soil = soilDp ? (soilDp.value as number) : null;
  const tempDp = find(TEMP_CODES);
  const temp = tempDp ? (tempDp.value as number) : null;
  return {
    name: typeof result['name'] === 'string' ? (result['name']) : 'Sensor de suelo',
    online: result['online'] === true,
    updatedAt: lastReport ?? toMs(result['update_time']),
    soilPct: soil === null ? null : normSoil(soil),
    tempC: temp === null ? null : normTemp(temp),
    battery: num('battery_percentage', 'battery', 'va_battery'),
    soilCode: soilDp?.code ?? null,
    tempCode: tempDp?.code ?? null,
    codes: status.map((s) => String(s.code)),
  };
}

/** Estado del sensor. Reutiliza el token mientras no venza; si Tuya lo rechaza, pide uno nuevo una vez. */
export async function readTuyaSoil(cfg: SoilSensorConfig, now: number, token?: TuyaToken | null): Promise<{ status: SoilStatus; token: TuyaToken }> {
  let tk = token && token.expiresAt > now ? token : await tuyaToken(cfg, now);
  const device = `/v1.0/devices/${encodeURIComponent(cfg.deviceId.trim())}`;
  let result: Record<string, unknown>;
  try {
    result = await call(cfg, device, now, tk.accessToken);
  } catch (e) {
    const code = e instanceof TuyaError ? Number(e.code) : 0;
    if (tk === token && (code === 1010 || code === 1011)) {
      tk = await tuyaToken(cfg, now);
      result = await call(cfg, device, now, tk.accessToken);
    } else {
      throw e;
    }
  }
  // La hora exacta de cada dato (opcional: si el proyecto no tiene ese permiso, basta el estado del dispositivo).
  let shadow: TuyaDp[] | null = null;
  try {
    const r = await call(cfg, `/v2.0/cloud/thing/${encodeURIComponent(cfg.deviceId.trim())}/shadow/properties`, now, tk.accessToken);
    shadow = Array.isArray(r['properties']) ? (r['properties'] as TuyaDp[]) : null;
  } catch {
    shadow = null;
  }
  return { status: parseSoilDevice(result, shadow), token: tk };
}

interface TuyaLog { code?: string; value?: unknown; event_time?: unknown }

/**
 * Formas de pedir el historial de reportes (según el proyecto y el plan, Tuya acepta una u otra). Cada una arma
 * la ruta con los parámetros en orden alfabético (así los firma Tuya) y lee la página de respuesta.
 */
const LOG_VARIANTS: {
  id: string;
  url: (id: string, code: string, start: number, end: number, rowKey: string | null) => string;
  page: (r: Record<string, unknown>) => { logs: TuyaLog[]; next: string | null };
}[] = [
  {
    id: 'thing-report-logs',
    url: (id, code, start, end, row) =>
      `/v2.0/cloud/thing/${id}/report-logs?codes=${code}&end_time=${end}${row ? `&last_row_key=${encodeURIComponent(row)}` : ''}&size=20&start_time=${start}`,
    page: (r) => ({ logs: logsOf(r), next: r['has_more'] && typeof r['last_row_key'] === 'string' ? (r['last_row_key']) : null }),
  },
  {
    id: 'iot03-report-logs',
    url: (id, code, start, end, row) =>
      `/v1.0/iot-03/devices/${id}/report-logs?codes=${code}&end_time=${end}${row ? `&last_row_key=${encodeURIComponent(row)}` : ''}&size=20&start_time=${start}`,
    page: (r) => ({ logs: logsOf(r), next: r['has_more'] && typeof r['last_row_key'] === 'string' ? (r['last_row_key']) : null }),
  },
  {
    id: 'device-logs',
    url: (id, code, start, end, row) =>
      `/v1.0/devices/${id}/logs?codes=${code}&end_time=${end}&size=100${row ? `&start_row_key=${encodeURIComponent(row)}` : ''}&start_time=${start}&type=7`,
    page: (r) => ({ logs: logsOf(r), next: r['has_next'] && typeof r['next_row_key'] === 'string' ? (r['next_row_key']) : null }),
  },
];

const logsOf = (r: Record<string, unknown>) => (Array.isArray(r['logs']) ? (r['logs'] as TuyaLog[]) : []);

/** La forma que funcionó con este proyecto (se prueba primero la próxima vez). */
let workingVariant: string | null = null;

/**
 * Historial de reportes del sensor guardado en la nube de Tuya (~7 días): completa el historial del teléfono con
 * los reportes ocurridos mientras nadie consultaba. Un código por consulta, hasta `maxPages` páginas cada uno.
 */
export async function readTuyaReportLogs(
  cfg: SoilSensorConfig,
  token: TuyaToken,
  codes: string[],
  startMs: number,
  endMs: number,
  maxPages = 15,
): Promise<TuyaLog[]> {
  const id = encodeURIComponent(cfg.deviceId.trim());
  const now = Date.now();
  // Ni futuro (si el reloj del teléfono va adelantado) ni más atrás de lo que Tuya guarda.
  const end = Math.round(Math.min(endMs, now - 10_000));
  const start = Math.round(Math.max(startMs, now - 7 * 86_400_000 + 3_600_000, end - 7 * 86_400_000 + 3_600_000));
  if (start >= end) return [];
  const order = [...LOG_VARIANTS].sort((a, b) => Number(b.id === workingVariant) - Number(a.id === workingVariant));
  const failures: TuyaError[] = [];
  for (const v of order) {
    try {
      const out: TuyaLog[] = [];
      for (const code of codes) {
        let row: string | null = null;
        for (let page = 0; page < maxPages; page++) {
          const r = await call(cfg, v.url(id, encodeURIComponent(code), start, end, row), Date.now(), token.accessToken);
          const { logs, next } = v.page(r);
          out.push(...logs.map((l) => ({ ...l, code: l.code ?? code })));
          if (!next || !logs.length) break;
          row = next;
        }
      }
      workingVariant = v.id;
      return out;
    } catch (e) {
      if (!(e instanceof TuyaError)) throw e; // sin conexión: no tiene sentido probar otra forma
      failures.push(new TuyaError(e.code, `${v.id}: ${e.message} (${e.code})`));
    }
  }
  // Todas las formas fallaron: el detalle de cada una sirve para el diagnóstico.
  throw new TuyaError(failures.at(-1)?.code, failures.map((f) => f.message).join(' · '));
}
