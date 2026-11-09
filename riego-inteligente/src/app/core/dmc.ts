// Estaciones automáticas de la Dirección Meteorológica de Chile (DMC): lluvia y meteorología OBSERVADAS, que
// reemplazan a las del pronóstico en el balance hídrico. Funciones sin dependencias de Angular: las usan la app y
// el worker en segundo plano. Este archivo es la fachada pública; la implementación está en ./dmc/.
export * from './dmc/api';
export * from './dmc/constants';
export * from './dmc/diagnose';
export * from './dmc/live';
export * from './dmc/met';
export * from './dmc/rain';
export * from './dmc/station-data';
export * from './dmc/stations';
export * from './dmc/store';
