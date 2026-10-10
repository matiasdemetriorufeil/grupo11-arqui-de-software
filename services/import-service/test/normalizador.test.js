// ---------------------------------------------------------------------------
// Tests de la etapa de normalización del pipeline de importación.
//
//   npm test   (desde services/import-service)
//
// Los casos salen de planillas reales de fabricantes: formatos de número
// distintos, unidades mezcladas y columnas con nombres propios de cada marca.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aDecimal,
  aPotenciaW,
  evaluarLote,
  normalizarFila,
} from '../src/pipeline/normalizador.js';

// Los dos perfiles que vienen cargados en la base de demo.
const PERFIL_JINKO = {
  fabricante: 'Jinko Solar',
  version: 1,
  separador_decimal: '.',
  moneda_por_defecto: 'USD',
  columnas: {
    codigo_fabricante: 'Model No.',
    descripcion: 'Description',
    potencia_w: 'Pmax (W)',
    precio_lista: 'FOB Price USD/pc',
    unidades_por_pallet: 'Pcs/Pallet',
  },
  transformaciones: [
    { campo: 'precio_lista', tipo: 'quitar_simbolo_moneda' },
    { campo: 'codigo_fabricante', tipo: 'trim_mayusculas' },
  ],
};

const PERFIL_TRINA = {
  fabricante: 'Trina Solar',
  version: 1,
  separador_decimal: ',',
  moneda_por_defecto: 'USD',
  columnas: {
    codigo_fabricante: 'CODIGO',
    descripcion: 'DETALLE DEL PRODUCTO',
    potencia_w: 'POTENCIA',
    precio_lista: 'PRECIO UNIT.',
    bonificacion_pct: 'DTO %',
    unidades_por_pallet: 'BULTO',
  },
  // El formato decimal lo declara `separador_decimal`; no se transforma el
  // número a mano (ver el comentario de TRANSFORMACIONES en el normalizador).
  transformaciones: [{ campo: 'descripcion', tipo: 'colapsar_espacios' }],
};

// --- Interpretación de números --------------------------------------------

test('interpreta precios con punto decimal y separador de miles', () => {
  assert.equal(aDecimal('1,234.56', '.'), 1234.56);
  assert.equal(aDecimal('$ 85.00', '.'), 85);
  assert.equal(aDecimal('85', '.'), 85);
});

test('interpreta precios con coma decimal', () => {
  assert.equal(aDecimal('1.234,56', ','), 1234.56);
  assert.equal(aDecimal('110,20', ','), 110.2);
});

test('el separador lo declara el perfil, no se adivina', () => {
  // La misma celda significa cosas distintas según el fabricante. Si esto se
  // adivinara, un precio podría quedar mil veces más alto o más bajo.
  assert.equal(aDecimal('1.234', '.'), 1.234);
  assert.equal(aDecimal('1.234', ','), 1234);
});

test('devuelve null para celdas sin número usable', () => {
  assert.equal(aDecimal('', '.'), null);
  assert.equal(aDecimal(null, '.'), null);
  assert.equal(aDecimal('consultar', '.'), null);
  assert.equal(aDecimal('-', '.'), null);
});

test('acepta celdas que ya son numéricas (planillas xlsx)', () => {
  assert.equal(aDecimal(85.5, '.'), 85.5);
  assert.equal(aDecimal(Number.NaN, '.'), null);
});

// --- Interpretación de potencia -------------------------------------------

test('extrae la potencia venga como venga', () => {
  assert.equal(aPotenciaW('550'), 550);
  assert.equal(aPotenciaW('550W'), 550);
  assert.equal(aPotenciaW('550 Wp'), 550);
  assert.equal(aPotenciaW(580), 580);
});

test('convierte kW a Watts', () => {
  assert.equal(aPotenciaW('50 kW'), 50000);
  assert.equal(aPotenciaW('0.55 kWp'), 550);
});

test('una potencia que no se entiende queda en null, no en cero', () => {
  assert.equal(aPotenciaW('s/d'), null);
  assert.equal(aPotenciaW(''), null);
});

// --- Normalización de filas completas -------------------------------------

test('normaliza una fila del formato Jinko', () => {
  const resultado = normalizarFila(
    {
      'Model No.': ' jkm550n-72hl4-bdv ',
      Description: 'Tiger Neo 550W Bifacial',
      'Pmax (W)': '550W',
      'FOB Price USD/pc': '$ 85.00',
      'Pcs/Pallet': '36',
    },
    PERFIL_JINKO,
  );

  assert.equal(resultado.ok, true);
  assert.deepEqual(resultado.fila, {
    codigo_fabricante: 'JKM550N-72HL4-BDV',
    descripcion: 'Tiger Neo 550W Bifacial',
    potencia_w: 550,
    precio_lista: 85,
    moneda: 'USD',
    bonificacion_pct: null,
    unidades_por_pallet: 36,
  });
});

test('normaliza una fila del formato Trina, con coma decimal y columnas propias', () => {
  const resultado = normalizarFila(
    {
      CODIGO: 'TSM-580NEG19RC.20',
      'DETALLE DEL PRODUCTO': 'Vertex  S+   580W',
      POTENCIA: '580 Wp',
      'PRECIO UNIT.': '1.110,20',
      'DTO %': '2,5',
      BULTO: '31',
    },
    PERFIL_TRINA,
  );

  assert.equal(resultado.ok, true);
  assert.equal(resultado.fila.codigo_fabricante, 'TSM-580NEG19RC.20');
  assert.equal(resultado.fila.precio_lista, 1110.2);
  assert.equal(resultado.fila.potencia_w, 580);
  assert.equal(resultado.fila.bonificacion_pct, 2.5);
  assert.equal(resultado.fila.descripcion, 'Vertex S+ 580W');
});

test('el formato decimal se interpreta una sola vez', () => {
  // Regresión: con una transformación que además convertía coma a punto, este
  // precio terminaba valiendo 111020 (mil veces más).
  const resultado = normalizarFila(
    { CODIGO: 'TSM-580', 'PRECIO UNIT.': '1.110,20' },
    PERFIL_TRINA,
  );
  assert.equal(resultado.fila.precio_lista, 1110.2);
});

test('una fila sin código de fabricante no se puede mapear a un producto', () => {
  const resultado = normalizarFila(
    { 'Model No.': '   ', 'FOB Price USD/pc': '85.00' },
    PERFIL_JINKO,
  );
  assert.equal(resultado.ok, false);
  assert.equal(resultado.errores[0].campo, 'codigo_fabricante');
});

test('una fila sin precio interpretable se rechaza con el nombre de la columna', () => {
  const resultado = normalizarFila(
    { 'Model No.': 'JKM550N', 'FOB Price USD/pc': 'consultar' },
    PERFIL_JINKO,
  );
  assert.equal(resultado.ok, false);
  const error = resultado.errores.find((e) => e.campo === 'precio_lista');
  assert.ok(error.mensaje.includes('FOB Price USD/pc'), 'el error nombra la columna del fabricante');
});

test('rechaza precios no positivos', () => {
  const resultado = normalizarFila(
    { 'Model No.': 'JKM550N', 'FOB Price USD/pc': '0' },
    PERFIL_JINKO,
  );
  assert.equal(resultado.ok, false);
  assert.ok(resultado.errores.some((e) => e.campo === 'precio_lista'));
});

test('rechaza bonificaciones fuera de rango', () => {
  const resultado = normalizarFila(
    { CODIGO: 'TSM-580', 'PRECIO UNIT.': '100,00', 'DTO %': '150' },
    PERFIL_TRINA,
  );
  assert.equal(resultado.ok, false);
  assert.ok(resultado.errores.some((e) => e.campo === 'bonificacion_pct'));
});

test('acumula todos los errores de una fila, no sólo el primero', () => {
  const resultado = normalizarFila({ 'Model No.': '', 'FOB Price USD/pc': 'n/d' }, PERFIL_JINKO);
  assert.equal(resultado.ok, false);
  assert.equal(resultado.errores.length, 2);
});

// --- Decisión sobre el lote completo --------------------------------------

test('aplica un lote con pocas filas con error', () => {
  const decision = evaluarLote({ filasTotal: 100, filasConError: 5 });
  assert.equal(decision.aplicar, true);
  assert.equal(decision.porcentaje_error, 5);
});

test('rechaza el lote completo si se pasa del umbral de error', () => {
  const decision = evaluarLote({ filasTotal: 100, filasConError: 25 });
  assert.equal(decision.aplicar, false);
  assert.ok(decision.motivo.includes('25'));
});

test('rechaza una planilla sin filas de datos', () => {
  assert.equal(evaluarLote({ filasTotal: 0, filasConError: 0 }).aplicar, false);
});

test('el umbral es configurable por lote', () => {
  assert.equal(evaluarLote({ filasTotal: 100, filasConError: 25, umbralDeErrorPct: 30 }).aplicar, true);
});
