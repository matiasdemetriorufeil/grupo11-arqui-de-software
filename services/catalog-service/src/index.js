// ---------------------------------------------------------------------------
// catalog-service — Punto de entrada
//
// Arquitectura interna: EN CAPAS (http → aplicación → persistencia).
//
//   src/http/         Rutas y validación de entrada.
//   src/application/  Servicios de aplicación: unificación de catálogo y SKUs.
//   src/persistence/  Repositorios PostgreSQL.
//
// Por qué este patrón acá: el servicio es dueño de un modelo relacional estable
// y sus operaciones son mayormente CRUD con invariantes de integridad que la
// base ya garantiza. Un hexágono sería ceremonia sin beneficio. La decisión de
// usar patrones distintos por servicio está en docs/adr/ADR-001.
// ---------------------------------------------------------------------------

import express from 'express';

import { log, middlewareDeLogs, SERVICIO, INSTANCIA } from './observabilidad.js';
import { routerDeSalud } from './salud.js';
import { sondaDesdeUrl } from './sondas.js';
import { middlewareDeErrores } from './problema.js';
import { routerDeCatalogo } from './http/rutas-catalogo.js';

const PUERTO = Number(process.env.PUERTO ?? 3002);

const app = express();
app.disable('x-powered-by');
app.use(middlewareDeLogs);
app.use(express.json({ limit: '512kb' }));

app.use(
  routerDeSalud({
    postgres: sondaDesdeUrl(process.env.DATABASE_URL, 5432),
    rabbitmq: sondaDesdeUrl(process.env.RABBITMQ_URL, 5672),
  }),
);

// API interna. catalog-service NO forma parte del contrato público: el mundo
// exterior ve el catálogo a través de pricing-search-service, que es el que
// agrega precio y disponibilidad.
app.use('/catalogo', routerDeCatalogo());

app.use(middlewareDeErrores(log));

const servidor = app.listen(PUERTO, () => {
  log.info({ puerto: PUERTO, patron_interno: 'capas' }, `${SERVICIO} (${INSTANCIA}) escuchando`);
});

for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => {
    log.info({ senal }, 'apagado ordenado iniciado');
    servidor.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
