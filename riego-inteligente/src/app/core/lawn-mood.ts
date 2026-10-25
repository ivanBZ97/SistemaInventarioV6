// Estado de ánimo del "pasto mascota" del Dashboard. Funciones puras (testeadas).
import type { Evaluation, IrrigationStatus } from './models';

export type Mood = 'happy' | 'content' | 'thirsty' | 'wilted';
export type Scene = 'sun' | 'rain' | 'wind' | 'cloud';

/** humedad útil (0–100) + decisión de riego → ánimo. */
export function lawnMood(humidityPct: number, status: IrrigationStatus): Mood {
  if (humidityPct < 35) return 'wilted';
  if (status === 'irrigate' || humidityPct < 55) return 'thirsty';
  return humidityPct >= 80 ? 'happy' : 'content';
}

/** Clima que se dibuja detrás del pasto: lluvia (medida o pronosticada) > viento > nublado (frío) > sol. */
export function lawnScene(
  ev: Pick<Evaluation, 'rainProbPct' | 'rainForecastMm' | 'windWarning' | 'tempMaxC'> & Partial<Pick<Evaluation, 'rainingNow'>>,
): Scene {
  if (ev.rainingNow || ev.rainProbPct >= 50 || ev.rainForecastMm >= 1) return 'rain';
  if (ev.windWarning) return 'wind';
  return ev.tempMaxC < 14 ? 'cloud' : 'sun';
}

/** Frases que dice el pasto al tocarlo (rotan en cada toque). */
export function lawnMessages(
  mood: Mood,
  scene: Scene,
  ev:
    | (Pick<Evaluation, 'minutes' | 'rainForecastMm' | 'windMaxKmh'> &
        Partial<Pick<Evaluation, 'rainMeasuredMm' | 'rainingNow'>> & { status?: IrrigationStatus })
    | null,
): string[] {
  const base: Record<Mood, string[]> = {
    happy: ['¡Estoy feliz! 😄 Tengo toda el agua que necesito.', 'Hoy no me riegues, ¡estoy hidratado! 💚', 'Mis raíces están contentas 🌱'],
    content: ['Estoy bien 🙂 Todavía me queda reserva.', 'Aguanto unos días más sin riego 👍', 'Vigilo mi humedad por ti 🔍'],
    thirsty:
      ev?.status === 'ok'
        ? ['Me estoy secando 🌤️ Pronto me tocará riego.', 'Todavía aguanto, pero no por mucho 💧', 'Mira "Próximo riego" para saber cuándo 📅']
        : ev?.status === 'paused_rain'
          ? ['Tengo algo de sed, pero la lluvia me va a ayudar 🌧️', 'Mejor espera la lluvia antes de regar ☔', 'Gracias por cuidarme 💧']
          : [`Tengo sed 🥵 ¿Me das ${ev?.minutes ?? '?'} min de riego?`, 'Riégame temprano, entre 06:30 y 08:30 🌅', 'Gracias por cuidarme 💧'],
    wilted: ['Estoy muy seco… 😞 ¡Necesito agua pronto!', 'Mis hojas se están poniendo tristes 🥀', 'Un buen riego y me recupero 💪'],
  };
  const extra: string[] = [];
  const fell = ev?.rainMeasuredMm ?? 0;
  if (ev?.rainingNow) extra.push('🌧️ ¡Está lloviendo en el sector! Me estoy dando un buen trago.');
  else if (fell >= 1) extra.push(`💧 Hoy ya me cayeron ${fell.toLocaleString('es-CL', { maximumFractionDigits: 1 })} mm de lluvia.`);
  if (scene === 'rain' && !ev?.rainingNow) extra.push(`🌧️ ¡Viene lluvia (${(ev?.rainForecastMm ?? 0).toLocaleString('es-CL', { maximumFractionDigits: 1 })} mm)! Yo me encargo de beberla.`);
  if (scene === 'wind') extra.push(`💨 Hay viento de ${Math.round(ev?.windMaxKmh ?? 0)} km/h: riega temprano.`);
  return [...base[mood], ...extra];
}
