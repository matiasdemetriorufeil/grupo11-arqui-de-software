// ---------------------------------------------------------------------------
// Lado LECTURA del CQRS: adaptador HTTP de búsqueda y cotizaciones.
//
// Rutas publicadas en el contrato (docs/contracts/openapi.yaml):
//   GET  /v1/proveedor/catalogo
//   POST /v1/proveedor/cotizaciones
//   GET  /v1/proveedor/cotizaciones/:id
//
// En la Entrega 1 la validación de parámetros ya está implementada (es parte del
// contrato y el consumidor tiene que poder confiar en ella) y la resolución
// contra Elasticsearch llega en la Entrega 2.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { ErrorDeDominio, noImplementadoTodavia } from '../problema.js';
import { claveDeCache } from '../query/precios.js';

const PENDIENTE = noImplementadoTodavia('Entrega 2');

const ORDENES_VALIDOS = new Set([
  'costo_por_watt_asc',
  'costo_por_watt_desc',
  'potencia_w_desc',
  'relevancia',
]);
const TIPOS_VALIDOS = new Set(['panel', 'inversor', 'estructura', 'bateria']);

export function routerDeBusqueda() {
  const router = Router();

  router.get('/proveedor/catalogo', validarBusqueda, (req, res, next) => {
    // La clave de caché se calcula acá y se expone en una cabecera: hace
    // observable la decisión de cacheo antes de que exista Redis conectado.
    res.setHeader('X-Clave-Cache', claveDeCache(req.busqueda));
    res.setHeader('X-Cache', 'MISS');
    PENDIENTE(req, res, next);
  });

  router.post('/proveedor/cotizaciones', validarSolicitudDeCotizacion, PENDIENTE);
  router.get('/proveedor/cotizaciones/:cotizacion_id', PENDIENTE);

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

function validarSolicitudDeCotizacion(req, _res, next) {
  const errores = [];
  const cuerpo = req.body ?? {};

  if (!cuerpo.destino?.provincia) {
    errores.push({ campo: 'destino.provincia', mensaje: 'Obligatorio: determina el flete.' });
  }
  if (!Array.isArray(cuerpo.lineas) || cuerpo.lineas.length === 0) {
    errores.push({ campo: 'lineas', mensaje: 'Debe contener al menos un elemento.' });
  } else {
    if (cuerpo.lineas.length > 50) {
      errores.push({ campo: 'lineas', mensaje: 'Máximo 50 líneas por cotización.' });
    }
    cuerpo.lineas.forEach((linea, i) => {
      if (!linea?.sku) errores.push({ campo: `lineas[${i}].sku`, mensaje: 'Obligatorio.' });
      if (!Number.isInteger(linea?.cantidad) || linea.cantidad < 1) {
        errores.push({ campo: `lineas[${i}].cantidad`, mensaje: 'Entero mayor o igual a 1.' });
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
