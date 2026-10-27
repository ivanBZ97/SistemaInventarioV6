import { Injectable, computed, inject, signal } from '@angular/core';
import { StorageService } from './storage.service';
import { RELEASE_API, type ReleaseInfo, parseRelease, updateAvailable } from './update';

const CHECK_EVERY_MS = 12 * 3_600_000;

/** Revisa en GitHub si hay un APK más nuevo (como máximo cada 12 h). */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private storage = inject(StorageService);

  readonly release = signal<ReleaseInfo | null>(null);
  readonly available = computed(() => updateAvailable(this.release()));
  /** null: aún no se revisa; si no, cuándo fue la última revisión y si resultó. */
  readonly checked = signal<{ at: number; ok: boolean } | null>(null);

  async check(force = false): Promise<void> {
    const cache = await this.storage.get<{ at: number; release: ReleaseInfo | null } | null>('updateCheck', null);
    if (!force && cache && Date.now() - cache.at < CHECK_EVERY_MS) {
      this.release.set(cache.release);
      this.checked.set({ at: cache.at, ok: true });
      return;
    }
    try {
      const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const release = parseRelease(await res.json());
      const at = Date.now();
      this.release.set(release);
      this.checked.set({ at, ok: true });
      await this.storage.set('updateCheck', { at, release });
    } catch {
      if (cache) this.release.set(cache.release);
      this.checked.set({ at: Date.now(), ok: false });
    }
  }
}
