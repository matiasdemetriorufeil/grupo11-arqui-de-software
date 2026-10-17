// ---------------------------------------------------------------------------
// Adaptador HTTP de entrada para la capacidad pública de pedidos.
//
// Las rutas de este archivo son exactamente las que publica el contrato
// (docs/contracts/openapi.yaml) y las que el gateway enruta a este servicio.
//
// Estado: `GET /proveedor/disponibilidad` ya responde contra la base real. El
// resto de las rutas devuelve 501 con un problem+json que apunta al mock hasta
// que se conecten a su caso de uso, en lugar de mentir con datos inventados.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { ErrorDeDominio, noImplementadoTodavia } from '../problema.js';

const PENDIENTE = noImplementadoTodavia('Entrega 2');

/** Mismo patrón que el schema `Sku` del contrato. */
const PATRON_SKU = /^HEL-[A-Z]{3}-[A-Z0-9-]{3,20}$/;

/**
 * @param {object} casosDeUso
 * @param {(consulta: {sku: string, cantidad: number}) => Promise<object>} casosDeUso.consultarDisponibilidad
 */
export function routerDePedidos({ consultarDisponibilidad }) {
  const router = Router();

  // GET /v1/proveedor/disponibilidad?sku=&cantidad=
  // Lectura informativa contra el inventario. No reserva nada.
  router.get(
    '/proveedor/disponibilidad',
    exigirParametros(['sku', 'cantidad']),
    validarConsultaDeDisponibilidad,
    async (req, res, next) => {
      try {
        res.json(await consultarDisponibilidad({ sku: req.query.sku, cantidad: Number(req.query.cantidad) }));
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /v1/pedidos/reservar
  // Operación crítica. Exige Idempotency-Key antes de cualquier otra cosa: sin
  // clave no hay forma de que un reintento del consumidor sea seguro.
  router.post('/pedidos/reservar', exigirClaveIdempotencia, PENDIENTE);

  // GET /v1/pedidos/:pedido_id
  router.get('/pedidos/:pedido_id', PENDIENTE);

  // POST /v1/pedidos/:pedido_id/confirmar
  router.post('/pedidos/:pedido_id/confirmar', exigirClaveIdempotencia, PENDIENTE);

  // DELETE /v1/pedidos/:pedido_id
  router.delete('/pedidos/:pedido_id', PENDIENTE);

  return router;
}

/**
 * El contrato declara Idempotency-Key como obligatorio en las escrituras.
 * Validarlo en el borde, antes de tocar el dominio, hace que el consumidor
 * reciba el mismo error en la Entrega 1 y en la implementación final.
 */
function exigirClaveIdempotencia(req, _res, next) {
  const clave = req.header('Idempotency-Key');
  if (!clave) {
    return next(
      new ErrorDeDominio('SOLICITUD_INVALIDA', 'Falta el header Idempotency-Key.', {
        errores_de_validacion: [
          { campo: 'Idempotency-Key', mensaje: 'Header obligatorio en operaciones de escritura.' },
        ],
      }),
    );
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clave)) {
    return next(
      new ErrorDeDominio('SOLICITUD_INVALIDA', 'El header Idempotency-Key debe ser un UUID.', {
        errores_de_validacion: [{ campo: 'Idempotency-Key', mensaje: 'Formato UUID v4 esperado.' }],
      }),
    );
  }
  req.claveIdempotencia = clave;
  next();
}

/** Valida los parámetros contra el contrato y nombra cada campo inválido. */
function validarConsultaDeDisponibilidad(req, _res, next) {
  const errores = [];
  if (typeof req.query.sku !== 'string' || !PATRON_SKU.test(req.query.sku)) {
    errores.push({ campo: 'sku', mensaje: 'Debe ser un SKU canónico de Helios (ej. HEL-PAN-550-JKM).' });
  }
  if (!/^[1-9][0-9]*$/.test(String(req.query.cantidad))) {
    errores.push({ campo: 'cantidad', mensaje: 'Debe ser un entero mayor o igual a 1.' });
  }
  if (errores.length > 0) {
    return next(
      new ErrorDeDominio('SOLICITUD_INVALIDA', 'Parámetros inválidos.', { errores_de_validacion: errores }),
    );
  }
  next();
}

function exigirParametros(nombres) {
  return (req, _res, next) => {
    const faltantes = nombres.filter((n) => req.query[n] === undefined);
    if (faltantes.length > 0) {
      return next(
        new ErrorDeDominio('SOLICITUD_INVALIDA', 'Faltan parámetros obligatorios.', {
          errores_de_validacion: faltantes.map((n) => ({
            campo: n,
            mensaje: 'Parámetro de consulta obligatorio.',
          })),
        }),
      );
    }
    next();
  };
}
