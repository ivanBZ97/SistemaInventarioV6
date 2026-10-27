import { Injectable, computed, inject, signal } from '@angular/core';
import { StorageService } from './storage.service';
import { RELEASE_API, type ReleaseInfo, parseRelease, updateAvailable } from './update';

const CHECK_EVERY_MS = 12 * 3_600_000;
const RETRY_AFTER_FAILURE_MS = 3_600_000;

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

  /** Una sola consulta a la vez (la app y Ajustes pueden pedirla juntas). */
  check(force = false): Promise<void> {
    this.inflight ??= this.run(force).finally(() => (this.inflight = null));
    return this.inflight;
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
      const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const release = parseRelease(await res.json());
      this.release.set(release);
      this.checked.set({ at, ok: true });
      await this.storage.set<UpdateCache>('updateCheck', { at, ok: true, release });
    } catch {
      // Sin red o límite de GitHub: se conserva lo último sabido y se reintenta en 1 h.
      this.release.set(cache?.release ?? null);
      this.checked.set({ at, ok: false });
      await this.storage.set<UpdateCache>('updateCheck', { at, ok: false, release: cache?.release ?? null });
    }
  }
}
