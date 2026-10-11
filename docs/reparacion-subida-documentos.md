# Reparación de subida de documentos — informe A–G

Fecha: **2026-10-11 UTC**. Repositorio: `sarqsan/gestor-patrimonial-4.1.-2`.
Base inspeccionada: `3a71b97495e98f250681b8280e4592958c5439d8`.
Rama aislada: `arena/98d8e88d-gestor-patrimonial-4-1-2`.

**Estado:** corrección implementada en la rama, con **340 pruebas PASS**, TypeScript PASS y build de producción PASS. **No está desplegada y no se declara producción recuperada.** La aceptación con Firebase/Vercel Blob reales sigue pendiente. No se recomienda fusionar antes de esa validación y la revisión de los riesgos de seguridad indicados abajo.

## A. Causa raíz: confirmaciones y cuestiones pendientes

El diagnóstico inicial se entregó **antes de modificar código**. Esta tabla conserva las ubicaciones inspeccionadas en el **commit base**; las líneas de la reparación están en C.

| Fase | Archivos, funciones y líneas del commit base | Hallazgo confirmado en código |
| --- | --- | --- |
| Selección / validación | `src/components/Expenses.tsx:185–203`, `src/components/Properties.tsx:181–198`; `src/lib/attachmentRules.ts`, `validateAttachment` | Seleccionar/previsualizar un File no lo guarda. PDF e imágenes: máximo 10 MiB. Word solo habilitado expresamente para contratos. |
| Sesión Firebase | `src/lib/firebase.ts:7–16`, `ensureFirebaseAuth:113–165`; `src/lib/attachments.ts`, `ensureSignedIn:52–86` | Proyecto versionado `startup-sanctuary-sln7n`, bucket `startup-sanctuary-sln7n.firebasestorage.app` y base Firestore nombrada. Restauración de sesión y `signInAnonymously`; plazo cliente de 15 s. |
| Destino / autorización | `src/lib/attachments.ts`, `uploadAttachment:199–268`; `src/lib/vaultClient.ts:99–124,168–194`; `server/vault/routes.ts:178–191` | Vault primero si hay token; después Firebase. Sesión Firebase no acredita permisos de Storage. Cliente Vault comprobaba `storageOk`, pero no exigía `durable`. |
| Subida manual | `src/lib/attachments.ts:272–287` | `uploadBytes` con plazo de 60 s devolvía la referencia sin lectura posterior de metadatos. |
| Subida verificada / importación | `src/lib/attachments.ts`, `uploadBytesVerified:305–348`; `src/lib/verifiedObjectStore.ts:32–54` | `getBytes` antes de subir y después. La consulta previa podía bloquear la subida antes de llamar a `uploadBytes`. El mensaje denunciado se genera en `attachments.ts:322–324`. |
| Temporizadores | `src/lib/attachments.ts:42–49,276–280,321–336` | Rechazaban la espera sin cancelar el transporte. Los requests/reintentos SDK podían seguir activos después del error. |
| Asociación de gasto | `src/components/Expenses.tsx:576–655`, `src/components/Dashboard.tsx:253–299` | IDs nuevos por intento, asociaciones `propertyId`/`movementId` incompletas en algunas subidas y callbacks `void`: se cerraba/limpiaba antes de confirmar persistencia. |
| Asociación de inmueble | `src/components/Properties.tsx`, `handleSaveDocument:201–253` | ID nuevo por intento; faltaba `propertyId` en upload y no se esperaba el callback antes de limpiar. |
| Persistencia final | `src/App.tsx:681–798`; `src/lib/movementService.ts`, `saveMovement:139–187`; `App.tsx:234–251` | Escritura de movimiento y sincronización de cartera en segundo plano por caminos separados. El éxito de la pantalla no demostraba el commit remoto del adjunto y su operación. Una copia de cartera antigua podía competir con la asociación nueva. |
| Vault remoto | `src/lib/vaultClient.ts:255–414`; `server/vault/routes.ts:398–542,702–749`; `server/vault/persistence.ts:66–130,222–265,698–709`; `server/vault/blobPort.ts:44–65` | Blob privado, cuenta derivada del token y SHA-256 calculado por servidor. Faltaban identidad estable/contraste de respuesta en el cliente y relectura del objeto al reutilizarlo. |
| Recuperación / conservación | `src/lib/attachments.ts:351–431`; `src/lib/vaultClient.ts:416–425`; `server/vault/routes.ts:518–542` | Prioridad Vault → Storage → inline histórico. `getBlob`/`getBytes` del SDK siguen necesitando CORS para descargar media en el navegador. No hay justificación para tratar su llamada como prueba de subida que ya terminó. |

**Confirmado:** verificación frágil mediante descarga de bytes, consulta previa que podía impedir la subida, cancelación incompleta, referencias/IDs de reintento insuficientes y confirmación de interfaz anterior al commit de la operación.

**No confirmado contra producción:** CORS real del bucket, reglas publicadas, permisos efectivos, estado actual de Anonymous/Identity Platform, incidencias de red, disponibilidad/configuración del Blob privado y bundle que realmente ejecutó el navegador. No hay una traza de la petición fallida en producción. No se atribuye el incidente a uno de esos factores sin evidencia.

## B. Fase exacta del fallo y conservación de errores

El mensaje exacto:

> La verificación del archivo ha superado el tiempo de espera. No se ha guardado la operación.

se origina en la envoltura de **lectura `getBytes` de `uploadBytesVerified`**, no en una confirmación de subida. En el código base el mismo plazo cubre la lectura previa y la posterior: **sin la traza no puede distinguirse cuál se bloqueó**.

Además, el formulario manual del commit base llama a `uploadAttachment`, no a `uploadBytesVerified`. Si el texto aparece al subir manualmente, hay que comprobar el bundle/camino de importación realmente ejecutado; no basta con dar por hecho que esa pantalla usa esa función.

La reparación identifica las fases `validation`, `session`, `preflight`, `upload`, `verification`, `association`, `persistence` y `download`, junto con backend, código, causa original y posibilidad de reintento:

- `auth/admin-restricted-operation` / `ADMIN_ONLY_OPERATION`: sesión/configuración administrativa; no se recodifica como red. Reproducido mediante driver de pruebas, no observado contra el proveedor real en esta sesión.
- `storage/unauthorized`, `permission-denied`, `vault/unauthorized`, `vault/http-403`: rechazo de autorización en la fase concreta; no provocan cambio de identidad/proveedor después de empezar a subir.
- Solo `storage/object-not-found` en la consulta previa significa que hay que crear el objeto; permisos/red no se convierten en ausencia.
- Desajuste de hash/tamaño/tipo/referencia/generación: integridad, no éxito.
- `attachment/timeout`: plazo de la fase. Se dice **«no se ha confirmado»**, porque una respuesta perdida no demuestra que el proveedor no escribiera.

Los logs `[attachments]` preservan código y mensaje originales cuando existen; no registran bytes del documento ni tokens. Habilitar Anonymous, por sí solo, no acredita acceso a Storage/Firestore ni identidad de la cuenta patrimonial.

## C. Cambios, funciones y justificación del alcance

Estas son las ubicaciones **actuales de la rama**:

| Archivo / función / línea | Corrección |
| --- | --- |
| `src/lib/attachmentErrors.ts:13,45,55,68` — `AttachmentError`, `attachmentFailure`, `logAttachmentFailure`, `attachmentPhase` | Errores por fase con causa/código y plazos abortables. Una respuesta tardía no se convierte en éxito. |
| `src/lib/storageAttachment.ts:27,32,50` — `md5Base64`, `assertObjectMetadata`, `storeStorageAttachment` | Consulta autenticada de metadatos; MD5 calculado por Storage contrastado con los bytes locales, bucket/ruta/tipo/tamaño/generación y asociaciones. Reuso solo si coincide; consulta posterior sobre la referencia realmente subida. Sin `getBytes` ni URL como puerta de subida. |
| `src/lib/attachments.ts:39,223,289,318,350,355,372` — sesión, `uploadAttachment`, `uploadBytesVerified`, `verifyAttachmentReference`, preview/descarga | Mismo flujo fiable para manual/importación, ID por contenido y operación/inmueble, `uploadBytesResumable` cancelable y destino elegido antes de escribir. Referencia remota verificada antes de asociar. Descarga autorizada y URLs locales temporales para el visor. |
| `src/lib/firebase.ts:19–20` | Presupuestos SDK de reintento: operaciones 10 s y upload 60 s. No se aumenta el timeout para ocultar el error; metadatos no continúan reintentándose durante minutos tras el plazo de la pantalla. Proyecto, credenciales y reglas sin cambios. |
| `src/lib/vaultClient.ts:184,306,319,343,398,415,462,474,516` — capacidades, verificación, upload JSON/directo/auto, download, commits individuales y cola histórica | Exige destino duradero operativo. Valida ID/SHA/tamaño/tipo/asociaciones y consulta protegida del objeto. Reserva/commit con el mismo ID; reconcilia respuesta perdida antes de repetir PUT. Descarga con SHA-256 contrastado. Conserva el código/cause de auth/red. |
| `src/lib/attachmentPersistence.ts:94,126` — `persistAttachedExpense`, `persistAttachedProperty` | Requiere referencia remota; verifica asociación; espera escritura y lectura posterior. Firestore usa `getDocFromServer`, no caché local. Vault confirma un movimiento o un inmueble. Solo elimina campos alternativos obsoletos de referencia al reemplazar un comprobante; no archivos/operaciones. Soporta documento, contrato activo e historial existente. |
| `src/lib/attachmentWriteCoordinator.ts:4`; `src/App.tsx:172,187,593,633,726,790` | Cola por cuenta e invalidación de copias de cartera anteriores/durante el commit. Callbacks de adjuntos esperados; estado y éxito solo tras confirmación. Guardas de cambio de cuenta. ID de inmueble creado antes de subir y reintento sin duplicar inmueble/cobros. |
| `src/lib/portfolioRemote.ts:65,274,320` | Propagación de señal de cancelación a sincronización/hidratación, indispensable para que una sincronización colgada no deje bloqueado el commit ni aplique una copia obsoleta. División de entidades y cálculos sin cambios. |
| `src/components/Expenses.tsx:167,218,560,588` — visor, adjuntar desde tabla, editar, submit | Conserva File/importe/fecha/categoría/inmueble/concepto al fallar, guarda draft ID y referencia para reintentar, bloquea doble submit y no resetea mientras persiste. Visor protegido con URL local revocable; descarga tardía no sustituye la selección nueva. |
| `src/components/Dashboard.tsx:196,250` — `handleFileScan`, `handleConfirmScan` | Scanner transmite IDs de operación/inmueble; espera el callback y conserva archivo/datos. Bloqueo también durante la indicación de éxito. No se cambia extracción Gemini ni cálculos. |
| `src/components/Properties.tsx:211,304,668` — documento, PDF de ficha, submit | Documento/draft con ID estable, cache de File/referencia, callback esperado y controles bloqueados al guardar. Mensaje «seleccionado, pendiente» en vez de falsa subida. Se conserva la selección si falla. Al cambiar proveedor de PDF no se revive la referencia anterior prioritaria; archivos anteriores no se borran. |
| `src/components/ContractCreator.tsx:247` — `handleLinkToProperty` | Hash/cache del documento generado y espera de asociación, bloqueo contra doble enlace. No cambian texto legal, titularidad ni cálculos. |
| `server/vault/routes.ts:334,379,491,551,586,595,776,791` | `movimientos.save` individual con integridad/asociación/readback; comprobación opcional de adjuntos en inmueble; presign/commit reconciliables; `files.verify` lee bytes privados y recalcula SHA; download `private, no-store`; reuso verifica bytes reales. Un error de hash no borra el objeto. |
| `server/vault/persistenceTypes.ts:27,129`; `persistence.ts:262,515`; `blobPort.ts:52,124`; `memoryBlobPort.ts:15,35` | Creación exclusiva del binario: Blob `allowOverwrite:false`, filesystem enlace exclusivo y fake con la misma semántica. No se sobreescriben binarios existentes para «arreglar» un conflicto. |
| `src/components/RecoveryPreviewPanel.tsx:62` | **Únicamente `format?: string` en el tipo del estado ya leído por la pantalla.** Necesario para validar TypeScript con los nuevos tipos React de las pruebas; no cambia código ejecutable, recuperación ni modelo de datos. Véase la aclaración en D. |
| `package.json`, `package-lock.json`, `bun.lock` | `spark-md5` para contraste MD5; renderer React/tipos solo de desarrollo y suites enumeradas. Renderer fijado a 19.2.7 para el React bloqueado existente. Bun lock sincronizado, incluyendo Blob ya declarado en el manifest base; sin actualizar dependencias productivas existentes. |

No se han modificado `firestore.rules`, `storage.rules`, configuración del proyecto Firebase, variables de producción, `vercel.json` ni fórmulas financieras. No se han ejecutado migraciones, borrados o escrituras sobre datos reales.

### Pruebas añadidas y regresiones adaptadas

- Nuevas: `src/lib/storageAttachment.test.ts`, `attachmentPersistence.test.ts`, `attachmentWriteCoordinator.test.ts`, `attachmentForms.test.tsx`, `server/vault/attachmentFlow.test.ts`.
- Fixtures sintéticos: `src/lib/attachmentTestFixtures.ts`; no importados por la aplicación.
- Regresiones adaptadas: `attachmentsVault.test.ts`, `vaultClient.test.ts`, `remotePersistence.test.ts`, `migrationWiring.test.ts`, `server/vault/persistenceBlob.test.ts`. Se corrigieron mocks que no aportaban SHA/confirmación realista y expectativas de borrado; no se relajaron las comprobaciones de integridad.
- Una regresión de cliente histórico fue reparada en servidor: omitir `propertyId` al reintentar conserva la asociación existente; proporcionar uno distinto se rechaza. La prueba patrimonial original vuelve a pasar y se añade cobertura explícita.

## D. Pruebas ejecutadas y resultados reales

| Comprobación | Resultado |
| --- | --- |
| `npm test` antes de reparar | **288 PASS**: 246 cliente + 42 servidor. |
| `npm ci --no-audit --no-fund` con lock final | PASS; 383 paquetes. |
| `npm test` con la reparación | **340 PASS**: 285 cliente + 55 servidor; 0 fallos, canceladas o saltadas. Incluye las 288 pruebas existentes y 52 nuevas. |
| Nuevas suites | Storage 14; persistencia 12; coordinación 5; componentes reales 8; HTTP/Blob simulado 13. |
| `npm run lint` (`tsc --noEmit`) final | **PASS, 0 errores**. |
| `npm run build` final | **PASS**, frontend Vite y backend esbuild. Advertencia no fatal de chunk superior a 500 kB; no se ha silenciado ni tratado fuera del alcance. |
| Bun `install --lockfile-only --frozen-lockfile --ignore-scripts` | PASS. Advertencia de `vite` duplicado en dependencies/devDependencies ya declarado en el manifest base. No es prueba de despliegue. |
| `git diff --check` | PASS. |
| PDF y JPG/PNG de prueba | PDF válido de una página/xref comprobado con pypdf; JPG/PNG válidos de 1×1 decodificados con Pillow. Sin datos reales. |

**Aclaración de TypeScript:** la primera comparación del commit base reutilizaba los `node_modules` nuevos y mostraba el mismo error `backupMetadata.format`; eso demostraba una anotación incompleta en el código, **no un fallo del lint original con sus dependencias originales**. La segunda comprobación aislada, con `git archive HEAD` y `npm ci` del lock base, pasó. Los tipos React añadidos para las pruebas hacen visible el campo que la pantalla ya utiliza. Se corrigió únicamente la declaración opcional del estado; después TypeScript y build pasan. No se atribuye falsamente ese fallo al baseline original.

### Qué demuestra la cobertura controlada

- PDF auténtico, PNG y JPEG válidos; inferencia MIME y Word HTML generado admitido para contratos.
- Flujo con cliente de producción y handlers HTTP reales: subir → verificar bytes/SHA → asociar → guardar → releer → descargar.
- Recuperación tras recrear API/persistencia y limpiar todos los datos de sesión/caché del navegador de pruebas.
- IDs de movimiento/inmueble y referencias conservados; actualización del inmueble propio sin escribir/borrar el otro inmueble sintético.
- Rechazo 401 de falta de token/token inválido y 404 de acceso con otra cuenta; documento inexistente o asociación errónea impiden commit.
- Hash/tamaño incorrectos, objeto alterado y upload directo incompleto no se confirman ni provocan borrado.
- Respuesta perdida de upload JSON, commit directo y persistencia: reintento mantiene un documento/operación; no repite PUT directo si el objeto ya está íntegro.
- Timeout con aborto/señal, ausencia de éxito tardío y reintento seguro; errores originales de autorización/red preservados.
- Componentes reales con renderer React: File y campos retenidos, formulario bloqueado hasta confirmación, doble click controlado, adjuntar desde tabla con reintento y cambio de referencia PDF sin rescatar la anterior.
- Compatibilidad de resolución Vault/Storage/inline histórico y autenticación mediante suites existentes.

**Límite importante:** MemoryBlobPort es un proveedor **simulado** que retiene objetos dentro del proceso de pruebas. Reinstanciar el servidor sobre él NO prueba cold starts/redeploys de Vercel ni almacenamiento remoto real. El renderer ejecuta componentes/handlers, pero NO es un navegador real ni prueba CORS/IndexedDB/selectores de Android. Los tests de Storage/Firestore inyectan transporte; no publican reglas ni acreditan permisos reales.

### Comprobaciones aún bloqueadas o pendientes

| Comprobación | Motivo específico |
| --- | --- |
| Anonymous real y permisos efectivos de `startup-sanctuary-sln7n` | Habilitación comunicada por el usuario; sin consulta administrativa del proveedor en esta sesión. |
| Firebase Storage + Firestore reales, dueño correcto y lectura desde nueva sesión/dispositivo | Sin acceso directo permitido a Google/Firebase ni consola administrativa; las reglas publicadas y el mapeo identidad/cuenta no están verificados. |
| CORS de media y recuperación en navegador real | La verificación por metadatos no prueba el transporte de descarga desde el navegador; requiere prueba autorizada del bucket real. |
| Vercel Blob privado real, límites/firmas, cold start/redeploy y readback | No hay prueba con credenciales/proveedor reales. No se ha autorizado ni ejecutado despliegue de esta reparación. |
| Preview con el código reparado | No se ha creado/pushado un commit ni una preview de esta rama. No se presenta una URL vieja como validación. |
| Factura sintética de aceptación en producción | Escritura remota no ejecutada: requiere autorización explícita y cuenta/inmueble de prueba. |
| OCR Scanner/Gemini y Word generado en navegador real | No forman parte de la prueba remota ejecutada; se conservan llamadas existentes y se comprueban compilación/transporte/servicios, no extracción del proveedor. |

Logs locales, excluidos de Git, en `data/attachment-repair-checks/`: `baseline-tests.log`, `baseline-clean-typecheck.log`, `full-tests-final.log`, `typecheck-final.log`, `production-build-final.log`, `fixture-format-validation.log`. Las ejecuciones intermedias con fallos se conservaron; no sustituyen a la ejecución final.

## E. Commit, rama y PR

- Rama de trabajo: **`arena/98d8e88d-gestor-patrimonial-4-1-2`**. No se cambió a otra rama.
- HEAD/base: **`3a71b97495e98f250681b8280e4592958c5439d8`**.
- Cambios guardados en el workspace, **sin commit nuevo**, sin push y sin PR nueva. No hay SHA de reparación que afirmar desplegado.
- No se ha fusionado, cerrado o modificado una PR en esta sesión.
- PR #9: CLOSED, `mergedAt:null`, `mergeCommit:null`. Su propuesta local-first no se incorporó a main; `src/lib/localVault.ts` no existe en el checkout. No se adopta como solución definitiva.
- PR #10–13 están incorporadas en la base; #13 contiene el enrutado compatible `?op=`. Esto no demuestra el funcionamiento actual del runtime.

## F. Vercel, producción y riesgos residuales

Consulta real de GitHub: último despliegue registrado **Production**, ID `6995215846`, estado `success`, **2026-10-11 12:01:04 UTC**, SHA base `3a71b97495e98f250681b8280e4592958c5439d8`.

URL inmutable registrada:
`https://gestor-patrimonial-4-1-2-gkc7z2rp8-sarqsan2-4111s-projects.vercel.app`.

El alias solicitado `https://gestor-patrimonial-4-1-2.vercel.app/` no se ha consultado directamente desde este sandbox. La política de salida permite GitHub/registros de paquetes, no Vercel/Firebase/Blob; no se presenta esto como un HTTP probe realizado. La versión registrada por GitHub no demuestra qué bundle recibió ese navegador.

Los comentarios históricos de PR #13 muestran preview **302** por Vercel Authentication y producción **404** en ambos estilos de ruta a las 11:30 UTC, **antes** del despliegue de 12:01. No se extrapolan al runtime posterior. No se ha ejecutado el workflow de verificación anterior, que crea datos remotos.

**Producción no ha sido modificada por esta sesión. La reparación NO está incorporada al despliegue.** No hay éxito de factura real/sintética en producción que declarar.

### Riesgos que deben revisarse antes de aceptar/fusionar

1. **Aislamiento Firebase:** las reglas versionadas de Storage (`storage.rules:14–26`) permiten leer con cualquier sesión, pero no vinculan la carpeta patrimonial al dueño; Anonymous no acredita ese username. Firestore portfolio exige `isOwner(userId)`; expenses contempla `ownerUid`. No se han relajado ni publicado reglas. No se puede certificar protección/cross-device del fallback Firebase sin revisar identidad y reglas efectivas. Vault privado y sus cuentas sí se prueban con control de autorización, pero solo sobre proveedor simulado.
2. **Media/CORS:** metadatos y checksum prueban referencia/contenido almacenado y acceso de esa consulta; no prueban que el navegador real pueda descargar la media. El criterio final exige recuperación real desde otra sesión, no solo upload/metadata.
3. **Durabilidad Vault:** `storageOk` y `durable` son necesarios, no prueba suficiente. Se deben verificar contra Blob privado real. Si no hay destino duradero operativo, el commit se rechaza; no se convierte una copia de navegador o filesystem efímero en éxito.
4. **Concurrencia:** cola/epochs protegen las sincronizaciones de este cliente. No se añade una transacción distribuida ni se garantiza inmunidad a reservas/metadatos concurrentes de distintas instancias/clientes antiguos. Los binarios son create-only, pero siguen pendientes pruebas de carreras distribuidas sobre el proveedor real.
5. **Reintento pendiente:** la identidad de la operación se conserva en el formulario abierto. No se añade guardado permanente de drafts/Files ni reanudación automática tras recargar/cancelar una operación sin confirmar. Hay que reconciliar el estado remoto antes de crear manualmente una operación nueva tras una respuesta perdida.
6. **Cancelación:** fetch y UploadTask se abortan cuando el transporte lo permite; SDK Firestore/metadatos no permiten cancelar una escritura/lectura ya emitida. Un proveedor podría terminar después del timeout. Nunca se anuncia éxito tardío ni se borra el objeto; el siguiente intento reconcilia la referencia estable.

**Propuesta de siguiente paso, no de merge:** revisar este patch y autorizar una preview aislada identificada por el SHA de la reparación. Validar G con almacenamiento real/protegido. Solo después decidir fusión y una validación de producción expresamente autorizada.

## G. Validación segura con documento IBI sintético

### Material de prueba

Generado localmente a partir de los mismos fixtures de tests; no es un recibo fiscal válido:

- [IBI_PRUEBA_SIN_VALIDEZ_FISCAL.pdf](../data/attachment-repair-checks/manual/IBI_PRUEBA_SIN_VALIDEZ_FISCAL.pdf): 625 bytes, una página con «PRUEBA IBI — SIN VALIDEZ FISCAL — SIN DATOS REALES».
- [IMAGEN_PRUEBA.png](../data/attachment-repair-checks/manual/IMAGEN_PRUEBA.png) y [IMAGEN_PRUEBA.jpg](../data/attachment-repair-checks/manual/IMAGEN_PRUEBA.jpg): blanco de 1×1 para validar formatos/transporte, **no OCR de facturas**.

SHA-256 esperado del PDF:

```text
96bdb6beac7daf8b7de4d8c64e914539d44eee0b97c0e7b6eac14517893d2a8c
```

Los binarios de prueba/build/logs están excluidos de Git; no se incluyen datasets ni facturas reales.

### Procedimiento de preview — pendiente de autorización

1. Revisar cambios y aprobar la creación de commit/push/preview de **esta rama**, sin fusionar main ni cambiar proyecto, credenciales, variables o reglas. Confirmar SHA/bundle de esa preview: una URL histórica no contiene esta reparación.
2. Entrar legítimamente en la preview si Vercel Authentication la protege. No desactivar protección ni poner tokens de bypass/servicio en cliente. Antes de subir, comprobar que `/api/vault?op=health` llega al backend correcto, JSON válido, destino privado real con `storageOk:true` y `durable:true`; 302/HTML/404 no son salud ni aceptación. No inventar `durable:true` para hacer pasar la prueba.
3. Usar una cuenta y un inmueble **exclusivamente sintéticos**, autorizados para la prueba, por ejemplo `prueba_ibi_20261011_<sufijo>` y «PRUEBA IBI — SIN DATOS REALES». Elegir contraseña propia; no compartirla. Verificar primero que ese inmueble esté guardado en el remoto. No tocar inmuebles/documentos/operaciones de personas reales.
4. En Gastos registrar **IBI**, importe **1,00 €**, fecha **2026-10-11**, concepto **PRUEBA SIN VALIDEZ FISCAL**, inmueble sintético y el PDF. Seleccionar solo debe decir pendiente. Guardar y esperar confirmación de archivo **y** operación. Comprobar `receiptVaultId`/`receiptPath`, ID de operación y `propertyId` correctos, objeto privado y hash/tamaño esperado; no aceptar únicamente el toast.
5. Descargar desde la operación, abrir el PDF y comparar SHA-256 local. Cerrar sesión; usar navegador/sesión limpia y volver a autenticar la cuenta de prueba. Recuperar la operación y el mismo documento desde el remoto, sin depender de caché/localStorage.
6. Con otra cuenta de prueba y sin token comprobar denegación de acceso al documento. No compartir una URL pública permanente como prueba de protección. Para Firebase, validar además dueño/UID/cuenta y CORS reales; Anonymous habilitado no basta.
7. En esa cuenta repetir JPG y PNG y el documento desde **Inmuebles → Recibos/Docs → IBI → Integrar Documento**. Verificar enlace al inmueble propio, año/categoría y recuperación posterior. Las imágenes solo prueban transporte/formato.
8. Solo en preview/cuenta sintética simular fallo de red/rechazo: mantener importe, fecha, concepto, inmueble y File; no confirmar ni cerrar. Reintentar **el mismo formulario** sin recargar: mismo ID/referencia, un documento y una operación. Probar doble click y respuesta perdida tras commit. Si se recarga, revisar primero el remoto antes de registrar otra operación.
9. Verificar permanencia tras nueva instancia/cold start o redeploy autorizado del backend de preview, sin borrar los datos de prueba. Conservar evidencia: SHA del build, fase/código, ID de objeto/operación/inmueble y hash de descarga; **sin Authorization, cookies, firmas de PUT, claves ni datos fiscales reales**.
10. Detener aceptación si falla autorización, integridad, asociación, durabilidad o recuperación. Un build verde, un provider habilitado o 340 tests locales no sustituyen estos pasos.

**Producción:** repetir un único caso sintético allí solo con autorización explícita posterior, una vez aceptada la preview. Hasta que el documento esté guardado, protegido, asociado y recuperado de verdad, **producción sigue sin validación de recuperación**. No ejecutar importaciones/migraciones/borrados masivos para comprobarlo.
