// ---------------------------------------------------------------------------
// Carga inicial del índice con datos de demostración.
//
// PROVISORIO: en régimen el índice se puebla con eventos de los servicios
// dueños de los datos (ver README de esta carpeta). Mientras la cadena de
// eventos no exista, esta carga permite cotizar y reservar de punta a punta en
// local. Produce los documentos con el mismo proyector que va a usar el
// consumidor de eventos, así que reemplazarla no cambia lo que ve la búsqueda.
//
// Los datos replican los de demo de los otros servicios:
//   ficha y fabricante       → catalog-service/db/init/002_datos_demo.sql
//   unidades libres          → stock-service/db/init/002_datos_demo.sql (DEP-CBA-01)
//   días de entrega y bonif. → tabla `fabricante` de catalog-service
//   precio de lista          → inventado: todavía no hay listas importadas.
//
// Se activa con CARGAR_DATOS_DEMO=true (docker compose lo hace por defecto).
// ---------------------------------------------------------------------------

import { documentoDeProducto } from './proyector.js';
import { ALIAS_PRODUCTOS } from './mapeo-indice.js';

const CERT_PANEL = ['IEC 61215', 'IEC 61730', 'CE'];
const CERT_INVERSOR = ['IEC 62109', 'CE'];

export const PRODUCTOS_DEMO = [
  {
    ficha: {
      sku: 'HEL-PAN-550-JKM', tipo: 'panel', modelo: 'Tiger Neo 550W Bifacial',
      potencia_w: 550, tecnologia_celda: 'topcon', certificaciones: CERT_PANEL, multiplo_de_embalaje: 36,
    },
    ofertas: [
      { fabricante: 'Jinko Solar', moneda: 'USD', precio_lista: 85.0, bonificacion_base_pct: 3, unidades_libres: 1840, dias_de_entrega: 45 },
    ],
  },
  {
    ficha: {
      sku: 'HEL-PAN-580-TRN', tipo: 'panel', modelo: 'Vertex S+ 580W',
      potencia_w: 580, tecnologia_celda: 'topcon', certificaciones: CERT_PANEL, multiplo_de_embalaje: 31,
    },
    ofertas: [
      { fabricante: 'Trina Solar', moneda: 'USD', precio_lista: 92.0, bonificacion_base_pct: 2.5, unidades_libres: 620, dias_de_entrega: 50 },
    ],
  },
  {
    ficha: {
      sku: 'HEL-PAN-540-LNG', tipo: 'panel', modelo: 'Hi-MO 6 540W',
      potencia_w: 540, tecnologia_celda: 'mono_perc', certificaciones: CERT_PANEL, multiplo_de_embalaje: 36,
    },
    ofertas: [
      { fabricante: 'Longi', moneda: 'USD', precio_lista: 80.0, bonificacion_base_pct: 2, unidades_libres: 144, dias_de_entrega: 40 },
    ],
  },
  {
    ficha: {
      sku: 'HEL-INV-50K-SUN', tipo: 'inversor', modelo: 'SG50CX 50kW',
      potencia_w: 50000, certificaciones: CERT_INVERSOR, multiplo_de_embalaje: 1,
    },
    ofertas: [
      { fabricante: 'Sungrow', moneda: 'USD', precio_lista: 2650.0, bonificacion_base_pct: 1.5, unidades_libres: 24, dias_de_entrega: 35 },
    ],
  },
  {
    ficha: {
      sku: 'HEL-INV-36K-HWI', tipo: 'inversor', modelo: 'SUN2000-36KTL 36kW',
      potencia_w: 36000, certificaciones: CERT_INVERSOR, multiplo_de_embalaje: 1,
    },
    ofertas: [
      { fabricante: 'Huawei', moneda: 'USD', precio_lista: 2100.0, bonificacion_base_pct: 1, unidades_libres: 18, dias_de_entrega: 30 },
    ],
  },
];

/**
 * Indexa los productos de demo que todavía no estén en el índice.
 *
 * Usa `create` (no `index`): si el documento ya existe, no se toca. Así un
 * reinicio no pisa con precios de demo lo que ya haya proyectado un evento, y
 * las dos instancias pueden correrla a la vez sin duplicar nada.
 *
 * @param {import('@elastic/elasticsearch').Client} es
 * @returns {Promise<{creados: number, existentes: number}>}
 */
export async function cargarDatosDemo(es, { alias = ALIAS_PRODUCTOS, ahora = new Date() } = {}) {
  const operaciones = PRODUCTOS_DEMO.flatMap(({ ficha, ofertas }) => [
    { create: { _index: alias, _id: ficha.sku } },
    documentoDeProducto({ ficha, ofertas, ahora }),
  ]);

  const respuesta = await es.bulk({ operations: operaciones, refresh: 'wait_for' });

  let creados = 0;
  let existentes = 0;
  for (const { create } of respuesta.items) {
    if (create.status === 201) creados += 1;
    else if (create.status === 409) existentes += 1;
    else throw new Error(`No se pudo indexar ${create._id}: ${JSON.stringify(create.error)}`);
  }
  return { creados, existentes };
}
