/**
 * vault.test.ts — Pruebas del backend persistente (vault).
 *
 * Cubren la directiva de reconstrucción §4 con HTTP real contra la app Express real:
 *  1. Autenticar a un usuario real (registro + login con scrypt; contraseña falsa → 401).
 *  2. Subir un archivo a almacenamiento remoto persistente (POST /api/vault/files).
 *  3. Guardar su referencia junto al movimiento (movementId en el índice del archivo).
 *  4. Recuperar el archivo por su referencia (GET /api/vault/files/:id, bytes íntegros).
 *  5. Rechazar el acceso desde una cuenta no autorizada (401 sin token, 404 entre cuentas).
 *  6. Mantener los archivos tras reiniciar el servidor (nueva instancia, mismo volumen).
 * Además: límites de tamaño/tipo espejo de storage.rules, idempotencia, anti-traversal,
 * movimientos, expediente por fechas y copias de seguridad.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Server } from "node:http";

import { createApiApp } from "../apiApp.js";
import { VaultStore, VAULT_MAX_FILE_BYTES, safeId } from "./store.js";
import { hashPassword, verifyPassword, createSessionToken, verifySessionToken } from "./auth.js";
import { crc32 } from "./zip.js";

let dataDir = "";
let server: Server;
let base = "";
const started: Array<() => Promise<void>> = [];

async function startApp(): Promise<string> {
  const app = createApiApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  started.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

test.before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
  process.env.RENTASYNC_VAULT_DIR = dataDir;
  base = await startApp();
});

test.after(async () => {
  for (const stop of started.reverse()) await stop();
  delete process.env.RENTASYNC_VAULT_DIR;
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

async function json(method: string, url: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function registerAndLogin(username: string, password: string): Promise<string> {
  const reg = await json("POST", "/api/vault/auth/register", { username, password });
  assert.ok(reg.status === 201 || reg.status === 409, `registro de ${username}: ${reg.status}`);
  const login = await json("POST", "/api/vault/auth/login", { username, password });
  assert.equal(login.status, 200, `login de ${username} debe funcionar`);
  return login.body.token as string;
}

// ---------- unidad: contraseñas y tokens ----------
test("S1. scrypt: verifica la contraseña correcta y rechaza otra", () => {
  const { salt, hash } = hashPassword("rentasync123");
  assert.equal(verifyPassword("rentasync123", salt, hash), true);
  assert.equal(verifyPassword("otra-contraseña", salt, hash), false);
  assert.notEqual(hash, hashPassword("rentasync123").hash, "la sal debe hacer único cada hash");
});

test("S2. Tokens HMAC: firma, caducidad y manipulación", () => {
  const token = createSessionToken("secreto", "rentasync");
  assert.equal(verifySessionToken("secreto", token), "rentasync");
  assert.equal(verifySessionToken("otro-secreto", token), null, "otro secreto no valida");
  const [payload, sig] = token.split(".");
  assert.equal(verifySessionToken("secreto", `${payload}.AAAA${sig.slice(4)}`), null, "firma manipulada");
  const expired = createSessionToken("secreto", "rentasync", -1000);
  assert.equal(verifySessionToken("secreto", expired), null, "token caducado");
});

test("S3. Identificadores seguros (anti path-traversal)", () => {
  assert.equal(safeId("file_123-abc_OK"), "file_123-abc_OK");
  assert.equal(safeId("../etc/passwd"), null);
  assert.equal(safeId("a/b"), null);
  assert.equal(safeId("a\\b"), null);
  assert.equal(safeId(""), null);
  assert.equal(safeId("x".repeat(129)), null);
});

// ---------- extremo a extremo por HTTP ----------
test("E1. Registro y login reales (punto 1 de la directiva)", async () => {
  const reg = await json("POST", "/api/vault/auth/register", { username: "rentasync", password: "rentasync123" });
  assert.equal(reg.status, 201);

  const dup = await json("POST", "/api/vault/auth/register", { username: "rentasync", password: "otra" });
  assert.equal(dup.status, 409, "no se puede registrar dos veces el mismo usuario");

  const badUser = await json("POST", "/api/vault/auth/login", { username: "rentasync", password: "mala" });
  assert.equal(badUser.status, 401, "contraseña incorrecta → 401");

  const login = await json("POST", "/api/vault/auth/login", { username: "rentasync", password: "rentasync123" });
  assert.equal(login.status, 200);
  assert.ok(typeof login.body.token === "string" && login.body.token.length > 20);

  const session = await json("GET", "/api/vault/session", undefined, login.body.token);
  assert.equal(session.status, 200);
  assert.equal(session.body.username, "rentasync");

  const noToken = await json("GET", "/api/vault/session");
  assert.equal(noToken.status, 401, "sin token no hay sesión");
  const badToken = await json("GET", "/api/vault/session", undefined, "token.inventado");
  assert.equal(badToken.status, 401, "token falsificado no vale");
});

test("E2. Subida real, referencia al movimiento y recuperación íntegra (puntos 2-4)", async () => {
  const token = await registerAndLogin("rentasync", "rentasync123");
  const bytes = new Uint8Array(4096);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17) % 256;
  const b64 = Buffer.from(bytes).toString("base64");

  const up = await json(
    "POST",
    "/api/vault/files",
    { name: "recibo_ibi_2026.png", contentType: "image/png", bytesBase64: b64, movementId: "exp_0001" },
    token
  );
  assert.equal(up.status, 201, `la subida debe funcionar: ${JSON.stringify(up.body)}`);
  const fileId = up.body.file.id as string;
  assert.ok(fileId, "debe devolver la referencia del archivo");
  assert.equal(up.body.file.movementId, "exp_0001", "el archivo queda vinculado a su movimiento");
  assert.equal(up.body.file.sha256, createHash("sha256").update(bytes).digest("hex"), "hash registrado");

  const res = await fetch(`${base}/api/vault/files/${fileId}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200, "recuperación por referencia");
  assert.equal(res.headers.get("content-type"), "image/png");
  const recovered = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(Array.from(recovered), Array.from(bytes), "bytes íntegros");
  assert.equal(res.headers.get("x-vault-sha256"), createHash("sha256").update(bytes).digest("hex"));

  const list = await json("GET", "/api/vault/files", undefined, token);
  assert.equal(list.status, 200);
  assert.ok(list.body.files.some((f: any) => f.id === fileId && f.movementId === "exp_0001"));
});

test("E3. Aislamiento: otra cuenta no accede a los archivos ni a las copias (punto 5)", async () => {
  const tokenA = await registerAndLogin("cuenta_a", "clave_a_1");
  const tokenB = await registerAndLogin("cuenta_b", "clave_b_1");

  const bytes = new Uint8Array([1, 2, 3, 4]);
  const up = await json(
    "POST",
    "/api/vault/files",
    { name: "privado.png", contentType: "image/png", bytesBase64: Buffer.from(bytes).toString("base64") },
    tokenA
  );
  assert.equal(up.status, 201);
  const fileId = up.body.file.id as string;

  const asB = await fetch(`${base}/api/vault/files/${fileId}`, { headers: { authorization: `Bearer ${tokenB}` } });
  assert.equal(asB.status, 404, "la cuenta B no ve el archivo de la cuenta A");

  const anon = await fetch(`${base}/api/vault/files/${fileId}`);
  assert.equal(anon.status, 401, "sin sesión no hay acceso");

  const filesB = await json("GET", "/api/vault/files", undefined, tokenB);
  assert.equal(filesB.body.files.length, 0, "la cuenta B no lista archivos de la A");

  const traversal = await fetch(`${base}/api/vault/files/..%2F..%2F..%2Fsecret.key`, {
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.ok(traversal.status === 404 || traversal.status === 400, "el traversal se rechaza");

  const backup = await json("POST", "/api/vault/backups", { portfolio: { properties: ["solo_de_a"] } }, tokenA);
  assert.equal(backup.status, 201);
  const bkpAsB = await json("GET", `/api/vault/backups/${backup.body.id}`, undefined, tokenB);
  assert.equal(bkpAsB.status, 404, "la cuenta B no lee las copias de la A");
});

test("E4. Límites espejo de storage.rules: tamaño y tipos", async () => {
  const token = await registerAndLogin("cuenta_limites", "clave_l_1");

  const badType = await json(
    "POST",
    "/api/vault/files",
    { name: "x.exe", contentType: "application/x-msdownload", bytesBase64: Buffer.from([1]).toString("base64") },
    token
  );
  assert.equal(badType.status, 400, "tipo no admitido se rechaza");

  const empty = await json("POST", "/api/vault/files", { name: "v.png", contentType: "image/png", bytesBase64: "" }, token);
  assert.equal(empty.status, 400, "archivo vacío se rechaza");

  // Límite binario en el almacén (10 MB)
  const store = new VaultStore(dataDir);
  const tooBig = new Uint8Array(VAULT_MAX_FILE_BYTES + 1);
  await assert.rejects(
    () => store.putFile("cuenta_limites", { name: "g.pdf", contentType: "application/pdf", bytes: tooBig }),
    /límite de 10 MB/i
  );
});

test("E5. Idempotencia: reintentar la misma subida no duplica ni sobrescribe", async () => {
  const token = await registerAndLogin("cuenta_idem", "clave_i_1");
  const bytes = new Uint8Array([9, 9, 9]);
  const b64 = Buffer.from(bytes).toString("base64");

  const first = await json("POST", "/api/vault/files", { id: "file_fijo_1", name: "a.png", contentType: "image/png", bytesBase64: b64 }, token);
  assert.equal(first.status, 201);
  const second = await json("POST", "/api/vault/files", { id: "file_fijo_1", name: "a.png", contentType: "image/png", bytesBase64: b64 }, token);
  assert.equal(second.status, 201, "reintento idéntico reutiliza el objeto");
  assert.equal(second.body.file.sha256, first.body.file.sha256);

  const conflict = await json("POST", "/api/vault/files", { id: "file_fijo_1", name: "a.png", contentType: "image/png", bytesBase64: Buffer.from([1]).toString("base64") }, token);
  assert.equal(conflict.status, 400, "contenido distinto con el mismo id se rechaza (sin sobrescribir)");
});

test("E6. Movimientos y expediente fiscal por fechas", async () => {
  const token = await registerAndLogin("cuenta_movs", "clave_m_1");
  const movements = [
    { id: "exp_2021", propertyId: "p1", category: "ibi", amount: 100, date: "2021-06-01", type: "gasto" },
    { id: "exp_2024", propertyId: "p1", category: "repairs", amount: 250, date: "2024-03-15", type: "gasto" },
    { id: "exp_2026", propertyId: "p1", category: "community", amount: 60, date: "2026-02-01", type: "gasto" },
  ];
  const put = await json("PUT", "/api/vault/movimientos", { movements }, token);
  assert.equal(put.status, 200);
  assert.equal(put.body.saved, 3);

  const get = await json("GET", "/api/vault/movimientos", undefined, token);
  assert.equal(get.body.movements.length, 3);

  // Repetir la sincronización es idempotente (mismo conjunto)
  const putAgain = await json("PUT", "/api/vault/movimientos", { movements }, token);
  assert.equal(putAgain.body.saved, 3);

  const expediente = await json("GET", "/api/vault/expediente?from=2023-01-01&to=2026-12-31", undefined, token);
  assert.equal(expediente.status, 200);
  assert.deepEqual(expediente.body.movements.map((m: any) => m.id).sort(), ["exp_2024", "exp_2026"]);
});

test("E7. Persistencia tras reinicio del servidor (punto 6): nueva instancia, mismo volumen", async () => {
  const tokenA = await registerAndLogin("rentasync", "rentasync123");
  const filesBefore = await json("GET", "/api/vault/files", undefined, tokenA);
  assert.ok(filesBefore.body.files.length >= 1, "hay archivos antes del reinicio");

  // Reinicio: parar la instancia actual y levantar otra nueva sobre el MISMO directorio.
  await started.pop()!();
  base = await startApp();

  const login = await json("POST", "/api/vault/auth/login", { username: "rentasync", password: "rentasync123" });
  assert.equal(login.status, 200, "las credenciales sobreviven al reinicio (usuarios persistidos)");
  const token2 = login.body.token;

  const session = await json("GET", "/api/vault/session", undefined, token2);
  assert.equal(session.body.username, "rentasync");

  const filesAfter = await json("GET", "/api/vault/files", undefined, token2);
  assert.deepEqual(
    filesAfter.body.files.map((f: any) => f.id).sort(),
    filesBefore.body.files.map((f: any) => f.id).sort(),
    "los archivos sobreviven al reinicio"
  );

  const one = filesAfter.body.files[0];
  const res = await fetch(`${base}/api/vault/files/${one.id}`, { headers: { authorization: `Bearer ${token2}` } });
  assert.equal(res.status, 200, "el archivo se sigue recuperando tras el reinicio");

  const movs = await json("GET", "/api/vault/movimientos", undefined, token2);
  assert.ok(Array.isArray(movs.body.movements), "los movimientos persisten");
});

/** Lector ZIP mínimo (método store) para validar lo que genera el endpoint de expediente. */
function readStoreZip(buf: Buffer): Map<string, { bytes: Buffer; crc: number }> {
  const out = new Map<string, { bytes: Buffer; crc: number }>();
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break; // directorio central
    const crc = buf.readUInt32LE(off + 14);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString("utf8");
    const dataStart = off + 30 + nameLen + extraLen;
    out.set(name, { bytes: Buffer.from(buf.subarray(dataStart, dataStart + compSize)), crc });
    off = dataStart + compSize;
  }
  return out;
}

test("E8. Expediente completo en un único ZIP: movimientos + documentos vinculados", async () => {
  const token = await registerAndLogin("cuenta_zip", "clave_z_1");

  const bytesA = new Uint8Array(1024);
  for (let i = 0; i < bytesA.length; i++) bytesA[i] = (i * 31) % 256;
  const upA = await json(
    "POST",
    "/api/vault/files",
    { name: "recibo_zip.png", contentType: "image/png", bytesBase64: Buffer.from(bytesA).toString("base64"), movementId: "exp_zip_1" },
    token
  );
  assert.equal(upA.status, 201);
  const fileA = upA.body.file.id as string;

  const bytesB = new Uint8Array(512);
  for (let i = 0; i < bytesB.length; i++) bytesB[i] = (i * 7) % 256;
  const upB = await json(
    "POST",
    "/api/vault/files",
    { name: "contrato_zip.pdf", contentType: "application/pdf", bytesBase64: Buffer.from(bytesB).toString("base64") },
    token
  );
  assert.equal(upB.status, 201);
  const fileB = upB.body.file.id as string;

  const movements = [
    { id: "exp_zip_1", propertyId: "p1", category: "ibi", amount: 100, date: "2026-04-01", receiptVaultId: fileA },
    { id: "exp_zip_2", propertyId: "p1", category: "insurance", amount: 90, date: "2026-05-01", pdfVaultId: fileB },
    { id: "exp_viejo", propertyId: "p1", category: "ibi", amount: 50, date: "2020-01-01" },
  ];
  assert.equal((await json("PUT", "/api/vault/movimientos", { movements }, token)).body.saved, 3);

  const res = await fetch(`${base}/api/vault/expediente.zip?from=2026-01-01&to=2026-12-31`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /application\/zip/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "firma ZIP");
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50, "fin de directorio central");

  const entries = readStoreZip(buf);
  const names = Array.from(entries.keys());
  assert.ok(entries.has("movimientos.json"), "incluye movimientos.json");
  assert.ok(entries.has("archivos.json"), "incluye archivos.json");
  const entryA = names.find((n) => n.includes(fileA));
  const entryB = names.find((n) => n.includes(fileB));
  assert.ok(entryA, `incluye el recibo vinculado (${fileA})`);
  assert.ok(entryB, `incluye el contrato referenciado (${fileB})`);

  // Bytes íntegros y CRC válidos en cada entrada.
  assert.deepEqual(Array.from(entries.get(entryA!).bytes), Array.from(bytesA), "bytes del recibo íntegros en el ZIP");
  assert.deepEqual(Array.from(entries.get(entryB!).bytes), Array.from(bytesB), "bytes del contrato íntegros en el ZIP");
  for (const [name, e] of entries) {
    assert.equal(crc32(e.bytes), e.crc, `CRC válido en ${name}`);
  }

  const movs = JSON.parse(entries.get("movimientos.json")!.bytes.toString("utf8"));
  assert.deepEqual(movs.movements.map((m: any) => m.id).sort(), ["exp_zip_1", "exp_zip_2"], "solo movimientos del rango");
  assert.ok(!names.some((n) => n === "archivos/exp_viejo"), "sin documentos fuera de rango");

  // Sin rango: incluye todos los archivos del usuario.
  const full = await fetch(`${base}/api/vault/expediente.zip`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(full.status, 200);
  const fullEntries = readStoreZip(Buffer.from(await full.arrayBuffer()));
  assert.ok(Array.from(fullEntries.keys()).some((n) => n.includes(fileA)));
  assert.ok(Array.from(fullEntries.keys()).some((n) => n.includes(fileB)));
});
