// Lectura defensiva de respuestas de servicios externos (sus formatos cambian sin aviso).

/** Texto de un campo de la respuesta: solo cadenas y números (un objeto inesperado queda vacío). */
export function textOf(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}
