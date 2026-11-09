// `fetch` con tiempo límite. Sin él, una red que acepta la conexión pero no responde (portal cautivo, señal muy
// débil) deja la consulta colgada para siempre, y con ella todo lo que espera su resultado. Sirve en la app y en
// el worker en segundo plano.

/** Consultas livianas (pronóstico, sensor, búsquedas). */
export const TIMEOUT_MS = 15_000;
/** Lecturas de una estación de la DMC: cada respuesta pesa ~0,5 MB. */
export const SLOW_TIMEOUT_MS = 30_000;

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`sin respuesta en ${Math.round(ms / 1000)} s`);
    this.name = 'TimeoutError';
  }
}

/**
 * Igual que `fetch`, pero rechaza con {@link TimeoutError} si la respuesta (encabezados) no llega en `timeoutMs`.
 * Si el entorno lo permite, además cancela la conexión.
 */
export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
      controller?.abort();
    }, timeoutMs);
    fetch(url, controller ? { ...init, signal: controller.signal } : init)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
