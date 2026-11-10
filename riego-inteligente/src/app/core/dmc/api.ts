// Cliente de la Dirección Meteorológica de Chile (DMC): direcciones, credenciales y lectura tolerante de sus
// respuestas (datos recientes de una estación automática y resumen diario oficial).
//
// Servicio oficial documentado (usuario + token gratuitos del Portal de Servicios Climáticos):
//   https://climatologia.meteochile.gob.cl/application/servicios/getDatosRecientesEma/<código>?usuario=…&token=…
// Sin credenciales se intenta el antiguo acceso público (…/productos/datosRecientesEma/<código>), que en
// octubre de 2026 responde 404.
import { SLOW_TIMEOUT_MS, fetchWithTimeout } from '../http';
import type { DmcAuth, ISODate } from '../models';

export const BASE = 'https://climatologia.meteochile.gob.cl/application/productos';

export const SERVICES = 'https://climatologia.meteochile.gob.cl/application/servicios';

export const WIS2 = 'https://wischile.meteochile.gob.cl/oapi';

export const hasAuth = (auth?: DmcAuth): auth is DmcAuth => !!auth?.user?.trim() && !!auth?.token?.trim();

function authQuery(auth: DmcAuth): string {
  return `usuario=${encodeURIComponent(auth.user.trim())}&token=${encodeURIComponent(auth.token.trim())}`;
}

/** URL de los datos recientes de una estación: servicio con token si hay credenciales, si no el público. */
export function recentUrl(code: string, auth?: DmcAuth): string {
  return hasAuth(auth) ? `${SERVICES}/getDatosRecientesEma/${code}?${authQuery(auth)}` : `${BASE}/datosRecientesEma/${code}`;
}

/** Quita usuario y token de un texto (para mostrar o copiar diagnósticos sin filtrar credenciales). */
export function redact(text: string, auth?: DmcAuth): string {
  let out = text;
  for (const secret of [auth?.user, auth?.token]) {
    const v = secret?.trim();
    if (!v) continue;
    for (const form of new Set([v, encodeURIComponent(v)])) out = out.split(form).join('***');
  }
  return out;
}

export interface DmcSample {
  momento: string;
  [field: string]: unknown;
}

/** "0.2 mm", "12,5 °C", 3 → número (la DMC entrega los valores con su unidad). */
export function unitNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(v);
  return m ? parseFloat(m[0].replace(',', '.')) : null;
}

/** Los `momento` de la DMC vienen en UTC; se devuelve el instante como Date. */
export function parseMomento(momento: string): Date | null {
  const s = momento.trim().replace(' ', 'T');
  const d = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Extrae las muestras de la respuesta (`datosEstaciones.datos`, tolerando variantes del formato). */
export function parseDmcSamples(json: unknown): DmcSample[] {
  const out: DmcSample[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      if (node.length && node.every((x) => x && typeof x === 'object' && 'momento' in x)) {
        out.push(...(node as DmcSample[]));
        return;
      }
      node.forEach((x) => visit(x, depth + 1));
      return;
    }
    Object.values(node as Record<string, unknown>).forEach((v) => visit(v, depth + 1));
  };
  visit(json, 0);
  return out;
}

export interface RecentFetch {
  ok: boolean;
  status: number;
  samples: DmcSample[];
  error?: string;
  /** Inicio de la respuesta (sin credenciales) cuando no trae lecturas: ayuda a diagnosticar. */
  snippet?: string;
}

async function bodySnippet(res: { text?: () => Promise<string> }, auth?: DmcAuth): Promise<string | undefined> {
  try {
    const t = res.text ? await res.text() : '';
    return t ? redact(t.replace(/\s+/g, ' ').slice(0, 180), auth) : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchRecent(code: string, auth?: DmcAuth): Promise<RecentFetch> {
  try {
    const res = await fetchWithTimeout(recentUrl(code, auth), {}, SLOW_TIMEOUT_MS);
    if (!res.ok) return { ok: false, status: res.status, samples: [], snippet: await bodySnippet(res, auth) };
    const json = (await res.json()) as unknown;
    const samples = parseDmcSamples(json);
    const snippet = samples.length ? undefined : redact(JSON.stringify(json).slice(0, 180), auth);
    return { ok: true, status: res.status, samples, snippet };
  } catch (e) {
    return { ok: false, status: 0, samples: [], error: redact(e instanceof Error ? e.message : String(e), auth) };
  }
}

/** Lectura más nueva (cualquier dato) que entrega la DMC para una estación. */
export async function newestReading(code: string, auth?: DmcAuth): Promise<{ f: RecentFetch; newest: number | null }> {
  const f = await fetchRecent(code, auth);
  const ts = f.samples.map((s) => parseMomento(String(s.momento))?.getTime() ?? 0).filter((t) => t > 0);
  return { f, newest: ts.length ? Math.max(...ts) : null };
}

/** "24-10-2026", "24/10/2026" o "2026-10-24" → fecha ISO. */
export function parseDmcDate(s: unknown): ISODate | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  let m = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Lluvia diaria del resumen diario de la DMC: bloque `aguaCaidaDiaria` (fecha dd-mm-aaaa + valor en mm).
 * Tolera variantes (arreglo, objeto por fecha, hoy/ayer anidados). No usa `aguaCaidaDiariaEstacion`.
 */
export function parseDailySummary(json: unknown): Map<ISODate, number> {
  const out = new Map<ISODate, number>();
  const take = (fecha: unknown, valor: unknown) => {
    const d = parseDmcDate(fecha);
    const v = unitNumber(valor);
    if (d && v !== null && v >= 0) out.set(d, v);
  };
  const read = (block: unknown, depth: number): void => {
    if (depth > 3 || block === null || typeof block !== 'object') return;
    if (Array.isArray(block)) return block.forEach((b) => read(b, depth + 1));
    const o = block as Record<string, unknown>;
    if ('fecha' in o && ('valor' in o || 'value' in o)) return take(o['fecha'], o['valor'] ?? o['value']);
    for (const [k, v] of Object.entries(o)) {
      if (parseDmcDate(k))
        take(k, v && typeof v === 'object' ? ((v as Record<string, unknown>)['valor'] ?? (v as Record<string, unknown>)['value']) : v);
      else read(v, depth + 1);
    }
  };
  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'aguaCaidaDiaria') read(v, 0);
      else visit(v, depth + 1);
    }
  };
  visit(json, 0);
  return out;
}

/** Fragmento del resumen donde están los datos de lluvia (para el diagnóstico si no se pudo leer). */
function summarySnippet(json: unknown, auth?: DmcAuth): string {
  let found: unknown = null;
  const visit = (node: unknown, depth: number): void => {
    if (found || depth > 6 || node === null || typeof node !== 'object') return;
    if (!Array.isArray(node) && Object.keys(node).some((k) => k.startsWith('aguaCaida'))) {
      found = node;
      return;
    }
    Object.values(node).forEach((v) => visit(v, depth + 1));
  };
  visit(json, 0);
  return redact(JSON.stringify(found ?? json).slice(0, 420), auth);
}

export interface SummaryFetch {
  status: number;
  daily: Map<ISODate, number>;
  snippet?: string;
}

export async function fetchDailySummary(code: string, auth: DmcAuth): Promise<SummaryFetch> {
  try {
    const res = await fetchWithTimeout(`${SERVICES}/getEmaResumenDiario/${code}?${authQuery(auth)}`);
    if (!res.ok) return { status: res.status, daily: new Map() };
    const json = (await res.json()) as unknown;
    const daily = parseDailySummary(json);
    return { status: res.status, daily, snippet: daily.size ? undefined : summarySnippet(json, auth) };
  } catch {
    return { status: 0, daily: new Map() };
  }
}
