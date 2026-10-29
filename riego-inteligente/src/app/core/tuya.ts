// Sensor de humedad de suelo Tuya / Smart Life leído desde la nube de Tuya (OpenAPI, iot.tuya.com): firma
// HMAC-SHA256, token y estado del dispositivo. Funciones sin dependencias de Angular: las usan la app y el worker.
import { hex, hmacSha256, sha256, utf8 } from './sha256';
import { clamp } from './irrigation-core';
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

/** Errores de Tuya en palabras simples (los más comunes al configurar). */
export function tuyaErrorText(e: unknown): string {
  if (e instanceof TuyaError) {
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
  const res = await fetch(TUYA_REGIONS[cfg.region]?.url + path, { headers });
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
  const ttl = typeof r['expire_time'] === 'number' ? (r['expire_time'] as number) : 7200;
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
  /** Códigos que entrega el sensor (para el diagnóstico si cambia el modelo). */
  codes: string[];
}

/** Lee el estado del sensor de suelo (los códigos varían algo entre modelos; se prueban los habituales). */
export function parseSoilDevice(result: Record<string, unknown>): SoilStatus {
  const status = (Array.isArray(result['status']) ? result['status'] : []) as { code?: string; value?: unknown }[];
  const num = (...codes: string[]) => {
    for (const code of codes) {
      const v = status.find((s) => s.code === code)?.value;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  };
  const soil = num('humidity', 'soil_humidity', 'soil_moisture', 'moisture', 'humidity_value', 'va_humidity');
  const temp = num('temp_current', 'soil_temp', 'temperature', 'temp_value', 'va_temperature');
  const upd = typeof result['update_time'] === 'number' ? (result['update_time'] as number) : null;
  return {
    name: typeof result['name'] === 'string' ? (result['name'] as string) : 'Sensor de suelo',
    online: result['online'] === true,
    updatedAt: upd === null ? null : upd < 1e12 ? upd * 1000 : upd,
    // Algunos modelos informan la humedad en décimas (p. ej. 355 = 35,5 %) y la temperatura en décimas de °C.
    soilPct: soil === null ? null : soil > 100 ? soil / 10 : soil,
    tempC: temp === null ? null : Math.abs(temp) > 60 ? temp / 10 : temp,
    battery: num('battery_percentage', 'battery', 'va_battery'),
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
  return { status: parseSoilDevice(result), token: tk };
}

/**
 * Lectura del sensor (% de humedad del suelo) → déficit (mm) con la calibración de tu jardín: el % con el suelo
 * recién regado a fondo es déficit 0 y el % cuando toca regar es el umbral; en medio, proporcional.
 * null si falta calibrar (o los dos puntos están demasiado juntos para distinguir).
 */
export function deficitFromSensor(soilPct: number, cfg: Pick<SoilSensorConfig, 'wetPct' | 'dryPct'>, thresholdMm: number): number | null {
  const { wetPct, dryPct } = cfg;
  if (wetPct === undefined || dryPct === undefined || wetPct - dryPct < 3) return null;
  return Math.round(clamp((thresholdMm * (wetPct - soilPct)) / (wetPct - dryPct), 0, 25) * 10) / 10;
}

/** Un reporte del sensor de más de 6 h ya no describe el suelo de ahora. */
export const SENSOR_MAX_AGE_MS = 6 * 3_600_000;
