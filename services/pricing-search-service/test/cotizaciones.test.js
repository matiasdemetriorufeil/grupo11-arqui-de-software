// ---------------------------------------------------------------------------
// Tests de cotizaciones: cálculo, flete, estado y rutas HTTP.
//
// Sin infraestructura: el índice y Redis se reemplazan por dobles. Contra
// Elasticsearch y Redis reales: cotizaciones.integracion.test.js.
// ---------------------------------------------------------------------------

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { PRODUCTOS_DEMO } from '../src/projection/datos-demo.js';
import { documentoDeProducto } from '../src/projection/proyector.js';
import { armarCotizacion, conEstadoActual } from '../src/query/cotizacion.js';
import { crearCotizaciones } from '../src/query/cotizaciones.js';
import { esProvinciaConocida, fletePorProvincia } from '../src/query/flete.js';
import { routerDeBusqueda } from '../src/http/rutas-busqueda.js';
import { middlewareDeErrores } from '../src/problema.js';

const AHORA = new Date('2026-10-17T12:00:00Z');
const DOCUMENTOS = new Map(PRODUCTOS_DEMO.map((p) => [p.ficha.sku, documentoDeProducto(p)]));
const DESTINO = { provincia: 'Córdoba', localidad: 'Villa María' };

function cotizar(lineas, { destino = DESTINO, documentos = DOCUMENTOS } = {}) {
  return armarCotizacion({ solicitud: { destino, lineas }, documentosPorSku: documentos, id: 'c-1', ahora: AHORA });
}

// --- Flete -------------------------------------------------------------------

describe('fletePorProvincia', () => {
  test('normaliza mayúsculas, tildes y espacios', () => {
    for (const escrita of ['Córdoba', 'CORDOBA', '  córdoba ', 'Cordoba']) {
      assert.equal(fletePorProvincia(escrita), 350, escrita);
    }
    assert.equal(fletePorProvincia('Ciudad Autónoma de Buenos Aires'), 900);
  });

  test('una provincia desconocida no tiene tarifa: nunca se cobra un flete inventado', () => {
    assert.equal(esProvinciaConocida('Atlantis'), false);
    // "Córdoba" con la tilde mal codificada (UTF-8 leído como Latin-1).
    assert.equal(esProvinciaConocida('CÃ³rdoba'), false);
    assert.throws(() => fletePorProvincia('Atlantis'), RangeError);
  });
});

// --- Cálculo -------------------------------------------------------------------

describe('armarCotizacion', () => {
  test('el ejemplo del contrato: precio unitario en el orden de R3.1', () => {
    const c = cotizar([
      { sku: 'HEL-PAN-550-JKM', cantidad: 108 },
      { sku: 'HEL-INV-50K-SUN', cantidad: 2, fabricante_preferido: 'Sungrow' },
    ]);
    const [panel, inversor] = c.lineas;

    // 110 unidades → 1,5 % por volumen, que se suma al 3 % base de Jinko.
    // (85 × 0,955 + 350 / 110) × 1,21 = 102,0717
    assert.deepEqual(panel.precio_unitario, { monto: '102.07', moneda: 'USD' });
    assert.deepEqual(panel.subtotal, { monto: '11023.56', moneda: 'USD' });
    assert.equal(panel.bonificacion_por_volumen_pct, 1.5);
    assert.equal(panel.fabricante_elegido, 'Jinko Solar');
    assert.equal(panel.costo_por_watt, 0.18558);

    // (2650 × 0,97 + 350 / 110) × 1,21 = 3114,155
    assert.deepEqual(inversor.precio_unitario, { monto: '3114.16', moneda: 'USD' });
    assert.equal(inversor.motivo_eleccion, 'fabricante_preferido');

    assert.deepEqual(c.flete, { monto: '350.00', moneda: 'USD' });
    assert.deepEqual(c.total, { monto: '17251.88', moneda: 'USD' });
  });

  test('el total es la suma exacta de los subtotales y el desglose cierra al centavo', () => {
    const c = cotizar([
      { sku: 'HEL-PAN-550-JKM', cantidad: 108 },
      { sku: 'HEL-PAN-580-TRN', cantidad: 62 },
      { sku: 'HEL-INV-36K-HWI', cantidad: 3 },
    ]);
    const centavos = (d) => Math.round(Number(d.monto) * 100);
    const sumaSubtotales = c.lineas.reduce((acc, l) => acc + centavos(l.subtotal), 0);

    assert.equal(centavos(c.total), sumaSubtotales);
    assert.equal(centavos(c.subtotal_mercaderia) + centavos(c.flete) + centavos(c.impuestos), centavos(c.total));
  });

  test('la bonificación por volumen se calcula sobre el pedido completo, no por línea', () => {
    // 72 + 62 = 134 unidades: ninguna línea llega a 100, el pedido sí.
    const c = cotizar([
      { sku: 'HEL-PAN-550-JKM', cantidad: 72 },
      { sku: 'HEL-PAN-580-TRN', cantidad: 62 },
    ]);
    assert.ok(c.lineas.every((l) => l.bonificacion_por_volumen_pct === 1.5));
  });

  test('el flete se prorratea: más unidades, menos flete por unidad', () => {
    const chico = cotizar([{ sku: 'HEL-PAN-550-JKM', cantidad: 36 }], { destino: { provincia: 'Chubut', localidad: 'x' } });
    const grande = cotizar([{ sku: 'HEL-PAN-550-JKM', cantidad: 72 }], { destino: { provincia: 'Chubut', localidad: 'x' } });
    assert.ok(Number(grande.lineas[0].precio_unitario.monto) < Number(chico.lineas[0].precio_unitario.monto));
  });

  test('el destino cambia el precio a través del flete', () => {
    const cordoba = cotizar([{ sku: 'HEL-PAN-550-JKM', cantidad: 36 }]);
    const ushuaia = cotizar([{ sku: 'HEL-PAN-550-JKM', cantidad: 36 }], {
      destino: { provincia: 'Tierra del Fuego', localidad: 'Ushuaia' },
    });
    assert.ok(Number(ushuaia.total.monto) > Number(cordoba.total.monto));
  });

  test('elige al de mejor costo por Watt con stock, salvo fabricante preferido', () => {
    const multi = documentoDeProducto({
      ficha: PRODUCTOS_DEMO[0].ficha,
      ofertas: [
        { fabricante: 'Caro', moneda: 'USD', precio_lista: 90, bonificacion_base_pct: 0, unidades_libres: 500, dias_de_entrega: 10 },
        { fabricante: 'Barato', moneda: 'USD', precio_lista: 80, bonificacion_base_pct: 0, unidades_libres: 500, dias_de_entrega: 60 },
      ],
    });
    const documentos = new Map([['HEL-PAN-550-JKM', multi]]);

    const porRanking = cotizar([{ sku: 'HEL-PAN-550-JKM', cantidad: 36 }], { documentos });
    assert.equal(porRanking.lineas[0].fabricante_elegido, 'Barato');
    assert.equal(porRanking.lineas[0].motivo_eleccion, 'mejor_costo_por_watt');

    const preferido = cotizar([{ sku: 'HEL-PAN-550-JKM', cantidad: 36, fabricante_preferido: 'Caro' }], { documentos });
    assert.equal(preferido.lineas[0].fabricante_elegido, 'Caro');
  });

  test('vigencia de 15 minutos desde la emisión', () => {
    const c = cotizar([{ sku: 'HEL-PAN-550-JKM', cantidad: 36 }]);
    assert.equal(c.estado, 'vigente');
    assert.equal(c.emitida_en, '2026-10-17T12:00:00.000Z');
    assert.equal(c.vigente_hasta, '2026-10-17T12:15:00.000Z');
  });

  test('cantidad que no es múltiplo del pallet: 422 nombrando la línea', () => {
    assert.throws(() => cotizar([{ sku: 'HEL-PAN-550-JKM', cantidad: 100 }]), (err) => {
      assert.equal(err.codigo, 'CANTIDAD_NO_MULTIPLO_EMBALAJE');
      assert.equal(err.status, 422);
      assert.deepEqual(err.extra.errores_de_validacion.map((e) => e.campo), ['lineas[0].cantidad']);
      return true;
    });
  });

  test('informa TODAS las líneas con problemas, no sólo la primera', () => {
    assert.throws(
      () =>
        cotizar([
          { sku: 'HEL-PAN-999-XXX', cantidad: 1 },
          { sku: 'HEL-PAN-550-JKM', cantidad: 100 },
        ]),
      (err) => {
        assert.equal(err.codigo, 'SKU_DESCONTINUADO');
        assert.deepEqual(err.extra.errores_de_validacion.map((e) => e.campo), ['lineas[0].sku', 'lineas[1].cantidad']);
        return true;
      },
    );
  });

  test('sin ninguna oferta con stock no se cotiza', () => {
    const sinStock = documentoDeProducto({
      ficha: PRODUCTOS_DEMO[0].ficha,
      ofertas: [{ ...PRODUCTOS_DEMO[0].ofertas[0], unidades_libres: 0 }],
    });
    assert.throws(
      () => cotizar([{ sku: 'HEL-PAN-550-JKM', cantidad: 36 }], { documentos: new Map([['HEL-PAN-550-JKM', sinStock]]) }),
      { codigo: 'SKU_DESCONTINUADO' },
    );
  });
});

describe('conEstadoActual', () => {
  const c = cotizar([{ sku: 'HEL-PAN-550-JKM', cantidad: 36 }]);

  test('vigente hasta un instante antes del vencimiento', () => {
    assert.equal(conEstadoActual(c, new Date('2026-10-17T12:14:59.999Z')).estado, 'vigente');
  });

  test('expirada en el instante del vencimiento', () => {
    assert.equal(conEstadoActual(c, new Date('2026-10-17T12:15:00Z')).estado, 'expirada');
  });
});

// --- Rutas HTTP ----------------------------------------------------------------

/** Repositorio en memoria con el mismo contrato que el de Redis. */
function repositorioEnMemoria() {
  const datos = new Map();
  return {
    async guardar(cotizacion, consumidor) {
      datos.set(cotizacion.cotizacion_id, { cotizacion, consumidor });
    },
    async obtener(id) {
      return datos.get(id) ?? null;
    },
  };
}

describe('rutas de cotizaciones', () => {
  let servidor;
  let base;
  let reloj = AHORA;
  const repositorio = repositorioEnMemoria();

  before(async () => {
    const es = {
      async mget({ ids }) {
        return { docs: ids.map((id) => (DOCUMENTOS.has(id) ? { _id: id, found: true, _source: DOCUMENTOS.get(id) } : { _id: id, found: false })) };
      },
    };
    let n = 0;
    const cotizaciones = crearCotizaciones({
      es,
      repositorio,
      reloj: () => reloj,
      generarId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    });

    const app = express();
    app.use(express.json());
    app.use('/v1', routerDeBusqueda({ cotizaciones }));
    app.use(middlewareDeErrores({ error() {} }));
    servidor = app.listen(0);
    await new Promise((resolve) => servidor.once('listening', resolve));
    base = `http://127.0.0.1:${servidor.address().port}/v1/proveedor/cotizaciones`;
  });

  after(() => new Promise((resolve) => servidor.close(resolve)));

  const CUERPO = { destino: DESTINO, lineas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 108 }] };

  function post(cuerpo, consumidor = 'grupo-consumidor') {
    return fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(consumidor ? { 'X-Consumer-Username': consumidor } : {}) },
      body: JSON.stringify(cuerpo),
    });
  }

  function get(id, consumidor = 'grupo-consumidor') {
    return fetch(`${base}/${id}`, { headers: { 'X-Consumer-Username': consumidor } });
  }

  test('POST 201 con Location, y el dueño la puede consultar', async () => {
    const res = await post(CUERPO);
    assert.equal(res.status, 201);
    const cotizacion = await res.json();
    assert.equal(res.headers.get('location'), `/v1/proveedor/cotizaciones/${cotizacion.cotizacion_id}`);

    const leida = await get(cotizacion.cotizacion_id);
    assert.equal(leida.status, 200);
    assert.deepEqual(await leida.json(), cotizacion);
  });

  test('otro consumidor no la ve: 404, no 403', async () => {
    const { cotizacion_id } = await (await post(CUERPO)).json();
    assert.equal((await get(cotizacion_id, 'otro-grupo')).status, 404);
  });

  test('pasada la vigencia responde 200 con estado expirada', async () => {
    const { cotizacion_id } = await (await post(CUERPO)).json();
    reloj = new Date(AHORA.getTime() + 15 * 60_000);
    try {
      const res = await get(cotizacion_id);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).estado, 'expirada');
    } finally {
      reloj = AHORA;
    }
  });

  test('sin consumidor identificado: 401', async () => {
    assert.equal((await post(CUERPO, null)).status, 401);
  });

  test('un id que no es UUID es un 404, no un 400', async () => {
    assert.equal((await get('no-es-un-uuid')).status, 404);
  });

  for (const [descripcion, cuerpo, campo] of [
    ['sin localidad', { ...CUERPO, destino: { provincia: 'Córdoba' } }, 'destino.localidad'],
    ['provincia desconocida', { ...CUERPO, destino: { provincia: 'Cordova', localidad: 'x' } }, 'destino.provincia'],
    ['moneda ARS', { ...CUERPO, moneda: 'ARS' }, 'moneda'],
    ['SKU fuera de formato', { ...CUERPO, lineas: [{ sku: 'jkm550', cantidad: 36 }] }, 'lineas[0].sku'],
    [
      'SKU repetido',
      { ...CUERPO, lineas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 36 }, { sku: 'HEL-PAN-550-JKM', cantidad: 72 }] },
      'lineas[1].sku',
    ],
  ]) {
    test(`400 ${descripcion}, nombrando el campo`, async () => {
      const res = await post(cuerpo);
      assert.equal(res.status, 400);
      assert.deepEqual((await res.json()).errores_de_validacion.map((e) => e.campo), [campo]);
    });
  }

  test('422 con una regla de negocio incumplida', async () => {
    const res = await post({ ...CUERPO, lineas: [{ sku: 'HEL-PAN-550-JKM', cantidad: 100 }] });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).codigo, 'CANTIDAD_NO_MULTIPLO_EMBALAJE');
  });
});
