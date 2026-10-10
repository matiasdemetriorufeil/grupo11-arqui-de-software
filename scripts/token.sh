#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Emite un JWT de desarrollo para llamar a la API a través del gateway.
#
#   TOKEN=$(./scripts/token.sh)
#   curl http://localhost:8000/v1/proveedor/catalogo -H "Authorization: Bearer $TOKEN"
#
# Opcionalmente, el primer argumento es el consumidor a impersonar
# (`grupo-consumidor` por defecto; también existe `helios-frontend`).
#
# Sólo sirve en local: firma con el mismo secreto que valida el gateway, que en
# la nube es otro y no está en el repositorio.
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

consumidor="${1:-grupo-consumidor}"

# El secreto sale de .env si existe; si no, del valor por defecto del compose.
secreto="dev-only-no-usar-en-la-nube"
if [[ -f .env ]]; then
  de_env=$(grep -E '^HELIOS_JWT_SECRET=' .env | cut -d= -f2- || true)
  [[ -n "${de_env}" ]] && secreto="${de_env}"
fi

node -e '
const crypto = require("node:crypto");
const [consumidor, secreto] = process.argv.slice(1);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

const encabezado = b64({ alg: "HS256", typ: "JWT" });
const cuerpo = b64({
  iss: consumidor,
  sub: consumidor,
  exp: Math.floor(Date.now() / 1000) + 3600,
  scope: "catalogo:leer cotizaciones:escribir pedidos:escribir",
});
const firma = crypto
  .createHmac("sha256", secreto)
  .update(`${encabezado}.${cuerpo}`)
  .digest("base64url");

console.log(`${encabezado}.${cuerpo}.${firma}`);
' "${consumidor}" "${secreto}"
