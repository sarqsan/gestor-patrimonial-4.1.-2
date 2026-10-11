#!/usr/bin/env node
/**
 * verificacion-persistencia.mjs — Verificación sintética END-TO-END contra un despliegue real.
 *
 * Uso:  node scripts/verificacion-persistencia.mjs <URL-base>
 *   ej. node scripts/verificacion-persistencia.mjs https://gestor-patrimonial-4-1-2.vercel.app
 *
 * Comprueba, con DATOS SINTÉTICOS y sin secretos:
 *   V1. Enrutado: la forma anidada clásica y la compatible ?op= (qué llega realmente a Express).
 *   V2. Salud del almacén: driver/durable/storageOk tal y como los declara el backend desplegado.
 *   V3. Registro y acceso de dos cuentas sintéticas.
 *   V4. Subida de un documento, descarga y comparación SHA-256 byte a byte.
 *   V5. Movimientos y copias de seguridad: escritura y lectura.
 *   V6. Persistencia tras nuevas ejecuciones del backend (segunda ronda de lecturas).
 *   V7. Idempotencia: reintentar la misma subida no duplica registros.
 *   V8. Aislamiento entre cuentas: la cuenta B no ve ni lee ni borra lo de la A.
 *   V9. Errores explícitos: token inválido, identificador manipulado.
 *
 * Códigos de salida: 0 = todo verificado · 1 = alguna comprobación crítica falló ·
 *                     2 = despliegue no verificable (protección SSO/401, HTML de plataforma, red).
 */
import { createHash, randomBytes } from "node:crypto";

const base = (process.argv[2] || "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("Uso: node scripts/verificacion-persistencia.mjs <URL-base-del-despliegue>");
  process.exit(2);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "OK  " : "FALLO"} ${name}${detail ? ` — ${detail}` : ""}`);
  return Boolean(ok);
}

async function req(method, url, { token, body, raw } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      redirect: "manual",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    return { status: 0, contentType: "", text: `ERROR DE RED: ${err?.message || err}`, bytes: null, json: null };
  }
  const contentType = res.headers.get("content-type") || "";
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(buf);
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* no JSON */
  }
  return {
    status: res.status,
    contentType,
    text: raw ? "" : text.slice(0, 500),
    bytes: raw ? buf : null,
    json,
    location: res.headers.get("location") || "",
  };
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 4, 5, 6, 7]);
const suffix = Date.now().toString(36) + randomBytes(3).toString("hex");
const userA = `verif_a_${suffix}`;
const userB = `verif_b_${suffix}`;
const passA = `Verif-${randomBytes(9).toString("base64url")}`;
const passB = `Verif-${randomBytes(9).toString("base64url")}`;
const fileId = `file_verif_${suffix}`;
const movId = `mov_verif_${suffix}`;
const backupId = `backup_verif_${suffix}`;

console.log(`== Verificación de persistencia contra ${base} ==`);

// --- V1: enrutado -----------------------------------------------------------
const nested = await req("GET", `${base}/api/vault/health`);
const modern = await req("GET", `${base}/api/vault?op=health`);
console.log(`[enrutado] GET /api/vault/health (anidada)  -> ${nested.status} ${nested.contentType}`);
console.log(`[enrutado] GET /api/vault?op=health (compat) -> ${modern.status} ${modern.contentType}`);
if (modern.text) console.log(`[enrutado] cuerpo ?op=health: ${modern.text}`);

const looksHtml = (r) => /text\/html/.test(r.contentType) || /^\s*<!doctype/i.test(r.text || "");
const isSso = (r) => r.status === 401 || (r.status >= 300 && r.status < 400 && /vercel\.com|login|sso/i.test(r.location || r.text || ""));
const modernApi = modern.status === 200 && modern.json && modern.json.vault === "ok" && "driver" in modern.json;
const legacyApi = nested.status === 200 && nested.json && nested.json.vault === "ok";

if (isSso(modern) || isSso(nested) || (looksHtml(modern) && looksHtml(nested) && modern.status !== 200)) {
  check("V1. despliegue accesible sin SSO", false, `protegido o inaccesible (anidada=${nested.status}, op=${modern.status})`);
  console.log("EVIDENCIA-JSON " + JSON.stringify({ base, bloqueado: "SSO/protección de despliegue", nested: nested.status, modern: modern.status }));
  process.exit(2);
}

check("V1a. la forma compatible ?op= alcanza el router del vault", modernApi || legacyApi, `status=${modern.status}`);
check(
  "V1b. la forma anidada clásica alcanza el router del vault",
  legacyApi,
  legacyApi ? "ok" : `status=${nested.status} ${nested.contentType.slice(0, 40)} (si es HTML/404 de plataforma: confirmado el fallo de enrutado anidado)`
);

// Modo de direccionamiento del API desplegado.
const mode = modernApi ? "modern" : legacyApi ? "legacy" : "none";
const url = (op, nestedPath) => (mode === "modern" ? `${base}/api/vault?op=${op}` : `${base}${nestedPath}`);
const urlWithId = (op, nestedPath, id) => (mode === "modern" ? `${base}/api/vault?op=${op}&id=${encodeURIComponent(id)}` : `${base}${nestedPath}`);

if (mode === "none") {
  check("V2. salud del almacén consultable", false, `ni ?op= ni anidada responden JSON del vault (modern=${modern.status}, nested=${nested.status})`);
  console.log("EVIDENCIA-JSON " + JSON.stringify({ base, mode, modern: modern.status, nested: nested.status }));
  process.exit(2);
}

// --- V2: salud del almacén --------------------------------------------------
const health = mode === "modern" ? modern : nested;
check("V2a. salud del almacén responde JSON del vault", true, JSON.stringify(health.json).slice(0, 200));
const hasDriverInfo = health.json && typeof health.json.driver === "string";
check("V2b. el backend declara driver/durable/storageOk", hasDriverInfo, hasDriverInfo ? `driver=${health.json.driver} durable=${health.json.durable} storageOk=${health.json.storageOk}` : "API legado sin campos de driver (código anterior a la persistencia Blob)");
if (hasDriverInfo) {
  const d = health.json.driver;
  const healthyBlob = d === "vercel-blob" && health.json.storageOk === true && health.json.durable === true;
  const isDevFs = d === "fs";
  check(
    "V2c. almacén operativo (vercel-blob con storageOk y durable; fs solo en desarrollo)",
    healthyBlob || isDevFs,
    healthyBlob
      ? `driver=${d} durable=${health.json.durable} storageOk=${health.json.storageOk}`
      : isDevFs
        ? "driver=fs: destino de DESARROLLO local (no aplica a un despliegue de Vercel)"
        : `driver=${d} durable=${health.json.durable} storageOk=${health.json.storageOk}${health.json.detail ? ` detail=${health.json.detail}` : ""} (en un despliegue esto significa almacén NO conectado)`
  );
}

// --- V3: sesiones -----------------------------------------------------------
async function registerAndLogin(user, pass) {
  const reg = await req("POST", url("auth.register", "/api/vault/auth/register"), { body: { username: user, password: pass } });
  const login = await req("POST", url("auth.login", "/api/vault/auth/login"), { body: { username: user, password: pass } });
  return { reg, login, token: login.json?.token || "" };
}
const accA = await registerAndLogin(userA, passA);
const accB = await registerAndLogin(userB, passB);
check("V3a. alta y acceso de la cuenta sintética A", accA.reg.status === 201 && accA.login.status === 200 && !!accA.token, `register=${accA.reg.status} login=${accA.login.status}`);
check("V3b. alta y acceso de la cuenta sintética B", accB.reg.status === 201 && accB.login.status === 200 && !!accB.token, `register=${accB.reg.status} login=${accB.login.status}`);

if (!accA.token || !accB.token) {
  console.log("EVIDENCIA-JSON " + JSON.stringify({ base, mode, results }));
  process.exit(1);
}

// --- V4: documento con SHA-256 ---------------------------------------------
const expectedSha = sha256(pngBytes);
const up = await req("POST", url("files.upload", "/api/vault/files"), {
  token: accA.token,
  body: {
    id: fileId,
    name: "verificacion.png",
    contentType: "image/png",
    bytesBase64: Buffer.from(pngBytes).toString("base64"),
    movementId: movId,
  },
});
check("V4a. subida del documento sintético", up.status === 201 && up.json?.file?.id === fileId, `status=${up.status}`);
check("V4b. el servidor devuelve el SHA-256 verificado", up.json?.file?.sha256 === expectedSha, `sha=${up.json?.file?.sha256}`);

const dl = await req("GET", urlWithId("files.get", `/api/vault/files/${fileId}`, fileId), { token: accA.token, raw: true });
const dlSha = dl.bytes ? sha256(dl.bytes) : "";
check("V4c. descarga byte a byte idéntica (SHA-256 coincide)", dl.status === 200 && dlSha === expectedSha, `status=${dl.status} sha=${dlSha}`);

// --- V5: movimientos y copias ------------------------------------------------
const putMov = await req("PUT", url("movimientos", "/api/vault/movimientos"), {
  token: accA.token,
  body: { movements: [{ id: movId, date: "2026-10-11", amount: 123.45, concept: "verificación sintética" }] },
});
check("V5a. escritura de movimientos", putMov.status === 200 && putMov.json?.saved === 1, `status=${putMov.status} saved=${putMov.json?.saved}`);
const getMov = await req("GET", url("movimientos", "/api/vault/movimientos"), { token: accA.token });
check("V5b. lectura de movimientos", getMov.status === 200 && (getMov.json?.movements || []).some((m) => m.id === movId), `status=${getMov.status}`);

const putBk = await req("POST", url("backups.create", "/api/vault/backups"), {
  token: accA.token,
  body: { id: backupId, portfolio: { marca: "verificacion", inmuebles: [{ id: "prop_verif", direccion: "calle sintética 1" }] } },
});
check("V5c. copia de seguridad creada", putBk.status === 201, `status=${putBk.status}`);
const getBk = await req("GET", urlWithId("backups.get", `/api/vault/backups/${backupId}`, backupId), { token: accA.token });
check("V5d. copia de seguridad recuperada íntegra", getBk.status === 200 && getBk.json?.portfolio?.marca === "verificacion", `status=${getBk.status}`);

// --- V6: nuevas ejecuciones del backend --------------------------------------
console.log("[persistencia] segunda ronda tras pausa (nueva ejecución serverless)…");
await new Promise((r) => setTimeout(r, 2500));
const dl2 = await req("GET", urlWithId("files.get", `/api/vault/files/${fileId}`, fileId), { token: accA.token, raw: true });
const list2 = await req("GET", url("files.list", "/api/vault/files"), { token: accA.token });
const movs2 = await req("GET", url("movimientos", "/api/vault/movimientos"), { token: accA.token });
check("V6a. el documento se recupera tras nuevas ejecuciones del backend", dl2.status === 200 && sha256(dl2.bytes || new Uint8Array()) === expectedSha, `status=${dl2.status}`);
check("V6b. el listado sigue completo tras nuevas ejecuciones", (list2.json?.files || []).some((f) => f.id === fileId), `total=${(list2.json?.files || []).length}`);
check("V6c. los movimientos siguen intactos tras nuevas ejecuciones", (movs2.json?.movements || []).some((m) => m.id === movId), `total=${(movs2.json?.movements || []).length}`);

// --- V7: idempotencia --------------------------------------------------------
const upRetry = await req("POST", url("files.upload", "/api/vault/files"), {
  token: accA.token,
  body: { id: fileId, name: "verificacion.png", contentType: "image/png", bytesBase64: Buffer.from(pngBytes).toString("base64"), movementId: movId },
});
const listAfter = await req("GET", url("files.list", "/api/vault/files"), { token: accA.token });
const copies = (listAfter.json?.files || []).filter((f) => f.id === fileId).length;
check("V7. reintentar la misma subida es idempotente (sin duplicados)", (upRetry.status === 200 || upRetry.status === 201) && copies === 1, `retry=${upRetry.status} copias=${copies}`);
const putMov2 = await req("PUT", url("movimientos", "/api/vault/movimientos"), {
  token: accA.token,
  body: { movements: [{ id: movId, date: "2026-10-11", amount: 123.45, concept: "verificación sintética" }] },
});
const movs3 = await req("GET", url("movimientos", "/api/vault/movimientos"), { token: accA.token });
const movCopies = (movs3.json?.movements || []).filter((m) => m.id === movId).length;
check("V7b. re-sincronizar movimientos no duplica por id", putMov2.status === 200 && movCopies === 1, `copias=${movCopies}`);

// --- V8: aislamiento entre cuentas --------------------------------------------
const steal = await req("GET", urlWithId("files.get", `/api/vault/files/${fileId}`, fileId), { token: accB.token, raw: true });
check("V8a. otra cuenta NO puede descargar el documento", steal.status === 404, `status=${steal.status}`);
const stealBk = await req("GET", urlWithId("backups.get", `/api/vault/backups/${backupId}`, backupId), { token: accB.token });
check("V8b. otra cuenta NO puede leer la copia ajena", stealBk.status === 404, `status=${stealBk.status}`);
const listB = await req("GET", url("files.list", "/api/vault/files"), { token: accB.token });
check("V8c. el listado de otra cuenta está vacío", (listB.json?.files || []).length === 0, `total=${(listB.json?.files || []).length}`);
const delB = await req("DELETE", urlWithId("files.delete", `/api/vault/files/${fileId}`, fileId), { token: accB.token });
const stillThere = await req("GET", urlWithId("files.get", `/api/vault/files/${fileId}`, fileId), { token: accA.token, raw: true });
check("V8d. otra cuenta NO puede borrar lo ajeno (el dueño lo sigue teniendo)", delB.status === 404 && stillThere.status === 200, `delete=${delB.status} relectura=${stillThere.status}`);

// --- V9: errores explícitos ---------------------------------------------------
const badToken = await req("GET", url("files.list", "/api/vault/files"), { token: "token.inventado" });
check("V9a. token inválido rechazado con 401", badToken.status === 401, `status=${badToken.status}`);
if (mode === "modern") {
  const traversal = await req("GET", `${base}/api/vault?op=files.get&id=${encodeURIComponent("../../vault/secret.key")}`, { token: accA.token });
  check("V9b. identificador manipulado rechazado con error explícito", traversal.status === 400, `status=${traversal.status}`);
} else {
  const traversal = await req("GET", `${base}/api/vault/files/..%2F..%2Fvault%2Fsecret.key`, { token: accA.token, raw: true });
  check("V9b. identificador manipulado no sirve contenido sensible", traversal.status !== 200 || traversal.bytes?.length === 0, `status=${traversal.status}`);
}

// --- Resumen -------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n== Resumen: ${results.length - failed.length}/${results.length} comprobaciones correctas ==`);
console.log("EVIDENCIA-JSON " + JSON.stringify({ base, mode, sha256_documento: expectedSha, results }, null, 1));
process.exit(failed.length ? 1 : 0);
