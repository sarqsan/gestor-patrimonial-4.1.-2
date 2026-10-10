# Integración del PR #10 (almacenamiento remoto propio) — verificación y estado de persistencia

Fecha: 2026-10-10 · Rama de trabajo: `arena/8d1e8838-gestor-patrimonial-4-1-2`

## 1. Estado de la integración

| Elemento | Valor |
| --- | --- |
| PR integrado | #10 `feat(vault): almacenamiento remoto persistente propio para comprobantes, contratos y documentos` |
| SHA del commit del PR | `048a86807f12439b95d0051ac3304fe631646ba4` |
| Commit de fusión en `main` | `d7b10cce392f79f63f7f64ab7ddba612a210a068` (merge de GitHub, sin reset ni force-push) |
| `main` antes / después | `d5bfcc6` → `d7b10cc` |
| Conflictos | Ninguno (la rama era descendiente directa de `main`) |
| Ramas y datos | No se ha borrado ninguna rama, documento, movimiento ni dato histórico |

El backend del vault **no es una demostración aparte**: `server/vault/*` se monta en `/api/vault`
dentro de `server/apiApp.ts`, la aplicación Express que ya sirve la API de la aplicación tanto en
Render (`server.ts` → `npm run start`) como en Vercel (`api/[...route].ts`). El cliente usa rutas
relativas del mismo origen (`/api/vault/*`) y la sesión se establece al iniciar sesión con las
**mismas credenciales** de la pantalla de acceso (`AuthScreen` → `vaultEnsureSession`).

## 2. Correcciones de la revisión de integración (esta rama)

La revisión previa a la fusión detectó dos rutas de lectura incompletas en el modo vault: solo se
manifestaban cuando el almacenamiento remoto es el destino activo (es decir, en el objetivo final,
no en el estado actual). Se corrigen aquí, sin tocar el backend:

1. **Visor de comprobantes (`Expenses.tsx`)**: el botón «Descargar para AEAT / Hacienda» exigía
   `receiptPath` (Storage) y, con el comprobante en el vault, quedaba como enlace roto
   (`href={undefined}`). Ahora hay un único botón que resuelve la referencia real
   (`vault → Storage → legado`) mediante `downloadAttachment`.
2. **Edición de movimientos (`Expenses.tsx`)**: al editar un movimiento cuyo comprobante está en el
   vault, el formulario mostraba el estado «sin comprobante» y no permitía previsualizarlo. Ahora se
   reconoce el comprobante existente, se muestra su origen real y el visor resuelve la referencia
   remota (blob a demanda, con la marca de comprobante guardado si la descarga no está disponible).
3. **Tarjeta de contrato del inmueble (`Properties.tsx`)**: el guardián de descarga comprobaba solo
   `pdfPath`, por lo que un contrato almacenado en el vault (`pdfVaultId`, sin `pdfPath`) se
   declaraba «sin archivo». Ahora se resuelve con `contractPdfSource`.

La resolución de origen (`receiptSource`, `documentSource`, `contractPdfSource`,
`hasAttachmentSource`) es una función pura y probada en `src/lib/attachmentSources.test.ts`
(7 pruebas nuevas). **El backend es idéntico al commit fusionado**: ninguna otra parte cambia.

## 3. Verificaciones ejecutadas (entorno identificado)

Entorno: sandbox de Arena (Node v22.22.3), sobre el **build de producción** (`npm run build` →
`node dist/server.cjs`), con HTTP real y almacenamiento en el sistema de ficheros del sandbox
(`RENTASYNC_VAULT_DIR=/tmp/vaultdata`). **No es el entorno desplegado**: ver §5.

| Comprobación | Resultado |
| --- | --- |
| Suite completa | 249/249 pruebas de cliente + 11/11 de backend |
| TypeScript (`tsc --noEmit`) y `npm run build` | Correctos |
| Registro / login / autorización | Registro 201, duplicado 409, contraseña incorrecta 401, 12/12 rutas de datos 401 sin sesión |
| Token manipulado y firmado con otro secreto | 401 en ambos casos; rutas con traversal (`..%2f`, `%2e%2e`) → 404, sin fuga de ficheros |
| Subida + hash | `sha256` del servidor = `sha256` del original; >10 MB → 413; tipo no admitido → 400 |
| Recuperación por referencia remota | Bytes idénticos (sha256) y cabecera `x-vault-sha256` coincidente |
| Aislamiento entre cuentas | Otra cuenta: descarga 404, borrado 404, índice sin el archivo, movimientos y copias ajenos inaccesibles |
| Cola local → remoto | 1.ª pasada externaliza 2 comprobantes; 2.ª pasada 0 (idempotente, sin duplicar); `reconcileMovements` 3 movimientos únicos y sin pérdidas |
| Expediente fiscal ZIP | 38/38 comprobaciones HTTP; ZIP validado con CRC externo (`zipfile.testzip()` → sin errores) y contenido byte a byte idéntico |
| Persistencia tras reinicio | **Proceso nuevo** (PID distinto) sobre el mismo directorio: login con las mismas credenciales, documento intacto (sha256), movimientos sin duplicar, expediente operativo, aislamiento conservado |
| Antifalso-éxito | Con el remoto caído y Firebase restringido, la subida **no** se declara remota (modo cola local + aviso explícito); si no cabe en la cola local, se lanza error; los contratos sin destino remoto fallan explícitamente |
| Almacenamiento no escribible | Registro/subida → 500; ninguna operación declara éxito |
| Claves y reglas | Sin claves de servicio ni `GEMINI_API_KEY` en el bundle del navegador; `firestore.rules`, `storage.rules` y `firebase-applet-config.json` intactos respecto a `main` |

## 4. Compatibilidad histórica y recuperación

- `receiptUrl` (data URL legado y cola temporal), `receiptPath` (Firebase Storage) y `fileData`
  (documentos legados) se siguen leyendo con la misma prioridad en toda la interfaz
  (`vault → Storage → legado`); nada se reasigna ni se borra.
- La cola local solo se convierte en referencia remota **después** de confirmar la subida
  (`flushQueuedReceiptsToVault`); si la subida falla, el data URL permanece intacto.
- `portfolioPayload.ts`, `recoveryImport.ts`, `importAttachments.ts` y `legacyDataUrl.ts` no se han
  modificado: importación, exportación, copia y recuperación conservan su comportamiento.
- Exportación/importación de la cartera transporta los objetos completos, por lo que las
  referencias del vault (`receiptVaultId`, `vaultId`, `pdfVaultId`) se conservan.

## 5. Bloqueo real de persistencia en producción (no resuelto)

- `main` despliega **producción en Vercel** (integraciones de GitHub: entorno `Production`,
  creado por `vercel[bot]`; el último despliegue de producción corresponde a `d5bfcc6`). Tras la
  fusión, `main` se despliega automáticamente por el mismo cauce.
- En Vercel, el sistema de ficheros de las funciones serverless **no es persistente** y el cuerpo
  de la petición está limitado (~4,5 MB en el plan Hobby). El vault necesita un directorio
  escribible y duradero (`RENTASYNC_VAULT_DIR`) o un adaptador PostgreSQL (`DATABASE_URL`):
  **ninguno de los dos está aprovisionado**.
- `render.yaml` declara el disco `vault-data` (1 GB) montado en `/var/data` y
  `RENTASYNC_VAULT_DIR=/var/data`, pero **declararlo no basta**: requiere sincronizar el blueprint
  en Render y aceptar una instancia de pago (Render no ofrece discos en el plan gratuito), lo que
  exige una autorización de contratación y una consola que no está conectada a esta sesión (no
  existe conector de Render, Vercel ni de base de datos; todos los intentos devuelven `unsupported`).
- Consecuencia: hasta que exista ese almacenamiento duradero, la aplicación funciona en modo
  degradado —los comprobantes quedan en la **cola local** con aviso explícito y sin falso éxito— y
  no puede considerarse resuelta la subida persistente de justificantes en producción.

## 6. Cabos sueltos conocidos (documentados, no regresiones)

- Los endpoints de copias del vault (`POST/GET /api/vault/backups`) están implementados y
  verificados por HTTP, pero todavía no tienen interfaz propia: el panel de copias existente sigue
  siendo el de migración/restauración sobre Firebase.
- Borrar un documento o contrato en la interfaz no elimina el archivo remoto del vault (no hay
  borrado destructivo automático), de forma deliberada y conservadora.
- El primer inicio de sesión contra el vault crea la cuenta con las credenciales de la aplicación;
  si un tercero registrase antes ese nombre de usuario en el vault, el titular quedaría en modo
  degradado (no hay lectura de datos ajenos, pero sí una posible denegación de servicio por
  suplantación de nombre). Requiere definir una política de aprovisionamiento si el vault se abre
  a más usuarios.
