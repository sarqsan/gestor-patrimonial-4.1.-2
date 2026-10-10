# Propuesta técnica — Almacenamiento remoto persistente del Gestor Patrimonial ("Vault")

Fecha: 2026-10-10 · Directiva de reconstrucción · PR #9 cerrado sin fusionar
Estado: implementación en la rama `arena/17d0d46b-gestor-patrimonial-4-1-2`

## 1. Por qué esta arquitectura

Hechos verificados (no asumidos):

1. El proyecto Firebase `startup-sanctuary-sln7n` rechaza `signInAnonymously` con
   `ADMIN_ONLY_OPERATION`. Sin acceso administrativo (sin conectores Firebase/GCP en Arena,
   sin credenciales, sin red a Google), **Firestore y Storage de ese proyecto son
   inutilizables** por tiempo indefinido.
2. Inventario de integraciones (todas comprobadas con `list_connector_tools`): firebase,
   google-cloud, gcp, google, render, vercel, supabase, neon, database, storage →
   `unsupported`. Única integración operativa: **GitHub** (gh/git autenticados).
3. El repositorio YA incluye un servidor propio desplegado con la app:
   `server/apiApp.ts` (Express), servido por `server.ts` en Render y por
   `api/[...route].ts` en Vercel. Ese servidor es infraestructura existente, administrable
   desde el repositorio (código → push → despliegue), sin consolas externas.

Conclusión: la única vía de almacenamiento remoto persistente administrable desde Arena es
**un backend propio dentro del despliegue existente**, con autenticación de usuario real y
autorización por cuenta.

## 2. Arquitectura

```
Navegador ──(mismo origen /api/vault/*)──► Express (server/apiApp.ts)
                                            ├── auth: registro/login (scrypt) + tokens HMAC
                                            ├── movimientos: users/{u}/movements.json
                                            ├── archivos:    users/{u}/files/{id} + índice
                                            └── backups:     users/{u}/backups/{ts}.json
                                   RENTASYNC_VAULT_DIR (volumen persistente)
```

- **Autenticación**: las MISMAS cuentas de la aplicación (usuario/contraseña de
  `AuthScreen`). Las credenciales se validan y guardan en el servidor con hash scrypt
  (nunca en claro). Primer inicio de sesión contra el vault = alta automática (la app ya
  exigía usuario+contraseña locales; el servidor se convierte en la autoridad). Sesiones:
  token firmado HMAC-SHA256 con secreto generado por el servidor y persistido en el volumen.
  Sin Firebase anónimo, sin claves de servicio en el navegador, sin cuentas compartidas.
- **Autorización**: cada petición requiere el token; todos los recursos viven bajo el
  directorio del usuario del token. No existe ruta que exponga datos de otra cuenta. Ids de
  archivo validados (sin traversal). Límites idénticos a `storage.rules`: 10 MB y tipos
  PDF/imagen/DOC-contratos.
- **Almacenamiento**: ficheros binarios + índices JSON con escrituras atómicas
  (tmp+rename). Sin dependencias nuevas. Adaptador futuro a Postgres por `DATABASE_URL`
  si se aprovisiona.
- **Compatibilidad histórica** (nada se borra ni se reasigna):
  - `receiptUrl`/`fileData` legados: se siguen leyendo igual.
  - `receiptPath` (Firebase Storage): intacto; se leerá si Firebase vuelve a dar sesión.
  - Nuevo campo `receiptVaultId` (+`vaultId` en documentos, `pdfVaultId` en contratos):
    referencia al vault. Orden de lectura de un adjunto: vault → Storage → inline legado.
- **Flujo de datos del cliente**: localStorage pasa a ser **caché/cola de sincronización**
  (identificada como tal): la subida intenta (1) vault, (2) Firebase Storage si hay sesión,
  (3) cola local. Los comprobantes que queden en la cola local se **externalizan al vault
  automáticamente en el login** (`flushQueuedReceiptsToVault`: idempotente, solo toca
  registros sin referencia remota, sustituye `receiptUrl` por `receiptVaultId` tras
  confirmar la subida). Los movimientos se reflejan en el vault en cada guardado
  (best-effort, con debounce) y se reconcilian al iniciar sesión (`reconcileMovements`).
- **Recuperación y exportación**: `GET /api/vault/expediente` (manifiesto JSON: movimientos
  + metadatos de archivos por rango de fechas), `GET /api/vault/expediente.zip` (arte­facto
  único para el expediente fiscal: `movimientos.json`, `archivos.json` y los bytes de cada
  documento vinculado al periodo, ZIP estándar verificado por CRC), copias de la cartera
  (`POST/GET /api/vault/backups`) y descarga de archivos por referencia con cabecera
  `x-vault-sha256` para verificación byte a byte.
- **Migración de archivos Firebase→vault** (cuando el proyecto Firebase vuelva a ser
  accesible): operación aparte, verificable e idempotente, con hash y tamaño por archivo y
  sin borrar el original hasta verificar la copia. No forma parte de esta entrega porque
  hoy no hay sesión Firebase que permita leer esos objetos.

## 3. Qué se puede administrar desde Arena y qué no

| Capacidad | Estado |
| --- | --- |
| Código, pruebas y PRs | ✅ desde Arena (GitHub) |
| Backend vault completo (auth, archivos, movimientos, backups) | ✅ construido y probado en esta entrega |
| Demostración desplegada en entorno controlado (servidor real + HTTP real + disco real) | ✅ live-preview de Arena (ver informe) |
| Despliegue de producción | vía el pipeline existente (push → Render/Vercel); sin consolas |
| **Volumen persistente de producción** | ⚠️ ÚNICO aprovisionamiento pendiente. Ya está DECLARADO en código: `render.yaml` define el disco `vault-data` (1 GB) montado en `/var/data` y `RENTASYNC_VAULT_DIR=/var/data`. Acción restante: sincronizar el blueprint en Render y aceptar el cambio de plan (Render no admite discos en instancias gratuitas). Alternativa: cualquier Postgres gestionado vía `DATABASE_URL` (adaptador previsto). No hay conector de Render en Arena → esa aprobación no es ejecutable desde aquí. Mientras tanto, el vault falla por operación y la app degrada a su cola local sin falsos éxitos |
| Limitación Vercel | el plan Hobby limita el cuerpo HTTP a ~4,5 MB: el despliegue recomendado para archivos es Render |

## 4. Seguridad (requisitos de la directiva)

- Sin claves de servicio en el navegador: el cliente solo posee el token de sesión del
  usuario (same protection class que el estado local ya existente).
- Sin reglas públicas ni endpoints anónimos de escritura: todo `/api/vault/*` exige token,
  salvo registro/login/health.
- Validación de tamaño/tipo espejo de `storage.rules`; ids saneados; escrituras atómicas.
- Contraseñas: scrypt + comparación en tiempo constante. Nunca se devuelven ni se loguean.

## 5. Criterios de aceptación y su evidencia

Ver informe de la entrega: login real contra el servidor, subida y recuperación reales por
HTTP, persistencia tras reinicio del servidor, aislamiento entre cuentas (403/404 entre
usuarios), exportación de expediente, suite automatizada + tsc + build. La persistencia
entre dispositivos quedará demostrada en producción cuando el volumen persistente esté
montado (la arquitectura ya lo soporta: mismo servidor, mismo volumen, cualquier cliente).
