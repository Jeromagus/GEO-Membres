// Appels réseau avec délai maximal : un service public qui ne répond plus ne doit pas
// bloquer l'import indéfiniment (constaté le 2026-11-16 avec l'API Adresse et geo.api.gouv.fr).

export class TimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`pas de réponse en ${Math.round(ms / 1000)} s`);
    this.name = 'TimeoutError';
  }
}

// fetch interrompu par l'annulation de l'utilisateur (Error('Aborted')) ou par le délai (TimeoutError)
export async function fetchWithTimeout(url: string, init: RequestInit, signal: AbortSignal, ms: number): Promise<Response> {
  if (signal.aborted) throw new Error('Aborted');
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), ms);
  const onAbort = () => timeout.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: timeout.signal });
  } catch (err: any) {
    if (signal.aborted) throw new Error('Aborted');
    if (timeout.signal.aborted) throw new TimeoutError(ms);
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Message lisible d'une erreur réseau, pour le journal d'import
export function describeError(err: any): string {
  if (err instanceof TimeoutError) return err.message;
  if (err?.name === 'TypeError') return 'réseau injoignable (connexion, proxy ou blocage)';
  return err?.message || String(err);
}

// Diagnostic rempli par les géocodeurs : service qui a répondu, raison d'un échec
export interface Diag {
  source?: string;
  reason?: string;
}
