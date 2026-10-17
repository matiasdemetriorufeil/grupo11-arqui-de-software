// ---------------------------------------------------------------------------
// Cliente de Redis compartido: almacén de cotizaciones y, más adelante, caché
// de búsquedas.
//
// Configurado para FALLAR RÁPIDO: sin conexión, un comando se rechaza en el
// acto en lugar de quedar encolado esperando a que Redis vuelva. Cada uso
// decide qué hacer con esa falla (la cotización devuelve 503; la caché de
// búsqueda, cuando exista, va directo a Elasticsearch).
// ---------------------------------------------------------------------------

import { createClient } from 'redis';

/**
 * @param {object} [opciones]
 * @param {string} [opciones.url]
 * @param {{warn: Function}} [opciones.log]
 */
export function crearClienteRedis({ url = process.env.REDIS_URL ?? 'redis://redis:6379', log = { warn() {} } } = {}) {
  const cliente = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 2000,
      // Reconecta para siempre, con espera creciente hasta 5 s.
      reconnectStrategy: (intentos) => Math.min(intentos * 200, 5000),
    },
  });

  // Sin este handler, un error de conexión tiraría abajo el proceso. Se loguea
  // una sola vez por caída para no inundar los logs mientras reconecta.
  let caido = false;
  cliente.on('error', (err) => {
    if (!caido) log.warn({ err }, 'Redis no disponible; se reintenta la conexión');
    caido = true;
  });
  cliente.on('ready', () => {
    caido = false;
  });

  // La conexión inicial no bloquea el arranque: si Redis todavía no responde,
  // la estrategia de reconexión sigue intentando.
  cliente.connect().catch(() => {});
  return cliente;
}
