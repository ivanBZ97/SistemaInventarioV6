import { Injectable, computed, inject, signal } from '@angular/core';
import { StorageService } from './storage.service';
import { RELEASE_API, type ReleaseInfo, parseRelease, updateAvailable } from './update';

const CHECK_EVERY_MS = 12 * 3_600_000;
const RETRY_AFTER_FAILURE_MS = 3_600_000;
/** Una red mala (portal cautivo) puede dejar la consulta colgada: se abandona a los 10 s. */
const TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('tiempo agotado')), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

interface UpdateCache {
  at: number;
  ok?: boolean;
  release: ReleaseInfo | null;
}

/** Revisa en GitHub si hay un APK más nuevo (como máximo cada 12 h). */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private storage = inject(StorageService);

  readonly release = signal<ReleaseInfo | null>(null);
  readonly available = computed(() => updateAvailable(this.release()));
  /** null: aún no se revisa; si no, cuándo fue la última revisión y si resultó. */
  readonly checked = signal<{ at: number; ok: boolean } | null>(null);

  private inflight: Promise<void> | null = null;

  /**
   * Una sola consulta a la vez (la app y Ajustes pueden pedirla juntas); una forzada ("Actualizar") espera a la que
   * esté en curso y luego consulta de verdad. Nunca falla: ante cualquier error queda lo último sabido.
   */
  check(force = false): Promise<void> {
    if (this.inflight && !force) return this.inflight;
    const run: Promise<void> = (this.inflight ?? Promise.resolve())
      .then(() => this.run(force))
      .catch(() => undefined)
      .finally(() => {
        if (this.inflight === run) this.inflight = null;
      });
    this.inflight = run;
    return run;
  }

  private async run(force: boolean): Promise<void> {
    const cache = await this.storage.get<UpdateCache | null>('updateCheck', null);
    const wait = cache?.ok === false ? RETRY_AFTER_FAILURE_MS : CHECK_EVERY_MS;
    if (!force && cache && Date.now() - cache.at < wait) {
      this.release.set(cache.release);
      this.checked.set({ at: cache.at, ok: cache.ok !== false });
      return;
    }
    const at = Date.now();
    try {
      const res = await withTimeout(fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } }), TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const release = parseRelease(await withTimeout(res.json(), TIMEOUT_MS));
      this.release.set(release);
      this.checked.set({ at, ok: true });
      await this.storage.set<UpdateCache>('updateCheck', { at, ok: true, release });
    } catch {
      // Sin red o límite de GitHub: se conserva lo último sabido y se reintenta en 1 h.
      this.release.set(cache?.release ?? null);
      this.checked.set({ at, ok: false });
      await this.storage.set<UpdateCache>('updateCheck', { at, ok: false, release: cache?.release ?? null }).catch(() => undefined);
    }
  }
}
