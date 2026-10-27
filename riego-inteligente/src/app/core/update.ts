// Aviso de versión nueva: compara este APK con el publicado en GitHub (release "apk-latest"). Funciones puras.
import { BUILD_INFO } from './build-info';

export const RELEASE_API = 'https://api.github.com/repos/ivanBZ97/SistemaInventarioV6/releases/tags/apk-latest';
export const APK_URL = 'https://github.com/ivanBZ97/SistemaInventarioV6/releases/download/apk-latest/riego-inteligente.apk';

export interface ReleaseInfo {
  sha: string;
  /** Número de build de GitHub Actions ("build 23" en el título o las notas), si viene. */
  run: number | null;
  publishedAt: string | null;
}

/** Lee el commit (target_commitish) y el número de build del release. */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as { target_commitish?: unknown; body?: unknown; name?: unknown; published_at?: unknown };
  const text = `${typeof r.name === 'string' ? r.name : ''} ${typeof r.body === 'string' ? r.body : ''}`;
  const sha = /\b([0-9a-f]{40})\b/i.exec(text)?.[1] ?? (typeof r.target_commitish === 'string' ? r.target_commitish : '');
  if (!sha) return null;
  const run = /build\s*#?\s*(\d+)/i.exec(text);
  return { sha, run: run ? Number(run[1]) : null, publishedAt: typeof r.published_at === 'string' ? r.published_at : null };
}

/** ¿El APK publicado es más nuevo que este? En desarrollo (build 0) nunca se avisa. */
export function updateAvailable(release: ReleaseInfo | null, build: { sha: string; run: number } = BUILD_INFO): boolean {
  if (!release || build.run === 0 || release.sha === build.sha) return false;
  return release.run === null || release.run > build.run;
}
