# Corrección local de bloqueantes de adjuntos — entrega con STOP

**Fecha:** 2026-10-11. **No dar la corrección global por terminada ni aceptar/fusionar.**

Los ocho contraejemplos originales están corregidos en su comprobación local: **14/14 invariantes PASS**. Sin embargo, la revisión adicional reprodujo una **carrera multirregistro todavía abierta** y el cierre conservador del endpoint de borrado produjo una **regresión funcional que sigue detectada por R6**. Se mantienen ambas comprobaciones y se solicita autorización independiente para resolver el ciclo de vida. No se presenta una suite completamente verde ni aceptación remota.

## A. Estado, conservación y límites de autorización

- Rama exclusiva: `arena/98d8e88d-gestor-patrimonial-4-1-2`; HEAD sin cambios: `3a71b97495e98f250681b8280e4592958c5439d8`.
- No se ha hecho commit, staging, push, PR, merge, despliegue, migración ni escritura en servicios reales. Ninguna factura/operación real fue utilizada o eliminada.
- Los **42 archivos existentes al comienzo de esta corrección**, incluidos los 34 originales, están conservados en `estado-anterior.tar.gz` (379430 bytes) y comprobados contra las 42 huellas de `estado-anterior.json`. Los documentos históricos de reparación y auditoría no se reescriben para cambiar sus resultados.
- El estado previo se reconstruyó en una carpeta temporal con `git archive HEAD` más ese archivo verificado, sin checkout, stash ni cambio de rama. Las pruebas ampliadas se ejecutaron contra esa reconstrucción. La carpeta generada se retiró; el archivo persistente permanece intacto.
- Autorización recibida: **solo** el registro técnico de revocación por sesión `{username, tokenHash, expiresAt}`, separado de los datos financieros. No contiene credencial en claro, no rota contraseñas/clave global y no autoriza cambios de reglas, proyecto, infraestructura o transacciones de ciclo de vida.
- Se revisaron los informes A–G anteriores: la reparación funcional previa no acreditaba los invariantes de seguridad ni el aislamiento remoto. Este informe es acumulativo, no sustituye aquella evidencia.

## B. Ocho fallos originales: causa y corrección local

| Invariante | Causa reproducida antes | Cambio | Resultado después |
|---|---|---|---|
| L06 — Storage | Se aceptaba `receiptPath` como prueba del documento aunque fuera inexistente o ajeno. | Verificador autoritativo **de servidor**, obligatorio: propietario, ruta, bytes/SHA, generación y contexto. Sin verificador configurado, rechazo; ningún flag del cliente lo omite. La confirmación Firebase por defecto también falla cerrada. | 403 para ruta ajena; no `storageOk`. Casos de verificador simulado cubren ausencia, otro propietario, corrupción, contexto y generación. No demuestra permisos Firebase reales. |
| L07 — padre remoto | Coincidían cadenas `propertyId`, pero no se exigía inmueble existente en la cartera autorizada. | Consulta al padre remoto propio antes del commit y verificación posterior. | 409 en padre inexistente o solo presente en otra cuenta. **No cubre por sí sola la carrera CICLO-01**. |
| L08 — gasto antiguo | Reemplazo genérico del JSON eliminaba el comprobante confirmado. | Retención de referencias derivadas del registro y escritura CAS por ETag. Una versión explícita incorrecta devuelve 409. El cliente no obtiene una versión fresca para legitimar datos viejos. | 409; referencia confirmada conservada. Dos escrituras cambiantes contra el mismo ETag confirman solo una. |
| L09 — bandera opcional | Solo se comprobaban archivos si venía `attachmentIds`. | Derivación obligatoria de documentos/contrato/historial del cuerpo, independientemente de `attachmentIds` ausente/vacío. | 409 para referencias privadas ajenas o inexistentes. |
| L10 — inmueble antiguo | Snapshot completo podía borrar documentos. | CAS y retención de documentos/historial. Sin una versión capturada con los datos, se rechaza retirar/sustituir referencias. | 409; documentos y registros retenidos. |
| L11 — logout | Borrado local de un token HMAC de larga duración; el servidor seguía aceptándolo. | Revocación persistida por huella, consulta en autenticación y logout del cliente esperado antes de limpiar estado. `sid` aleatorio para sesiones distintas. Firebase `signOut` esperado. Lectura de revocación corrupta/no disponible falla cerrada. | Helper real + API local: token retirado del navegador y credencial retenida devuelve **401**. Otra cuenta y otra sesión de la misma cuenta siguen válidas; secreto global no cambia. |
| L13 — ZIP | Empaquetaba lectura cruda sin las comprobaciones de descarga. | Verifica SHA/tamaño/consolidación, padre y vínculo al gasto o documento del inmueble. Incluye referencias legacy `pdfVaultId/pdfPath`; no depende del prefijo histórico del ID. | Corrupción/reserva/documento sin vínculo se rechazan. No se alteran originales para hacer pasar el ZIP. |
| L14 — legacy | Sin ID histórico se generaban IDs aleatorios en cada retry. | Identidad determinista por hash **real de contenido**, nombre/MIME y contexto; creación exclusiva y reconciliación tras conflicto. Reserva directa sin ID requiere SHA antes de reservar. | Mismo contenido/intención reutiliza ID; dos instancias concurrentes no duplican. Mismo nombre/tamaño con bytes o contexto diferentes no se fusionan. |

Estos PASS corresponden a los contraejemplos ejecutados, no a una garantía universal de atomicidad entre objetos o de privacidad de Firebase existente.

## C. Inventario exacto de esta corrección

El inventario distingue cambios de **esta corrección** del trabajo previo acumulado: `inventario-cambios.json`, con SHA antes/después. Son **16 fuentes existentes modificadas y 3 nuevas**; los demás cambios visibles contra HEAD pertenecían a etapas anteriores y se conservan.

| Archivo | Justificación |
|---|---|
| `package.json` | Añade la suite de bloqueantes y carga la barrera de red en ambos procesos de `npm test`. |
| `server/apiApp.ts` | Inyección opcional de un puerto Storage autoritativo solo servidor; ninguna credencial/configuración real añadida. |
| `server/vault/auth.ts` | Verificación de claims compatible con sesiones antiguas y `sid` nuevo; no rotación de secreto. |
| `server/vault/persistenceTypes.ts` | ETag/condiciones de escritura y lectura versionada; tipos del registro técnico de revocación autorizado. ETag no se añade como columna financiera. |
| `server/vault/blobPort.ts` | Lectura sin caché y `ifMatch`/creación exclusiva/borrado condicional del SDK; proveedor real no invocado. |
| `server/vault/memoryBlobPort.ts` | Doble que impone esas condiciones entre instancias; no almacenamiento permanente real. |
| `server/vault/persistence.ts` | CAS de JSON, retención, creación exclusiva de cuenta/clave/binario, revocación por huella y fallo cerrado de ledger ilegible. Equivalentes locales no duraderos con locks de fichero. |
| `server/vault/routes.ts` | Verificación obligatoria, padre propio, logout, lecturas versionadas, legacy determinista, ZIP seguro y errores 409. **Retirada conservadora del borrado HTTP existente: objeto/reserva propio existente devuelve 409, ausente/ajeno 404, sin borrar**. Esta restricción provoca R6 pendiente. |
| `server/vault/attachmentSafety.ts` — nuevo | Extracción de referencias, retención y transición inmutable de identidad/contexto del archivo. |
| `server/vault/storageVerification.ts` — nuevo | Contrato de verificación autoritativa de propietario/bytes/hash/versión/contexto; no adaptador Firebase habilitado. |
| `server/vault/attachmentBlockers.test.ts` — nuevo | 32 casos locales del servidor, incluidos dos servidores, CAS, sesión, verificador simulado, ZIP y retención de borrado. |
| `server/vault/attachmentFlow.test.ts` | Preparación de un padre remoto sintético propio; no relajación de aserciones. |
| `server/vault/patrimonialIntegration.test.ts` | Sube los bytes antes de confirmar referencias; mismas aserciones patrimoniales. |
| `server/vault/vault.test.ts` | Padre propio y contexto auténtico de los archivos sintéticos del ZIP; se mantienen comprobaciones de contenido y CRC. |
| `src/lib/vaultClient.ts` | Logout esperado/reintetable, servidor primero. Se eliminó GET ad hoc de ETag en commit: no legitimar snapshot capturado antes. |
| `src/App.tsx` | Espera revocación y Firebase signOut antes de limpiar usuario/datos/UI; fallo no anuncia cierre correcto. |
| `src/lib/attachmentPersistence.ts` | Firebase por defecto se bloquea **antes de lecturas/escrituras SDK** de confirmación sin autoridad servidor. Se retiraron cuerpos SDK inalcanzables, conservados en el archivo anterior. El puerto simulado sigue comprobando el flujo. |
| `src/lib/vaultClient.test.ts` | Cliente real: revocación esperada, credencial retenida ante fallo, retry 401 ya revocado y prohibición de ETag conseguido para un snapshot viejo. |
| `src/lib/remotePersistence.test.ts` | Driver Auth falso explícito para que pruebas locales no intenten Firebase real. |

### RecoveryPreviewPanel

No se revierte su anotación previa `format?: string`. Un compilador TypeScript con el archivo hipotéticamente modificado **en memoria**, sin editarlo, devuelve **TS2339 en línea 407** si se elimina. Conservarla evita perder trabajo necesario. Evidencia: `revision-recovery.json`; SHA del archivo idéntico al preservado al inicio de esta corrección.

### Formularios y proveedores

Se conservan las pruebas del componente real que retienen `File`, importe, fecha, inmueble, concepto e ID ante fallo; un upload no limpia el formulario antes de resolver la persistencia y su lectura. El puerto de confirmación compara datos/vínculos y no convierte memoria/localStorage en guardado remoto.

**Restricción funcional explícita:** la UI actual no dispone de un ETag capturado con el formulario. Sustituir una referencia ya confirmada puede devolver 409 conservando el formulario; no se utiliza un GET fresco como bypass. El flujo seguro de sustitución/concurrencia debe completarse junto al ciclo de vida autorizado. Storage/Firebase sin autoridad servidor no es una ruta de éxito; tampoco se cambia silenciosamente de proveedor para aparentarlo.

## D. Pruebas realmente ejecutadas

Todo es sintético, proveedor MemoryBlobPort o filesystem local de prueba, HTTP loopback y barrera de fetch/TCP. Ningún test usa facturas reales o servicios externos.

| Comprobación | Resultado | Evidencia |
|---|---|---|
| Invariantes originales antes | 14: **6 PASS / 8 FAIL** | `antes-invariantes.json`, `antes-local.mjs` |
| Mismas invariantes después | 14: **14 PASS / 0 FAIL** | `despues-invariantes.json`, `despues-local.mjs` |
| Nueva suite inicial antes | 16: **2 PASS / 14 FAIL** | `antes-regresion.json` |
| Regresión ampliada sobre estado previo reconstruido | 42: **12 PASS / 30 FAIL** | `antes-regresion-ampliada.json` |
| Caso adicional de borrado definitivo antes | 1: **FAIL** | `antes-borrado-definitivo.json` |
| Regresión ampliada final (32 servidor + 11 cliente) | 43: **43 PASS / 0 FAIL** | `despues-regresion-ampliada.json` |
| Suite final `npm test` | 375: **374 PASS / 1 FAIL** (cliente 288/288; servidor 86/87) | `despues-regresion.json` |
| `npm run lint` / TypeScript | **PASS**, exit 0 | `despues-typescript.json` |
| `npm run build` / Vite + esbuild | **PASS**, exit 0; advertencia de chunks >500 kB | `despues-build.json` |
| Ciclo de vida multirregistro, dos servidores | **FAIL; bloqueante reproducido** | `comprobacion-ciclo-vida.mjs`, `ciclo-vida-pendiente.json` |

En la suite final: **32 informes de barrera**, **0 fetch externos intentados/bloqueados y 0 sockets externos intentados/bloqueados**. TypeScript/build y los scripts también se ejecutaron con barrera. La ausencia de egress no acredita un proveedor real.

**R6 no se ha borrado, marcado skip ni cambiado de 204 a 409.** Detecta que el DELETE anidado de un archivo propio ya existente ha dejado de responder 204 por el bloqueo conservador. El routing llega a Express, pero su contrato funcional no está satisfecho. Es una regresión pendiente, no una suite verde.

El diagnóstico después de L11 ejecuta **`vaultLogoutSession` contra la API local**, no solo `clearVaultToken`. Para L12/L13 abre otra sesión autenticada del mismo usuario, de modo que su rechazo de corrupción no sea un falso PASS causado por usar un token ya revocado.

Pruebas adicionales detectaron y corrigieron dos fallos intermedios sin relajar sus aserciones: ZIP de un documento sin vínculo al inmueble (`antes-zip-asociacion.json`) y ledger de revocación JSON corrupto (`antes-revocacion-corrupta.json`).

## E. Bloqueante adicional reproducido: CICLO-01

Una operación se protege con CAS **en su JSON**, pero el gasto y su inmueble son objetos distintos. Reproducción determinista, sin servicios reales:

1. Instancia B comprueba que un inmueble no tiene aún gasto con adjunto y queda detenida justo antes de su borrado CAS.
2. Instancia A confirma bytes, padre, gasto y readback; responde **200**.
3. B continúa: su ETag de inmueble sigue siendo válido, porque guardar el gasto no cambió ese JSON. Borra el padre y responde **204**.
4. Lectura del padre: **404**; lectura del gasto confirmado: **200**, con su referencia de archivo aún presente.

**Resultado FAIL.** La doble verificación y el CAS por objeto no equivalen a transacción padre/gasto/archivo. No se oculta como «test remoto pendiente»: el fallo **ya se ha demostrado localmente** y bloquea el cierre de la corrección de concurrencia/retención global.

También siguen sin demostrarse como transacciones globales: consolidación de bytes/metadatos entre objetos, una petición ya autenticada que coincida con logout y atomicidad de batches de varios objetos. Un batch puede haber guardado objetos anteriores antes de un conflicto posterior; no se anuncia todo-o-nada.

## F. Qué requiere autorización / riesgos que no se han resuelto

1. **Ciclo de vida multirregistro:** autorización independiente para diseñar e implementar localmente un mecanismo técnico de coordinación/transacción de asociación/sustitución/retirada que cubra TODOS los escritores y dos instancias. La autorización de `session-revocations` no autoriza otro namespace técnico, esquema, migración o infraestructura. Se ha detenido esta parte, manteniendo el contraejemplo y R6.
2. **Storage/Firebase:** faltan autoridad de identidad username↔UID, adaptador servidor y reglas/ACL aisladas demostradas. No se modificaron/publicaron reglas ni se cambió proyecto, credenciales o variables. Las reglas/objetos Firebase existentes siguen sin garantía de aislamiento acreditada. Anonymous habilitado no la prueba.
3. **Entorno remoto:** el informe previo registró preview/producción con la misma configuración Firebase versionada. No se hizo ninguna nueva sonda ni se ha demostrado una vinculación aislada no productiva para Firebase/Blob. Pruebas reales, aceptación y fusión permanecen bloqueadas.
4. **Logout:** revoca la credencial Vault cerrada, no todas las sesiones del usuario. Firebase signOut limpia la sesión SDK del navegador; no invalida retroactivamente todos los tokens Firebase ni enlaces de descarga antiguos. Peticiones ya en vuelo no están demostradas como cancelables transaccionalmente.
5. **Revocaciones:** expiración guardada y rechazo de token expirado; no se implementó limpieza masiva del ledger ni se borró registro real alguno.
6. **Borrado y sustitución:** restricciones conservadoras preservan archivos pero no son un flujo de ciclo de vida acabado; R6 y el rechazo de sustitución sin snapshot versionado deben resolverse, no aprobarse como funcionamiento completo.

## G. Decisión y siguiente paso solicitado

**STOP: no cerrar la corrección como completa, no fusionar ni desplegar.** Los ocho contraejemplos originales pasan, pero los criterios globales de concurrencia/ciclo de vida no están satisfechos y la suite completa conserva un fallo.

Se solicita autorización **solo para trabajo local** de un mecanismo técnico separado de ciclo de vida/coordinación transaccional, sin columnas financieras, credenciales/rules/proyecto nuevos, migración, conexiones productivas ni escrituras reales. Primero diseño e invariantes verificables; después implementación, CICLO-01 y R6 obligatoriamente PASS sin debilitar ninguno, y nueva suite/TypeScript/build. Si esa autorización no se concede, mantener esta parte detenida y los riesgos explicitados.

Para aceptación remota se requiere, adicionalmente y por separado, demostrar bindings no productivos aislados y obtener las autorizaciones necesarias. Los artefactos locales y la compilación no sustituyen esa puerta.
