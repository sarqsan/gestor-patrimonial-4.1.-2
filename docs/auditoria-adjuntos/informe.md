# Auditoría previa a cualquier fusión — adjuntos

**Fecha:** 2026-10-11. **Decisión: DETENER la aceptación remota y la fusión.**

La reparación mejora verificación, cancelación, retención del formulario e idempotencia por ID, pero **no acredita todavía todos los requisitos de autorización, asociación duradera y recuperación**. La auditoría reproduce ocho invariantes incumplidas en un servidor estrictamente local y simulado. No se ha probado ni modificado producción.

## A. Estado exacto de la rama y diferencias

### Estado observado antes de la auditoría

- Rama exclusiva: `arena/98d8e88d-gestor-patrimonial-4-1-2`.
- Base y HEAD: `3a71b97495e98f250681b8280e4592958c5439d8`.
- **0 commits posteriores a la base**. Ningún cambio en el índice: todo sigue sin commit.
- **23 archivos rastreados modificados; 11 archivos nuevos no rastreados; 0 eliminados/renombrados**.
- Diff de rastreados: **1.124 inserciones / 817 eliminaciones**. No incluye el contenido de los 11 no rastreados.
- No se cambió de rama ni se ejecutaron restore/reset, commit, push, PR, merge, deploy, migraciones o publicación de reglas.
- Los logs/fixtures ignorados del turno anterior y `node_modules` no estaban presentes al comenzar. El informe anterior persistía, pero sus enlaces a evidencias ignoradas no eran una prueba accesible en este checkout. Esta auditoría reinstaló dependencias localmente y ejecutó comprobaciones nuevas.

### Diferencias completas

[**Diferencial completo respecto de la base**](diferencias-base-sanitizadas.patch): contiene todos los hunks de los 23 rastreados y el contenido completo de los 11 añadidos iniciales, incluido el informe anterior. Tamaño: 307.341 bytes. Por privacidad, 127 líneas con literales relacionados con credenciales —también de pruebas— se ocultaron. No es un parche para aplicar directamente. No se imprimieron tokens/secretos reales ni valores de variables de entorno.

### Conservación del trabajo y cambios ajenos

Se congelaron SHA-256 de los **34 archivos iniciales** antes de auditar. Tras las inspecciones y pruebas, **0 de esos archivos habían cambiado**. No se puede atribuir autoría de cambios sin commit solo con Git; no hay nuevos commits ni rutas de código inesperadas respecto del inventario de la reparación anterior.

La excepción de alcance explícita es `RecoveryPreviewPanel.tsx`: una anotación `format?: string` para compilar con los nuevos tipos React. Es auxiliar, no una corrección de upload ni un cambio de comportamiento. Requiere revisión de alcance; no se ocultó como ausencia total de cambios en otros módulos.

### Añadidos exclusivamente por esta auditoría

Solo se añaden **ocho artefactos bajo `docs/auditoria-adjuntos/`**: este informe, diferencial sanitizado, barrera de red, script de comprobaciones locales y cuatro resúmenes JSON. No se alteró código de producción ni las pruebas originales. Estado final previsto tras añadir este informe: **23 modificados + 19 añadidos, 0 eliminados**, todo sin commit.

## B. Archivos modificados y motivo

### Rastreados modificados inicialmente — inventario completo

| Archivo | Motivo de la reparación pendiente |
| --- | --- |
| `bun.lock` | Sincronizar dependencias; incorpora Blob ya declarado en el manifest base y nuevas dependencias de esta reparación. |
| `package-lock.json` | Bloquear checksum/renderer/tipos. |
| `package.json` | `spark-md5`, renderer/tipos de desarrollo y enumeración de suites nuevas. |
| `server/vault/blobPort.ts` | Binarios create-only; firma directa sin sobrescritura. |
| `server/vault/memoryBlobPort.ts` | Semántica equivalente en el proveedor **simulado**. No acredita durabilidad real. |
| `server/vault/persistence.ts` | Creación exclusiva de binarios Blob/filesystem; JSON de entidades sigue reemplazable. |
| `server/vault/persistenceTypes.ts` | Opciones de creación exclusiva y hash de reserva directa. |
| `server/vault/routes.ts` | Nuevos commits/verificación, presign/commit reconciliables y comprobaciones de asociaciones; contiene lagunas descritas en C. |
| `server/vault/persistenceBlob.test.ts` | Reintento con mismo ID y conservación del binario cuando falla hash. |
| `src/App.tsx` | Esperar commits de adjuntos, guardas de cambio de cuenta y coordinación de snapshots. También afecta la sincronización general y debe revisarse como parte indispensable de asociaciones. |
| `src/components/ContractCreator.tsx` | Cache/hash del documento y callback de enlace esperado. Sin cambiar texto legal. |
| `src/components/Dashboard.tsx` | IDs/asociación/reintento del Scanner; mantiene la ruta de extracción previa. |
| `src/components/Expenses.tsx` | File/campos retenidos, doble submit, adjuntar desde tabla, referencias y visor local. |
| `src/components/Properties.tsx` | Documento/PDF con ID/cache estable y callback esperado; evita referencias antiguas prioritarias. |
| `src/components/RecoveryPreviewPanel.tsx` | Solo anotación opcional `format` en el estado existente. |
| `src/lib/attachments.ts` | Metadata/MD5, upload cancelable, IDs por contenido/contexto, errores y preview/descarga protegida. |
| `src/lib/attachmentsVault.test.ts` | Mocks de confirmación/SHA/verify más realistas. |
| `src/lib/firebase.ts` | Presupuesto SDK de retries, **no** proveedor ni vínculo identidad/cuenta. |
| `src/lib/migrationWiring.test.ts` | Comprobar uso del nuevo helper en vez de descarga de bytes como sonda. |
| `src/lib/portfolioRemote.ts` | Propagación de aborto a sincronización/hidratación; conserva reemplazos/borrados de entidades anteriores. |
| `src/lib/remotePersistence.test.ts` | Contratos de reserva/hash/error actualizados; C2 aún puede intentar Auth real si no se bloquea la red. |
| `src/lib/vaultClient.test.ts` | Confirmación/hash/errores con causa preservada. |
| `src/lib/vaultClient.ts` | Verificación y commits individuales, ID estable y reconciliación del transporte. |

### Añadidos iniciales — inventario completo

| Archivo | Tipo / propósito |
| --- | --- |
| `docs/reparacion-subida-documentos.md` | Informe de la reparación anterior; no sustituye a esta auditoría. |
| `src/lib/attachmentErrors.ts` | Producción: fase/backend/código/cause y deadlines. |
| `src/lib/storageAttachment.ts` | Producción: metadata/MD5/generación y creación/reuso. |
| `src/lib/attachmentPersistence.ts` | Producción: referencia, asociación, write/readback. |
| `src/lib/attachmentWriteCoordinator.ts` | Producción: cola/epochs **solo de ese cliente**. |
| `src/lib/attachmentTestFixtures.ts` | PDF/PNG/JPEG/propiedad/transportes sintéticos; sin imports desde módulos de la aplicación. |
| `src/lib/storageAttachment.test.ts` | 14 tests nuevos. |
| `src/lib/attachmentPersistence.test.ts` | 12 tests nuevos. |
| `src/lib/attachmentWriteCoordinator.test.ts` | 5 tests nuevos. |
| `src/lib/attachmentForms.test.tsx` | 8 casos con componentes reales; uno parametrizado por proveedor. |
| `server/vault/attachmentFlow.test.ts` | 13 casos HTTP con Blob **simulado**. |

**Sin diferencias respecto de base:** `storage.rules`, `firestore.rules`, `firebase-applet-config.json`, `vercel.json`, `server/vault/auth.ts`, `server/apiApp.ts`, `AuthScreen.tsx`, `src/types.ts`, `movementService.ts` y `attachmentRules.ts`. No se encontraron cambios de fórmulas fiscales/titularidad ni de proyecto/credenciales; sí hay cambios de callbacks/IDs y sincronización ligados a adjuntos.

## C. Auditoría de autorización, privacidad e integridad

### C1. Autenticación de cada transporte

| Petición / camino | Autenticación observada | Resultado / límite |
| --- | --- | --- |
| Vault upload JSON, presign, commit, verify, download y persistencia | Bearer obtenido de sesión HMAC. `authedUser` verifica firma/caducidad **y existencia de la cuenta**; `requireAuth` fija `req.vaultUser` (`routes.ts:138–189`). | Control de cuenta real en el servidor, no solo un flag del formulario. Sin credencial: 401. Otra cuenta: 404 para el archivo. |
| PUT directo a Blob | Delegación por URL firmada, tras presign autenticado. SDK limita objeto, `put`, MIME, bytes, expiración de 10 min y `allowOverwrite:false` (`blobPort.ts:103–127`). | La URL **es una credencial temporal de upload**, aunque no sea la credencial administrativa del almacén. No se vuelve a autenticar con sesión Vault en ese PUT; quien conserve la firma puede usarla dentro de su alcance hasta expirar. |
| Firebase Storage metadata/upload/getBlob | SDK con sesión Firebase, actualmente **anónima**, restaurable en IndexedDB. No se vincula la cuenta de la aplicación con el UID (`firebase.ts:25–34,117–169`). | Sesión ≠ permiso sobre una carpeta patrimonial. El cliente comprueba un prefijo de username, pero no es una frontera del servidor. |
| Firestore gasto / portfolio | SDK Firebase y reglas. Client escribe `ownerUid`; readback usa servidor, no caché (`attachmentPersistence.ts:40–77`). | Vínculo de identidad y reglas publicados no comprobados; política de `ownerUid` insegura en reglas versionadas. |
| Scanner: POST `/api/extract-invoice` | `Dashboard.tsx:227` envía contenido sin Bearer. `apiApp.ts:296` no aplica `requireAuth`. | Procesamiento de documentos/consumo Gemini abierto en el código, **preexistente**. No es un endpoint de lectura de archivos guardados, pero no puede afirmarse que toda transferencia de documento esté autenticada. No se invocó. |
| Inline histórico / URL Blob local | Bytes ya presentes en el navegador. | No es persistencia remota ni una nueva comprobación de autorización. Un fichero ya descargado no se borra mágicamente al retirar la sesión. |

La sesión Vault es un formato HMAC propio de **dos componentes**, no un JWT estándar. Contraseñas remotas: scrypt/salt; firma/caducidad y comparación constante en `auth.ts:9–23,35–74`. No se añadieron claves administrativas en el cliente.

### C2. Cuenta propietaria, cartera y referencias

**Correcto en Vault:** el servidor calcula la carpeta de datos desde `req.vaultUser`; un `username`/ID enviado en el body no selecciona otra cuenta. IDs de ruta usan `safeSegment`. Download no permite leer otra carpeta con un token de otra cuenta; comprobación local L01/L02.

**Incompleto en el nuevo servidor:**

- `movimientos.save` verifica bytes/asociación para `receiptVaultId`, pero para `receiptPath` solo comprueba que sea truthy (`routes.ts:334–358`). Aceptó una ruta Firebase **inexistente y perteneciente por prefijo a otra cuenta**, con `200` y `storageOk:true` — **L06 FAIL**. No se llamó a Firebase: el fallo está en confiar en la referencia del cliente.
- `propertyId` se acepta como string sin exigir padre autorizado/existente. Un archivo subido con un ID inventado y un gasto con ese mismo ID se confirmaron sin inmueble remoto — **L07 FAIL**. Coincidir dos strings no acredita un padre patrimonial autorizado.
- `entities.put` verifica adjuntos **solo si el cliente suministra `attachmentIds`** (`routes.ts:391–415`). Omitirlo permitió persistir en un inmueble propio el ID de un archivo de otra cuenta — **L09 FAIL**. Eso no permitió descargarlo con la cuenta equivocada; sí dejó una asociación privada inconsistente.
- La ruta genérica `PUT movimientos` (`319–327`) no aplica esas comprobaciones. Es un camino utilizado por la sincronización y no se puede ignorar al auditar el commit definitivo.

**Firebase, reglas versionadas — bloqueante, no prueba de reglas publicadas:**

- `storage.rules:20–33` autoriza lectura/creación a cualquier `request.auth != null`; no exige coincidencia con `{userId}`. Anonymous facilita autenticación, no aislamiento por cuenta. No puede certificarse protección por cartera si esa política está publicada.
- `firestore.rules:44–49` permite write mediante `request.resource.data.ownerUid == request.auth.uid` además de propietario previo. Carece de inmovilidad del dueño y de vínculo seguro entre carpeta patrimonial y UID. La política acepta identidad declarada en el dato entrante; requiere revisión y pruebas con motor de reglas. No se ejecutó una toma de propiedad ni se investigaron datos reales. Los efectos exactos con claims ausentes/reglas publicadas siguen pendientes.
- El código de `AuthScreen.tsx:37–106` comprueba contraseñas locales; `App.tsx:1137–1202` marca sesión autenticada antes del resultado remoto. Las contraseñas se conservan en claro en `rentasync_users` y hay credenciales demo conocidas, **preexistentes**. No constituyen autorización de servidor para Firebase.

### C3. Descarga privada sin autenticación

- Vault normal: **rechazada 401**. Otra cuenta con credencial válida: **404**, no bytes. Blob se solicita con `access:private` y `useCache:false`; download lleva `private, no-store`, SHA y attachment (`routes.ts:595–620`). El almacén real configurado no se inspeccionó.
- La firma de PUT no delega GET: no es una URL pública permanente de descarga.
- Firebase: las reglas versionadas rechazan ausencia de sesión, pero **no cuenta ajena con sesión anónima**. La lectura real/reglas efectivas y posibles URLs históricas con download token no se comprobaron. Las nuevas previews usan URL Blob **local**; esto no revoca tokens de descarga antiguos ni garantiza limpieza de bytes ya descargados.
- `files.list` devuelve metadatos sin aplicar `publicFileMeta` (`routes.ts:443–446`), mientras upload/verify/expediente sí filtran. Puede exponer campos internos de metadata histórica/reservada al dueño; no se demostró exposición de credenciales. Debe uniformarse la respuesta.

### C4. IDs, hashes y reintentos en servidor

**Verificado positivamente, no solamente en formulario:** con el **mismo ID**, upload compara contexto/hash, relee los bytes existentes y devuelve el objeto ya guardado; commit directo también recalcula SHA antes de reuso. JSON de gasto se guarda por ID. L05: un documento, sin duplicado por retry. Las suites prueban respuesta perdida de upload/commit/persistencia y mismo ID.

**No universal:** ID es opcional en upload/presign. Sin ID el servidor crea uno nuevo (`routes.ts:57,507,807`). Dos requests legacy iguales crearon dos objetos — **L14 FAIL** para la expectativa de deduplicar ese reintento. El cliente nuevo evita esto en el formulario abierto, pero no hay una garantía de intención única independiente de cliente/recarga ni transacción para reservas concurrentes.

**Integridad real en caminos principales:**

- Vault: SHA-256 del objeto leído de persistencia, contraste con bytes originales, relectura tras upload, y hash de nuevo en verify/download (`routes.ts:551–620,776–854`; `vaultClient.ts:415–430`). L03 byte a byte; L12 corrupción: download rechazado 502.
- Firebase: MD5 de metadata calculado por Storage frente al MD5 local, tipo/tamaño/ruta/bucket/generación; consulta posterior de la referencia real (`storageAttachment.ts:32–84`). SHA custom metadata lo declara el cliente, no debe presentarse como hash independiente del proveedor. El objeto real no se probó; metadata no prueba CORS de media.
- Verificación posterior de referencia Firebase (`attachments.ts:318–347`) exige MD5 presente, pero no conserva/compara nuevamente el checksum original de la subida. Depende también de la inmutabilidad efectiva del objeto/reglas.

**Bypass de recuperación:** `expediente.zip` lee bytes directamente (`routes.ts:695–703`) sin exigir hash confirmado ni recalcularlo. La descarga normal rechazó el objeto alterado, pero ZIP devolvió **200 e incluyó los bytes alterados** — **L13 FAIL**. Es preexistente y bloquea afirmar integridad uniforme de todos los medios de recuperación.

### C5. Sincronización y asociación duradera

- La cola/epochs en `attachmentWriteCoordinator.ts:4–43` protege snapshots de **esa instancia de cliente** y es una mejora válida.
- El servidor reemplaza JSON sin revision/ETag/CAS (`persistence.ts:128–130,174–207,237–240`). Binario create-only **no** convierte metadatos/asociaciones en inmutables.
- Un snapshot antiguo enviado después del commit por cliente/instancia distinto puede sobrescribir el mismo gasto y retirar `receiptVaultId`: **L08 FAIL**, HTTP 200, documento binario todavía presente.
- Un inmueble antiguo sin la lista nueva de documentos reemplazó el inmueble confirmado: **L10 FAIL**, HTTP 201 y referencia perdida.
- `portfolioRemote.ts:294–309` puede además borrar entidades no vistas en una cartera antigua; no hay revisión de concurrencia en el DELETE servidor.
- El espejo Firestore de `App.tsx:265–268` sigue siendo best-effort no esperado. Las escrituras SDK ya emitidas no pueden cancelarse; una lectura de confirmación en un instante no garantiza que otra escritura tardía no lo sustituya.
- La prueba anterior E9 del flujo de adjuntos usa `vaultPutMovements([])` como snapshot antiguo; en Blob ese array vacío **no borra** los movimientos. Verifica que la cola omita el callback, pero no demuestra la protección frente al snapshot real peligroso que incluye el mismo ID sin referencia. L08/L10 cubren esta laguna sin alterar la suite original.

### C6. Limpieza de sesión y cambio de cuenta

- Logout retira la credencial actual y usuario Vault activo, limpia cache de sincronización y estado UI (`App.tsx:1275–1306`; `vaultClient.ts:81–87`). Un cliente sin esa credencial ya no puede usar download Vault. Las nuevas guardas evitan aplicar el resultado a otra cuenta de UI.
- **No existe revocación en servidor ni endpoint logout.** Una credencial conservada antes de la limpieza sigue válida con firma/caducidad/cuenta existente, hasta 30 días (`auth.ts:35–74`). L11: browser limpiado, credencial conservada → **HTTP 200**. Es autenticación con una credencial todavía válida, no download anónimo; la invalidación de sesión exigida no está garantizada.
- Logout no llama a Firebase `signOut`; la identidad anónima persistida se mantiene al cambiar el username de la aplicación. Esto agrava el desacople de identidad/cartera. No se certifica que una segunda cuenta en el mismo navegador quede aislada de la primera en Firebase.
- No se eliminan `rentasync_users`, caches `rentasync_state_*`, datos inline antiguos ni credenciales de otras cuentas previamente retenidas. Retención de formulario no debe confundirse con aislamiento en dispositivo compartido.
- El visor modal revoca URL local al limpiar (`Expenses.tsx:167–184`); no hay limpieza global equivalente de todas las URLs del formulario y previews tardías al logout/unmount. No se añadió abort global de requests por cambio de sesión. Una operación ya emitida puede terminar para la cuenta anterior; la guarda posterior de UI no revoca la petición ni borra bytes.

## D. Entorno real de pruebas y aislamiento

### Lo que se comprobó realmente

Consultas **solo de lectura en GitHub**, no al backend:

| Registro GitHub | Fecha UTC | SHA | Estado |
| --- | --- | --- | --- |
| Production `6995215846` | 2026-10-11 12:01:04 | `3a71b97495e98f250681b8280e4592958c5439d8` | Registro existente; la auditoría no lo desplegó. |
| Preview `6994892390` | 2026-10-11 11:31:03 | `585e027ed0abdad674fa24f4a4d4df4e0843c869` | `success` según último status consultado. No contiene los cambios sin commit actuales. |

Se recuperó `firebase-applet-config.json` de **ambos commits registrados**, filtrando cualquier clave/credencial. Los identificadores versionados son **idénticos**:

- Proyecto: `startup-sanctuary-sln7n`.
- Bucket: `startup-sanctuary-sln7n.firebasestorage.app`.
- Base Firestore nombrada: `ai-studio-remixlogeado412-92798005-389f-42ef-9583-f7e6b817c154`.

`firebase.ts:5–16` importa directamente ese JSON. No hay selección por Preview/Production ni llamadas a emuladores en el código. El navegador puede iniciar Anonymous al cargar (`firebase.ts:204–208`), por lo que **ni siquiera abrir una preview/local app con esta configuración es prueba aislada**. No se abrió una app en navegador.

Vault se selecciona desde nombres de variables de servidor y usa prefijo común `vault/users/...` (`persistence.ts:62–99,701–712`). No hay separación por `VERCEL_ENV`; esa variable solo contribuye a detectar Vercel y evitar filesystem efímero. Si dos despliegues tienen el mismo store, comparten datos y ubicación de firma de sesión.

**No se han leído/publicado valores de variables de entorno** ni consultado registros financieros. Vinculaciones reales de Blob/store ID, IAM/credenciales, reglas publicadas, overrides externos de build, secreto de firma y Gemini no son verificables mediante esos metadatos. Los conectores `vercel` y `firebase` devolvieron `unsupported`; no hay acceso administrativo del proveedor en esta auditoría. Un intento técnico complementario de consulta no dejó evidencia y no se asumió completado; se repitieron solo lecturas públicas acotadas que sí devolvieron resultado.

### Veredicto de aislamiento

**No hay una preview realmente aislada demostrada.** Hay un registro Preview distinto, pero su código apunta al Firebase de producción y el binding Blob/Vault sigue desconocido. URL distinta, rama distinta y cuenta sintética no prueban aislamiento. No se ejecutaron llamadas contra Vercel/Firebase/Blob/Gemini, pruebas de escritura remota ni aceptación de producción.

**Se detiene la aceptación remota.** El servidor usado para auditar C es Express en loopback, con `MemoryBlobPort` inyectado y credenciales sintéticas aleatorias solo en memoria. Esto sí evita afectar datos reales, pero **no es almacenamiento remoto permanente ni preview cloud**. `BlobVaultPersistence` etiqueta ese doble como durable/driver Blob por diseño; esas etiquetas no transforman memoria en un servicio remoto.

Para reabrir aceptación faltan: entorno de pruebas autorizado, endpoints Firebase no productivos/emuladores explicitados, Blob/store realmente distinto con permisos limitados, namespaces/datos/firma separados, vínculos de identidad probados, bloqueo de fallback accidental a producción y evidencia administrativa de esas vinculaciones **sin compartir valores de credenciales**. No se cambió el proyecto ni las variables para crear ese entorno.

## E. Pruebas ejecutadas, resultados y limitaciones

### Reejecución nueva, no confianza en logs desaparecidos

- Dependencias: `npm ci --ignore-scripts --no-audit --no-fund`, **PASS, 383 paquetes**. Instalación local únicamente.
- Suites del script `npm test`, con preload de barrera TCP/fetch que permite solo loopback y datos locales: **340 PASS = 285 cliente + 55 servidor**, 0 fail/cancelled/skipped. [Resumen](pruebas-regresion.json).
- La barrera cubrió 31 procesos de prueba y bloqueó **2 intentos de fetch externos antes de envío**, 0 conexiones externas. Por eso no se certifica que `npm test` sin guard sea hermético. [C2 aislado](aislamiento-prueba-c2.json): `remotePersistence.test.ts` C2 hizo **1 intento externo bloqueado**, pasó y no efectuó petición cloud. El otro intento no se atribuye a un archivo concreto sin nueva evidencia.
- TypeScript `npm run lint`: **PASS, 0 diagnósticos**. Build: **PASS, 2.312 módulos**, advertencia no fatal de chunk >500 kB. [Resumen](compilacion.json). Compile/bundle no demuestra autorización o durabilidad remota.
- Control de preservación por SHA-256: **34/34 archivos iniciales intactos**, sin staging, commits, borrados ni renombrados.

### Contraejemplos locales de seguridad/consistencia

Script reproducible: [comprobaciones-locales.mjs](comprobaciones-locales.mjs). Requiere [barrera de red](solo-red-local.mjs), MemoryBlobPort, PDF ficticio del fixture y servidor solo loopback. **No ejecutar contra una URL remota.** Código de salida **1** deliberado por invariantes incumplidas, no un error de infraestructura. [Resultados completos sin credenciales](resultados-locales.json).

| Caso | Expectativa / observado | Resultado |
| --- | --- | --- |
| L01 | Download sin credencial → 401 | PASS |
| L02 | Otra cuenta → 404, sin bytes | PASS |
| L03 | Dueño descarga mismo contenido/SHA simulado → 200 | PASS |
| L04 | Commit correcto conserva gasto/documento/inmueble → 200 | PASS |
| L05 | Mismo ID al reintentar → un objeto | PASS |
| L06 | Rechazar receiptPath inexistente/de otra cuenta; devolvió 200/storageOk | **FAIL** |
| L07 | Exigir inmueble remoto autorizado; confirmó sin padre → 200 | **FAIL** |
| L08 | Conservar referencia de gasto confirmado; snapshot viejo la retiró → 200 | **FAIL** |
| L09 | Verificar referencia ajena aunque no haya attachmentIds; aceptó → 201 | **FAIL** |
| L10 | Conservar documento en inmueble confirmado; snapshot viejo lo desvinculó → 201 | **FAIL** |
| L11 | Revocar credencial conservada tras logout; siguió download → 200 | **FAIL** |
| L12 | Rechazar corrupción en download normal → 502 | PASS |
| L13 | Rechazar corrupción en ZIP; ZIP 200 incluyó bytes alterados | **FAIL** |
| L14 | Evitar duplicación legacy sin ID; dos uploads → IDs diferentes | **FAIL** |

**Total: 14 invariantes; 6 PASS / 8 FAIL.** Los 340 tests funcionales verdes no contradicen estos fallos: no cubrían todos estos caminos/interleavings. No se alteró la suite original para ocultarlos.

### Límites

No hubo navegador real, CORS real, reglas efectivas/emulador, revocación Firebase real, Blob real, cold start/redeploy, OCR/Gemini ni facturas auténticas. Recuperación en Fake tras reinstanciar servidor sobre el mismo objeto MemoryBlobPort no demuestra recuperación entre procesos/cloud. Hash en memoria prueba lógica, no durabilidad del proveedor real. Los casos de cambios de usuario/proxies existentes no sustituyen la comprobación de aislamiento entre cuentas/dispositivos reales.

## F. Riesgos pendientes y correcciones que requieren autorización

### Bloqueantes

1. **Entorno sin aislamiento acreditado.** No usar las previews registradas como entorno de escritura; no abrir una app que inicialice Firebase de producción para suplir falta de entorno.
2. **Autorización Firebase desacoplada de cartera.** Revisar política de carpetas/claims/ownerUid y recuperación entre sesiones/dispositivos; no abrir reglas ni publicar cambios sin autorización. Un nombre de usuario o UID escrito por el cliente no es prueba de dueño.
3. **Validación servidor obligatoria de referencias en todos los endpoints**, no dependiente de `attachmentIds` suministrado por el cliente ni de receiptPath truthy. Verificar existencia/integridad/cuenta/padre y evitar confirmación de un gasto con referencia no verificable. Los nuevos endpoints incompletos son parte de la reparación, no solo deuda histórica.
4. **Control de concurrencia en servidor.** Versiones/ETag/CAS o protocolo equivalente para impedir que snapshots antiguos o clientes anteriores retire referencias confirmadas. Preservar legítimas operaciones de edición sin confiar en cola de un navegador.
5. **Integridad en toda recuperación**, también ZIP y referencias históricas/reservadas, no solo download/verify individuales.
6. **Cierre de sesión completo.** Revocación servidor cuando corresponda, Firebase/identidad, firmas pendientes, requests y URLs/caches locales de cuenta. No declarar credencial invalidada solo por eliminar localStorage. Evitar romper recuperación histórica al modificar identidad sin diseño autorizado.
7. **Idempotencia servidor frente a clientes sin ID/recargas**, con intención/clave de reintento adecuada; no deduplicar indiscriminadamente documentos legítimos de operaciones diferentes.
8. **Hermeticidad de pruebas.** Mockear todas las autenticaciones/transportes o mantener bloqueo de egress; los tests con proyecto real no deben poder crear cuentas anónimas reales por accidente.

### Deuda adicional comprobada en código, preexistente y no corregida durante auditoría

- `ensureSecret` Blob (`persistence.ts:138–146`) interpreta también fallo de lectura como ausencia y escribe un secreto nuevo con sobrescritura; cold starts concurrentes no usan creación exclusiva. Puede cambiar la firma de sesiones de forma no controlada. `createUser:153–160` también hace read-then-overwrite, no create-if-absent transaccional. No se reprodujo contra proveedor real ni se cambiaron cuentas/credenciales.
- Salud Blob (`315–321`) es `head` y devuelve ok incluso si el marcador está ausente; no prueba permiso de escritura ni todas las propiedades de persistencia/privacidad. Debe distinguirse salud de aceptación.
- Contraseñas locales/demo conocidas, mínimo 4 caracteres remoto y rutas AI sin autenticación requieren revisión de seguridad separada y autorizada. No se usaron credenciales demo ni se invocaron rutas AI.
- Filtrado uniforme de metadata, bytes locales después de logout y mensajes originales de SDK deben revisarse; conservar códigos no justifica publicar una firma/credencial o contenido fiscal en logs. Esta auditoría conserva solo resúmenes sin cabeceras/credenciales.

## G. Recomendación explícita y puerta de aceptación

### **DETENER**

**No autorizar merge, push/PR o deploy para presentar esta reparación como definitiva.** Se detiene la aceptación remota por falta de aislamiento y fallos demostrados de asociación/integridad/lifecycle. Los tests verdes y el registro Preview `success` no satisfacen el objetivo.

**CORREGIR**, solo con autorización expresa y conservando la rama existente, los bloqueantes del servidor/identidad/concurrencia y el aislamiento de tests. No se ha aplicado una corrección automática ni restaurado el trabajo del usuario.

Antes de preparar un plan operativo sobre una preview deben verificarse las vinculaciones y autorizarse un entorno de pruebas no productivo. El informe anterior describe pasos de prueba, pero **no habilita ejecutarlos sobre las URLs actuales** ni demuestra separación de datos.

Puerta para una futura aceptación — actualmente **NO habilitada**:

1. PDF ficticio inequívoco, cuenta/inmueble sintéticos en servicios autorizados no productivos; upload y persistencia remota real.
2. Hash del objeto guardado, referencia y dueño/padre correctos en servidor; rechazar referencias inventadas.
3. Logout y nuevo login en sesión/dispositivo limpio; recuperar el mismo gasto y archivo sin cache local.
4. Denegar sin credencial, con cuenta distinta y credencial revocada; también paths Storage y exportación ZIP.
5. Timeout/respuesta perdida/interleavings de dos clientes: mismas identidades, sin duplicados ni pérdida de vínculo; no depender exclusivamente del formulario.
6. Fallo de persistencia: File/campos retenidos y ausencia de falsa confirmación.
7. Comparar diff/archivos y verificar ausencia de cambios funcionales ajenos a la reparación; aprobar explícitamente la excepción de tipado/dependencias.

Hasta cumplir esa puerta, **no se demuestra que los adjuntos queden permanentemente guardados, protegidos, asociados y recuperables en un entorno remoto real**. Producción no fue modificada por esta auditoría.
