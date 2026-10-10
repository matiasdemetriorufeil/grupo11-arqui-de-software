// ---------------------------------------------------------------------------
// import-service — Punto de entrada
//
// Arquitectura interna: PIPELINE POR ETAPAS.
//
//   ingesta → parseo → normalización → validación → publicación
//
//   src/pipeline/     Una etapa por archivo, con una entrada y una salida.
//   src/persistence/  Colecciones de MongoDB (lotes, filas crudas, perfiles).
//   src/http/         Adaptador de entrada: subida de archivos y seguimiento.
//
// Por qué este patrón acá: el trabajo de este servicio es una transformación de
// datos de varios pasos donde cada paso puede fallar por sus propias razones y
// hay que poder reanudar desde donde se cortó. Las etapas se testean por
// separado y el estado del lote dice en qué etapa está.
//
// Es, junto con el hexágono de stock-service y el CQRS de pricing-search, uno de
// los tres patrones internos distintos del sistema (ver docs/adr/ADR-001).
// ---------------------------------------------------------------------------

import express from 'express';

import { log, middlewareDeLogs, SERVICIO, INSTANCIA } from './observabilidad.js';
import { routerDeSalud } from './salud.js';
import { sondaDesdeUrl } from './sondas.js';
import { middlewareDeErrores } from './problema.js';
import { routerDeImportaciones } from './http/rutas-importaciones.js';

const PUERTO = Number(process.env.PUERTO ?? 3001);

const app = express();
app.disable('x-powered-by');
app.use(middlewareDeLogs);
app.use(express.json({ limit: '1mb' }));

app.use(
  routerDeSalud({
    mongodb: sondaDesdeUrl(process.env.MONGO_URL, 27017),
    rabbitmq: sondaDesdeUrl(process.env.RABBITMQ_URL, 5672),
  }),
);

// API interna. Las listas de precios las sube el equipo de compras de Helios
// desde el frontend propio; no es una capacidad que se publique a terceros.
app.use('/importaciones', routerDeImportaciones());

app.use(middlewareDeErrores(log));

const servidor = app.listen(PUERTO, () => {
  log.info({ puerto: PUERTO, patron_interno: 'pipeline' }, `${SERVICIO} (${INSTANCIA}) escuchando`);
});

for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => {
    log.info({ senal }, 'apagado ordenado iniciado');
    servidor.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
