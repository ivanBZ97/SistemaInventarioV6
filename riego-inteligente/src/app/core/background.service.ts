import { Injectable, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { BackgroundRunner } from '@capacitor/background-runner';
import { IrrigationEngineService } from './irrigation-engine.service';

const RUNNER = { label: 'cl.riego.inteligente.check', event: 'syncState' };

/**
 * Worker en segundo plano (WorkManager vía @capacitor/background-runner).
 * La app le entrega una copia del estado y ajustes; el worker (runner/background.ts) cada ~15 min
 * baja el clima, recalcula con el MISMO motor y reprograma las alertas de 06:30 / 13:00,
 * por lo que funcionan con la app cerrada.
 */
@Injectable({ providedIn: 'root' })
export class BackgroundService {
  private engine = inject(IrrigationEngineService);

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
