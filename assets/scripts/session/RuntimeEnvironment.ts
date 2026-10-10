export type RuntimeEnvironment = 'test' | 'production';

/** Build entries supply this value before Creator starts; editor previews have no entry injection. */
export function resolveRuntimeEnvironment(injected: unknown, preview: boolean): RuntimeEnvironment {
  if (injected === undefined) return preview ? 'test' : 'production';
  if (injected === null || typeof injected !== 'object' || Array.isArray(injected)) return 'production';
  const environment = (injected as { environment?: unknown }).environment;
  return environment === 'test' ? 'test' : 'production';
}
