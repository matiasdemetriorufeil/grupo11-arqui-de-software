// ---------------------------------------------------------------------------
// Reglas de identidad del catálogo unificado.
//
// El problema concreto: cinco fabricantes mandan el mismo panel con cinco
// códigos distintos, y el mismo fabricante lo escribe distinto entre una
// planilla y la siguiente ("JKM550N-72HL4-BDV", "jkm550n 72hl4 bdv",
// "JKM550N-72HL4-BDV."). Sin una normalización estable, cada importación crea
// productos duplicados y el comparador de precios deja de tener sentido.
//
// Lógica pura: tests en test/skus.test.js.
// ---------------------------------------------------------------------------

/** Formato del SKU canónico de Helios. El mismo que valida la base y el contrato. */
const PATRON_SKU = /^HEL-[A-Z]{3}-[A-Z0-9-]{3,20}$/;

/** Prefijo de tres letras por tipo de producto. */
const PREFIJOS = {
  panel: 'PAN',
  inversor: 'INV',
  estructura: 'EST',
  bateria: 'BAT',
};

export function esSkuCanonico(sku) {
  return typeof sku === 'string' && PATRON_SKU.test(sku);
}

/**
 * Normaliza el código propio de un fabricante para poder compararlo.
 *
 * Dos códigos que normalizan al mismo valor se consideran el mismo producto;
 * de ahí que `mapeo_sku` tenga UNIQUE (fabricante_id, codigo_fabricante) sobre
 * el valor normalizado.
 */
export function normalizarCodigoDeFabricante(codigo) {
  if (typeof codigo !== 'string') return '';
  return codigo
    .trim()
    .toUpperCase()
    // Espacios, guiones bajos y barras son separadores equivalentes al guión.
    .replace(/[\s_/]+/g, '-')
    // Varios separadores seguidos valen por uno.
    .replace(/-{2,}/g, '-')
    // Separadores o puntos al principio o al final no aportan identidad.
    .replace(/^[-.]+|[-.]+$/g, '');
}

/**
 * Construye el SKU canónico de un producto NUEVO.
 *
 * Un SKU ya publicado no se recalcula nunca: es el identificador que el grupo
 * consumidor tiene guardado en sus propios pedidos. Si esta función cambia, los
 * productos existentes conservan su SKU (por eso los de los datos de demo no
 * necesariamente coinciden con lo que generaría esta versión).
 *
 * @param {object} args
 * @param {'panel'|'inversor'|'estructura'|'bateria'} args.tipo
 * @param {number} args.potenciaW        Potencia nominal; se expresa en kW para inversores.
 * @param {string} args.fabricante       Nombre canónico del fabricante.
 */
export function construirSku({ tipo, potenciaW, fabricante }) {
  const prefijo = PREFIJOS[tipo];
  if (!prefijo) throw new TypeError(`Tipo de producto desconocido: ${tipo}`);
  if (!(potenciaW > 0)) throw new TypeError('La potencia debe ser mayor a cero');
  if (!fabricante) throw new TypeError('El fabricante es obligatorio');

  // Los inversores se nombran en kW: 50000 W -> "50K". Un panel, en Watts.
  const potencia = tipo === 'inversor' ? `${Math.round(potenciaW / 1000)}K` : String(potenciaW);
  const marca = abreviarFabricante(fabricante);

  return `HEL-${prefijo}-${potencia}-${marca}`;
}

/**
 * Abrevia un fabricante a tres letras estables.
 * Se toman las consonantes de la primera palabra para que "Jinko Solar" y
 * "Jinko Solar Co. Ltd." den el mismo resultado.
 */
export function abreviarFabricante(nombre) {
  const primera = nombre.trim().toUpperCase().split(/\s+/)[0];
  const consonantes = primera.replace(/[^A-Z]/g, '').replace(/[AEIOU]/g, '');
  const base = consonantes.length >= 3 ? consonantes : primera.replace(/[^A-Z]/g, '');
  return base.slice(0, 3).padEnd(3, 'X');
}
