// Evapotranspiración de referencia diaria, FAO-56 Penman-Monteith (Allen et al., 1998, cap. 3 y 4).
// Funciones puras: las usan la app y el worker en segundo plano.

/** Presión de vapor de saturación e°(T) en kPa (FAO-56 ec. 11). */
export function satVapourPressure(tC: number): number {
  return 0.6108 * Math.exp((17.27 * tC) / (tC + 237.3));
}

/** Día del año (1–366) de una fecha YYYY-MM-DD. */
export function dayOfYear(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86_400_000);
}

/** Factor para llevar el viento medido a 10 m a la altura estándar de 2 m (FAO-56 ec. 47). */
export const WIND_10M_TO_2M = 4.87 / Math.log(67.8 * 10 - 5.42);

export interface DailyMet {
  tmaxC: number;
  tminC: number;
  /** Presión de vapor real media del día (kPa). */
  eaKpa: number;
  /** Radiación solar global del día (MJ/m²/día). */
  rsMJ: number;
  /** Viento medio a 2 m (m/s). */
  u2: number;
}

/**
 * ET0 diaria (mm/día) por FAO-56 Penman-Monteith, con G = 0 (paso diario).
 * Validada contra el Ejemplo 18 de FAO-56 (Bruselas, 6 de julio → 3,9 mm/día).
 */
export function et0PenmanMonteith(m: DailyMet, latitudeDeg: number, elevationM: number, date: string): number {
  const { tmaxC, tminC, eaKpa, u2 } = m;
  const tmean = (tmaxC + tminC) / 2;
  const es = (satVapourPressure(tmaxC) + satVapourPressure(tminC)) / 2;
  const delta = (4098 * satVapourPressure(tmean)) / (tmean + 237.3) ** 2;
  const pressure = 101.3 * ((293 - 0.0065 * elevationM) / 293) ** 5.26;
  const gamma = 0.000665 * pressure;

  // Radiación extraterrestre Ra (ec. 21–25) y de cielo despejado Rso (ec. 37)
  const j = dayOfYear(date);
  const phi = (latitudeDeg * Math.PI) / 180;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * j) / 365);
  const decl = 0.409 * Math.sin((2 * Math.PI * j) / 365 - 1.39);
  const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(decl))));
  const ra = ((24 * 60) / Math.PI) * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.sin(ws));
  const rso = (0.75 + 2e-5 * elevationM) * ra;

  // Radiación neta (ec. 38–40): la medida no puede superar la de cielo despejado
  const rs = Math.min(Math.max(0, m.rsMJ), rso);
  const rns = 0.77 * rs;
  const relRs = rso > 0 ? Math.min(1, Math.max(0.3, rs / rso)) : 0.5;
  const sigmaT4 = 4.903e-9 * (((tmaxC + 273.16) ** 4 + (tminC + 273.16) ** 4) / 2);
  const rnl = sigmaT4 * (0.34 - 0.14 * Math.sqrt(Math.max(0, eaKpa))) * (1.35 * relRs - 0.35);
  const rn = rns - rnl;

  const et0 =
    (0.408 * delta * rn + gamma * (900 / (tmean + 273)) * u2 * (es - eaKpa)) /
    (delta + gamma * (1 + 0.34 * u2));
  return Math.max(0, et0);
}
