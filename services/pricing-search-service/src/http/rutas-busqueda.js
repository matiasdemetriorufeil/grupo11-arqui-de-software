// ---------------------------------------------------------------------------
// Lado LECTURA del CQRS: adaptador HTTP de búsqueda y cotizaciones.
//
// Rutas publicadas en el contrato (docs/contracts/openapi.yaml):
//   GET  /v1/proveedor/catalogo
//   POST /v1/proveedor/cotizaciones
//   GET  /v1/proveedor/cotizaciones/:id
//
// Las cotizaciones ya resuelven contra el índice y se guardan en Redis. La
// búsqueda de catálogo valida los parámetros pero todavía responde 501.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { ErrorDeDominio, noImplementadoTodavia } from '../problema.js';
import { claveDeCache } from '../query/precios.js';
import { esProvinciaConocida } from '../query/flete.js';

const PENDIENTE = noImplementadoTodavia('Entrega 2');

const ORDENES_VALIDOS = new Set([
  'costo_por_watt_asc',
  'costo_por_watt_desc',
  'potencia_w_desc',
  'relevancia',
]);
const TIPOS_VALIDOS = new Set(['panel', 'inversor', 'estructura', 'bateria']);

/** Mismo patrón que el schema `Sku` del contrato. */
const PATRON_SKU = /^HEL-[A-Z]{3}-[A-Z0-9-]{3,20}$/;
const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEDAS_COTIZABLES = new Set(['USD']);

/**
 * @param {object} casosDeUso
 * @param {ReturnType<import('../query/cotizaciones.js').crearCotizaciones>} casosDeUso.cotizaciones
 */
export function routerDeBusqueda({ cotizaciones }) {
  const router = Router();

  router.get('/proveedor/catalogo', validarBusqueda, (req, res, next) => {
    // La clave de caché se calcula acá y se expone en una cabecera: hace
    // observable la decisión de cacheo antes de que exista Redis conectado.
    res.setHeader('X-Clave-Cache', claveDeCache(req.busqueda));
    res.setHeader('X-Cache', 'MISS');
    PENDIENTE(req, res, next);
  });

  router.post(
    '/proveedor/cotizaciones',
    exigirConsumidor,
    validarSolicitudDeCotizacion,
    async (req, res, next) => {
      try {
        const cotizacion = await cotizaciones.cotizar(req.body, req.consumidor);
        res
          .status(201)
          .location(`${req.baseUrl}/proveedor/cotizaciones/${cotizacion.cotizacion_id}`)
          .json(cotizacion);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get('/proveedor/cotizaciones/:cotizacion_id', exigirConsumidor, async (req, res, next) => {
    try {
      // El contrato no declara 400 en esta operación: un id mal formado es un
      // id que no existe.
      if (!PATRON_UUID.test(req.params.cotizacion_id)) {
        throw new ErrorDeDominio('NO_ENCONTRADO', 'No existe una cotización con ese identificador.');
      }
      res.json(await cotizaciones.obtener(req.params.cotizacion_id, req.consumidor));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Valida y normaliza los parámetros de búsqueda del contrato.
 * Lo que sale de acá en `req.busqueda` ya está saneado y tipado.
 */
function validarBusqueda(req, _res, next) {
  const errores = [];
  const q = req.query;

  const pagina = enteroEnRango(q.pagina, 1, Number.MAX_SAFE_INTEGER, 1, 'pagina', errores);
  const tamanio = enteroEnRango(q.tamanio_pagina, 1, 100, 20, 'tamanio_pagina', errores);
  const potenciaMin = enteroEnRango(q.potencia_w_min, 0, 100000, undefined, 'potencia_w_min', errores);
  const potenciaMax = enteroEnRango(q.potencia_w_max, 0, 100000, undefined, 'potencia_w_max', errores);

  if (potenciaMin !== undefined && potenciaMax !== undefined && potenciaMin > potenciaMax) {
    errores.push({
      campo: 'potencia_w_min',
      mensaje: 'No puede ser mayor que potencia_w_max.',
    });
  }

  if (q.tipo !== undefined && !TIPOS_VALIDOS.has(String(q.tipo))) {
    errores.push({
      campo: 'tipo',
      mensaje: `Valores admitidos: ${[...TIPOS_VALIDOS].join(', ')}.`,
    });
  }

  const orden = q.orden === undefined ? 'costo_por_watt_asc' : String(q.orden);
  if (!ORDENES_VALIDOS.has(orden)) {
    errores.push({
      campo: 'orden',
      mensaje: `Valores admitidos: ${[...ORDENES_VALIDOS].join(', ')}.`,
    });
  }

  if (q.q !== undefined && String(q.q).length > 120) {
    errores.push({ campo: 'q', mensaje: 'Máximo 120 caracteres.' });
  }

  if (errores.length > 0) {
    return next(
      new ErrorDeDominio('SOLICITUD_INVALIDA', 'Parámetros de búsqueda inválidos.', {
        errores_de_validacion: errores,
      }),
    );
  }

  req.busqueda = {
    q: q.q ? String(q.q) : undefined,
    tipo: q.tipo ? String(q.tipo) : undefined,
    fabricante: q.fabricante ? String(q.fabricante) : undefined,
    potencia_w_min: potenciaMin,
    potencia_w_max: potenciaMax,
    tecnologia_celda: q.tecnologia_celda ? String(q.tecnologia_celda) : undefined,
    costo_por_watt_max: q.costo_por_watt_max ? Number(q.costo_por_watt_max) : undefined,
    solo_disponibles: q.solo_disponibles === undefined ? true : q.solo_disponibles !== 'false',
    orden,
    pagina,
    tamanio_pagina: tamanio,
  };
  next();
}

/**
 * La cotización pertenece a quien la pidió. El gateway valida el JWT y agrega
 * esta cabecera con el consumidor; stock-service la manda en sus llamadas
 * internas con el consumidor original del pedido.
 */
function exigirConsumidor(req, _res, next) {
  const consumidor = req.header('X-Consumer-Username');
  if (!consumidor) {
    return next(new ErrorDeDominio('NO_AUTENTICADO', 'No se pudo identificar al consumidor.'));
  }
  req.consumidor = consumidor;
  next();
}

function validarSolicitudDeCotizacion(req, _res, next) {
  const errores = [];
  const cuerpo = req.body ?? {};

  if (typeof cuerpo.destino?.provincia !== 'string' || cuerpo.destino.provincia.trim() === '') {
    errores.push({ campo: 'destino.provincia', mensaje: 'Obligatorio: determina el flete.' });
  } else if (!esProvinciaConocida(cuerpo.destino.provincia)) {
    errores.push({ campo: 'destino.provincia', mensaje: 'Provincia argentina desconocida.' });
  }
  if (typeof cuerpo.destino?.localidad !== 'string' || cuerpo.destino.localidad.trim() === '') {
    errores.push({ campo: 'destino.localidad', mensaje: 'Obligatorio.' });
  }
  if (cuerpo.moneda !== undefined && !MONEDAS_COTIZABLES.has(cuerpo.moneda)) {
    // ARS está en el contrato, pero Helios no convierte monedas (SPEC § 4) y
    // los fabricantes cotizan en USD.
    errores.push({ campo: 'moneda', mensaje: 'Por ahora sólo se cotiza en USD.' });
  }
  if (!Array.isArray(cuerpo.lineas) || cuerpo.lineas.length === 0) {
    errores.push({ campo: 'lineas', mensaje: 'Debe contener al menos un elemento.' });
  } else {
    if (cuerpo.lineas.length > 50) {
      errores.push({ campo: 'lineas', mensaje: 'Máximo 50 líneas por cotización.' });
    }
    const vistos = new Set();
    cuerpo.lineas.forEach((linea, i) => {
      if (typeof linea?.sku !== 'string' || !PATRON_SKU.test(linea.sku)) {
        errores.push({ campo: `lineas[${i}].sku`, mensaje: 'Debe ser un SKU canónico de Helios.' });
      } else if (vistos.has(linea.sku)) {
        // Una línea por SKU: la reserva compara línea por línea contra la cotización.
        errores.push({ campo: `lineas[${i}].sku`, mensaje: 'SKU repetido: usar una sola línea por producto.' });
      } else {
        vistos.add(linea.sku);
      }
      if (!Number.isInteger(linea?.cantidad) || linea.cantidad < 1) {
        errores.push({ campo: `lineas[${i}].cantidad`, mensaje: 'Entero mayor o igual a 1.' });
      }
      if (linea?.fabricante_preferido != null && typeof linea.fabricante_preferido !== 'string') {
        errores.push({ campo: `lineas[${i}].fabricante_preferido`, mensaje: 'Debe ser texto.' });
      }
    });
  }

  if (errores.length > 0) {
    return next(
      new ErrorDeDominio('SOLICITUD_INVALIDA', 'La solicitud de cotización es inválida.', {
        errores_de_validacion: errores,
      }),
    );
  }
  next();
}

function enteroEnRango(valor, min, max, porDefecto, campo, errores) {
  if (valor === undefined || valor === '') return porDefecto;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) {
    errores.push({ campo, mensaje: `Entero entre ${min} y ${max}.` });
    return porDefecto;
  }
  return n;
}
