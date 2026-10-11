/**
 * patrimonialIntegration.test.ts — Pruebas de integración del modelo patrimonial (datos sintéticos).
 *
 * Flujo completo contra la aplicación Express REAL y el almacén remoto (doble en memoria con la
 * misma interfaz que Vercel Blob):
 *
 *  I1. Titulares + relación de titularidad, inmueble, contrato, movimiento y documento asociado.
 *  I2. Recuperación íntegra desde una NUEVA ejecución del backend (mismo almacén remoto).
 *  I3. Relaciones intactas tras el reinicio (titularidad, contrato→inmueble, documento→movimiento→inmueble).
 *  I4. Repetir las operaciones no genera duplicados (idempotencia por identificador).
 *  I5. Aislamiento: otra cuenta no lee, no modifica ni borra estas entidades ni sus documentos.
 *  I6. Identificadores manipulados y operaciones no autorizadas: rechazo explícito.
 *  I7. Fallo del almacén remoto: error explícito, sin confirmar guardados falsos.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Server } from "node:http";

import { createApiApp } from "../apiApp.js";
import { BlobVaultPersistence, UnconfiguredVaultPersistence } from "./persistence.js";
import type { BlobObjectInfo, BlobPort, PresignedPut } from "./persistenceTypes.js";
import { MemoryBlobPort } from "./memoryBlobPort.js";

/** Puerto que falla todas las escrituras (simula el almacén caído o sin permisos). */
class FailingWritePort extends MemoryBlobPort {
  override async putBytes(pathname: string, bytes: Uint8Array, contentType: string): Promise<BlobObjectInfo> {
    // El secreto y la cuenta se dejan funcionar: solo el ALMACÉN de datos falla.
    if (pathname.includes("/entities/") || pathname.includes("/movements/") || pathname.includes("/contents/") || pathname.includes("/files/")) {
      throw new Error("almacén remoto no disponible (sintético)");
    }
    return super.putBytes(pathname, bytes, contentType);
  }
}

const openServers: Server[] = [];

async function startApp(port: BlobPort): Promise<string> {
  const app = createApiApp({ vaultPersistence: new BlobVaultPersistence(port) });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  openServers.push(server);
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

async function json(method: string, url: string, body?: unknown, token?: string) {
  const res = await fetch(url, {
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

async function registerAndLogin(base: string, username: string, password: string): Promise<string> {
  const reg = await json("POST", `${base}/api/vault?op=auth.register`, { username, password });
  assert.equal(reg.status, 201);
  const login = await json("POST", `${base}/api/vault?op=auth.login`, { username, password });
  assert.equal(login.status, 200);
  return login.body.token as string;
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 226, 226]); // cabecera PDF sintética

// Escenario sintético (sin datos personales reales)
const propietario1 = { id: "user1", name: "Titular Uno", dni: "00000001R", brutoTrabajo: 30000, netoTrabajo: 24000 };
const propietario2 = { id: "user2", name: "Titular Dos", dni: "00000002R", brutoTrabajo: 22000, netoTrabajo: 18000, hasPartner: true };
const inmueble = {
  id: "prop_sint_1",
  address: "Calle Ficticia 7",
  cadastralReference: "0000-SINT-000000",
  owner: "both",
  ownershipPercentageUser1: 60,
  ownershipPercentageUser2: 40,
  monthlyRent: 950,
  contract: { startDate: "2026-01-01", monthlyRent: 950, pdfVaultId: "file_contrato_1" },
  tenantHistory: [
    { id: "ct_sint_1", tenantName: "Inquilino Sintético", tenantDni: "00000003T", startDate: "2026-01-01", monthlyRent: 950 },
  ],
  documents: [{ id: "doc_sint_1", name: "ibi-2026.pdf", size: "12 KB", type: "application/pdf", category: "ibi", year: 2026, uploadDate: "2026-02-01", vaultId: "file_doc_1" }],
};
const movimiento = {
  id: "mov_sint_1",
  propertyId: "prop_sint_1",
  category: "rent",
  type: "ingreso",
  amount: 950,
  date: "2026-03-01",
  receiptVaultId: "file_recibo_1",
};

test("I1-I4. Altas, relaciones, recuperación tras reinicio e idempotencia", async () => {
  const port = new MemoryBlobPort();
  const base = await startApp(port);
  const ana = await registerAndLogin(base, "int_ana", "secreto-int-ana-1");

  // Titulares (con la relación de titularidad viva en el inmueble).
  assert.equal((await json("POST", `${base}/api/vault?op=entities.put`, { type: "owners", id: "user1", entity: propietario1 }, ana)).status, 201);
  assert.equal((await json("POST", `${base}/api/vault?op=entities.put`, { type: "owners", id: "user2", entity: propietario2 }, ana)).status, 201);
  // Documentos binarios asociados: recibo del movimiento, contrato y documento del inmueble.
  for (const [id, movementId, propertyId] of [
    ["file_recibo_1", "mov_sint_1", "prop_sint_1"],
    ["file_contrato_1", undefined, "prop_sint_1"],
    ["file_doc_1", undefined, "prop_sint_1"],
  ] as const) {
    const up = await json(
      "POST",
      `${base}/api/vault?op=files.upload`,
      { id, name: `${id}.pdf`, contentType: "application/pdf", bytesBase64: Buffer.from(PDF).toString("base64"), movementId, propertyId },
      ana
    );
    assert.equal(up.status, 201, `subida de ${id}`);
    assert.equal(up.body.file.sha256, sha(PDF));
  }


  // Inmueble con contrato embebido y metadatos de documento (relaciones por id).
  assert.equal((await json("POST", `${base}/api/vault?op=entities.put`, { type: "properties", id: inmueble.id, entity: inmueble }, ana)).status, 201);
  // Contrato del redactor como entidad independiente, relacionado por propertyId.
  assert.equal(
    (await json("POST", `${base}/api/vault?op=entities.put`, { type: "contracts", id: "ct_redactor_1", entity: { id: "ct_redactor_1", propertyId: "prop_sint_1", clauses: "sintético" } }, ana)).status,
    201
  );
  // Movimiento con receiptVaultId → documento.
  assert.equal((await json("PUT", `${base}/api/vault?op=movimientos`, { movements: [movimiento] }, ana)).status, 200);
  // I4. Repetir las operaciones: cero duplicados.
  assert.equal((await json("PUT", `${base}/api/vault?op=movimientos`, { movements: [movimiento] }, ana)).status, 200);
  assert.equal((await json("POST", `${base}/api/vault?op=entities.put`, { type: "properties", id: inmueble.id, entity: inmueble }, ana)).status, 201);
  const upRetry = await json(
    "POST",
    `${base}/api/vault?op=files.upload`,
    { id: "file_recibo_1", name: "file_recibo_1.pdf", contentType: "application/pdf", bytesBase64: Buffer.from(PDF).toString("base64"), movementId: "mov_sint_1" },
    ana
  );
  assert.equal(upRetry.status, 201);

  // I2. NUEVA ejecución del backend (otro proceso de función, mismo almacén remoto).
  const base2 = await startApp(port);

  const owners = await json("GET", `${base2}/api/vault?op=entities.list&type=owners`, undefined, ana);
  assert.deepEqual(owners.body.entities.map((e: any) => e.id).sort(), ["user1", "user2"]);
  const props = await json("GET", `${base2}/api/vault?op=entities.list&type=properties`, undefined, ana);
  assert.equal(props.body.entities.length, 1, "un solo inmueble tras reintentar");
  const recovered = props.body.entities[0].data;
  // I3. Relaciones intactas.
  assert.equal(recovered.ownershipPercentageUser1 + recovered.ownershipPercentageUser2, 100);
  assert.equal(recovered.owner, "both");
  assert.equal(recovered.contract.pdfVaultId, "file_contrato_1");
  assert.equal(recovered.tenantHistory[0].id, "ct_sint_1");
  assert.equal(recovered.documents[0].vaultId, "file_doc_1");
  const contracts = await json("GET", `${base2}/api/vault?op=entities.list&type=contracts`, undefined, ana);
  assert.equal(contracts.body.entities[0].data.propertyId, "prop_sint_1");
  const movs = await json("GET", `${base2}/api/vault?op=movimientos`, undefined, ana);
  assert.equal(movs.body.movements.length, 1, "sin movimientos duplicados");
  assert.equal(movs.body.movements[0].propertyId, "prop_sint_1");
  assert.equal(movs.body.movements[0].receiptVaultId, "file_recibo_1");
  const files = await json("GET", `${base2}/api/vault?op=files.list`, undefined, ana);
  assert.equal(files.body.files.length, 3, "sin documentos duplicados");
  const recibo = files.body.files.find((f: any) => f.id === "file_recibo_1");
  assert.equal(recibo.movementId, "mov_sint_1");
  assert.equal(recibo.propertyId, "prop_sint_1");

  // La descarga del recibo devuelve los bytes originales con su hash verificado.
  const dl = await fetch(`${base2}/api/vault?op=files.get&id=file_recibo_1`, { headers: { authorization: `Bearer ${ana}` } });
  assert.equal(dl.status, 200);
  const bytes = new Uint8Array(await dl.arrayBuffer());
  assert.equal(sha(bytes), sha(PDF));

  // I5. Otra cuenta: ni entidades, ni movimientos, ni documentos ajenos.
  const eva = await registerAndLogin(base2, "int_eva", "secreto-int-eva-1");
  assert.equal((await json("GET", `${base2}/api/vault?op=entities.list&type=properties`, undefined, eva)).body.entities.length, 0);
  assert.equal((await json("GET", `${base2}/api/vault?op=movimientos`, undefined, eva)).body.movements.length, 0);
  assert.equal((await fetch(`${base2}/api/vault?op=files.get&id=file_recibo_1`, { headers: { authorization: `Bearer ${eva}` } })).status, 404);
  assert.equal((await json("DELETE", `${base2}/api/vault?op=entities.delete&id=prop_sint_1&type=properties`, undefined, eva)).status, 404);
  assert.equal((await json("DELETE", `${base2}/api/vault?op=files.delete&id=file_recibo_1`, undefined, eva)).status, 404);
  // La cuenta propietaria conserva todo tras los intentos ajenos.
  assert.equal((await json("GET", `${base2}/api/vault?op=entities.list&type=properties`, undefined, ana)).body.entities.length, 1);

  // I6. Identificadores manipulados y operaciones no autorizadas.
  assert.equal((await json("DELETE", `${base2}/api/vault?op=entities.delete&id=../../account&type=properties`, undefined, ana)).status, 400);
  assert.equal((await json("GET", `${base2}/api/vault?op=entities.delete&id=x&type=properties`, undefined, ana)).status, 405, "método no admitido: 405 explícito");
  assert.equal((await json("GET", `${base2}/api/vault?op=entities.list&type=properties`)).status, 401);
  assert.equal((await json("GET", `${base2}/api/vault?op=entities.list&type=properties`, undefined, "token.falso")).status, 401);

  // Auditoría de la cuenta: solo identificadores propios, con las escrituras registradas.
  const audit = await json("GET", `${base2}/api/vault?op=audit&limit=100`, undefined, ana);
  const actions = audit.body.events.map((e: any) => e.action);
  assert.ok(actions.includes("entity.put"));
  assert.ok(actions.includes("file.upload"));
  assert.ok(!JSON.stringify(audit.body).includes("int_eva"), "la auditoría de una cuenta no contiene la otra");
});

test("I7. Con el almacén remoto caído, las escrituras fallan de forma explícita (sin falso éxito)", async () => {
  const base = await startApp(new FailingWritePort());
  const ana = await registerAndLogin(base, "int_rui", "secreto-int-rui-1");

  const entity = await json("POST", `${base}/api/vault?op=entities.put`, { type: "properties", id: "prop_x", entity: { id: "prop_x" } }, ana);
  assert.equal(entity.status, 503, "la entidad NO se declara guardada");
  assert.match(entity.body.error || "", /almacenamiento remoto|no disponible/i);

  const upload = await json(
    "POST",
    `${base}/api/vault?op=files.upload`,
    { id: "file_x", name: "x.pdf", contentType: "application/pdf", bytesBase64: Buffer.from(PDF).toString("base64") },
    ana
  );
  assert.equal(upload.status, 503, "el documento NO se declara guardado");
  assert.equal((await json("GET", `${base}/api/vault?op=files.list`, undefined, ana)).body.files.length, 0, "no queda metadato huérfano");

  const movs = await json("PUT", `${base}/api/vault?op=movimientos`, { movements: [{ id: "m1", amount: 1 }] }, ana);
  assert.equal(movs.status, 503);
});

test("I7b. Sin almacén configurado en Vercel: modo degradado declarado, jamás disco local", async () => {
  const app = createApiApp({ vaultPersistence: new UnconfiguredVaultPersistence() });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  openServers.push(server);
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  const health = await json("GET", `${base}/api/vault?op=health`);
  assert.equal(health.body.durable, false);
  assert.equal(health.body.driver, "unconfigured");
  assert.equal(health.body.storageOk, false, "la sonda NUNCA informa de todo correcto sin almacén");
});

test.after(async () => {
  for (const s of openServers) await new Promise<void>((resolve) => s.close(() => resolve()));
});
