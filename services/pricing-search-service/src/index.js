// ---------------------------------------------------------------------------
// pricing-search-service — Punto de entrada
//
// Arquitectura interna: CQRS con read model.
//
//   src/projection/   Lado escritura: consume eventos de dominio y proyecta un
//                     documento desnormalizado por producto al índice.
//   src/query/        Lado lectura: resuelve búsquedas y cotizaciones contra el
//                     índice, con caché cache-aside en Redis.
//
// Por qué este patrón acá: el servicio no es dueño de ningún dato: todo lo que
// sirve se deriva del catálogo, de las listas de precios y del stock. Separar
// proyección de consulta permite responder búsquedas facetadas sin consultar a
// los otros tres servicios, y escalar la lectura por separado (este servicio es
// el que corre en dos instancias detrás del balanceador).
//
// Contrapartida aceptada: el índice es eventualmente consistente. El retraso
// máximo tolerable está fijado en 60 s y se mide (ver docs/ARCHITECTURE.md).
// ---------------------------------------------------------------------------

import express from 'express';

import { log, middlewareDeLogs, SERVICIO, INSTANCIA } from './observabilidad.js';
import { routerDeSalud } from './salud.js';
import { sondaDesdeUrl, sondaHttp } from './sondas.js';
import { middlewareDeErrores } from './problema.js';
import { routerDeBusqueda } from './http/rutas-busqueda.js';
import { routerDeMetricas } from './http/rutas-metricas.js';
import { routerInterno } from './http/rutas-internas.js';
import { crearClienteElasticsearch } from './elasticsearch.js';
import { asegurarIndice } from './projection/mapeo-indice.js';
import { cargarDatosDemo } from './projection/datos-demo.js';
import { crearConsultaDeRanking } from './query/ranking.js';
import { crearClienteRedis } from './redis.js';
import { crearRepositorioDeCotizaciones } from './query/repositorio-cotizaciones.js';
import { crearCotizaciones } from './query/cotizaciones.js';

const PUERTO = Number(process.env.PUERTO ?? 3003);

const es = crearClienteElasticsearch();
const redis = crearClienteRedis({ log });
const mejorFabricante = crearConsultaDeRanking({ es });
const cotizaciones = crearCotizaciones({ es, repositorio: crearRepositorioDeCotizaciones({ redis }) });

const app = express();
app.disable('x-powered-by');
app.use(middlewareDeLogs);
app.use(express.json({ limit: '512kb' }));

// Cabecera que identifica qué instancia respondió: es la evidencia de que el
// balanceador del gateway está repartiendo el tráfico.
app.use((_req, res, next) => {
  res.setHeader('X-Instancia', INSTANCIA);
  next();
});

app.use(
  routerDeSalud({
    elasticsearch: sondaHttp(`${process.env.ELASTICSEARCH_URL}/_cluster/health`),
    redis: sondaDesdeUrl(process.env.REDIS_URL, 6379),
    rabbitmq: sondaDesdeUrl(process.env.RABBITMQ_URL, 5672),
  }),
);

// Capacidad pública: catálogo y cotizaciones (docs/contracts/openapi.yaml).
app.use('/v1', routerDeBusqueda({ cotizaciones }));

// API interna para otros servicios (tráfico este-oeste, no pasa por el gateway).
app.use(routerInterno({ mejorFabricante }));

// Métricas en formato Prometheus, para el tablero de observabilidad.
app.use(routerDeMetricas());

app.use(middlewareDeErrores(log));

const servidor = app.listen(PUERTO, () => {
  log.info({ puerto: PUERTO, patron_interno: 'cqrs' }, `${SERVICIO} (${INSTANCIA}) escuchando`);
  prepararIndice();
});

/**
 * Crea el índice si no existe y, en desarrollo, lo puebla con datos de demo.
 * No bloquea el arranque: si Elasticsearch todavía no responde, reintenta. Las
 * dos instancias lo corren a la vez y es seguro (ver asegurarIndice y
 * cargarDatosDemo).
 */
async function prepararIndice(intento = 1) {
  try {
    const creado = await asegurarIndice(es);
    log.info({ creado }, 'índice de productos listo');
    if (process.env.CARGAR_DATOS_DEMO === 'true') {
      log.info(await cargarDatosDemo(es), 'datos de demo cargados en el índice');
    }
  } catch (err) {
    const esperaMs = Math.min(intento * 2000, 30_000);
    log.warn({ err, intento, espera_ms: esperaMs }, 'no se pudo preparar el índice; se reintenta');
    setTimeout(() => prepararIndice(intento + 1), esperaMs).unref();
  }
}

for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => {
    log.info({ senal }, 'apagado ordenado iniciado');
    servidor.close(() =>
      Promise.allSettled([es.close(), redis.quit()]).finally(() => process.exit(0)),
    );
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
