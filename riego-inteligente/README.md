# 💧 Riego Inteligente (Android)

App Ionic + Angular + Capacitor que calcula el balance hídrico diario de un césped residencial
(ballica / festuca fina) con la ET0 FAO-56 de [Open-Meteo](https://open-meteo.com) (gratis, sin API key) y avisa
por notificación **cuándo** y **cuántos minutos** regar. Todo se guarda en el teléfono (SharedPreferences).

## Estructura

```
riego-inteligente/
├── capacitor.config.ts            # appId, config del Background Runner (cada ~15 min)
├── angular.json · tsconfig*.json · package.json
├── runner/
│   └── background.ts              # worker nativo (WorkManager) → runners/background.js (esbuild)
├── src/
│   ├── index.html · main.ts · global.scss     # tema claro/oscuro automático
│   └── app/
│       ├── app.component.ts · app.config.ts · app.routes.ts
│       ├── core/
│       │   ├── models.ts                      # tipos
│       │   ├── irrigation-core.ts             # ⭐ motor agronómico (funciones puras, testeadas)
│       │   ├── irrigation-engine.service.ts   # ⭐ IrrigationEngineService (estado + persistencia + acciones)
│       │   ├── open-meteo.ts                  # ⭐ cliente Open-Meteo (compartido app/worker)
│       │   ├── weather.service.ts             # caché de clima + GPS
│       │   ├── notification.service.ts        # ⭐ canales, botones de acción, programación exacta
│       │   ├── background.service.ts          # sincroniza estado con el worker
│       │   ├── soil-sensor.provider.ts        # SoilSensorProvider (Fase 2: Tuya Zigbee)
│       │   └── storage.service.ts
│       └── pages/
│           ├── dashboard/                     # ⭐ gauge, estado, acciones, resiembra, gráfico 7 días
│           └── settings/                      # umbral 6–12 mm, tasa del aspersor, ubicación, permisos
├── test/irrigation-core.test.mjs  # 10 tests del motor (npm test)
└── android/                       # proyecto nativo (manifest ya configurado)
```

## Reglas implementadas (`irrigation-core.ts`)

| Regla | Implementación |
|---|---|
| Kc | Primavera (sep–nov) 0.80 · Verano (dic–feb) 0.85 · Otoño (mar–may) 0.70 · Invierno (jun–ago) 0.55 |
| ETc | `ET0 × Kc` |
| Balance | `Déficit_hoy = max(0, Déficit_ayer + ETc_ayer − Lluvia_efectiva_ayer − Riego_ayer)`; lluvia efectiva = 80 % si > 2 mm, si no 0 |
| Umbral / minutos | `déficit ≥ 8 mm` (configurable 6–12) → `round(déficit / tasa)` min (tasa por defecto 0.6 mm/min) |
| Bloqueo lluvia | prob. máx ≥ 50 % **o** ≥ 4 mm ⇒ "Riego pausado por pronóstico de lluvia" |
| Viento | > 25 km/h ⇒ aviso "riega temprano" en la alerta |
| Sin riego nocturno | toda alerta de riego se fuerza a 06:30–08:30 (`clampToIrrigationWindow`) |
| Resiembra | 10 días; chequeo extra 13:00, si `tmax ≥ 20 °C` envía "🌱 Modo Resiembra: Rocía solo los parches…" |
| Humedad útil | 0 mm = 100 %, 12 mm = 20 % (lineal) |

El riego registrado ("Ya regué", "Registrar Riego Ahora") baja el déficit a 0 mm en el momento (por eso el
balance diario no lo vuelve a restar) y queda en el historial que alimenta el gráfico.

## Alertas con la app cerrada

1. **Alarma exacta** (`LocalNotifications`, `allowWhileIdle`): la app deja programada la alerta del día siguiente
   a las 06:30 con los botones **✅ Ya regué** / **⏳ Posponer a mañana** (también 13:00 en modo resiembra).
2. **Worker en segundo plano** (`@capacitor/background-runner`, WorkManager ~cada 15 min): baja el clima y
   reprograma esas mismas alertas (mismo id ⇒ se reemplazan) con el mismo motor, de modo que el contenido
   está fresco aunque no abras la app. Si el teléfono estuvo apagado y estamos dentro de 06:30–08:30 sin
   alerta programada para hoy, la emite al instante.

Limitaciones honestas: WorkManager no es exacto (por eso la alarma exacta es la vía principal) y algunos
fabricantes matan procesos en segundo plano: excluye la app del ahorro de batería
(<https://dontkillmyapp.com>). El worker no puede cancelar alertas, así que en días sin riego programa un
mensaje "✅ Hoy no hace falta regar" que sobrescribe cualquier alerta obsoleta. Los botones de acción en
notificaciones creadas por el worker dependen de que el tipo de acción esté registrado (la app lo registra
al abrirse); si no aparecieran, el toque abre el Dashboard, que tiene las mismas acciones.

## Comandos paso a paso

Requisitos: Node 20+/22, JDK 21 y Android SDK (Android Studio o `cmdline-tools`, `ANDROID_HOME` definido).

```bash
cd riego-inteligente
npm install

npm test                         # tests del motor agronómico
npm run build                    # bundle del worker (runner/dist) + build Angular → www/
npx cap sync android             # copia www/ y plugins al proyecto Android

# Solo si regeneras el proyecto nativo desde cero (npx cap add android), vuelve a aplicar:
#  - permisos del AndroidManifest (ver abajo)
#  - en android/app/build.gradle, dentro de repositories { flatDir { ... } }:
#      dirs '../../node_modules/@capacitor/background-runner/android/src/main/libs', 'libs'

cd android && ./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Atajo: `npm run apk:debug`. Para depurar en un dispositivo: `npx cap run android`. Para ver la UI en el navegador:
`npm start` (las notificaciones/worker solo funcionan en Android).

### Permisos (`android/app/src/main/AndroidManifest.xml`, ya incluidos)

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.VIBRATE" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
```

En el primer arranque la app pide el permiso de notificaciones; en **Ajustes → Alarmas exactas** abre la pantalla
del sistema para permitir "Alarmas y recordatorios" (Android 12+).

## Fase 2: sensor de suelo

`SoilSensorProvider` (`core/soil-sensor.provider.ts`) define `isAvailable()` y `read(): SoilReading | null`
(humedad útil 0–100 %). Si devuelve una lectura de menos de 3 h, `IrrigationEngineService` sobrescribe el déficit
teórico. `TuyaZigbeeSoilSensorProvider` es el esqueleto: impleméntalo y regístralo en `app.config.ts`
(`{ provide: SOIL_SENSOR_PROVIDER, useClass: TuyaZigbeeSoilSensorProvider }`).
