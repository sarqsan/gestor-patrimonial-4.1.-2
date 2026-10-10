# Adjuntos en Firebase Storage y migración de la cartera

## Arquitectura

- `users/{u}/data/portfolio` (Firestore) guarda solo datos estructurados y **referencias** a Storage
  (`receiptPath`, `storagePath`). Ningún archivo nuevo se escribe en Base64.
- Adjuntos: `users/{u}/attachments/{carpeta}/{id}/{nombre}` (carpetas `expenses`, `property-documents`, `contracts`).
- Copias de seguridad de la cartera: `users/{u}/backups/portfolio/{sha256}.json` en Storage (JSON completo,
  direccionado por contenido). El índice pequeño vive en `users/{u}/backups/{sha256}` (Firestore, solo metadatos).
- Registro de la migración: `users/{u}/migrations/portfolio-attachments-v1` (estado, hashes, rutas, resultado).

## Guardia de escritura

Todas las escrituras de la cartera pasan por `checkPortfolioWrite` (`src/lib/portfolioGuard.ts`):

- Mide el JSON exacto que se escribiría (bytes UTF-8).
- Rechaza cualquier Base64 **nuevo** (no presente en la nube o en la copia local conocida).
- Bloquea si el documento supera el margen seguro de 1.000.000 bytes (límite duro de Firestore: 1 MiB).
- Avisa al 80 % del margen. Si los datos estructurados se acercan al límite, la solución prevista es
  mover los registros a subcolecciones (`users/{u}/expenses/{id}`, etc.) manteniendo la misma API de lectura.

Las rutas de importación y restauración externalizan antes los Base64 (`src/lib/importAttachments.ts`).

## Migración (`portfolio-attachments-v1`)

1. Lee el documento original y calcula su hash.
2. Crea la copia de seguridad en Storage y la verifica byte a byte. Solo después escribe el índice.
3. Sube cada adjunto a su ruta estable y lo verifica byte a byte. No sobrescribe objetos con otro contenido.
4. Prepara el documento final en memoria (el original no se toca).
5. Escribe en una transacción que compara el hash: si la cartera cambió, aborta sin escribir.
6. Verifica el resultado (documento, referencias y bytes en Storage). Si falla, restaura el original automáticamente.
7. Nunca borra datos ni objetos.

Es idempotente y reanudable. El panel exige escribir `MIGRAR <usuario>` para ejecutarla.
La restauración desde la copia exige `RESTAURAR <usuario>`.

### Fidelidad de los metadatos históricos

La migración **solo** retira el Base64 y añade la referencia verificada; no reescribe nada más:

- `receiptName` (gastos) y `name` (documentos de inmueble) se conservan **tal cual**, con sus espacios,
  acentos y símbolos. El saneado se aplica únicamente a la ruta de Storage, nunca al registro: son los
  nombres que muestran la interfaz, la descarga y el paquete ZIP para la AEAT.
- Si el registro histórico no declaraba nombre, **no se inventa**: la clave sigue ausente y cada pantalla
  usa su propio nombre de descarga derivado (`comprobante_{id}`, `factura_{fecha}_{inmueble}…`).
- El tipo de contenido procede del registro (`receiptType` / `type` / `contentType`) o de la propia data URL.
  Si ninguna fuente lo declara, se marca como desconocido y el precheck de reglas lo detiene con un motivo
  honesto, en lugar de subirlo como `application/pdf` y etiquetar mal los bytes.
- Las claves `receiptUrl` / `fileData` se **eliminan** del objeto (no se dejan en `undefined`, que Firestore
  rechaza en las escrituras).

### Limitación conocida

Si un adjunto histórico no se puede guardar en Storage (tipo no admitido por las reglas, más de 10 MB o
Base64 ilegible), la migración **se detiene antes de escribir nada** y lo indica con el identificador y el
motivo. No se borra ni se aísla ese contenido: el documento original queda intacto. En ese caso hay que
resolver primero ese fichero (por ejemplo, volver a adjuntarlo desde la pantalla correspondiente, que sí lo
sube a Storage) y repetir la migración.

## Requisitos de despliegue previos a la migración real

1. **Publicar `storage.rules`** en el proyecto `startup-sanctuary-sln7n` (rutas `attachments/**` y `backups/**`).
   Sin esta publicación, las subidas y la copia de seguridad fallarán (y la migración se detendrá sin escribir).
2. Confirmar que la sesión de usuario tiene acceso a Firestore y Storage del proyecto.
3. Revisar `firestore.rules`: actualmente permiten lectura y escritura a cualquiera (no modificado en esta entrega).

## Ejecución operativa

- Entrar con el usuario afectado, abrir **Sincronización** y revisar el diagnóstico en vivo.
- Pulsar **Migrar a Storage**, escribir la frase de confirmación y esperar al resultado.
- Si el resultado es `rolled-back` o `failed`, el original sigue intacto; la copia indicada en el mensaje
  permite restaurar con **Restaurar desde la copia**.
