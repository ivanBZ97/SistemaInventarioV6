// Diagnóstico de una estación ("Probar" en Ajustes): explica en texto qué entregó la DMC.
import { fetchWithTimeout } from '../http';
import { ageText, clock, dayMonthClock as hhmm, decimal } from '../format';
import type { DmcAuth, ISODate } from '../models';
import { BASE, type RecentFetch, WIS2, hasAuth, newestReading, parseMomento, redact, unitNumber } from './api';
import { STALE_STATION_MS } from './constants';
import { liveRainFromStore } from './live';
import { WIND_TO_MS, detectMetFields, et0Correction, stationEt0 } from './met';
import { rainPoints, totalRain } from './rain';
import type { StationMeta } from './stations';
import { type DmcStore, observedFromStore, refreshDmcStore } from './store';

const fmtMm = (v: number) => `${decimal(v)} mm`;

/** Prueba un recurso y resume qué devolvió (estado, claves y el inicio del contenido, sin credenciales). */
async function probe(url: string, auth?: DmcAuth, describe?: (json: unknown) => string): Promise<string> {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return `HTTP ${res.status}`;
    const json = (await res.json()) as unknown;
    if (describe) return redact(`OK · ${describe(json)}`, auth);
    const keys = json && typeof json === 'object' ? Object.keys(json).slice(0, 8).join(', ') : typeof json;
    return redact(`OK · claves: ${keys} · ${JSON.stringify(json).slice(0, 160)}`, auth);
  } catch (e) {
    return `sin respuesta (${redact(e instanceof Error ? e.message : String(e), auth)})`;
  }
}

const wis2Collections = (json: unknown): string => {
  const cols = (json as { collections?: { id?: string }[] })?.collections ?? [];
  return `${cols.length} colecciones: ${cols
    .slice(0, 8)
    .map((c) => c.id)
    .join(', ')}`;
};

/**
 * Prueba la estación y explica qué entregó: sirve para verificar contra agrometeorologia.cl y, si algo
 * cambió en la DMC, para saber qué ajustar. También agrega las lecturas al almacén.
 */
export async function diagnoseDmc(
  code: string,
  store: DmcStore | null,
  today: ISODate,
  now = Date.now(),
  auth?: DmcAuth,
  meta?: StationMeta,
  alternatives: { code: string; name: string; distanceKm: number }[] = [],
): Promise<{ ok: boolean; lines: string[]; store: DmcStore }> {
  const lines: string[] = [hasAuth(auth) ? 'Modo: servicio oficial con usuario y token.' : 'Modo: acceso público (sin token).'];
  const { store: next, fetched, rain, summary } = await refreshDmcStore(store, code, now, 0, true, auth);
  const f: RecentFetch = fetched ?? { ok: false, status: 0, samples: [], error: 'sin consulta' };
  if (!f.ok) {
    lines.push(`Datos recientes (${code}): ${f.status ? `HTTP ${f.status}` : `sin respuesta${f.error ? ` (${f.error})` : ''}`}.`);
    if (f.snippet) lines.push(`Respuesta: ${f.snippet}`);
  } else if (!f.samples.length) {
    lines.push(`Datos recientes (${code}): la respuesta no trae lecturas con "momento".`);
    if (f.snippet) lines.push(`Respuesta: ${f.snippet}`);
  } else if (!rain) {
    const keys = [...new Set(f.samples.slice(0, 5).flatMap((s) => Object.keys(s)))].slice(0, 14).join(', ');
    lines.push(`Datos recientes: ${f.samples.length} lecturas, pero sin campo de lluvia reconocible. Campos: ${keys}.`);
  } else {
    const pts = rainPoints(f.samples, rain);
    if (pts.length) {
      const kb = Math.round(JSON.stringify(f.samples).length / 1024);
      lines.push(
        `✓ Datos recientes: ${pts.length} lecturas (≈ ${kb} KB), de ${hhmm(pts[0][0])} a ${hhmm(pts[pts.length - 1][0])} · campo ${rain.field}.`,
      );
      lines.push(`Lluvia en ese periodo: ${fmtMm(totalRain(pts, rain.kind))}.`);
      const live = liveRainFromStore(next, code, today, now);
      if (live?.sinceMs != null) {
        lines.push(
          `Lluvia de hoy: ${fmtMm(live.mm)} desde las ${clock(live.sinceMs)} hasta las ${clock(live.lastAtMs)} ` +
            `(${Math.round((now - live.lastAtMs) / 60_000)} min de atraso)${live.rainingNow ? ' · está lloviendo' : ''}.`,
        );
      }
    } else {
      lines.push(`Datos recientes: ${f.samples.length} lecturas, pero ninguna con valor de ${rain.field}.`);
    }
  }
  // ¿La DMC no recibe datos de esta estación? Se prueban las más cercanas para saber si el problema es solo de esta.
  const times = f.samples.map((s) => parseMomento(String(s.momento))?.getTime() ?? 0).filter((t) => t > 0);
  const newest = times.length ? Math.max(...times) : null;
  if (f.ok && (newest === null || now - newest > STALE_STATION_MS)) {
    lines.push(
      newest === null
        ? '⚠ La DMC no está entregando lecturas de esta estación.'
        : `⚠ La lectura más nueva es del ${hhmm(newest)} (hace ${ageText(now - newest)}): la DMC no está recibiendo datos de esta estación.`,
    );
    if (alternatives.length) {
      const parts = await Promise.all(
        alternatives.map(async (s) => {
          const r = await newestReading(s.code, auth);
          const label = `${s.name} (${Math.round(s.distanceKm)} km)`;
          if (!r.f.ok) return `${label}: ${r.f.status ? `HTTP ${r.f.status}` : 'sin respuesta'}`;
          return r.newest === null
            ? `${label}: sin lecturas`
            : `${label}: última lectura ${hhmm(r.newest)} (hace ${ageText(now - r.newest)})`;
        }),
      );
      lines.push(`Otras estaciones DMC cercanas · ${parts.join(' · ')}.`);
    }
  }
  const days = observedFromStore(next, code, today);
  lines.push(
    days.size
      ? `Lluvia medida que usará la app: ${[...days]
          .sort()
          .map(([d, mm]) => `${d.slice(8)}/${d.slice(5, 7)} ${fmtMm(mm)}`)
          .join(' · ')}.`
      : 'Aún no hay días completos guardados: se completan solos con el uso (cada consulta trae ~12 h).',
  );
  // ET0 con los datos de la estación
  if (f.ok && f.samples.length) {
    const met = detectMetFields(f.samples);
    if (met.fields) {
      const mf = met.fields;
      const last = [...f.samples].reverse().find((s) => unitNumber(s[mf.temp]) !== null);
      const lastAt = last ? parseMomento(String(last.momento)) : null;
      const n = (k: string) => (last ? unitNumber(last[k]) : null);
      const c = (v: number | null) => (v === null ? '?' : String(v).replace('.', ','));
      const wind = n(mf.wind);
      lines.push(
        `ET0 · campos: ${mf.temp}, ${mf.rh}, ${mf.rad}, ${mf.wind} (${mf.windUnit}${mf.windUnitAssumed ? ', supuesto' : ''}).` +
          (last
            ? ` Última lectura${lastAt ? ` (${hhmm(lastAt.getTime())})` : ''}: ${c(n(mf.temp))} °C · ${c(n(mf.rh))} % HR · ${c(n(mf.rad))} W/m² · viento ${wind === null ? '?' : c(Math.round(wind * WIND_TO_MS[mf.windUnit] * 10) / 10)} m/s.`
            : ''),
      );
      // Campos presentes pero vacíos: la estación no está midiendo eso (sensor caído); la ET0 sale del pronóstico.
      const empty = (
        [
          [mf.temp, 'temperatura'],
          [mf.rh, 'humedad'],
          [mf.rad, 'radiación'],
          [mf.wind, 'viento'],
        ] as const
      ).filter(([k]) => !f.samples.some((s) => unitNumber(s[k]) !== null));
      if (empty.length) {
        const raw = JSON.stringify(f.samples[f.samples.length - 1]?.[empty[0][0]] ?? null).slice(0, 20);
        lines.push(
          `⚠ ET0 · ninguna de las ${f.samples.length} lecturas trae ${empty.map(([, name]) => name).join(', ')} (llega ${raw}): ` +
            'la estación no lo está midiendo, así que por ahora la ET0 sale del pronóstico.',
        );
      }
    } else {
      lines.push(`ET0 · faltan campos: ${met.missing.join(', ')}. Disponibles: ${met.keys.slice(0, 16).join(', ')}.`);
    }
  }
  if (meta && next.met?.length) {
    const st = stationEt0(next.met, meta, today);
    const pairs = next.et0Pairs ?? {};
    lines.push(
      st.size
        ? `✓ ET0 medida: ${[...st]
            .sort()
            .map(([d, v]) => `${d.slice(8)}/${d.slice(5, 7)} ${fmtMm(v)}${pairs[d] ? ` (modelo ${fmtMm(pairs[d][1])})` : ''}`)
            .join(' · ')}.`
        : 'ET0 medida: aún no hay días completos (se necesitan ≥ 21 h de lecturas; se completan solos con el uso).',
    );
    const corr = et0Correction(pairs, today);
    if (corr) lines.push(`Pronóstico de ET0 corregido ×${String(corr.ratio).replace('.', ',')} según ${corr.days} días medidos.`);
  }
  if (summary) {
    lines.push(
      summary.daily.size
        ? `✓ Resumen diario oficial: ${[...summary.daily]
            .sort()
            .map(([d, mm]) => `${d.slice(8)}/${d.slice(5, 7)} ${fmtMm(mm)}`)
            .join(' · ')}.`
        : `Resumen diario: ${summary.status ? `HTTP ${summary.status}` : 'sin respuesta'}${summary.snippet ? ` · no reconocí la lluvia en: ${summary.snippet}` : ''}`,
    );
  } else {
    lines.push(`Detalles técnicos · Resumen diario (público): ${await probe(`${BASE}/emaResumenDiario/${code}`, auth)}`);
  }
  lines.push(`Detalles técnicos · WIS2 DMC (público): ${await probe(`${WIS2}/collections?f=json`, auth, wis2Collections)}`);
  return { ok: f.ok && !!rain, lines: lines.map((l) => redact(l, auth)), store: next };
}
