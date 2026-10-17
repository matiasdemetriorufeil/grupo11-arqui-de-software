// ---------------------------------------------------------------------------
// Adaptador HTTP de entrada para la capacidad pública de pedidos.
//
// Las rutas de este archivo son exactamente las que publica el contrato
// (docs/contracts/openapi.yaml) y las que el gateway enruta a este servicio.
//
// Estado: disponibilidad, reservar y consultar un pedido responden contra la
// base real. Confirmar y cancelar devuelven 501 con un problem+json que apunta
// al mock hasta que se conecten a su caso de uso, en lugar de mentir con datos
// inventados.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { ErrorDeDominio, noImplementadoTodavia } from '../problema.js';

const PENDIENTE = noImplementadoTodavia('Entrega 2');

/** Mismo patrón que el schema `Sku` del contrato. */
const PATRON_SKU = /^HEL-[A-Z]{3}-[A-Z0-9-]{3,20}$/;
const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {object} casosDeUso
 * @param {(consulta: {sku: string, cantidad: number}) => Promise<object>} casosDeUso.consultarDisponibilidad
 * @param {(solicitud: object) => Promise<{estado: number, cuerpo: object, repetida: boolean}>} casosDeUso.reservarPedido
 * @param {(pedidoId: string, consumidor: string) => Promise<object>} casosDeUso.obtenerPedido
 */
export function routerDePedidos({ consultarDisponibilidad, reservarPedido, obtenerPedido }) {
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
  router.post(
    '/pedidos/reservar',
    exigirClaveIdempotencia,
    exigirConsumidor,
    validarSolicitudDeReserva,
    async (req, res, next) => {
      try {
        const { estado, cuerpo, repetida } = await reservarPedido({
          consumidor: req.consumidor,
          claveIdempotencia: req.claveIdempotencia,
          cuerpo: req.body,
          correlationId: req.id,
        });
        res
          .status(estado)
          .location(`${req.baseUrl}/pedidos/${cuerpo.pedido_id}`)
          .set('Idempotency-Replayed', String(repetida))
          .json(cuerpo);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /v1/pedidos/:pedido_id
  router.get('/pedidos/:pedido_id', exigirConsumidor, async (req, res, next) => {
    try {
      // El contrato no declara 400 en esta operación: un id mal formado es un
      // id que no existe.
      if (!PATRON_UUID.test(req.params.pedido_id)) {
        throw new ErrorDeDominio('NO_ENCONTRADO', 'No existe un pedido con ese identificador.');
      }
      res.json(await obtenerPedido(req.params.pedido_id, req.consumidor));
    } catch (err) {
      next(err);
    }
  });

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

/**
 * El pedido pertenece a quien lo hizo. El gateway valida el JWT y agrega esta
 * cabecera con el consumidor autenticado.
 */
function exigirConsumidor(req, _res, next) {
  const consumidor = req.header('X-Consumer-Username');
  if (!consumidor) {
    return next(new ErrorDeDominio('NO_AUTENTICADO', 'No se pudo identificar al consumidor.'));
  }
  req.consumidor = consumidor;
  next();
}

/** Valida el cuerpo contra el schema `SolicitudDeReserva` y nombra cada campo inválido. */
function validarSolicitudDeReserva(req, _res, next) {
  const errores = [];
  const cuerpo = req.body ?? {};

  if (typeof cuerpo.cotizacion_id !== 'string' || !PATRON_UUID.test(cuerpo.cotizacion_id)) {
    errores.push({ campo: 'cotizacion_id', mensaje: 'Obligatorio, en formato UUID.' });
  }
  if (
    cuerpo.referencia_externa != null &&
    (typeof cuerpo.referencia_externa !== 'string' || cuerpo.referencia_externa.length > 64)
  ) {
    errores.push({ campo: 'referencia_externa', mensaje: 'Texto de hasta 64 caracteres.' });
  }
  if (!Array.isArray(cuerpo.lineas) || cuerpo.lineas.length === 0) {
    errores.push({ campo: 'lineas', mensaje: 'Debe contener al menos un elemento.' });
  } else {
    const vistos = new Set();
    cuerpo.lineas.forEach((linea, i) => {
      if (typeof linea?.sku !== 'string' || !PATRON_SKU.test(linea.sku)) {
        errores.push({ campo: `lineas[${i}].sku`, mensaje: 'Debe ser un SKU canónico de Helios.' });
      } else if (vistos.has(linea.sku)) {
        errores.push({ campo: `lineas[${i}].sku`, mensaje: 'SKU repetido: una sola línea por producto.' });
      } else {
        vistos.add(linea.sku);
      }
      if (!Number.isInteger(linea?.cantidad) || linea.cantidad < 1) {
        errores.push({ campo: `lineas[${i}].cantidad`, mensaje: 'Entero mayor o igual a 1.' });
      }
    });
  }

  if (errores.length > 0) {
    return next(
      new ErrorDeDominio('SOLICITUD_INVALIDA', 'La solicitud de reserva es inválida.', {
        errores_de_validacion: errores,
      }),
    );
  }
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
