import type { PlatformHttpTransport } from './PlatformTypes';

/** H5 uses browser HTTPS and CORS; no mini-game request shim or cookie session. */
export function createBrowserHttpTransport(globals: object): PlatformHttpTransport {
  const scope = globals as { XMLHttpRequest?: typeof XMLHttpRequest; window?: { XMLHttpRequest?: typeof XMLHttpRequest } };
  return {
    request(options) {
      // Resolve on each request, including after a host finishes injecting its browser APIs.
      const Request = scope.XMLHttpRequest ?? scope.window?.XMLHttpRequest;
      if (typeof Request !== 'function') { options.fail({ code: 'NETWORK_ERROR' }); return; }
      const request = new Request();
      let settled = false;
      const detach = (): void => {
        request.onload = null; request.onerror = null; request.ontimeout = null; request.onabort = null;
      };
      const fail = (code: string): void => {
        if (settled) return;
        settled = true; detach(); options.fail({ code });
      };
      request.onload = () => {
        if (settled) return;
        if (!request.status) { fail('NETWORK_ERROR'); return; }
        const response = { statusCode: request.status, data: request.responseText };
        settled = true; detach(); options.success(response);
      };
      request.onerror = () => fail('NETWORK_ERROR');
      request.ontimeout = () => fail('TIMEOUT');
      request.onabort = () => fail('NETWORK_ERROR');
      try {
        request.open(options.method, options.url, true);
        request.timeout = options.timeout;
        request.withCredentials = false;
        for (const name of Object.keys(options.header)) request.setRequestHeader(name, options.header[name]);
        request.send(options.method === 'POST' ? JSON.stringify(options.data ?? {}) : null);
      } catch {
        fail('NETWORK_ERROR');
        try { request.abort(); } catch {}
      }
      return { abort() {
        if (settled) return;
        settled = true; detach();
        try { request.abort(); } catch {}
      } };
    },
  };
}
