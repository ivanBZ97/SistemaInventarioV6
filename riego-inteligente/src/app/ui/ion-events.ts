// Lectura tipada de los eventos de los controles de Ionic (ionInput, ionChange), para no repetir conversiones en
// las plantillas.

const detail = (ev: Event): { value?: unknown; checked?: unknown } => (ev as CustomEvent<{ value?: unknown; checked?: unknown }>).detail ?? {};

/** Texto escrito en un `ion-input`. */
export function inputText(ev: Event): string {
  const { value } = detail(ev);
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** Número escrito en un `ion-input` o elegido en un `ion-range` (NaN si está vacío o no es un número). */
export function inputNumber(ev: Event): number {
  const { value } = detail(ev);
  if (typeof value === 'number') return value;
  return typeof value === 'string' && value.trim() !== '' ? Number(value.replace(',', '.')) : NaN;
}

/** Igual que {@link inputNumber}, pero null si no hay un número mayor que cero. */
export function inputPositive(ev: Event): number | null {
  const n = inputNumber(ev);
  return n > 0 ? n : null;
}

/** Estado de un `ion-toggle`. */
export function inputChecked(ev: Event): boolean {
  return detail(ev).checked === true;
}
