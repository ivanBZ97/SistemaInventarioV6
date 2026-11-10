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

/** El worker en segundo plano (CapacitorKV existe solo ahí) tiene su propio `fetch`, más limitado que el del navegador. */
const inRunner = () => typeof (globalThis as { CapacitorKV?: unknown }).CapacitorKV !== 'undefined';

/**
 * Igual que `fetch`, pero rechaza con {@link TimeoutError} si la respuesta (encabezados) no llega en `timeoutMs`.
 * Si el entorno lo permite, además cancela la conexión. Siempre indica el método: el `fetch` del worker rechaza
 * una consulta con opciones pero sin `method`.
 */
export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  // El fetch del worker no entiende `signal`: allí el tiempo límite solo abandona la espera.
  const controller = typeof AbortController === 'function' && !inRunner() ? new AbortController() : null;
  const options: RequestInit = { ...init, method: init.method ?? 'GET', ...(controller ? { signal: controller.signal } : {}) };
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
      controller?.abort();
    }, timeoutMs);
    fetch(url, options)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
