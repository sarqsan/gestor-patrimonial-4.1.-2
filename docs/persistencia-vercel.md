# Persistencia del Gestor Patrimonial en Vercel (arquitectura, reinicialización e importación)

Fecha: 2026-10-11 · Rama de trabajo: `arena/e65d6133-gestor-patrimonial-4-1-2` (continuación de `arena/8d1e8838-gestor-patrimonial-4-1-2`, PR #12)

## 1. Arquitectura implantada

```
Navegador ──(mismo origen, /api/vault?op=…, sesión por usuario)──► Función serverless (api/[...route].ts)
                                                                 ├─ auth: registro/login (scrypt) + token HMAC
                                                                 ├─ datos estructurados (JSON por entidad)
                                                                 ├─ documentos: contenido binario + metadatos (SHA-256)
                                                                 ├─ expediente fiscal (JSON y ZIP) y copias
                                                                 └─ auditoría por cuenta
                                                                        │
                                                     @vercel/blob (SDK oficial, almacén PRIVADO)
                                                     objeto → vault/users/<cuenta>/...
```

| Responsabilidad | Dónde vive | Detalle |
| --- | --- | --- |
| Usuarios y cuentas | Almacén remoto | `vault/users/<cuenta>/account.json` (salt + hash scrypt; nunca la contraseña) |
| Movimientos | Almacén remoto | `vault/users/<cuenta>/movements/<id>.json` (una entidad por objeto: idempotente por id) |
| Documentos (metadatos) | Almacén remoto | `vault/users/<cuenta>/files/<id>.json` (nombre, tipo, tamaño, SHA-256, vínculos) |
| Documentos (contenido) | Almacén remoto PRIVADO | `vault/users/<cuenta>/contents/<id>` |
| Copias de seguridad | Almacén remoto | `vault/users/<cuenta>/backups/<id>.json` |
| Auditoría | Almacén remoto | `vault/users/<cuenta>/audit/<evento>.json` |
| Secretos/sesiones | Almacén remoto | `vault/secret.key` (clave HMAC de las sesiones, generada por el servidor) |
| Presentación | Vercel (estático) | `dist/` construido por `vite build` |

Decisiones clave:

- **El sistema de ficheros de la función serverless no es persistencia.** Por eso, en Vercel
  (`VERCEL=1`) el backend **nunca** elige el disco: si el almacén remoto no está conectado, el
  driver es `unconfigured`, las lecturas devuelven vacío y las **escrituras fallan con un error
  explícito** (HTTP 503). No hay falso éxito ni guardado local silencioso.
- **Nada de un índice único compartido**: cada entidad es un objeto independiente, así que dos
  escrituras concurrentes no se pisan y reintentar es idempotente por identificador.
- **El navegador no almacena documentos ni recibe credenciales del almacén.** Solo guarda su token
  de sesión. Las URLs de los objetos privados nunca salen del servidor.
- **Integridad verificable**: el servidor calcula el SHA-256 al recibir el contenido, y también lo
  recomprueba **al servir** (un objeto alterado no se entrega: 502).
- **Subidas grandes sin pasar por el límite de cuerpo de Vercel**: el servidor firma una subida
  directa (`POST /api/vault?op=files.presign`) acotada a un objeto, un tipo, un tamaño y 10 minutos;
  el navegador escribe en el almacén privado y después el servidor descarga el objeto, recalcula el
  hash y consolida los metadatos (`POST /api/vault?op=files.commit&id=…`). Si el hash no coincide, el
  objeto se descarta y la subida no se declara completada.

### Rutas de la API

**Forma principal (compatible con Vercel): `MÉTODO /api/vault?op=<operación>[&id=…]`** — un solo
segmento de ruta, con la operación y el identificador opcional en la consulta. Ver «Enrutado
compatible con Vercel» más abajo.

| Método y URL | Función |
| --- | --- |
| `GET /api/vault?op=health` | Estado del destino (`durable`, `driver`, `storageOk`, `directUpload`, `maxFileBytes`) |
| `POST /api/vault?op=auth.register` · `POST /api/vault?op=auth.login` | Alta y acceso con las mismas credenciales de la aplicación |
| `GET /api/vault?op=session` | Cuenta de la sesión |
| `GET/PUT /api/vault?op=movimientos` | Lectura y sincronización idempotente de movimientos |
| `POST /api/vault?op=files.upload` · `POST /api/vault?op=files.presign` · `POST /api/vault?op=files.commit&id=…` | Subida (cuerpo JSON o directa firmada) |
| `GET/DELETE /api/vault?op=files.get&id=…` · `GET /api/vault?op=files.list` | Listado, descarga autenticada (con `x-vault-sha256`) y borrado |
| `GET /api/vault?op=expediente&from=…&to=…` · `GET /api/vault?op=expediente.zip` | Expediente fiscal por fechas (JSON o ZIP único) |
| `POST/GET /api/vault?op=backups.create` · `GET /api/vault?op=backups.get&id=…` · `GET /api/vault?op=backups.list` | Copias de la cartera |
| `GET /api/vault?op=audit&limit=…` | Trazabilidad de las operaciones de la propia cuenta |

También se aceptan los nombres cortos por recurso y Método (`op=files`, `op=backups`,
`op=movimientos`) y la **ruta anidada clásica** (`GET /api/vault/files/:id`, …) donde la petición
sí alcanza Express (desarrollo local y Render): las dos formas son equivalentes y comparten los
mismos controles.

Todas las rutas de datos exigen `Authorization: Bearer <token>` y resuelven los recursos **siempre**
bajo la carpeta de la cuenta del token.

### Enrutado compatible con Vercel (hallazgo y solución)

**Hallazgo.** En el despliegue de Vercel, las rutas **anidadas** del vault (`/api/vault/files/:id`,
`/api/vault/auth/login`, …) devolvían un **404 de la propia plataforma antes de alcanzar Express**:
la petición nunca llegaba al router ni a sus controles de autenticación. Cualquier operación que
necesitara un segundo segmento de ruta quedaba inutilizada en producción aunque funcionara en
local.

**Solución.** La forma que en Vercel **siempre** alcanza la función y el router es la de un solo
segmento de ruta con la operación en la consulta:

```
/api/vault?op=<operación>[&id=…]
```

- El cliente (`src/lib/vaultClient.ts`, `vaultOperationUrl`) usa esta forma para todas las
  operaciones.
- La **capa de compatibilidad vive dentro del router** (`server/vault/routes.ts`): traduce
  `?op=<operación>[&id=…]` a la ruta interna equivalente y continúa el despacho normal, con los
  **mismos middlewares y los mismos controles de autenticación y autorización** que la forma
  anidada. El resto de la consulta (`from`, `to`, `limit`, …) se conserva.
- La forma anidada clásica **sigue funcionando** donde sí alcanza Express: no se rompe el montaje
  existente en `server/apiApp.ts`.
- Los errores de la forma compatible son explícitos (JSON con `ok: false` y mensaje): operación
  desconocida → 400, método no admitido → 405, identificador ausente o manipulado → 400, forma
  mixta (ruta anidada + `op`) → 400. Nunca se degradan a un 404 genérico de plataforma.

Verificación automatizada: `server/vault/routingCompatibility.test.ts` (R1–R7: llegada al router,
equivalencia de formas, autenticación idéntica, aislamiento entre cuentas, errores explícitos,
regresión del montaje Express y tabla de operaciones).

## 2. Configuración necesaria en Vercel

1. **Almacén Blob privado conectado al proyecto** (`gestor-patrimonial-documentos`). Al conectarlo,
   Vercel inyecta `BLOB_READ_WRITE_TOKEN` en los entornos del proyecto (producción, previsualización
   y desarrollo). No hay que copiar el token al repositorio: **nunca** se versiona un secreto.
2. **Nada más**: no se necesita volumen, ni `DATABASE_URL`, ni Render. El proyecto sigue en Vercel.
3. Comprobación: `GET /api/vault?op=health` debe responder `{"driver":"vercel-blob","durable":true,"storageOk":true}`.
   La pestaña «Sincronización» de la aplicación muestra ese mismo estado en lenguaje llano.

Si el almacén no está conectado, el backend funciona en modo degradado **declarado**: la interfaz
avisa («NO conectado») y cada intento de subida se cancela con un mensaje explícito.

## 3. Reinicialización (autorizada por el propietario)

El propietario ha autorizado descartar los datos actuales. Con la nueva arquitectura la
reinicialización es **implícita y no destructiva**:

1. La aplicación arranca con un almacén remoto vacío: la primera cuenta se crea al registrarse en la
   pantalla de acceso (las credenciales de la aplicación son las del almacén).
2. Los datos antiguos del navegador (Firestore fuera de servicio + `localStorage`) **no se borran**:
   quedan en el dispositivo y pueden descartarse o importarse. La aplicación no los envía al almacén
   automáticamente como si fueran datos del servidor.
3. **No se elimina nada del almacén Blob de forma indiscriminada**: el reinicio de metadatos es
   independiente del borrado de archivos. Para vaciar una cuenta concreta se borran los objetos
   `vault/users/<cuenta>/...` de esa cuenta, sin tocar `vault/secret.key` (invalida todas las
   sesiones) ni las demás cuentas.

Procedimiento recomendado, en este orden:

| Paso | Acción | Comprobación |
| --- | --- | --- |
| 1 | Confirmar el almacén correcto con `GET /api/vault?op=health` | `driver: vercel-blob`, `storageOk: true` |
| 2 | Registrar la cuenta administradora desde la interfaz | `POST /api/vault?op=auth.register` → 201; login → token |
| 3 | Importar el expediente descargado (sección 4) | Recuentos de inmuebles/movimientos/documentos |
| 4 | Descargar un justificante y abrir el expediente ZIP | SHA-256 del archivo descargado coincide |
| 5 | Cerrar sesión y volver a entrar (o esperar un nuevo despliegue) | Los datos siguen ahí: eran del almacén |

## 4. Importación de los datos descargados

La importación ocurre **en la interfaz**, con el mismo flujo de siempre (panel de importación /
recuperación) y sobre el almacén remoto:

1. **Movimientos**: el plan (`planRecoveryMerge`) muestra antes de aplicar cuántos registros se
   recuperan, cuántos se omiten por duplicado y cuáles quedan en revisión por ambigüedad. La
   ejecución (`executeRecoveryMerge`) conserva los identificadores y **no sobrescribe** un dato
   existente ante un conflicto: lo marca para revisión.
2. **Documentos**: los adjuntos incrustados del expediente (`receiptUrl`/`fileData` en data URL) se
   externalizan al almacén remoto con identificador estable derivado del hash del contenido
   (`externalizeImportedExpenses` / `externalizeImportedProperties`). Un adjunto ilegible **rechaza
   la importación** indicando qué registro falla, en lugar de importar a medias.
3. **Idempotencia**: reimportar el mismo expediente no duplica movimientos (mismo id/registro) ni
   documentos (mismo hash ⇒ ya existe). El recuento final no crece.
4. **Verificación**: tras importar, los recuentos por inmueble y las relaciones
   movimiento→inmueble→documento se comprueban en la interfaz; los movimientos con documento
   muestran «Guardado en el almacenamiento remoto».

Pruebas automatizadas del procedimiento (datos sintéticos, sin datos personales):
`server/vault/importProcedure.test.ts` (F1–F5) y `src/lib/recoveryImport.test.ts`.

## 5. Estado de producción y bloqueos

- La aplicación está desplegada en Vercel; `main` se despliega automáticamente.
- **Sin el almacén Blob conectado al proyecto, este código no puede guardar nada**: responde 503 y
  la interfaz lo dice. Con el almacén conectado, todo el flujo queda operativo sin más cambios.
- No existe conector de Vercel en la sesión de trabajo: la conexión del almacén al proyecto (si no
  estuviera ya hecha) es la única acción que debe realizarse desde el panel de Vercel.
