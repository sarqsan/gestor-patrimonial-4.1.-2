/**
 * routingCompatibility.test.ts — Compatibilidad de enrutado del vault en Vercel.
 *
 * En Vercel, las rutas anidadas (`/api/vault/files/:id`, ...) devolvían un 404 de la propia
 * plataforma ANTES de alcanzar Express. La forma compatible es la de un solo segmento de ruta
 * con la operación en la consulta:
 *
 *      /api/vault?op=<operación>[&id=…]
 *
 * La capa de compatibilidad vive en el router (server/vault/routes.ts) y traduce esa forma a la
 * ruta interna equivalente. Estas pruebas verifican, contra la aplicación Express REAL:
 *
 *  R1. La forma `?op=` llega al router (JSON del vault, no el 404 genérico de la plataforma).
 *  R2. Cada operación responde igual por `?op=` que por su ruta anidada clásica.
 *  R3. Los controles de autenticación y autorización son idénticos en ambas formas.
 *  R4. El aislamiento entre cuentas se mantiene también con `?op=`.
 *  R5. Los errores de la forma compatible son explícitos (operación desconocida, método no
 *      admitido, identificador ausente o manipulado, forma mixta).
 *  R6. La forma anidada clásica sigue funcionando: el montaje de Express no cambia.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";

import { createApiApp } from "../apiApp.js";
import { FsVaultPersistence } from "./persistence.js";
import { resolveVaultOperation, VAULT_OPERATION_SPECS } from "./routes.js";

let dataDir = "";
let server: Server;
let base = "";

async function startApp(): Promise<string> {
  const app = createApiApp({ vaultPersistence: new FsVaultPersistence(dataDir) });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

test.before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-routing-"));
  base = await startApp();
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  return { status: res.status, body: parsed, contentType: res.headers.get("content-type") || "" };
}

async function registerAndLogin(username: string, password: string): Promise<string> {
  const reg = await json("POST", "/api/vault?op=auth.register", { username, password });
  assert.equal(reg.status, 201, `registro de ${username}: ${reg.status}`);
  const login = await json("POST", "/api/vault?op=auth.login", { username, password });
  assert.equal(login.status, 200, `login de ${username}`);
  return login.body.token as string;
}

const PNG_B64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");

// --- R1: la forma compatible llega al router ---------------------------------

test("R1. GET /api/vault?op=health llega al router del vault (JSON propio, no el 404 genérico)", async () => {
  const res = await json("GET", "/api/vault?op=health");
  assert.equal(res.status, 200);
  assert.match(res.contentType, /application\/json/);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.vault, "ok");
  assert.equal(typeof res.body.driver, "string");
  assert.equal(typeof res.body.durable, "boolean");
  assert.equal(typeof res.body.storageOk, "boolean");
});

// --- R2: equivalencia de la forma ?op= con la ruta anidada clásica -----------

test("R2. Las mismas operaciones responden igual por ?op= y por la ruta anidada", async () => {
  // Sesión: alta y acceso por ambas formas.
  const regOp = await json("POST", "/api/vault?op=auth.register", {
    username: "routing_ana",
    password: "secreto-ana-1",
  });
  assert.equal(regOp.status, 201);
  const regNested = await json("POST", "/api/vault?op=auth.register", {
    username: "routing_beto",
    password: "secreto-beto-1",
  });
  assert.equal(regNested.status, 201);

  const loginOp = await json("POST", "/api/vault?op=auth.login", {
    username: "routing_ana",
    password: "secreto-ana-1",
  });
  const loginNested = await json("POST", "/api/vault/auth/login", {
    username: "routing_beto",
    password: "secreto-beto-1",
  });
  assert.equal(loginOp.status, 200);
  assert.equal(loginNested.status, 200);
  const ana = loginOp.body.token as string;

  // Sesión.
  const sessionOp = await json("GET", "/api/vault?op=session", undefined, ana);
  const sessionNested = await json("GET", "/api/vault/session", undefined, loginNested.body.token);
  assert.equal(sessionOp.status, 200);
  assert.equal(sessionOp.body.username, "routing_ana");
  assert.equal(sessionNested.status, 200);
  assert.equal(sessionNested.body.username, "routing_beto");

  // Subida por ?op= y listado por la ruta anidada (y al revés): todo el vocabulario es común.
  const upload = await json(
    "POST",
    "/api/vault?op=files.upload",
    { id: "file_routing_1", name: "factura.png", contentType: "image/png", bytesBase64: PNG_B64, movementId: "mov_1" },
    ana
  );
  assert.equal(upload.status, 201);
  assert.equal(upload.body.file.id, "file_routing_1");
  assert.equal(upload.body.file.movementId, "mov_1");

  const listNested = await json("GET", "/api/vault/files", undefined, ana);
  assert.equal(listNested.status, 200);
  assert.equal(listNested.body.files.length, 1);

  // Descarga por ?op=…&id=: bytes y cabecera de integridad idénticos.
  const dlOp = await fetch(`${base}/api/vault?op=files.get&id=file_routing_1`, {
    headers: { authorization: `Bearer ${ana}` },
  });
  assert.equal(dlOp.status, 200);
  const dlNested = await fetch(`${base}/api/vault/files/file_routing_1`, {
    headers: { authorization: `Bearer ${ana}` },
  });
  assert.equal(dlNested.status, 200);
  assert.deepEqual(new Uint8Array(await dlOp.arrayBuffer()), new Uint8Array(await dlNested.arrayBuffer()));
  assert.equal(dlOp.headers.get("x-vault-sha256"), dlNested.headers.get("x-vault-sha256"));

  // Movimientos: PUT por la forma corta de recurso+Método y GET por ?op= explícito.
  const putMov = await json("PUT", "/api/vault?op=movimientos", { movements: [{ id: "mov_1", amount: 1 }] }, ana);
  assert.equal(putMov.status, 200);
  assert.equal(putMov.body.saved, 1);
  const getMov = await json("GET", "/api/vault?op=movimientos", undefined, ana);
  assert.equal(getMov.body.movements.length, 1);

  // Copias de seguridad y auditoría.
  const backup = await json("POST", "/api/vault?op=backups.create", { portfolio: { properties: [] } }, ana);
  assert.equal(backup.status, 201);
  const backupGet = await json("GET", `/api/vault?op=backups.get&id=${backup.body.id}`, undefined, ana);
  assert.equal(backupGet.status, 200);
  const backupNested = await json("GET", `/api/vault/backups/${backup.body.id}`, undefined, ana);
  assert.deepEqual(backupGet.body.portfolio, backupNested.body.portfolio);

  const audit = await json("GET", "/api/vault?op=audit", undefined, ana);
  assert.equal(audit.status, 200);
  assert.ok(audit.body.events.length >= 3, "la auditoría registra las operaciones de la propia cuenta");
});

test("R2b. La consulta se preserva al traducir (op=expediente con from/to)", async () => {
  const ana = await registerAndLogin("routing_carla", "secreto-carla-1");
  await json(
    "PUT",
    "/api/vault?op=movimientos",
    {
      movements: [
        { id: "mov_dentro", date: "2026-06-15", amount: 1 },
        { id: "mov_fuera", date: "2020-01-01", amount: 2 },
      ],
    },
    ana
  );
  const exp = await json("GET", "/api/vault?op=expediente&from=2026-01-01&to=2026-12-31", undefined, ana);
  assert.equal(exp.status, 200);
  assert.deepEqual(
    exp.body.movements.map((m: any) => m.id),
    ["mov_dentro"],
    "from/to del expediente se trasladan a la ruta interna"
  );
  const limit = await json("GET", "/api/vault?op=audit&limit=1", undefined, ana);
  assert.equal(limit.status, 200);
  assert.equal(limit.body.events.length, 1, "limit de la auditoría también se traslada");
});

// --- R3: autenticación y autorización idénticas -------------------------------

test("R3. La forma ?op= exige la misma autenticación (401 sin token o con token inválido)", async () => {
  assert.equal((await json("GET", "/api/vault?op=session")).status, 401);
  assert.equal((await json("GET", "/api/vault?op=files.list")).status, 401);
  assert.equal((await json("GET", "/api/vault?op=session", undefined, "token.inventado")).status, 401);
  assert.equal((await json("GET", "/api/vault?op=movimientos")).status, 401);
  assert.equal((await json("POST", "/api/vault?op=backups.create", { portfolio: {} })).status, 401);
  // Los endpoints abiertos siguen abiertos.
  assert.equal((await json("GET", "/api/vault?op=health")).status, 200);
});

test("R4. El aislamiento entre cuentas se mantiene también con ?op=", async () => {
  const ana = await registerAndLogin("routing_diego", "secreto-diego-1");
  const eva = await registerAndLogin("routing_eva", "secreto-eva-1");

  const up = await json(
    "POST",
    "/api/vault?op=files.upload",
    { id: "file_privado_1", name: "secreto.png", contentType: "image/png", bytesBase64: PNG_B64 },
    ana
  );
  assert.equal(up.status, 201);
  const backup = await json("POST", "/api/vault?op=backups.create", { portfolio: { privado: "de ana" } }, ana);
  assert.equal(backup.status, 201);

  // Otra cuenta: ni lectura, ni listado, ni borrado de lo ajeno.
  assert.equal((await json("GET", "/api/vault?op=files.get&id=file_privado_1", undefined, eva)).status, 404);
  assert.equal((await json("DELETE", "/api/vault?op=files.delete&id=file_privado_1", undefined, eva)).status, 404);
  assert.equal((await json("GET", `/api/vault?op=backups.get&id=${backup.body.id}`, undefined, eva)).status, 404);
  const evaFiles = await json("GET", "/api/vault?op=files.list", undefined, eva);
  assert.equal(evaFiles.body.files.length, 0, "el listado de una cuenta no muestra lo de otra");
  const evaAudit = await json("GET", "/api/vault?op=audit", undefined, eva);
  assert.ok(
    !JSON.stringify(evaAudit.body).includes("file_privado_1"),
    "la auditoría ajena no filtra identificadores de otra cuenta"
  );

  // El propietario conserva su archivo.
  assert.equal((await json("GET", "/api/vault?op=files.get&id=file_privado_1", undefined, ana)).status, 200);
});

// --- R5: errores explícitos --------------------------------------------------

test("R5. Los errores de la forma compatible son explícitos (nunca un 404 de plataforma)", async () => {
  // Operación desconocida.
  const unknown = await json("GET", "/api/vault?op=operacion.inexistente");
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /operación no admitida/i);

  // Método no admitido.
  const wrongMethod = await json("GET", "/api/vault?op=auth.login");
  assert.equal(wrongMethod.status, 405);
  assert.match(wrongMethod.body.error, /método/i);

  // Identificador ausente.
  const missingId = await json("GET", "/api/vault?op=files.get");
  assert.equal(missingId.status, 400);
  assert.match(missingId.body.error, /identificador/i);

  // Identificador manipulado (traversal).
  const traversal = await json("GET", `/api/vault?op=files.get&id=${encodeURIComponent("../../vault/secret.key")}`);
  assert.equal(traversal.status, 400);
  assert.match(traversal.body.error, /identificador/i);

  // Varias operaciones a la vez.
  const many = await json("GET", "/api/vault?op=health&op=session");
  assert.equal(many.status, 400);
  assert.match(many.body.error, /única operación/i);

  // Forma mixta: ruta anidada + op a la vez.
  const mixed = await json("GET", "/api/vault/files?op=health");
  assert.equal(mixed.status, 400);
  assert.match(mixed.body.error, /op=|anidada/i);

  // Ninguna de estas respuestas es HTML de Vercel.
  for (const r of [unknown, wrongMethod, missingId, traversal, many, mixed]) {
    assert.match(r.contentType, /application\/json/);
    assert.equal(r.body.ok, false);
  }
});

// --- R6: la forma anidada clásica sigue funcionando --------------------------

test("R6. El montaje de Express no cambia: la ruta anidada clásica sigue operativa", async () => {
  const reg = await json("POST", "/api/vault/auth/register", { username: "routing_fabi", password: "secreto-fabi-1" });
  assert.equal(reg.status, 201);
  const login = await json("POST", "/api/vault/auth/login", { username: "routing_fabi", password: "secreto-fabi-1" });
  const fabi = login.body.token as string;
  const up = await json(
    "POST",
    "/api/vault/files",
    { id: "file_anidado_1", name: "n.png", contentType: "image/png", bytesBase64: PNG_B64 },
    fabi
  );
  assert.equal(up.status, 201);
  const dl = await fetch(`${base}/api/vault/files/file_anidado_1`, { headers: { authorization: `Bearer ${fabi}` } });
  assert.equal(dl.status, 200);
  assert.equal((await json("GET", "/api/vault/health")).status, 200);
  const del = await fetch(`${base}/api/vault/files/file_anidado_1`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${fabi}` },
  });
  assert.equal(del.status, 204);
});

// --- Tabla de operaciones -----------------------------------------------------

test("R7. La tabla de operaciones cubre todas las rutas del vault y valida identificadores", () => {
  // Cada operación con id exige un identificador válido…
  for (const [op, spec] of Object.entries(VAULT_OPERATION_SPECS)) {
    if (spec.requiresId) {
      const missing = resolveVaultOperation(op, spec.methods[0], "");
      assert.ok("error" in missing, `${op} sin id se rechaza`);
      const bad = resolveVaultOperation(op, spec.methods[0], "../../etc/passwd");
      assert.ok("error" in bad, `${op} con id manipulado se rechaza`);
    }
  }
  // …y las resoluciones correctas apuntan a la ruta interna esperada.
  assert.deepEqual(resolveVaultOperation("health", "GET", ""), { path: "/health" });
  assert.deepEqual(resolveVaultOperation("files.get", "GET", "file_1"), { path: "/files/file_1" });
  assert.deepEqual(resolveVaultOperation("files.commit", "POST", "file_1"), { path: "/files/file_1/commit" });
  assert.deepEqual(resolveVaultOperation("backups.get", "GET", "backup_1"), { path: "/backups/backup_1" });
  assert.deepEqual(resolveVaultOperation("files", "POST", ""), { path: "/files" });
  assert.deepEqual(resolveVaultOperation("movimientos", "PUT", ""), { path: "/movimientos" });
  // HEAD se despacha como GET (igual que Express).
  assert.deepEqual(resolveVaultOperation("health", "HEAD", ""), { path: "/health" });
});
