interface WeChatFontAdapter {
  loadFont(path: string): string | null | undefined;
}

interface WeChatFontScope {
  __globalAdapter?: WeChatFontAdapter;
  window?: { __globalAdapter?: WeChatFontAdapter };
}
interface FontParser {
  register(extension: string, handler: (file: string, options: Record<string, unknown>,
    complete: (error: Error | null, family?: string) => void) => void): void;
}

const installedParsers = new WeakSet<FontParser>();

/** Install before resources.load: WeChat can throw for loadFont permission errors,
 * while Creator's parser expects every handler to settle through its callback. */
export function installWeChatFontFallback(parser: FontParser,
  scope: WeChatFontScope = globalThis as typeof globalThis & WeChatFontScope,
  warn: (message: string, error?: unknown) => void = console.warn): boolean {
  // The Creator web adapter writes to window, which can be a separate host
  // object from globalThis in a mini-game JavaScript context.
  const adapter = typeof scope.__globalAdapter?.loadFont === 'function'
    ? scope.__globalAdapter : scope.window?.__globalAdapter;
  if (!adapter || typeof adapter.loadFont !== 'function' || installedParsers.has(parser)) return false;
  const loadFont = adapter.loadFont;
  let warned = false;
  parser.register('.ttf', (file, _options, complete) => {
    let family = 'Arial', fallback = true, failure: unknown;
    try {
      const loaded = loadFont.call(adapter, file);
      if (loaded) { family = loaded; fallback = false; }
    } catch (error) { failure = error; }
    if (fallback && !warned) {
      warned = true;
      // Diagnostics must not interrupt the resource completion callback.
      try { warn('[ForestGunner] WeChat font unavailable; using Arial.', failure); }
      catch (_) { /* Some host consoles can reject calls during teardown. */ }
    }
    // Keep completion outside the try block: a throwing consumer must not be called twice.
    complete(null, family);
  });
  installedParsers.add(parser);
  return true;
}
