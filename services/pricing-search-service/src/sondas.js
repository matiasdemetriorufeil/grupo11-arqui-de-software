// ---------------------------------------------------------------------------
// Sondas de dependencias para el readiness probe (/salud/lista).
//
// Deliberadamente sin clientes de base de datos: una sonda sólo tiene que
// responder "¿se puede llegar a esta dependencia?". Un chequeo TCP o un GET
// alcanza, no agrega dependencias al servicio y no se rompe si cambia el driver.
// ---------------------------------------------------------------------------

import net from 'node:net';

/** Resuelve true si se puede abrir un socket TCP contra host:puerto. */
export function sondaTcp(host, puerto, timeoutMs = 1000) {
  return () =>
    new Promise((resolve) => {
      const socket = new net.Socket();
      const cerrar = (ok) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => cerrar(true));
      socket.once('timeout', () => cerrar(false));
      socket.once('error', () => cerrar(false));
      socket.connect(puerto, host);
    });
}

/** Resuelve true si un GET a la URL responde con estado < 500. */
export function sondaHttp(url, timeoutMs = 1000) {
  return async () => {
    const abortar = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(url, { signal: abortar });
      return res.status < 500;
    } catch {
      return false;
    }
  };
}

/**
 * Convierte una URL de conexión (postgres://, mongodb://, amqp://, redis://)
 * en una sonda TCP, tomando host y puerto de la propia URL.
 */
export function sondaDesdeUrl(urlDeConexion, puertoPorDefecto) {
  try {
    const u = new URL(urlDeConexion);
    return sondaTcp(u.hostname, Number(u.port) || puertoPorDefecto);
  } catch {
    return async () => false;
  }
}
