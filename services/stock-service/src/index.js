// ---------------------------------------------------------------------------
// stock-service — Punto de entrada
//
// Arquitectura interna: HEXAGONAL (puertos y adaptadores) + DDD táctico.
//
//   src/domain/        Reglas de negocio puras. No conocen HTTP ni SQL.
//   src/application/   Casos de uso. Orquestan dominio + puertos.
//   src/adapters/      Implementaciones de los puertos (PostgreSQL, RabbitMQ,
//                      proveedor externo de pagos).
//   src/http/          Adaptador de entrada HTTP.
//
// Por qué este patrón acá: es el servicio con las reglas más densas y la
// operación crítica del sistema. Aislar el dominio permite testear las reglas
// sin levantar base de datos y cambiar de adaptador sin tocarlas.
// Ver docs/adr/ADR-001-limites-de-servicios.md.
// ---------------------------------------------------------------------------

import express from 'express';

import { log, middlewareDeLogs, SERVICIO, INSTANCIA } from './observabilidad.js';
import { routerDeSalud } from './salud.js';
import { sondaDesdeUrl } from './sondas.js';
import { middlewareDeErrores } from './problema.js';
import { routerDePedidos } from './http/rutas-pedidos.js';
import { routerInterno } from './http/rutas-internas.js';
import { crearRepositorioPostgres } from './adapters/repositorio-postgres.js';
import { crearServicioDePreciosHttp } from './adapters/precios-http.js';
import { crearConsultarDisponibilidad } from './application/consultar-disponibilidad.js';
import { crearReservarPedido } from './application/reservar-pedido.js';
import { crearObtenerPedido } from './application/obtener-pedido.js';

const PUERTO = Number(process.env.PUERTO ?? 3004);

// Composición del hexágono: los adaptadores se crean acá y se inyectan en los
// casos de uso. Es el único lugar que conoce las implementaciones concretas.
const repositorio = crearRepositorioPostgres();
const precios = crearServicioDePreciosHttp({ log });

// PROVISORIO: todavía no hay publicador de RabbitMQ. Los eventos quedan en la
// tabla outbox, escritos en la misma transacción que la reserva, y se publican
// cuando exista el publicador. El outbox es justamente lo que hace seguro
// diferirlo: no se pierde ninguno.
const eventos = { vaciarOutboxEnSegundoPlano() {} };

const consultarDisponibilidad = crearConsultarDisponibilidad({ repositorio });
const reservarPedido = crearReservarPedido({ repositorio, precios, eventos });
const obtenerPedido = crearObtenerPedido({ repositorio });

const app = express();
app.disable('x-powered-by');
app.use(middlewareDeLogs);
app.use(express.json({ limit: '1mb' }));

// Salud: liveness para el balanceador del gateway, readiness con dependencias.
app.use(
  routerDeSalud({
    postgres: sondaDesdeUrl(process.env.DATABASE_URL, 5432),
    rabbitmq: sondaDesdeUrl(process.env.RABBITMQ_URL, 5672),
  }),
);

// Capacidad pública expuesta al grupo consumidor (docs/contracts/openapi.yaml).
app.use('/v1', routerDePedidos({ consultarDisponibilidad, reservarPedido, obtenerPedido }));

// API interna para el frontend propio de Helios.
app.use('/interno', routerInterno());

app.use(middlewareDeErrores(log));

const servidor = app.listen(PUERTO, () => {
  log.info(
    { puerto: PUERTO, patron_interno: 'hexagonal' },
    `${SERVICIO} (${INSTANCIA}) escuchando`,
  );
});

// Apagado ordenado: deja de aceptar conexiones nuevas y termina las en curso.
// Es lo que permite reiniciar una instancia sin que el balanceador devuelva 502.
for (const senal of ['SIGTERM', 'SIGINT']) {
  process.on(senal, () => {
    log.info({ senal }, 'apagado ordenado iniciado');
    // Primero se terminan los pedidos en curso, después se cierra el pool.
    servidor.close(() => repositorio.cerrar().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
