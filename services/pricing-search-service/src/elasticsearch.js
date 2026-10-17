// ---------------------------------------------------------------------------
// Cliente de Elasticsearch compartido por la proyección y las consultas.
//
// Un solo cliente por proceso: mantiene su propio pool de conexiones.
// ---------------------------------------------------------------------------

import { Client, errors } from '@elastic/elasticsearch';
import { ErrorDeDominio } from './problema.js';

export function crearClienteElasticsearch({ url = process.env.ELASTICSEARCH_URL ?? 'http://elasticsearch:9200' } = {}) {
  return new Client({
    node: url,
    // Mismo criterio que las llamadas HTTP entre servicios (ADR-005): timeout
    // explícito y un reintento. Una consulta colgada ocupa una conexión sin
    // cambiar el resultado.
    requestTimeout: Number(process.env.TIMEOUT_ELASTICSEARCH_MS ?? 2000),
    maxRetries: 1,
  });
}

/**
 * Convierte "Elasticsearch no está disponible" en un 503 reintentable.
 * Cualquier otro error (un mapping roto, una consulta mal armada) se propaga y
 * termina en 500: esconderlo detrás de un 503 haría que el consumidor reintente
 * algo que nunca va a funcionar.
 */
export function traducirErrorDeElasticsearch(err) {
  if (
    err instanceof errors.ConnectionError ||
    err instanceof errors.TimeoutError ||
    err instanceof errors.NoLivingConnectionsError ||
    (err instanceof errors.ResponseError && [502, 503, 504].includes(err.statusCode))
  ) {
    throw new ErrorDeDominio('SERVICIO_NO_DISPONIBLE', 'El índice de productos no está disponible.');
  }
  throw err;
}
