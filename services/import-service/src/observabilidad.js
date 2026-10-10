// ---------------------------------------------------------------------------
// Observabilidad compartida del servicio: logs estructurados y correlacion.
//
// Todo log sale en JSON con `servicio`, `instancia` y `correlation_id`, para que
// una operacion se pueda seguir de punta a punta entre los cuatro servicios.
// El gateway genera X-Correlation-Id; si una peticion llega sin el, se crea uno.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import pino from 'pino';
import pinoHttp from 'pino-http';

export const SERVICIO = process.env.SERVICIO ?? 'import-service';
export const INSTANCIA = process.env.INSTANCIA ?? SERVICIO;
export const VERSION = process.env.VERSION ?? '0.1.0';

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { servicio: SERVICIO, instancia: INSTANCIA, version: VERSION },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (etiqueta) => ({ nivel: etiqueta }) },
});

export const CABECERA_CORRELACION = 'x-correlation-id';

export const middlewareDeLogs = pinoHttp({
  logger: log,
  genReqId: (req, res) => {
    const id = req.headers[CABECERA_CORRELACION] ?? randomUUID();
    res.setHeader('X-Correlation-Id', id);
    return id;
  },
  customProps: (req) => ({ correlation_id: req.id }),
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    // El sondeo del balanceador no ensucia los logs.
    if (req.url?.startsWith('/salud/')) return 'silent';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
});
