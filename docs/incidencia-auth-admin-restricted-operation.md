# Incidencia: `auth/admin-restricted-operation` en Firebase Auth (producción)

Fecha del informe: 2026-10-10
Repositorio: `sarqsan/gestor-patrimonial-4.1.-2`
Rama de trabajo: `arena/17d0d46b-gestor-patrimonial-4-1-2` (basada exactamente en el commit desplegado)

## 1. Verificación del código desplegado (solo lectura)

- `git rev-parse HEAD` = `d5bfcc6d0686b453cf4217f54d9e463ba2965aa0` → **coincide con el commit
  desplegado declarado**. La rama de trabajo parte de ese mismo commit; no hay deriva de código.
- Archivos inspeccionados: `src/lib/firebase.ts`, `src/lib/attachments.ts`,
  `src/lib/movementService.ts`, `firebase-applet-config.json`, `firestore.rules`,
  `storage.rules`, `src/App.tsx`, `src/components/AuthScreen.tsx`, `server/apiApp.ts`.

### Cómo se autentica hoy la aplicación

1. **Usuario de la aplicación**: pantalla local de usuario/contraseña (`AuthScreen`), con cuentas
   guardadas en `localStorage`. El nombre de usuario (p. ej. `rentasync`) es la clave de todos los
   datos: `users/{usuario}/data/portfolio`, `users/{usuario}/expenses/{id}` (Firestore) y
   `users/{usuario}/attachments/**`, `users/{usuario}/backups/**` (Storage).
2. **Sesión Firebase**: exclusivamente `signInAnonymously(auth)` (`src/lib/firebase.ts`,
   `ensureFirebaseAuth`). Su única función es satisfacer `request.auth != null` en las reglas de
   Firestore/Storage y aportar el `ownerUid` de los movimientos. No existe ningún otro flujo de
   Firebase Auth en el código (ni correo/contraseña, ni Google, ni tokens personalizados, ni
   credenciales de servicio en cliente o servidor).

### Causa demostrada del error

- El SDK de Firebase v12 instalado en el proyecto traduce el rechazo `ADMIN_ONLY_OPERATION` del
  **backend de Identity Platform** al código `auth/admin-restricted-operation` con el mensaje
  *"This operation is restricted to administrators only."* (verificado en
  `node_modules/@firebase/auth/dist/node/totp-D1uGng8T.js`).
- Es decir: la llamada `signInAnonymously` llega al servicio y el servicio la **rechaza por una
  restricción administrativa de configuración del proyecto Firebase** `startup-sanctuary-sln7n`.
- No es un fallo transitorio de red: esos fallos llegarían como `auth/network-request-failed`
  (error de `fetch`), y el cliente ya los distingue (ver §5).
- No es un error corregible en el cliente: ningún cambio de código de la aplicación puede levantar
  una restricción impuesta por la configuración del proyecto en el servicio.
- Consecuencia observada: `ensureSignedIn()` (`src/lib/attachments.ts`) aborta con
  `AttachmentError` **antes** de intentar `uploadBytes`; por eso "la subida del archivo se cancela".

**Límite de la evidencia**: el ajuste exacto que impone la restricción solo puede leerse en la
consola del proyecto (Firebase Authentication / Identity Platform). Este entorno no tiene acceso de
red a las APIs de Google ni credenciales de administración del proyecto, por lo que no se atribuye
el rechazo a un ajuste concreto sin evidencia; se documenta el hecho demostrado (rechazo
`ADMIN_ONLY_OPERATION` del servicio) y el cambio imprescindible (§4).

## 2. Alternativas de autenticación evaluadas (en el orden exigido)

1. **¿Existe un mecanismo ya disponible y compatible?** No.
   - `firebase-applet-config.json` incluye un `oAuthClientId`, pero no hay ningún flujo de acceso
     con Google en la aplicación. Implantarlo exigiría re-clavear los datos (hoy por nombre de
     usuario local) hacia el UID/email del token Google: eso **modificaría el modelo de
     propietarios y reasignaría movimientos**, expresamente prohibido en la incidencia. Además,
     `firestore.rules` (`isOwner`) no autorizaría a un token Google sobre `users/{usuario}` sin esa
     reasignación.
   - Correo/contraseña de Firebase: no hay flujo de alta en la app, las cuentas actuales son locales
     y la operación de alta (`signUp`) es precisamente del tipo que la restricción administrativa
     bloquea; además requeriría cambiar el modelo de usuarios. Descartado por los mismos motivos.
   - Tokens personalizados vía Admin SDK: no existen credenciales de servicio en el repositorio y
     embeber claves privilegiadas en el cliente está expresamente prohibido.
2. **Cambio de configuración/infraestructura imprescindible**: levantar la restricción
   administrativa que impide la sesión anónima en el proyecto `startup-sanctuary-sln7n` (detalle en
   §4). Es el único camino compatible con el modelo actual de usuarios y con los datos existentes.
3. **¿Puede ejecutarse ese cambio desde este entorno?** No. Ver §4 → **bloqueo real declarado**.

## 3. Cambios de código aplicados (alcance limitado; NO resuelven el bloqueo)

Siguiendo la instrucción de no introducir cambios de cliente que no pueden resolver la incidencia,
los cambios aplicados son únicamente los imprescindibles para **reproducir, clasificar y comunicar
honestamente** el rechazo administrativo:

| Archivo | Cambio | Motivo |
| --- | --- | --- |
| `src/lib/firebase.ts` | Punto de inyección `__setSignInDriverForTests` alrededor de `signInAnonymously` (comportamiento real idéntico). | Reproducir el rechazo del servicio en pruebas sin red ni proyecto real. |
| `src/lib/firebase.ts` | Clasificación `classifyAuthError` / `isAdministrativeAuthError` / `isTransientNetworkAuthError` y conjuntos de códigos. | Que el cliente no confunda el rechazo administrativo con fallo transitorio de red. |
| `src/lib/firebase.ts` | Mensaje de `describeAuthError` para `auth/admin-restricted-operation`: identifica la restricción administrativa y su vía de resolución (consola). | Comunicación honesta al operador. |
| `src/lib/attachments.ts` | Rama específica en `ensureSignedIn()` para rechazos administrativos: mensaje con el código del servicio, sin lenguaje de conectividad ni de timeout. | La subida se cancela comunicando el bloqueo real. |
| `src/lib/adminRestrictedOperation.test.ts` + registro en `package.json` | Pruebas nuevas (ver §5). | Verificación obligatoria. |

**No se ha tocado**: `firestore.rules`, `storage.rules`, `firebase-applet-config.json` (proyecto y
base de datos intactos), el modelo de propietarios/`ownerUid`, los movimientos históricos ni la
compatibilidad con comprobantes históricos (`receiptUrl`/data-URL antiguos).

## 4. BLOQUEO REAL: cambio administrativo no ejecutable desde este entorno

La resolución exige un cambio en la configuración del proyecto Firebase `startup-sanctuary-sln7n`
(propietario: la cuenta administradora del proyecto), que este entorno **no puede ejecutar**:

1. Consola de Firebase → proyecto `startup-sanctuary-sln7n` → **Authentication → Sign-in method**:
   verificar que el proveedor **Anonymous** está habilitado y que no hay restricciones de tipo
   "solo administradores" sobre el inicio de sesión.
2. Si el proyecto se gestiona con **Identity Platform** (Google Cloud → Identity Platform →
   Settings): permitir el acceso anónimo y revisar funciones de bloqueo o políticas que rechacen la
   operación (el código `ADMIN_ONLY_OPERATION` indica restricción a nivel de proyecto).
3. Revisar restricciones de la API key de Identity Toolkit si las hubiera.

Por qué no es automatizable desde aquí:

- No hay en el repositorio credenciales de administración de Firebase/GCP (ni service account, ni
  `FIREBASE_TOKEN`, ni `firebase.json` con proyecto configurado).
- Este entorno de trabajo no tiene ruta de red hacia `*.googleapis.com` / consola de Firebase.
- Ejecutarlo requiere identidad humana con rol propietario/editor del proyecto Google Cloud.

Hasta que ese cambio se aplique, **ningún cambio adicional de cliente puede resolver la
incidencia**, y por mandato expreso no se seguirán introduciendo.

## 5. Pruebas ejecutadas

- `src/lib/adminRestrictedOperation.test.ts` (nuevo, 11 comprobaciones):
  - **R1** reproduce el rechazo con el código y mensaje exactos del servicio
    (`auth/admin-restricted-operation` / *"restricted to administrators only"*) y verifica que se
    propaga sin enmascararse y sin bloqueo permanente.
  - **R2** verifica una sola petición en vuelo bajo llamadas concurrentes (sin tormentas).
  - **R3/R4** demuestran que el cliente **no clasifica ni comunica** el rechazo como fallo
    transitorio de red (contraste incluido con `auth/network-request-failed` y `auth/timeout`).
  - **R5** demuestra que el error llega de inmediato (no por el timeout de 15 s reservado a red) y
    con lenguaje de restricción administrativa.
  - **R6** demuestra que `uploadAttachment` se cancela **antes** de intentar la subida a Storage.
  - **R8** demuestra que el mecanismo de sesión funciona si el servicio autorizara la operación.
- Suite completa: `npm test` → **209 pruebas, 0 fallos** (incluye las 121 previas sin regresión).
- `npm run lint` (`tsc --noEmit`) sin errores; `npm run build` correcto.

**Alcance de estas pruebas**: son simuladas (el entorno no puede alcanzar el servicio real).
Demuestran el comportamiento del cliente ante el rechazo, **no** certifican la resolución de la
incidencia en producción.

## 6. Verificación pendiente tras el desbloqueo (entorno controlado)

Cuando la administración del proyecto levante la restricción, verificar **antes de declarar
resuelto**:

1. `signInAnonymously` obtiene sesión real (`auth.currentUser.isAnonymous === true`).
2. Escritura/lectura autorizada en Firestore: guardar un movimiento de prueba en
   `users/{usuario}/expenses/{id}` y releerlo.
3. Autorización en Storage: subir un archivo de prueba (PNG/PDF < 10 MB) a
   `users/{usuario}/attachments/expenses/...` y recuperarlo (`getAttachmentBytes` / descarga).
4. Confirmar que los gastos y comprobantes históricos siguen listándose y descargándose igual.
5. No se debe realizar ninguna escritura real en producción sin autorización expresa.

## Apéndice A — Auditoría de vías administrativas (segunda investigación, 2026-10-10)

Investigación ordenada por la dirección para agotar las vías administrativas disponibles antes de
declarar el bloqueo definitivo.

### A.1. Estado del repositorio verificado antes de actuar

- `origin/main` = `d5bfcc6d0686b453cf4217f54d9e463ba2965aa0` (commit de integración): **sin
  cambios ajenos** posteriores que preservar.
- Rama de diagnóstico en remoto = `2dd47af430f38c2d515275ba8661952e09064eb8`.
  `git merge-base --is-ancestor 2dd47af origin/main` → **NO integrado** (correcto: es diagnóstico,
  no solución).
- Sin PRs abiertos. Working tree limpio. El diff de `2dd47af` toca exactamente 5 ficheros
  (informe, registro de test, test nuevo, `firebase.ts`, `attachments.ts`): nada ajeno.

### A.2. Herramientas y conexiones comprobadas (resultado: SIN ACCESO)

| Vía comprobada | Resultado |
| --- | --- |
| Conectores de Arena `firebase`, `google-cloud`, `gcp`, `google` (`list_connector_tools`) | `unsupported` los cuatro; además no hay ninguna app conectada en la conversación |
| CLIs `firebase`, `gcloud`, `gsutil`, `bq` en el entorno | No instalados |
| Variables de entorno con credenciales (`GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_TOKEN`, etc.) | Ninguna |
| Configuraciones locales (`~/.config`, home) | Sin perfiles firebase/gcloud/google |
| Credenciales de administración en el repositorio (búsqueda por patrones `service account`, `private_key`, `client_email`, `firebase-admin`…) | Ninguna |
| Sonda de red SOLO LECTURA a `identitytoolkit`, `firebase`, `firestore`, `storage` y `oauth2` en `googleapis.com` | Inalcanzables (HTTP 000; el egress del entorno solo permite github.com, npm y pypi). Control: `api.github.com` responde HTTP 200 |

**Distinción requerida**: no se puede **leer** la configuración de autenticación del proyecto, no
se puede **modificar**, y no se dispone de **acceso** alguno. No se afirma nada sobre el estado
real del proveedor anónimo en `startup-sanctuary-sln7n` porque no ha podido consultarse; solo está
demostrado el rechazo `ADMIN_ONLY_OPERATION` del servicio (hecho de producción). Instalar
`firebase-tools` no cambiaría nada: no hay red hacia Google ni credenciales con las que autenticarse.
Los emuladores locales tampoco aplican: simularían un proyecto nuevo, no pueden ni consultar ni
levantar la restricción del proyecto real.

### A.3. Permiso/capacidad que falta

Una identidad con rol **Owner o Editor** (o Firebase Admin delegado) del proyecto Google Cloud
`startup-sanctuary-sln7n`, ejercida desde una red con acceso a
`console.firebase.google.com` / APIs de Google. Ese es el único permiso que desbloquea la causa.

### A.4. Acción administrativa concreta imprescindible

En el proyecto `startup-sanctuary-sln7n`:

1. Firebase Console → **Authentication → Sign-in method**: habilitar el proveedor **Anonymous**
   si estuviera deshabilitado, y retirar cualquier restricción de tipo "solo administradores".
2. Si el proyecto lo gobierna **Identity Platform** (Google Cloud → Identity Platform →
   Settings): permitir el sign-in anónimo y revisar funciones de bloqueo/políticas que devuelvan
   `ADMIN_ONLY_OPERATION`.
3. Tras el cambio, verificar según la sección 6 de este informe (sesión real, escritura en
   Firestore, subida y recuperación de un archivo de prueba, aislamiento entre usuarios).

### A.5. Alternativas técnicas evaluadas y descartadas por las restricciones vigentes

- **Cambiar la app a otro proyecto Firebase** donde el proveedor anónimo esté permitido: excluido
  (prohibido cambiar el proyecto o el identificador de la base de datos; además abandonaría los
  datos existentes, que no pueden migrarse).
- **Google OAuth o email/contraseña de Firebase**: excluidos mientras no exista un diseño
  compatible con la continuidad de identidad (datos claveados por usuario local, `isOwner` por
  uid/email/username) y una evaluación de los datos afectados; el sign-up de Firebase es del mismo
  tipo de operación que la restricción bloquea.
- **Proxy de sesión con Admin SDK en el servidor**: excluido: requeriría credenciales privilegiadas
  nuevas, y las escrituras de servidor eludirían las reglas por usuario, debilitando la frontera de
  seguridad que la incidencia manda conservar.
- **Emuladores de Firebase**: no consultan ni modifican el proyecto real; no resuelven nada.

Conclusión: para restaurar la sincronización en la nube, la única vía es la acción administrativa
A.4, ejecutable únicamente por la administración del proyecto. Mientras tanto, la subida de
comprobantes se restablece mediante la alternativa del apartado B.

## Apéndice B — Solución alternativa implementada: contingencia local-first (tercera investigación, 2026-10-10)

Orden recibida: resolver la subida de archivos sin intervención manual del usuario en Firebase
Console. Agotadas todas las vías administrativas (Apéndice A: sin conectores, sin CLIs, sin
credenciales, sin red a Google), la única alternativa ejecutable desde el repositorio es una vía de
contingencia que no dependa de la sesión de Firebase.

### B.1. Alternativas evaluadas y descartadas (con motivo)

| Alternativa | Motivo del descarte |
| --- | --- |
| Otro proveedor Firebase (Google OAuth, email/contraseña) | Exigen configuración del proyecto que no se puede consultar ni modificar desde aquí; además cambian el UID efectivo: `isOwner` no casaría tokens Google con `users/{usuario}` sin reasignar movimientos (prohibido) |
| Tokens personalizados (Admin SDK) | Requieren credenciales privilegiadas inexistentes y su uso en cliente está prohibido |
| Otro proyecto Firebase / otra BaaS | Prohibido cambiar el proyecto o el identificador de la base de datos; crear cuentas externas requeriría acción manual del usuario |
| Almacenamiento en el servidor propio (Render/Vercel) | Sin base de datos ni disco persistente configurados; crearlos exige acción manual del usuario y credenciales nuevas |
| GitHub como almacén en runtime | Exigiría incrustar un token con permisos de escritura en la app: clave privilegiada en cliente (prohibido) |

### B.2. La vía implementada

La aplicación nació con los adjuntos incrustados como data URL (formato legado que el visor, la
descarga, la exportación ZIP/AEAT y la reconciliación siguen soportando al 100 %). La solución
reutiliza ese formato como contingencia:

- `src/lib/localVault.ts` (nuevo): presupuesto local (~1 MB crudo por archivo, ajustado a
  localStorage), conversión a data URL, reducción de imágenes grandes en el navegador.
- `src/lib/attachments.ts`: si y solo si la sesión falla con la clase ADMINISTRATIVA
  (`auth/admin-restricted-operation`), `uploadAttachment` guarda el archivo en modo
  `local-inline` para comprobantes de gastos y documentos de inmueble. Los fallos de red siguen
  comportándose como antes (reintentables, sin bifurcar datos). Los contratos (sin campo legado
  equivalente) y las subidas verificadas de importación mantienen su comportamiento estricto.
- `src/components/{Expenses,Dashboard,Properties}.tsx`: escriben `receiptUrl` / `fileData`
  (campos legados) en modo local y `receiptPath` / `storagePath` en modo Storage; avisan al
  usuario de que el archivo queda en su copia local hasta el restablecimiento del acceso.
- Sin sesión (y por tanto sin escrituras) de Firebase en la vía de contingencia: no se genera
  ninguna ruta de Storage ni se intenta ninguna operación contra el proyecto bloqueado.

### B.3. Impacto analizado sobre UIDs, reglas y archivos históricos

- **UIDs**: ninguno nuevo; el modelo de propietarios (`ownerUid`, `users/{usuario}`) no se toca.
- **Reglas**: `firestore.rules` y `storage.rules` sin cambios (siguen sin acceso público).
- **Archivos históricos**: intactos en el proyecto Firebase y en las copias locales; nada se
  borra, migra ni reasigna. La vía local solo afecta a adjuntos NUEVOS subidos durante el bloqueo.
- **Aislamiento entre usuarios**: el contenido local vive en la copia de cada usuario
  (`rentasync_state_{usuario}` en localStorage), con el mismo aislamiento que el resto de su
  cartera local; ningún dato cruza entre usuarios.
- **Vía de salida**: cuando se restablezca el acceso, `externalizeImportedExpenses`/importaciones
  convierten los `receiptUrl` Base64 en referencias `receiptPath` de Storage (mecanismo ya
  existente y probado); `movementService` conserva `receiptUrl` mientras no haya `receiptPath`.

### B.4. Limitaciones honestas de la vía local

- Los comprobantes quedan en el navegador del usuario (localStorage, ~5 MB por origen); no hay
  copia en la nube hasta que se restablezca el acceso. Se comunica al usuario en cada guardado.
- Archivos no comprimibles por encima del presupuesto local (p. ej. PDF > ~1 MB) se rechazan con
  mensaje claro mientras dure el bloqueo.
- Contratos generados e importaciones masivas requieren Firebase: siguen cancelándose con el
  mensaje de restricción administrativa (sin falso éxito).
- La sincronización en la nube de movimientos permanece degradada (como antes de este cambio):
  la causa raíz (§4/A.4) sigue pendiente de la administración del proyecto.

### B.5. Verificación ejecutada

- Suite automatizada: **217 pruebas, 0 fallos** (incluye `localFallback.test.ts`: reproducción
  del bloqueo, modo local, recuperación byte a byte, no-confusión con fallos de red, contratos
  estrictos, presupuestos) + `tsc --noEmit` + `vite build` correctos.
- Extremo a extremo en entorno controlado (sin navegador): bloqueo administrativo real →
  subida del comprobante → registro del movimiento con `receiptUrl` → recuperación íntegra
  (5008/5008 bytes) → sin rutas de Storage generadas. Resultado: 5/5 PASS.
- **No verificado (imposible hasta el desbloqueo)**: la subida contra Firebase Storage real y la
  persistencia en Firestore real. La causa raíz administrativa permanece; esta entrega restaura la
  función de adjuntar comprobantes sin depender de ella, no la sustituye ni la declara resuelta.

## 7. Datos y seguridad: garantías mantenidas

- Proyecto Firebase e identificador de base de datos: sin cambios.
- Movimientos históricos: sin eliminar ni migrar; modelo de propietarios intacto.
- `firestore.rules` y `storage.rules`: sin relajar; sin acceso público a gastos o adjuntos.
- Compatibilidad con comprobantes históricos (data-URL): intacta.
- Sin credenciales inventadas, cuentas compartidas, tokens falsificados ni claves privilegiadas en
  el cliente.
