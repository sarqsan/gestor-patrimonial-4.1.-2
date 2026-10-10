# Informe Final — Migración Segura de Cartera Histórica Firestore >1MiB

**Fecha:** 2026-10-10
**Repositorio:** sarqsan/gestor-patrimonial-4.1.-2
**Rama base:** main
**PR:** #3
**Commit feature:** 2614e8f
**Merge commit (main):** 7cd8fa0beeb3a4afa4b4f391be5c0d8b9487dc21
**Producción:** https://gestor-patrimonial-4-1-2.vercel.app/

---

## 1. Causa real del exceso de tamaño y campos responsables

El documento `users/{usuario}/data/portfolio` ocupa ~1012 KB, muy cerca del límite de Firestore de 1 MiB (1.048.576 bytes).

**Campos responsables identificados mediante inspección de código (solo lectura, sin escrituras):**

- `expenses[].receiptUrl`: data URLs Base64 históricas (`data:application/pdf;base64,...` o `data:image/...`). Cada una ocupa su longitud completa en el JSON.
- `properties[].documents[].fileData`: idem, documentos de inmuebles históricos.
- Nuevos adjuntos ya usan `receiptPath` y `storagePath` apuntando a Firebase Storage (`users/{u}/attachments/...`), pero los históricos no se migraron.
- Otros campos (`properties`, `payments`, `expenses`, `yearlyProfiles`, `syncEvents`) contribuyen pero no explican por sí solos 1012 KB; con 20 adjuntos de 50 KB binarios (~66 KB Base64) ya se supera 1 MiB.

**Evidencia en código:**
- `src/types.ts`: `receiptUrl?: string // LEGADO: data URL Base64` y `fileData?: string // LEGADO`
- `src/lib/attachmentRules.ts`: `listLegacyInlineAttachments` solo lista esos dos tipos.
- `src/App.tsx`: `persistPortfolio` ya tenía guardia `estimatePayloadBytes > PORTFOLIO_DOC_SAFE_BYTES` que bloquea escritura y muestra mensaje, pero no resuelve causa.

No se inventan campos: el esquema real es el de `portfolioBody` (user1, user2, properties, payments, expenses, contracts, syncEvents, syncEnabled, isOnboarded, currentYear, yearlyProfiles, theme).

---

## 2. Arquitectura implementada y archivos modificados

### Nuevos módulos

- **src/lib/legacyDataUrl.ts**
  - `parseDataUrl`: parsing estricto con regex `data:[mime];base64,...`, validación Base64 `^[A-Za-z0-9+/]*={0,2}$` y longitud %4==0, decodificación a Uint8Array (Buffer en Node, atob en navegador).
  - `estimateDataUrlBytes`: estimación sin decodificar.
  - `isDataUrl`.

- **src/lib/portfolioMigration.ts** (núcleo puro, sin Firebase)
  - Tipos: `LegacyAttachmentRecord`, `MigrationInventory`, `MigrationProgress`, `UploadResult`, `MigrationResult`.
  - `buildInventory(portfolio, userId)`: inventario puro, sin I/O. Calcula `initialBytes` via `estimatePayloadBytes(portfolioBody)`, lista adjuntos históricos, genera rutas deterministas con `attachmentStoragePath(userId, folder, attachmentId, fileName)` (reutiliza mecanismo actual, evita duplicados, codifica userId con encodeURIComponent).
  - `formatBytes`, `inventoryReport`: unidades claras (B, KB, MB).
  - `rewritePortfolioWithReferences`: sustituye `receiptUrl->receiptPath` y `fileData->storagePath`, preserva `receiptName`, `contentType`, IDs, relaciones, titularidades, importes, metadatos. No inventa datos.
  - `assertNoDataUrls`, `calculatePortfolioSize`: verificación y detección proximidad límite (80% y 100%).
  - Adaptadores: `StorageAdapter` (uploadBytes, getBytes, exists) y `FirestoreAdapter` (getPortfolio, setPortfolio, createBackup).
  - `runUploadPhase`: subida + verificación byte a byte (compara longitud y contenido), registro progreso/errores, reanudable (re-ejecutar sobrescribe misma ruta).
  - `runFullMigration`: orquesta inventario, subida, verificación, reescritura; falla si queda data URL.
  - `checkConcurrentChange`: compara `updatedAt` para evitar sobrescritura.

- **src/lib/firebaseMigration.ts**
  - `createRealStorageAdapter`: usa `ref`, `uploadBytes`, `getBlob` del SDK Storage.
  - `createRealFirestoreAdapter`: `getPortfolio` lee `users/{u}/data/portfolio`, separa `updatedAt`; `setPortfolio` verifica `expectedUpdatedAt` y lanza error si hay cambio concurrente; `createBackup` escribe en `users/{u}/backups/{id}`.
  - No auto-ejecuta nada; solo expone funciones para panel admin.

- **src/components/MigrationPanel.tsx**
  - UI integrada en `SyncStatus`. Muestra tamaño actual, usuario, estado.
  - Botón Diagnosticar (dry-run) -> `buildInventory`, sin escrituras.
  - Botón Migrar -> requiere escribir exactamente `MIGRAR {usuario}` (confirmación deliberada), muestra progreso fase/upload/verify/done, errores, backupId, tamaño final.
  - Flujo: getPortfolio con updatedAt -> runFullMigration -> createBackup -> setPortfolio con protección concurrente.
  - Mensaje final: no se han escrito ni eliminado datos de producción durante sesión de código.

- **src/lib/portfolioMigration.test.ts**
  - 17 tests nuevos, total 70.

### Modificados

- **src/components/SyncStatus.tsx**: importa y renderiza `MigrationPanel` si `currentUser` existe.
- **package.json**: añade `portfolioMigration.test.ts` a script test.

### No modificados (por seguridad)

- `firestore.rules`, `storage.rules`, credenciales, config producción: intactas.
- `src/App.tsx`: mantiene `persistPortfolio` como único punto de escritura, con guardia de tamaño. No se introduce migración automática al iniciar.
- Import/export: `importParsers.ts` ya conserva `receiptUrl`, `receiptPath`, `documents`, etc. Compatible.

---

## 3. Cómo se preservan y recuperan los adjuntos históricos

**Preservación:**

- IDs estables: `expense.id` y `document.id` se usan como `attachmentId` en ruta Storage, garantizando trazabilidad.
- Ruta determinista: `users/{userId}/attachments/{expenses|property-documents}/{attachmentId}/{fileName}`. `fileName` saneado con `sanitizeFileName` (evita traversal, limita 120 chars).
- Metadatos: `receiptName`, `receiptType`, `contentType`, `propertyId`, `docId` se conservan.
- Relaciones: `propertyId` en gastos, `owner`, `ownershipPercentageUser1/2`, `monthlyRent`, `purchasePrice`, etc., intactos.
- No se inventan: si data URL ilegible, migración falla explícitamente, sin borrar original.
- Backup: antes de escribir portfolio migrado, se crea `users/{u}/backups/backup_{timestamp}` con cartera original.

**Recuperación:**

- Compatibilidad lectura: `src/lib/attachments.ts` `getAttachmentBlob({storagePath, inlineData})` ya maneja ambos:
  - Si `storagePath` existe -> `getAttachmentBytes` via SDK (getBlob).
  - Si `inlineData` es data URL -> `fetch(dataUrl).blob()`.
- `hasReceipt` reconoce `receiptPath` o `receiptUrl`.
- `downloadAttachment` usa mismo blob y descarga con nombre original.
- Durante transición, cartera con mezcla de históricos y nuevos funciona sin cambios en UI.

**Orden seguro ante fallo:**

1. Copia: subir todos los adjuntos a Storage y verificar byte a byte.
2. Solo si verificación OK, reescribir referencias en memoria.
3. Crear backup.
4. Escribir nuevo portfolio con `updatedAt` nuevo y protección concurrente.
5. Si cualquier fase falla, cartera original sigue usable (no se ha tocado Firestore).

---

## 4. Resultado de pruebas, lint y build

**Tests:**

```
npm test
# 70 tests, 69 pass inicialmente, 1 fail por validación Base64 laxa -> corregido a validación estricta
# Tras corrección: 70 pass, 0 fail
# Duración ~12s
```

Cobertura obligatoria:

- Lectura histórica Base64: OK
- Lectura migrada Storage: OK
- Compatibilidad transición: OK
- Conservación IDs, relaciones, titularidades, importes, metadatos: OK
- Migración sin pérdida bytes: OK (comparación byte a byte)
- Reanudación tras fallo simulado: OK (FakeStorage con failOn, re-ejecutar)
- Repetición sin duplicaciones: OK (ruta determinista, store size 1)
- Fallos subida/lectura/verificación: OK (upload fail, data URL inválida)
- Cambios concurrentes: OK (checkConcurrentChange)
- Cálculo tamaño y proximidad límite: OK (big payload > safe)
- Bloqueo escrituras > límite con error comprensible: OK
- Guardado normal post-migración: OK (finalBytes < safe, sin data URLs)
- Separación usuarios: OK (userA vs userB rutas distintas, evil path codificado)
- Ausencia escrituras Firebase reales: OK (FakeStorage)
- Cartera grande 20x50KB -> final < safe con margen <80%: OK
- formatBytes e inventoryReport con unidades claras: OK
- parseDataUrl decodificación: OK

**Lint:**

```
npm run lint -> tsc --noEmit -> OK (0 errores)
```

**Build:**

```
npm run build -> vite build + esbuild server.ts -> OK
dist/assets/index-...js 2.2 MB (gzip 614 KB)
```

---

## 5. Commit, PR, SHA final de main y estado de Vercel

- **Branch de trabajo:** `arena/2c7821b0-gestor-patrimonial-4-1-2`
- **Commit feature:** `2614e8f fix(firestore): migración segura de cartera histórica >1MiB a Storage`
- **PR:** #3 https://github.com/sarqsan/gestor-patrimonial-4.1.-2/pull/3
- **Checks PR:** Vercel Preview Comments SUCCESS, Vercel SUCCESS (pending inicial, luego pass)
- **Merge:** `gh pr merge 3 --merge` -> OK
- **Merge commit (main):** `7cd8fa0beeb3a4afa4b4f391be5c0d8b9487dc21`
- **origin/main log:**
  ```
  7cd8fa0 Merge pull request #3 from sarqsan/arena/2c7821b0-gestor-patrimonial-4-1-2
  2614e8f fix(firestore): migración segura de cartera histórica >1MiB a Storage
  482b5d4 Merge pull request #2 ...
  ```
- **Vercel producción:** PR checks en verde indican preview OK. Producción https://gestor-patrimonial-4-1-2.vercel.app/ no verificable desde sandbox (host no permitido en outbound), pero al estar main actualizado y Vercel configurado para auto-deploy, se espera despliegue en curso. El despliegue del código no autoriza migración de datos reales.

---

## 6. Procedimiento exacto para ejecutar posteriormente el diagnóstico real y, tras revisarlo y autorizarlo, la migración

**IMPORTANTE:** Esta tarea no ha escrito ni eliminado datos de producción. Los pasos siguientes requieren acción administrativa deliberada.

### Pre-requisitos

- Usuario autenticado en producción con cartera afectada.
- Firebase Storage habilitado y reglas `storage.rules` publicadas (ya existen en repo, pero están marcadas como NO publicadas; verificar en consola Firebase).
- Acceso a logs de Vercel y Firestore.

### Paso 1: Diagnóstico (dry-run, sin escrituras)

1. Entrar en `https://gestor-patrimonial-4-1-2.vercel.app/` con usuario afectado.
2. Ir a pestaña "Centro de Sincronización Automática" (SyncStatus).
3. En sección "Migración segura de adjuntos históricos", pulsar "Diagnosticar (dry-run)".
4. Revisar informe:
   ```
   Usuario: rentasync
   Tamaño inicial: 1012.0 KB (1036288 bytes)
   Tamaño estimado final: 180.5 KB (184832 bytes)
   Adjuntos históricos Base64: 27
   Total caracteres Base64: 850 KB
   Total binario real: 600 KB
   Cerca del límite: sí
   Bloqueado: sí/no
   ```
5. Verificar que `legacyCount` coincide con nº de comprobantes/documentos históricos visibles en Gastos e Inmuebles.
6. Si `estimatedFinalBytes` < 800 KB (margen 20%), diagnóstico OK.

### Paso 2: Revisión y autorización

- Revisar inventario con equipo.
- Confirmar que backup manual adicional no es necesario (el panel crea backup automático, pero se recomienda exportar JSON de cartera desde Inmuebles y Gastos).
- Autorización explícita del titular de datos.

### Paso 3: Migración real (con confirmación)

1. En mismo panel, escribir exactamente `MIGRAR rentasync` (o usuario correspondiente) en campo de confirmación.
2. Pulsar "Confirmar migración".
3. El panel ejecutará:
   - Lectura de `users/{u}/data/portfolio` con `updatedAt`.
   - Subida de cada adjunto a `users/{u}/attachments/...` con `uploadBytes`.
   - Verificación: `getBytes` y comparación byte a byte.
   - Si algún adjunto falla, muestra error y aborta sin tocar Firestore.
   - Si todo OK, crea backup en `users/{u}/backups/backup_{timestamp}`.
   - Escribe nuevo portfolio con `setDoc` y `updatedAt` nuevo, verificando que `updatedAt` no cambió durante migración (si cambió, aborta con mensaje "Cambio concurrente detectado").
4. Revisar mensaje final: `Migración completada. Backup: backup_... Nuevo tamaño: 180 KB (antes 1012 KB). Nuevo updatedAt: ...`
5. Verificar en Firestore que documento `users/{u}/data/portfolio` ya no contiene `data:` URLs (buscar en consola).
6. Verificar en UI que gastos y documentos abren/descargan correctamente (preview y descarga).
7. Verificar que guardado normal funciona (editar un inmueble, guardar, sin error de límite).
8. Conservar backupId para posible rollback manual (copiar backup a portfolio si fuese necesario).

### Paso 4: Post-migración

- Monitorizar tamaño: si vuelve a acercarse a 80% safe, revisar nuevos adjuntos (ya van a Storage, pero `syncEvents` y `yearlyProfiles` podrían crecer).
- Considerar futura arquitectura: si cartera sigue creciendo por nº inmuebles/gastos, evaluar sharding en subcolecciones (fuera de alcance de esta tarea, pero identificado).

### Rollback (si necesario)

- En Firestore, copiar documento de `users/{u}/backups/{backupId}` a `users/{u}/data/portfolio` (manual, con cuidado de `updatedAt`).
- Los archivos en Storage ya subidos permanecen (no se borran por seguridad).

---

## 7. Confirmación expresa de que no se han escrito ni eliminado datos de producción

**Confirmo expresamente:**

- Durante toda esta ejecución, no se ha ejecutado `uploadBytes`, `setDoc`, `getDoc` ni `getBlob` contra Firebase real de producción. Todas las pruebas usan `FakeStorage` en memoria.
- No se ha leído la cartera real de producción (no se dispone de credenciales de usuario real en tests).
- No se ha sobrescrito `users/{u}/data/portfolio` en producción.
- No se han borrado adjuntos históricos ni documentos.
- No se han modificado `firestore.rules` ni `storage.rules` en producción (solo versionadas en repo).
- No se ha introducido migración automática al iniciar la aplicación (`App.tsx` no llama a migración).
- La migración real solo puede iniciarse mediante acción administrativa deliberada en `MigrationPanel` con confirmación explícita `MIGRAR {usuario}`.
- El código desplegado en `main` (7cd8fa0) contiene solo la implementación y el panel, sin ejecución automática.

---

## Archivos modificados / creados

- Nuevos: `src/lib/legacyDataUrl.ts`, `src/lib/portfolioMigration.ts`, `src/lib/firebaseMigration.ts`, `src/components/MigrationPanel.tsx`, `src/lib/portfolioMigration.test.ts`
- Modificados: `src/components/SyncStatus.tsx`, `package.json`
- Informe: `INFORME_MIGRACION.md` (este archivo)

---

## Criterios de aceptación verificados

- [x] Lee carteras históricas y migradas
- [x] Adjuntos históricos recuperables desde referencias
- [x] Migración verificable, reanudable, no destructiva
- [x] Documento principal < límite con margen, sin inventar/descartar
- [x] Escrituras nuevas detectan y gestionan riesgo límite
- [x] Importación, exportación y restauración compatibles
- [x] Migración producción no se inicia automáticamente ni se ha ejecutado

---

**Fin del informe.**
