# Reparación y puerta de publicación de adjuntos

Fecha: 2026-10-12. Producción objetivo: https://gestor-patrimonial-4-1-2.vercel.app/.

## Preservación y alcance

- Rama de trabajo: `arena/98d8e88d-gestor-patrimonial-4-1-2`; base `3a71b97495e98f250681b8280e4592958c5439d8`.
- Los 70 archivos pendientes al comenzar esta orden se conservan íntegros en `estado-inicial.tar.gz`; manifiesto SHA-256 `estado-inicial.json`, verificado 70/70. No se descarta trabajo previo.
- Se conserva el caso R6 original de `server/vault/routingCompatibility.test.ts`, sin modificar su expectativa 204, ocultarlo o desactivarlo.
- No se modifican reglas Firebase, configuración/variables de producción ni credenciales existentes; no hay migración, campos financieros ni servicios nuevos.

## Corrección mínima de los dos bloqueantes

1. **R6:** retirar un archivo propio sin asociaciones confirmadas devuelve 204 mediante tombstone condicional en sus metadatos. El ID no se reutiliza, el objeto desaparece de lectura/listado autorizados y los bytes privados se conservan. Archivos asociados o reservados siguen rechazando la retirada con 409.
2. **Concurrencia:** antes de confirmar el gasto se reservan huellas técnicas `attachmentPins` en el registro del inmueble, **fuera de `data`**, cambiando su ETag; después se protege el archivo y se confirma el gasto. Un borrado prevalidado en otra instancia pierde CAS. Las actualizaciones genéricas conservan esas huellas. Protección monotónica, sin expiración/despinado automático ni borrado físico.
3. Equivalentes FS bajo bloqueos locales existentes. No se presenta FS ni MemoryBlobPort como persistencia remota.
4. `/api/health` expone únicamente el SHA Git válido de la variable de sistema Vercel existente (o null), para comprobar identidad del despliegue; ninguna variable se añade/modifica.

## Puerta local previa a publicación

- `npm test`: **380/380 PASS**, 289 cliente + 91 servidor, 0 fallos, 0 omitidos/cancelados. Incluye R6 y nuevas B28–B31.
- B28 antes: FAIL genuino (`antes-ciclo.json`). Después: PASS; se mantienen sus aserciones.
- Comprobación separada estricta de dos instancias: commit 200 / DELETE padre 409 / GET padre 200 / GET gasto 200 / referencia retenida. `despues-ciclo.json` es **simulación**, no aceptación de proveedor real.
- `npm run lint` / TypeScript: exit 0. `npm run build`: exit 0. Advertencia Vite de tamaño de bundle, no fallo.
- Guardas de red obligatorias en pruebas: 32 cargadas, 0 intentos externos. Lint/build también se ejecutaron con guarda; 0 intentos externos.
- Evidencia local: `pruebas-locales.json`, `typescript-build.json`. Se conservan informes históricos con sus fallos y límites; no se sustituyen por supuestos resultados remotos.

## Validación real posterior, no declarada aprobada aquí

Workflow manual `validacion-adjuntos-produccion.yml`, exclusivamente `main`, recibe SHA integrado y PR. Su script `scripts/validacion-adjuntos-produccion.mjs`:

- Comprueba el SHA desplegado exacto y Vault privado persistente operativo **antes de escribir**. Ante bloqueo de auth/configuración informa y para; no habilita reglas, cambia entorno ni fuerza credenciales.
- Crea exclusivamente cuentas propias e inmueble ficticios identificados; usa el PDF de fixture sin datos reales ni validez fiscal.
- Opera el formulario real en Chromium con sesión genuina emitida por el servidor, espera confirmación, comprueba asociación y recupera bytes/hash por API y visor reales.
- Comprueba ausencia de credencial, token inválido y otra cuenta; rechaza checksum falso conservando el original.
- Para el timeout guarda realmente el segundo gasto, retiene solo su respuesta al navegador y exige que el formulario conserve File/campos y que el retry reutilice operación/archivo sin duplicados.
- Publica JSON sanitizado en el PR (sin contraseñas/Bearers/variables). Identifica recursos nuevos; cierra solo sesiones propias y no elimina registros asociados ni bytes.

**Esta puerta local NO demuestra que el despliegue, subida, descarga o autorización de producción hayan pasado.** El resultado definitivo debe indicar commit/deployment reales y la ejecución remota efectiva, o el error concreto que la impidió. Exportaciones JSON no garantizan restauración de usuarios, permisos, documentos externos o configuración.
