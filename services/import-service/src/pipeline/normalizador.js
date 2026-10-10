// ---------------------------------------------------------------------------
// Etapa de NORMALIZACIÓN del pipeline de importación.
//
// Entrada: una fila cruda tal como vino en la planilla del fabricante, más el
// perfil de mapeo vigente de ese fabricante.
// Salida: una fila canónica, o la lista de errores que impiden normalizarla.
//
// Es el corazón del servicio: acá se absorbe que un fabricante use "1.234,56" y
// otro "$ 1,234.56", que la potencia venga como "550W" o como "550 Wp", y que
// las columnas se llamen distinto en cada planilla.
//
// Lógica pura, sin MongoDB: tests en test/normalizador.test.js.
// ---------------------------------------------------------------------------

/**
 * Transformaciones declarables desde un `perfil_mapeo`.
 *
 * Son sólo de LIMPIEZA de texto. A propósito no hay transformaciones que
 * reinterpreten el formato numérico ni las unidades: eso lo resuelven `aDecimal`
 * (con el `separador_decimal` del perfil) y `aPotenciaW`, que son la única
 * fuente de verdad para esas dos cosas.
 *
 * El motivo es concreto: una transformación "coma_a_punto" aplicada antes de
 * `aDecimal` con separador "," hace que "1.110,20" termine valiendo 111020. Dos
 * componentes interpretando el mismo formato es un error esperando a ocurrir, y
 * un precio mal interpretado por un factor de 1000 cotiza mal todo el catálogo.
 */
export const TRANSFORMACIONES = {
  /** "$ 1,234.56" → "1,234.56" — quita símbolos de moneda y texto suelto. */
  quitar_simbolo_moneda: (v) => String(v).replace(/[^\d.,-]/g, ''),
  /** "  jkm550n  " → "JKM550N" */
  trim_mayusculas: (v) => String(v).trim().toUpperCase(),
  /** "Panel  Tiger   Neo" → "Panel Tiger Neo" */
  colapsar_espacios: (v) => String(v).replace(/\s+/g, ' ').trim(),
};

/**
 * Convierte un valor de celda en un número decimal.
 *
 * Es la operación que más veces se rompe en la práctica, así que es explícita:
 * el separador decimal lo declara el perfil del fabricante, no se adivina. Un
 * precio mal interpretado por un factor de 1000 cotizaría mal todo el catálogo.
 *
 * @returns {number|null} null si la celda no contiene un número usable.
 */
export function aDecimal(valor, separadorDecimal = '.') {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;

  let texto = String(valor).trim();
  // Fuera símbolos de moneda, espacios finos y cualquier cosa que no sea número.
  texto = texto.replace(/[^\d.,-]/g, '');
  if (texto === '' || texto === '-') return null;

  if (separadorDecimal === ',') {
    texto = texto.replace(/\./g, '').replace(',', '.');
  } else {
    // Con punto decimal, las comas son separadores de miles.
    texto = texto.replace(/,/g, '');
  }

  const n = Number(texto);
  return Number.isFinite(n) ? n : null;
}

/** Extrae la potencia en Watts de celdas como "550", "550W", "550 Wp", "0.55 kW". */
export function aPotenciaW(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const texto = String(valor).trim().toLowerCase();
  const numero = aDecimal(texto.replace(/[a-z]/g, ''), '.');
  if (numero === null) return null;
  // Si la celda dice kW, se pasa a Watts.
  const enKw = /\bkw\b|kwp/.test(texto);
  const watts = enKw ? numero * 1000 : numero;
  return watts > 0 ? Math.round(watts) : null;
}

/**
 * Normaliza una fila cruda según el perfil de mapeo del fabricante.
 *
 * @param {object} filaCruda   Objeto columna → valor, tal como se leyó la planilla.
 * @param {object} perfil      Documento de `perfil_mapeo`.
 * @returns {{ok: true, fila: object} | {ok: false, errores: Array<{campo: string, mensaje: string}>}}
 */
export function normalizarFila(filaCruda, perfil) {
  const errores = [];
  const separador = perfil.separador_decimal ?? '.';
  const columnas = perfil.columnas ?? {};

  const leer = (campo) => {
    const columna = columnas[campo];
    if (columna === undefined) return undefined;
    const bruto = filaCruda[columna];
    return aplicarTransformaciones(bruto, campo, perfil.transformaciones);
  };

  // --- Código del fabricante: sin esto la fila no se puede mapear ----------
  const codigo = leer('codigo_fabricante');
  const codigoNormalizado = codigo === undefined ? '' : String(codigo).trim().toUpperCase();
  if (!codigoNormalizado) {
    errores.push({
      campo: 'codigo_fabricante',
      mensaje: `No se encontró valor en la columna "${columnas.codigo_fabricante ?? '(no mapeada)'}".`,
    });
  }

  // --- Precio de lista: sin precio la fila no sirve para comparar ----------
  const precio = aDecimal(leer('precio_lista'), separador);
  if (precio === null) {
    errores.push({
      campo: 'precio_lista',
      mensaje: `No se pudo interpretar un precio en la columna "${columnas.precio_lista ?? '(no mapeada)'}".`,
    });
  } else if (precio <= 0) {
    errores.push({ campo: 'precio_lista', mensaje: 'El precio debe ser mayor a cero.' });
  }

  // --- Campos opcionales: su ausencia no invalida la fila -----------------
  const potencia = aPotenciaW(leer('potencia_w'));
  const bonificacion = aDecimal(leer('bonificacion_pct'), separador);
  const porPallet = aDecimal(leer('unidades_por_pallet'), separador);
  const descripcion = leer('descripcion');

  if (bonificacion !== null && (bonificacion < 0 || bonificacion > 100)) {
    errores.push({
      campo: 'bonificacion_pct',
      mensaje: 'Una bonificación válida está entre 0 y 100.',
    });
  }

  if (errores.length > 0) return { ok: false, errores };

  return {
    ok: true,
    fila: {
      codigo_fabricante: codigoNormalizado,
      descripcion: descripcion ? String(descripcion).trim() : null,
      potencia_w: potencia,
      precio_lista: precio,
      moneda: perfil.moneda_por_defecto ?? 'USD',
      bonificacion_pct: bonificacion,
      unidades_por_pallet: porPallet !== null && porPallet >= 1 ? Math.round(porPallet) : null,
    },
  };
}

/**
 * Resumen del lote: lo que decide si la lista se aplica al catálogo o se rechaza.
 *
 * Regla: una lista con más del 10 % de filas con error se rechaza completa. Es
 * deliberado — aplicar media lista de precios deja el comparador en un estado
 * peor que no haberla importado, porque los productos que sí entraron compiten
 * con precios viejos de los que no entraron.
 */
export function evaluarLote({ filasTotal, filasConError, umbralDeErrorPct = 10 }) {
  if (filasTotal === 0) {
    return { aplicar: false, motivo: 'La planilla no tiene filas de datos.' };
  }
  const porcentaje = (filasConError / filasTotal) * 100;
  if (porcentaje > umbralDeErrorPct) {
    return {
      aplicar: false,
      motivo:
        `${filasConError} de ${filasTotal} filas con error (${porcentaje.toFixed(1)} %), ` +
        `por encima del umbral de ${umbralDeErrorPct} %.`,
      porcentaje_error: Number(porcentaje.toFixed(1)),
    };
  }
  return { aplicar: true, porcentaje_error: Number(porcentaje.toFixed(1)) };
}

function aplicarTransformaciones(valor, campo, transformaciones = []) {
  let actual = valor;
  for (const t of transformaciones) {
    if (t.campo !== campo) continue;
    const fn = TRANSFORMACIONES[t.tipo];
    if (fn && actual !== undefined && actual !== null) actual = fn(actual);
  }
  return actual;
}
