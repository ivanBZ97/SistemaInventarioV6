# 💧 Riego Inteligente (Android)

App Ionic + Angular + Capacitor que lleva el balance hídrico diario de un césped residencial (ballica / festuca)
y avisa por notificación **cuándo** y **cuántos minutos** regar. Usa el pronóstico de
[Open-Meteo](https://open-meteo.com) (gratis, sin clave) y, si se configuran, la lluvia y la evapotranspiración
medidas por una estación de la Dirección Meteorológica de Chile y un sensor de humedad de suelo Tuya / Smart Life.

No tiene servidor: todos los datos y claves quedan en el teléfono.

## Qué hace

- **Balance hídrico** con ET0 FAO-56 × Kc estacional, lluvia efectiva y riegos registrados.
- **Aviso de la mañana** (06:30–08:30, nunca de noche) con los minutos de riego, también con la app cerrada.
- **Lluvia medida casi en tiempo real** por la estación más cercana, con estación de respaldo si deja de publicar.
- **Sensor de suelo**: su lectura calibrada puede reemplazar al cálculo; se guarda un historial de un año.
- **Próximo riego** proyectado con el pronóstico, modo **Resiembra** y resumen de agua de los últimos 30 días.

## Arquitectura

```
riego-inteligente/
├── capacitor.config.ts         # appId y worker en segundo plano (cada ~15 min)
├── runner/background.ts        # worker nativo (WorkManager): mismo motor que la app, empaquetado con esbuild
├── src/app/
│   ├── core/                   # lógica sin interfaz
│   │   ├── models.ts                    # tipos del dominio
│   │   ├── irrigation-core.ts           # ⭐ motor agronómico: reglas puras (balance, decisión, avisos)
│   │   ├── dates.ts · format.ts · geo.ts · parse.ts · http.ts   # utilidades puras
│   │   ├── fao56.ts                     # ET0 Penman-Monteith
│   │   ├── open-meteo.ts · agromet.ts   # clientes de pronóstico e INIA
│   │   ├── dmc.ts + dmc/                # estaciones de la DMC (api, estaciones, lluvia, ET0, almacén, diagnóstico)
│   │   ├── tuya.ts · sha256.ts          # nube de Tuya (firma HMAC propia)
│   │   ├── soil-sensor.ts               # calibración del sensor y cuándo reemplaza al balance
│   │   ├── sensor-history.ts            # historial de mediciones
│   │   ├── runner-protocol.ts           # contrato app ↔ worker (eventos, claves, tipos)
│   │   ├── storage-keys.ts              # claves del almacenamiento local
│   │   └── *.service.ts                 # servicios Angular: motor, clima, avisos, worker, ubicación, sensor
│   ├── pages/
│   │   ├── dashboard/          # panel: dashboard.view.ts (textos y cifras, puro) + página
│   │   ├── settings/           # settings-form.ts (borrador) + una sección por componente
│   │   └── sensor/             # historial del sensor: sensor-chart.ts (geometría, pura) + página
│   └── ui/                     # pasto ilustrado, snackbar, estilos y helpers compartidos
├── test/                       # pruebas unitarias (node:test) de todo lo puro
├── e2e/                        # pruebas de extremo a extremo (Playwright) sobre la app compilada
└── android/                    # proyecto nativo
```

Principios:

- **Las reglas son funciones puras.** Lo que decide si se riega (`irrigation-core.ts`), lo que interpreta a la
  estación (`dmc/`) y al sensor (`soil-sensor.ts`), y los textos del panel (`dashboard.view.ts`) no dependen de
  Angular ni de Capacitor: se prueban solos y los comparte el worker en segundo plano.
- **Un solo dueño del estado.** `IrrigationEngineService` es la única clase que modifica el balance guardado, y
  ejecuta sus operaciones de a una (cada una lee, puede esperar a la red y escribe; en paralelo se pisarían).
- **La red puede fallar.** Toda consulta tiene tiempo límite (`http.ts`); sin conexión se usa lo último guardado
  y la interfaz lo dice. Las respuestas de servicios externos se leen de forma defensiva.
- **La app y el worker hablan por un contrato explícito** (`runner-protocol.ts`); cada uno tiene su almacén.

## Reglas implementadas (`irrigation-core.ts`)

| Regla                            | Implementación                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kc                               | Primavera (sep–nov) 0.80 · Verano (dic–feb) 0.85 · Otoño (mar–may) 0.70 · Invierno (jun–ago) 0.55                                                                                                                                                                                                                                                                                                                                                                                                       |
| ETc                              | `ET0 × Kc`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Balance                          | `Déficit_hoy = max(0, Déficit_ayer + ETc_ayer − Lluvia_efectiva_ayer − Riego_ayer)`; lluvia efectiva = 80 % si > 2 mm, si no 0                                                                                                                                                                                                                                                                                                                                                                          |
| Umbral / minutos                 | `déficit ≥ 8 mm` (configurable 6–12) → `round(déficit / tasa)` min (tasa por defecto 0.6 mm/min)                                                                                                                                                                                                                                                                                                                                                                                                        |
| Bloqueo lluvia                   | prob. máx ≥ 50 % **o** ≥ 4 mm pronosticados ⇒ "Riego pausado por pronóstico de lluvia"; con estación, ≥ 4 mm ya medidos hoy ⇒ "Riego pausado por lluvia", y ≥ 0,5 mm en la última hora ⇒ "Riego pausado: está lloviendo"                                                                                                                                                                                                                                                                                |
| Espera la lluvia de mañana       | si mañana la lluvia es muy probable (≥ 70 %) y abundante (mediana ≥ 5 mm), y tras sumar el consumo de hoy deja el déficit bajo la mitad del umbral, hoy no se riega ("🌧️ Hoy no riegues: mañana llueve"); solo si el déficit no pasa 3 mm sobre el umbral entretanto, y nunca con siembra de todo el jardín                                                                                                                                                                                             |
| Pronóstico con el pasto muy seco | si el déficit ya supera en más de 3 mm el umbral, un pronóstico de lluvia ya no pausa el riego (la lluvia medida o que está cayendo sí); así esperar una lluvia que no llega nunca seca el pasto de más                                                                                                                                                                                                                                                                                                 |
| Registrar riego                  | se indican los minutos regados (por defecto, los recomendados): repone minutos × tasa; si fue menos, queda déficit. Se puede deshacer                                                                                                                                                                                                                                                                                                                                                                   |
| Avisos sin sonido                | opción en Ajustes: el aviso de "Hoy no hace falta regar" llega por un canal silencioso                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Litros                           | con la superficie del pasto (Ajustes), 1 mm en 1 m² = 1 litro; resumen de los últimos 30 días en el panel                                                                                                                                                                                                                                                                                                                                                                                               |
| Lluvia de hoy (estación)         | lo medido hoy hasta la última lectura baja el déficit actual (80 % si > 2 mm; tras un riego o ajuste de hoy solo cuenta lo caído después); para mañana cuenta el máximo entre lo medido y lo pronosticado                                                                                                                                                                                                                                                                                               |
| Viento                           | > 25 km/h ⇒ aviso "riega temprano" en la alerta                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Sin riego nocturno               | toda alerta de riego se fuerza a 06:30–08:30 (`clampToIrrigationWindow`)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Resiembra                        | 10 días; al activarlo se elige dónde se sembró. **Todo el jardín:** se riega al llegar a 2 mm de déficit (riego corto casi a diario, "🌱 Riego de siembra") y a las 13:00, si `tmax ≥ 20 °C`, un riego corto de todo el jardín. **Por sectores:** el pasto sigue su umbral, el aviso de la mañana recuerda rociar lo sembrado y a las 13:00 (`tmax ≥ 20 °C`) envía "🌱 Modo Resiembra: Rocía solo los parches…". Si la estación ya midió lluvia hoy, el aviso de las 13:00 dice que no hace falta regar |
| Humedad útil                     | 0 mm = 100 %, 12 mm = 20 % (lineal)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

El riego registrado ("Ya regué", "Registrar riego") descuenta el déficit en el momento (por eso el balance diario
no lo vuelve a restar) y queda en el historial que alimenta el gráfico.

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

## Desarrollo

Requisitos: Node 22, JDK 21 y Android SDK (Android Studio o `cmdline-tools`, con `ANDROID_HOME` definido).

```bash
cd riego-inteligente
npm install

npm start                # la interfaz en el navegador (avisos y worker solo funcionan en Android)
npm run check            # formato + lint + tipos + pruebas (lo mismo que exige CI)
npm run e2e              # compila y recorre las tres pantallas en un navegador (Playwright)
npm run build            # worker (runner/dist) + Angular → www/
npm run apk:debug        # build + cap sync + gradle → android/app/build/outputs/apk/debug/app-debug.apk
```

| Comando                | Qué revisa                                                         |
| ---------------------- | ------------------------------------------------------------------ |
| `npm test`             | pruebas unitarias (`node:test`, empaquetadas con esbuild)          |
| `npm run lint`         | ESLint con reglas de tipos + angular-eslint (plantillas incluidas) |
| `npm run typecheck`    | `tsc` sobre la app, el worker y la configuración de Capacitor      |
| `npm run format:check` | Prettier (`npm run format` lo corrige)                             |

**Integración continua** (`.github/workflows/build-apk.yml`): cada push y cada pull request pasan por
`check` y por las pruebas de extremo a extremo (`e2e/`, con el reloj fijo y la red simulada). El APK de
depuración solo se compila y publica en el release `apk-latest` ("build N") si `check` pasa; ese release es el
que la app revisa para avisar de una versión nueva. Cada APK lleva N como `versionCode`.

El APK se firma con `android/app/debug.keystore`, que está en el repositorio a propósito (contraseña `android`,
alias `androiddebugkey`): así cada APK compilado en GitHub se instala encima del anterior y conserva los datos.
Para publicar en Play Store se usaría otra clave, privada.

Si se regenera el proyecto nativo (`npx cap add android`) hay que volver a aplicar: los permisos del manifiesto
(abajo), el `flatDir` del background-runner y los bloques `signingConfigs.debug` y `versionCode` de
`android/app/build.gradle`.

### Permisos (`android/app/src/main/AndroidManifest.xml`, ya incluidos)

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.VIBRATE" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```

En el primer arranque la app pide el permiso de notificaciones; en **Ajustes → Alarmas exactas** abre la pantalla
del sistema para permitir "Alarmas y recordatorios" (Android 12+).

## Ubicación

Primer arranque: la app pregunta dónde está el jardín (GPS aproximado ~1 km, GPS preciso ~10 m estando en el jardín, o búsqueda por ciudad con la API
de geocodificación de Open-Meteo). Muestra el nombre y la altitud en el Dashboard; con "Actualizar ubicación
automáticamente" la recalcula al volver a la app si te moviste más de 10 km (sin pedir permisos nuevos).

## Fuentes de clima

- **Open-Meteo multi-modelo:** pide ECMWF IFS, GFS e ICON en la misma consulta; promedia ET0, temperatura y
  viento, y usa la mediana para la lluvia (los modelos sin dato no cuentan). Si ningún modelo entrega probabilidad de lluvia, se
  estima como el % de modelos que pronostican ≥ 1 mm.
- **Lluvia observada sin clave (Dirección Meteorológica de Chile):** Ajustes → "Usar la estación más cercana"
  elige la estación automática (EMA) de la DMC más próxima (en Buin: El Milagro, código 330160) y lee el recurso
  JSON `…/datosRecientesEma/<código>` (últimas ~12 h, una lectura por minuto).
  La variante mensual (`…/<código>/<año>/<mes>`) hoy exige usuario y token (responde 404), por eso no se usa.
  Como cada consulta cubre ~12 h, las lecturas se guardan en un almacén local (app: Preferences `dmcStore`;
  worker: CapacitorKV) y con él se arman los días: `aguaCaida24Horas` es un acumulado que se
  reinicia a las 12:00 UTC, la lluvia diaria es la suma de incrementos y solo se usan días con ≥ 20 h cubiertas
  (sin contar huecos de más de 1 h). Tras un fallo se reintenta en 1 h (con la app abierta, en la siguiente consulta). "Probar" muestra un diagnóstico (estado
  HTTP, lecturas, campo de lluvia, lluvia de las últimas 24 h y días completos) que se puede copiar.
  Los días ya contabilizados con lluvia del modelo se corrigen solos cuando llega la medida.
  En octubre de 2026 todo `…/productos/…` responde 404: con **usuario y token** (registro gratuito en el portal;
  Ajustes → Lluvia observada) se usa el servicio oficial documentado
  `…/application/servicios/getDatosRecientesEma/<código>?usuario=…&token=…` (verificado en el teléfono: responde).
  Con token también se lee el resumen diario oficial (`getEmaResumenDiario`, bloque `aguaCaidaDiaria`: fecha +
  valor en mm), que completa los días que las lecturas no alcanzan a cubrir; las lecturas tienen prioridad. Las credenciales se guardan solo en el
  teléfono y el diagnóstico las oculta. "Probar" también informa el resumen diario oficial y el servicio público WIS2
  de la DMC (`wischile.meteochile.gob.cl/oapi`), para evaluar fuentes alternativas.
- **Estación de respaldo:** si la estación elegida lleva más de 3 h sin publicar, la app y el worker consultan también
  la siguiente más cercana dentro de 25 km (para El Milagro, Talagante) y usan su lluvia de hoy y los días cerrados
  que falten (también después de que la elegida vuelva). El sesgo del pronóstico de ET0 se sigue midiendo solo con la
  elegida. La tarjeta "Lluvia en tu sector" dice qué estación se está usando y por qué.
- **Elegir estación:** con usuario y token, "Conectar y ver estaciones" revisa las 6 estaciones DMC más cercanas
  (dentro de 40 km; la más cercana siempre) y muestra cuáles están al día (lectura de hace ≤ 90 min), atrasadas
  (≤ 24 h), sin datos o sin respuesta. Si aún no hay estación elegida, toma la más cercana al día; si la más
  cercana no publica, la siguiente que sí. Tocar una estación al día o atrasada la elige. Cada revisión trae las
  últimas ~12 h de cada estación. "Probar" avisa si la estación elegida lleva más de 3 h sin datos y revisa las
  dos siguientes más cercanas.
- **Lluvia de hoy casi en tiempo real:** la EMA publica una lectura por minuto con ~25 min de atraso. Con la app
  abierta se consulta cada 10 min (deslizar hacia abajo fuerza la consulta; cada consulta pesa ~0,5 MB) y la tarjeta "Lluvia en tu sector"
  muestra lo caído hoy hasta la última lectura ("hasta las 18:45"), la lluvia por hora y si está lloviendo
  (≥ 0,5 mm en la última hora, con una lectura de menos de 90 min). En segundo plano el worker consulta cada
  30 min si llueve, si se pronostica lluvia (≥ 1 mm o ≥ 30 %) o en la hora y media antes del aviso de la
  mañana; si no, cada 3 h. El resumen diario oficial se pide como máximo cada 3 h. "Probar" informa la lluvia
  de hoy, el atraso de la estación y el tamaño de cada consulta.
- **ET0 medida con la estación (FAO-56 Penman-Monteith):** con las lecturas por minuto de la EMA
  (`temperatura`, `humedadRelativa`, `radiacionGlobalInst`, `fuerzaDelVientoPromedio10Minutos` en nudos) se
  arman bloques de 10 min y, por día local con ≥ 21 h medidas, Tmáx/Tmín, presión de vapor real media (desde
  T y HR de cada bloque), radiación global (W/m² medio × 0,0864 = MJ/m²/día) y viento a 2 m (anemómetro a
  10 m × 0,748). La ET0 resultante reemplaza a la del modelo en los días pasados (y corrige los ya
  contabilizados). Para hoy y el pronóstico, la ET0 del modelo se multiplica por su sesgo reciente
  (Σ estación ÷ Σ modelo de los últimos 7 días, mín. 2 días, limitado a ±20 %). Validado contra el Ejemplo 18 de
  FAO-56 (3,9 mm/día). Latitud y altura: las de la estación (El Milagro: −33,754°, 460 m).
- **Lluvia observada (opcional, INIA Agromet):** con una clave personal de la API (`https://agromet.inia.cl/api/v2/`),
  Ajustes → "Buscar estación cercana" elige la estación más próxima que mida precipitación (la variable se
  busca por nombre, porque los IDs numéricos no son consistentes). Esa lluvia medida reemplaza a la del modelo
  en los días ya pasados, que es la que alimenta el balance. Si la estación falla, se usa el modelo.
  "Probar" muestra la lluvia por día que reporta la estación para contrastarla con la realidad.

Pendiente de validar con una clave real: formato exacto de `tiempo` (se asume hora local si no trae zona) y
la cadencia de las muestras. Se activa `CapacitorHttp` para evitar bloqueos CORS desde el WebView.

## Estado del sistema y actualizaciones

Ajustes → **Estado del sistema** muestra si el worker en segundo plano se está ejecutando (cada ejecución queda
registrada y la app la consulta con el evento `getStatus`), el próximo aviso, los permisos de notificaciones y
alarmas exactas, y la versión del APK. "Probar aviso" envía una notificación de prueba a los 5 s.

GitHub Actions escribe el commit y el número de build en `src/app/core/build-info.ts` y publica el release como
"build N". La app revisa ese release como máximo cada 12 h (1 h si falló) y, si hay uno más nuevo, muestra un aviso
con el enlace de descarga; el APK nuevo se instala encima porque usa la misma clave.

## Sensor de suelo (Tuya / Smart Life)

Ajustes → **Sensor de suelo** lee un sensor Tuya / Smart Life (WiFi o Zigbee) desde la nube de Tuya (OpenAPI,
`src/app/core/tuya.ts`): firma HMAC-SHA256 propia en JavaScript (`sha256.ts`, también en el worker), token
(`/v1.0/token`, se reutiliza mientras no vence) y estado del sensor (`/v1.0/devices/{id}`: `humidity`,
`temp_current`, `battery_percentage` y variantes). Requiere un proyecto gratuito en iot.tuya.com (Smart Home,
centro de datos de la cuenta; Chile = América oeste) con la API IoT Core y la cuenta de Smart Life vinculada.

Calibración en dos puntos: "Ahora está recién regado" (déficit 0) y "Ahora toca regar" (déficit = umbral); entre
ambos, proporcional. Con el sensor activado, una lectura de menos de 6 h y posterior al último riego/ajuste
reemplaza al déficit del balance (en la app cada 10 min como máximo y en el worker cada hora). Con un solo punto
marcado, el otro se estima a 30 puntos de distancia (calibración provisional). El panel muestra lo que marca el
sensor y si está en uso.

**Historial** (panel → etiqueta del sensor, o Ajustes → Ver historial): cada reporte queda guardado un año en el
teléfono. Se alimenta de las lecturas de la app, de las del worker (que la app recoge al abrirse) y, si el proyecto
de Tuya lo permite, de los reportes de los últimos 7 días que guarda su nube. Se ve por periodo (24 h, 7 y 30 días,
todo) en un gráfico en escalones con los niveles de calibración y los riegos, una tabla por día y copia en CSV.

## Privacidad y seguridad

- No hay servidor ni analítica: el estado, el historial y las claves (token de la DMC, clave de INIA, Access
  Secret de Tuya) se guardan solo en el almacenamiento privado de la app (Capacitor Preferences). Android puede
  incluirlo en la copia de seguridad de la cuenta de Google del teléfono (`allowBackup`).
- Las claves viajan únicamente al servicio al que pertenecen, por HTTPS. Los diagnósticos que se pueden copiar
  ocultan usuario y token (`redact`).
- El APK es de depuración y se instala fuera de Play Store: está pensado para uso personal.
