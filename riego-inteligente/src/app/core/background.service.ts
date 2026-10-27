import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { BackgroundRunner } from '@capacitor/background-runner';
import { IrrigationEngineService } from './irrigation-engine.service';
import type { RunnerStatus } from './models';

const RUNNER = { label: 'cl.riego.inteligente.check', event: 'syncState' };

/**
 * Worker en segundo plano (WorkManager vía @capacitor/background-runner).
 * La app le entrega una copia del estado y ajustes; el worker (runner/background.ts) cada ~15 min
 * baja el clima, recalcula con el MISMO motor y reprograma el aviso matutino y el de las 13:00,
 * por lo que funcionan con la app cerrada.
 */
@Injectable({ providedIn: 'root' })
export class BackgroundService {
  private engine = inject(IrrigationEngineService);

  /** Cómo le fue a la última revisión en segundo plano (null fuera del teléfono). */
  async status(): Promise<RunnerStatus | null> {
    if (!Capacitor.isNativePlatform()) return null;
    try {
      return await BackgroundRunner.dispatchEvent<RunnerStatus>({ label: RUNNER.label, event: 'getStatus', details: {} });
    } catch (e) {
      return { lastRunAt: null, ok: false, error: `el worker no respondió (${e instanceof Error ? e.message : e})` };
    }
  }

  async sync(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try {
      const details = await this.engine.exportForRunner();
      await BackgroundRunner.dispatchEvent({ label: RUNNER.label, event: RUNNER.event, details });
    } catch (e) {
      console.warn('No se pudo sincronizar con el worker en segundo plano', e);
    }
  }
}
