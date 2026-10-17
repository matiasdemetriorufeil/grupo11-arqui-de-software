// ---------------------------------------------------------------------------
// Tabla de flete por provincia de destino.
//
// SIMPLIFICACIÓN DOCUMENTADA: el flete real depende del peso, el volumen y la
// distancia, y lo cotiza un transportista. Para el alcance del trabajo alcanza
// con un costo por envío según la provincia, desde el depósito de Córdoba
// (DEP-CBA-01, el que usa stock-service para reservar). El costo se prorratea
// entre todas las unidades del envío (SPEC R3.1).
//
// Importes en USD por envío completo.
// ---------------------------------------------------------------------------

const FLETE_POR_PROVINCIA_USD = {
  cordoba: 350,
  'santa fe': 600,
  'san luis': 600,
  'la rioja': 700,
  'santiago del estero': 700,
  catamarca: 750,
  'buenos aires': 900,
  'ciudad autonoma de buenos aires': 900,
  'la pampa': 900,
  mendoza: 900,
  'san juan': 900,
  tucuman: 900,
  'entre rios': 950,
  salta: 1100,
  jujuy: 1200,
  chaco: 1100,
  corrientes: 1100,
  formosa: 1250,
  misiones: 1300,
  neuquen: 1300,
  'rio negro': 1300,
  chubut: 1600,
  'santa cruz': 1900,
  'tierra del fuego': 2200,
};

/** "Córdoba", " CORDOBA ", "córdoba" → "cordoba". */
function normalizarProvincia(provincia) {
  return String(provincia)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Una provincia que no está en la tabla se rechaza al validar la solicitud, en
 * lugar de cobrarle una tarifa por defecto: un error de tipeo o una tilde mal
 * codificada inflaría el precio sin que el consumidor se entere.
 */
export function esProvinciaConocida(provincia) {
  return normalizarProvincia(provincia) in FLETE_POR_PROVINCIA_USD;
}

/** Costo del envío completo a esa provincia, en USD. */
export function fletePorProvincia(provincia) {
  const flete = FLETE_POR_PROVINCIA_USD[normalizarProvincia(provincia)];
  if (flete === undefined) throw new RangeError(`Provincia sin tarifa de flete: ${provincia}`);
  return flete;
}
