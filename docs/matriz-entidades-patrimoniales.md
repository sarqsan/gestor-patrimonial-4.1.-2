# Matriz de entidades patrimoniales y persistencia remota

Fecha: 2026-10-11 · Rama: `arena/e65d6133-gestor-patrimonial-4-1-2` · Continúa PR #12

## 1. Arquitectura objetivo cumplida

| Capa | Destino | Contenido |
| --- | --- | --- |
| **Base de datos persistente** | Almacén remoto del backend (vault sobre Vercel Blob privado, objetos JSON por entidad) | Datos estructurados: entidades patrimoniales, relaciones (por identificador), permisos (por cuenta) e índices (listados por tipo + orden en `settings`) |
| **Vercel Blob privado** | `gestor-patrimonial-documentos` | Contenido binario de documentos (PDF, imágenes, .doc) |
| **Backend** (`server/vault`) | Función serverless `api/[...route].ts` | Validación, autenticación (scrypt + token HMAC), autorización por cuenta, escrituras/lecturas confirmadas y auditoría |

> **Dependencia documentada.** No existe una base de datos relacional provisionada (no hay conector
> de Vercel en la sesión ni autorización para contratar servicios). La persistencia estructurada
> usa **objetos JSON por entidad** en el almacén Blob privado, accedidos SOLO por el backend: no es
> un almacén relacional, pero cumple el contrato exigido (persistencia remota real, recuperación
> tras reinicios, aislamiento por cuenta, idempotencia por identificador y confirmación explícita
> de escritura). Si se provisiona Vercel Postgres/KV, la interfaz `VaultPersistence`
> (`server/vault/persistenceTypes.ts`) es el punto único donde sustituir el motor sin tocar rutas,
> autorización ni clientes.

**Firestore queda como espejo LEGADO documentado** (ver §4): nunca decide el éxito de un guardado
cuando hay sesión del almacén remoto.

## 2. Matriz de entidades (auditoría del código real)

| Entidad | Ubicación HASTA AHORA | Lecturas (hoy) | Escrituras (hoy) | Riesgos | Solución implantada |
| --- | --- | --- | --- | --- | --- |
| **Usuarios y cuentas de acceso** | `localStorage` (registro app) + vault `users/<u>/account.json` (PR #12) | `AuthScreen` (local) · `server/vault` (`getUser`) | `AuthScreen` (local) · `createUser` (vault) | Credenciales duplicadas; Firestore Auth con operaciones restringidas | Cuenta del vault con **hash scrypt + salt** (nunca la contraseña) por cuenta; token HMAC por sesión; aislamiento por usuario |
| **Propietarios y titulares** | `AppState.user1/user2` → Firestore `users/{u}/data/portfolio` + `localStorage` | `getDoc` + `onSnapshot` (Firestore) | `setDoc` (Firestore) + `localStorage` | Firestore caído/1 MiB; solo navegador si falla | Entidades `owners:user1` / `owners:user2` en el almacén remoto (`portfolioRemote.ts`) |
| **Carteras y relaciones de titularidad** | `Property.owner` + `ownershipPercentageUser1/2` dentro del doc de cartera | ídem | ídem | Relaciones embebidas en un doc monolítico; escritura completa ciega | Entidad `properties:<id>` con la titularidad **dentro del inmueble** (relación por identificador `user1/user2`); sincronización por entidad (solo cambia lo que cambia) |
| **Inmuebles** | `AppState.properties[]` → Firestore + `localStorage` | `getDoc`/`onSnapshot` | `setDoc` | Pérdida si Firestore rechaza; duplicados al reimportar | Entidad `properties:<id>` (un objeto por inmueble, idempotente); orden de visualización en `settings.order` |
| **Contratos** | `Property.contract`, `Property.tenantHistory[]`, `AppState.contracts[]` → Firestore | ídem | ídem | Sin identificador propio en `contracts[]`; dispersos | `tenantHistory` e `contract` embebidos en la entidad del inmueble (conservan `TenantContractRecord.id`); `AppState.contracts[]` → entidades `contracts:<id>` (id derivado del contenido si no tiene) con `propertyId` |
| **Ingresos y gastos (movimientos)** | Subcolección Firestore `users/{u}/expenses/{id}` (`movementService.ts`) + cola local + vault `movements/<id>.json` (espejo, PR #12) | `getDocs`/`onSnapshot` (Firestore) · `vaultGetMovements` | `setDoc`/`writeBatch` (Firestore) · `vaultPutMovements` | Dos escrituras; el vault era “mejor esfuerzo” | **Vault como definitivo**: `putMovements` idempotente por id en cada confirmación de guardado (ya no es best-effort); relaciones `propertyId` y `receiptVaultId` |
| **Recibos, facturas y documentos (binario)** | Firebase Storage + data URLs legadas + vault `files` (PR #12) | `getAttachmentBlob` (vault > Storage > legado) | `uploadAttachment` (vault) | Base64 en el navegador; Storage restringido | Contenido en Blob PRIVADO (`files/<id>`) con SHA-256 verificado a entrada y salida; metadatos con `movementId`/`propertyId`/`vaultId` |
| **Recibos de renta (RentPayment)** | `AppState.payments[]` → Firestore | ídem | ídem | Ídem inmuebles | Entidad `payments:<id>` con `propertyId` |
| **Metadatos e índices** | `AppState.syncEvents`, `currentYear`, `yearlyProfiles`, `theme`, `syncEnabled`, `isOnboarded` → Firestore | ídem | ídem | Sin índice de orden de listas en un almacén objeto | Entidad única `settings:app` (metadatos + `order` de listas) y **listados por tipo** (`entities.list`) como índice remoto |
| **Auditoría** | vault `audit/<id>.json` (PR #12) | `GET ?op=audit` | `appendAudit` | — | Por cuenta, solo identificadores y metadatos técnicos (sin datos fiscales) |
| **Copias de seguridad** | Firestore `users/{u}/backups/{id}` + Storage + vault `backups/<id>.json` (PR #12) | `RecoveryPreviewPanel` | `firebaseMigration` + `createBackup` | Triple ubicación | Copia completa en el vault (`backups`) con lectura autenticada; las de Firestore/Storage quedan como legado de migración |

## 3. Operaciones del almacén remoto para entidades (API)

| Operación | Mapeo interno | Semántica |
| --- | --- | --- |
| `GET /api/vault?op=entities.list&type=<tipo>` | `GET /entities?type=…` | Índice de la cuenta: `{id, updatedAt, data}` por entidad |
| `POST /api/vault?op=entities.put` (cuerpo `{type, id, entity}`) | `POST /entities` | Escritura idempotente por `(tipo, id)`; confirmación = resolución |
| `DELETE /api/vault?op=entities.delete&id=<id>&type=<tipo>` | `DELETE /entities/:id?type=…` | Borrado de lo que ya no existe (204; 404 explícito si no estaba) |

- Tipos admitidos (lista cerrada en cliente y servidor): `owners`, `properties`, `contracts`, `payments`, `settings`.
- Identificadores: `[A-Za-z0-9_-]{1,128}` (`safeSegment`); los registros con id inválido reciben uno
  derivado de su contenido (hash estable) sin perder relaciones.
- Límite por entidad: 1 MB serializado. Error explícito si se supera.
- **Idempotencia**: reintentar `put` con el mismo `(tipo, id)` no duplica; `syncPortfolioEntities`
  solo escribe lo que cambió (caché de hash por usuario) y elimina las entidades remotas
  desaparecidas. Pruebas: `server/vault/entities.test.ts`, `src/lib/portfolioRemote.test.ts`.

## 4. Firestore: dependencia LEGADO explícita (sustituida en lo definitivo)

| Situación | Comportamiento |
| --- | --- |
| **Con sesión del almacén remoto** (caso normal) | El guardado definitivo es `syncPortfolioEntities` + `vaultPutMovements`; solo si el almacén **confirma** se marca «Guardado». Firestore recibe un **espejo best-effort** que nunca bloquea ni decide el éxito (`legacyFirestoreWrite` en `App.tsx`). El listener de Firestore **no aplica** cambios sobre el estado cuando el remoto ya hidrató (`vaultHydratedRef`). |
| **Sin sesión del almacén remoto** (modo degradado declarado) | Mantiene el camino legado Firestore + copia local con los mensajes de error existentes; la interfaz no declara éxito si Firestore no confirma. |
| **Hidratación al iniciar sesión** | `loadPortfolioEntities` reconstruye la cartera desde el remoto (fuente definitiva). Si el remoto aún no tiene estado (cuenta nueva o primera migración desde el legado), el estado local **se siembra** en el remoto (`syncPortfolioEntities`) una vez. |
| **Firestore en el navegador** (`movementService`, `firebaseMigration`, `RecoveryPreviewPanel`) | Se mantiene como vía de migración/lectura del legado. Ninguna entidad crítica depende ya de él para su persistencia definitiva. |

## 5. Seguridad y fiabilidad (Fase 4) — verificado por pruebas

| Requisito | Estado | Dónde se prueba |
| --- | --- | --- |
| Aislamiento estricto por cuenta y cartera | ✅ | `entities.test.ts` E4, `patrimonialIntegration.test.ts` I5, `persistenceBlob.test.ts` P2, `routingCompatibility.test.ts` R4 |
| Autorización en el servidor en todas las operaciones | ✅ | Todas las rutas de datos exigen Bearer; `requireAuth` + usuario del token como raíz de todas las rutas |
| Protección frente a identificadores manipulados | ✅ | `safeSegment` en servidor; `entities.test.ts` E5, `patrimonialIntegration.test.ts` I6, `routingCompatibility.test.ts` R5 |
| Sesiones caducadas o inválidas rechazadas | ✅ | Tokens HMAC con caducidad verificada en el servidor (`SESSION_TTL_MS`, `verifySessionToken`); `vault.test.ts` S2 (token caducado → rechazado), `vaultClient.test.ts` C6 (401 → «sesión caducada») |
| Subidas con límite de tamaño, tipos permitidos e integridad | ✅ | Tipos acotados (PDF, imágenes, `.doc`) en `vaultContentTypeProblem`, máximo 10 MiB, firma de subida directa de un solo pathname con caducidad corta; SHA-256 recalculado por el servidor (`persistenceBlob.test.ts` P3/P4, `vault.test.ts`) |
| Integridad SHA-256 de los documentos | ✅ | Verificada al subir, al confirmar subida directa y al descargar (502 si el objeto no coincide); `persistenceBlob.test.ts` P3/P4 |
| Reintentos idempotentes sin duplicados | ✅ | `entities.test.ts` E2, `patrimonialIntegration.test.ts` I4, `portfolioRemote.test.ts` PR3, `vault.test.ts` |
| Ausencia de fallback local silencioso | ✅ | Con sesión remota no hay escritura local como sustituto; sin almacén: 503 explícito (`patrimonialIntegration.test.ts` I7/I7b, `persistenceBlob.test.ts` P5/P6/P8) |
| Errores claros cuando la persistencia remota falla | ✅ | Todo fallo del almacén se traduce a `VaultStorageUnavailableError` → HTTP 503 con motivo (`persistence.ts: storage()`); sin 500 genéricos |
| Ausencia de secretos y datos fiscales sensibles en respuestas y registros | ✅ | `publicFileMeta` oculta rutas internas; auditoría solo con identificadores; la contraseña nunca sale del navegador (hash scrypt en el almacén) |
| Recuperación coherente tras reiniciar/re-ejecutar el backend | ✅ | `entities.test.ts` E1, `patrimonialIntegration.test.ts` I2/I3, `persistenceBlob.test.ts` P1 |

## 6. Pruebas de integración (Fase 5) — datos sintéticos

`server/vault/patrimonialIntegration.test.ts` ejecuta el flujo completo contra la app Express real
y el almacén remoto (doble con la misma interfaz que Vercel Blob): titulares + relación de
titularidad → inmueble → contrato → movimiento → documento asociado; recuperación desde una
**nueva ejecución del backend**; relaciones intactas; reintentos sin duplicados; aislamiento entre
cuentas (lectura, borrado, listados); identificadores manipulados rechazados; fallo del almacén con
error explícito y sin metadatos huérfanos. Complemento en producción: `scripts/verificacion-persistencia.mjs`
(ejecutable contra un despliegue real por GitHub Actions).

### Matriz de aceptación por niveles (cada evidencia en SU nivel)

| Nivel | Qué demuestra | Cómo se ejecuta | Resultado actual |
| --- | --- | --- | --- |
| Prueba unitaria | Comportamiento aislado de una función | `npm test` (suites cliente: portfolioRemote, movementService, vaultClient, attachments, recoveryImport, …) | ✅ 246 pruebas en verde |
| Prueba de integración local | Interacción entre componentes en el entorno de prueba | Suites servidor contra la app Express real + doble de Blob (`npm test`): vault, persistenceBlob, routingCompatibility, importProcedure, entities, patrimonialIntegration + E2E local (`scripts/verificacion-persistencia.mjs` contra backend local) | ✅ 42 pruebas + 32/32 comprobaciones E2E locales |
| Preview real | Comportamiento del código desplegado en Vercel | Workflow «Verificación de persistencia» contra la URL de preview (CI de GitHub) | ⛔ Bloqueado por SSO de Vercel (302). Mecanismo autorizado preparado: secreto `VERCEL_AUTOMATION_BYPASS_SECRET` («Protection Bypass for Automation») — ver §8 |
| Producción | Comportamiento del despliegue público y sus servicios efectivos | Mismo workflow contra `https://gestor-patrimonial-4-1-2.vercel.app` | ⏳ Pendiente del merge (el código de producción actual aún no incluye la corrección de rutas; evidencia del fallo real en el PR #13) |

Ningún resultado de un nivel se atribuye a otro.

## 7. Importación de datos descargados (Fase 6)

### Inventario de archivos y formatos admitidos

| Entrada | Formato | Validación previa | Destino |
| --- | --- | --- | --- |
| Movimientos históricos (ingresos/gastos) | JSON (`PropertyExpense[]` con `id`, `propertyId`, `category`, `amount`, `date`, `type`) — salidas descargadas de la app y copias de seguridad `backups/<id>.json` | Esquema, fechas normalizadas, ids presentes; los inválidos se rechazan con motivo en el informe | Entidad/movimientos remotos por id, sin duplicar |
| Copias de seguridad completas del vault | JSON del esquema versionado de backup (`backups/<id>.json`) | Lectura autenticada, SHA de contenido, recuentos | Restauración/merge con vista previa |
| Justificantes y documentos (binarios) | PDF, imágenes (`image/*`) y `.doc` de contratos — espejo de `storage.rules` (`vaultContentTypeProblem`) | Tipo admitido, tamaño máximo (10 MiB), SHA-256 verificado a entrada y salida | Blob privado `files/<id>` + metadatos con `movementId`/`propertyId` |
| Referencias legadas de adjuntos | Storage de Firebase y data URLs base64 | `recoveryImport` las clasifica en recuperables/no verificables; nunca se importa a medias | Externalización con referencia estable por hash |

Procedimiento probado con conjunto pequeño (F1–F5 en `server/vault/importProcedure.test.ts` +
`src/lib/recoveryImport.test.ts`): validación de archivos (un adjunto ilegible rechaza con motivo,
sin importar a medias), conservación de identificadores y relaciones, detección de duplicados
(reimportar no duplica ni mueve recuentos), informe de registros rechazados y ambigüedades
(`planRecoveryMerge`, con revisión ANTES de confirmar en `RecoveryPreviewPanel`), recuentos
antes/después y asociación de documentos (externalización con referencia estable por hash), y
recuperación desde una sesión nueva tras reiniciar el servicio (I2/I3). La
importación masiva en producción queda pendiente de la decisión del propietario.

## 8. Verificación contra despliegues reales y bypass del SSO (mecanismo autorizado)

El entorno de trabajo solo puede alcanzar despliegues reales a través del workflow de GitHub
Actions «Verificación de persistencia (despliegue real)» (`.github/workflows/verificacion-persistencia.yml`),
que ejecuta `scripts/verificacion-persistencia.mjs` contra preview y producción con cuentas y
documentos sintéticos y publica la evidencia como comentario del PR.

Los previews del proyecto están protegidos con la autenticación de Vercel (SSO). El mecanismo
**autorizado y limitado** para que la automatización los verifique sin desactivar la protección es
el *Protection Bypass for Automation* de Vercel:

1. En Vercel → proyecto `gestor-patrimonial-4-1-2` → Settings → Deployment Protection →
   *Protection Bypass for Automation* → **Generate secret** (Vercel lo muestra una sola vez).
2. En GitHub → repo → Settings → Secrets and variables → Actions → **New repository secret**:
   - **Nombre**: `VERCEL_AUTOMATION_BYPASS_SECRET`
   - **Valor**: el secreto generado en Vercel.

Con ese secreto presente, el workflow lo envía solo como cabecera `x-vercel-protection-bypass`
en las peticiones de verificación. El valor no se imprime, no se registra y no aparece en la
documentación ni en los comentarios del PR. Sin el secreto, el SSO se documenta como bloqueo y
**no** se presenta ninguna prueba local como si fuera una prueba de preview.

La verificación de producción no necesita bypass (el despliegue público no tiene SSO).
