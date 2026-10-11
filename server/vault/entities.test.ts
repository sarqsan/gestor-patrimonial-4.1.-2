/**
 * entities.test.ts — Entidades estructuradas de la cartera en el almacén remoto del vault.
 *
 * Cubre la mecánica de `VaultPersistence` para las entidades patrimoniales (owners, properties,
 * contracts, payments, settings): una entidad = un objeto JSON por identificador bajo la cuenta.
 *
 *  E1. Persistencia tras reinicio del backend (nueva instancia, mismo almacén).
 *  E2. Idempotencia: reintentar `put` no duplica; la lista es un índice estable por id.
 *  E3. Borrado por id y no-existencia explícita.
 *  E4. Aislamiento entre cuentas (lectura, escritura y borrado de lo ajeno).
 *  E5. Validaciones: tipo no admitido, id manipulado, contenido ausente, límite de tamaño.
 *  E6. Forma compatible ?op= y forma anidada clásica (traducción del router).
 *  E7. Sin almacén remoto configurado: lecturas vacías y escrituras fallidas (nunca falso éxito).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";

import { createApiApp } from "../apiApp.js";
import { FsVaultPersistence, UnconfiguredVaultPersistence, VAULT_MAX_ENTITY_BYTES } from "./persistence.js";

const openServers: Server[] = [];

async function startApp(persistence: FsVaultPersistence | UnconfiguredVaultPersistence): Promise<string> {
  const app = createApiApp({ vaultPersistence: persistence });
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
  assert.ok(reg.status === 201 || reg.status === 409, `registro: ${reg.status}`);
  const login = await json("POST", `${base}/api/vault?op=auth.login`, { username, password });
  assert.equal(login.status, 200);
  return login.body.token as string;
}

let dataDir = "";
let base = "";
let base2 = ""; // segunda instancia sobre el MISMO almacén (reinicio del backend)
let tokA = "";
let tokB = "";

test.before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-entities-"));
  base = await startApp(new FsVaultPersistence(dataDir));
  tokA = await registerAndLogin(base, "ent_ana", "secreto-ent-ana-1");
  tokB = await registerAndLogin(base, "ent_beto", "secreto-ent-beto-1");
});

test.after(async () => {
  for (const s of openServers) await new Promise<void>((resolve) => s.close(() => resolve()));
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

test("E1+E2. Las entidades persisten tras reiniciar el backend y reintentar es idempotente", async () => {
  const propiedad = {
    id: "prop_1",
    address: "Calle Sintética 1",
    owner: "both",
    ownershipPercentageUser1: 60,
    ownershipPercentageUser2: 40,
  };
  const put = await json("POST", `${base}/api/vault?op=entities.put`, { type: "properties", id: "prop_1", entity: propiedad }, tokA);
  assert.equal(put.status, 201);
  assert.equal(put.body.entity.id, "prop_1");
  assert.ok(put.body.entity.updatedAt);

  // Reintento idempotente: mismo id, mismo objeto, sin duplicados en el índice.
  const putAgain = await json("POST", `${base}/api/vault?op=entities.put`, { type: "properties", id: "prop_1", entity: propiedad }, tokA);
  assert.equal(putAgain.status, 201);

  // NUEVA instancia del backend sobre el mismo almacén remoto.
  base2 = await startApp(new FsVaultPersistence(dataDir));
  const list = await json("GET", `${base2}/api/vault?op=entities.list&type=properties`, undefined, tokA);
  assert.equal(list.status, 200);
  assert.equal(list.body.entities.length, 1, "sin duplicados tras el reintento");
  assert.deepEqual(list.body.entities[0].data, propiedad, "la entidad se recupera íntegra tras el reinicio");
});

test("E3. Borrado por identificador y ausencia explícita", async () => {
  const put = await json("POST", `${base2}/api/vault?op=entities.put`, { type: "payments", id: "pay_1", entity: { id: "pay_1", propertyId: "prop_1", amount: 700 } }, tokA);
  assert.equal(put.status, 201);
  const del = await json("DELETE", `${base2}/api/vault?op=entities.delete&id=pay_1&type=payments`, undefined, tokA);
  assert.equal(del.status, 204);
  const delAgain = await json("DELETE", `${base2}/api/vault?op=entities.delete&id=pay_1&type=payments`, undefined, tokA);
  assert.equal(delAgain.status, 404, "borrar lo ya borrado es un 404 explícito, no un falso éxito");
  const list = await json("GET", `${base2}/api/vault?op=entities.list&type=payments`, undefined, tokA);
  assert.equal(list.body.entities.length, 0);
});

test("E4. Aislamiento entre cuentas: cada entidad vive bajo la cuenta de su token", async () => {
  await json("POST", `${base2}/api/vault?op=entities.put`, { type: "owners", id: "user1", entity: { id: "user1", name: "Ana", dni: "00000000X" } }, tokA);
  const asB = await json("GET", `${base2}/api/vault?op=entities.list&type=owners`, undefined, tokB);
  assert.equal(asB.status, 200);
  assert.equal(asB.body.entities.length, 0, "B no ve las entidades de A");
  const overwrite = await json("POST", `${base2}/api/vault?op=entities.put`, { type: "owners", id: "user1", entity: { id: "user1", name: "Impostor" } }, tokB);
  assert.equal(overwrite.status, 201, "B puede escribir SU PROPIA entidad con el mismo id: son espacios de nombres distintos");
  const asAAgain = await json("GET", `${base2}/api/vault?op=entities.list&type=owners`, undefined, tokA);
  assert.equal(asAAgain.body.entities[0].data.name, "Ana", "la escritura de B no toca la entidad homónima de A");
  const delAsB = await json("DELETE", `${base2}/api/vault?op=entities.delete&id=user1&type=owners`, undefined, tokB);
  assert.equal(delAsB.status, 204, "B borra la suya");
  const asAFinal = await json("GET", `${base2}/api/vault?op=entities.list&type=owners`, undefined, tokA);
  assert.equal(asAFinal.body.entities.length, 1, "la de A sigue intacta");
});

test("E5. Validaciones explícitas: tipo, identificador, contenido y tamaño", async () => {
  const badType = await json("POST", `${base2}/api/vault?op=entities.put`, { type: "hack", id: "x", entity: {} }, tokA);
  assert.equal(badType.status, 400);
  assert.match(badType.body.error, /no admitido/i);

  const badId = await json("POST", `${base2}/api/vault?op=entities.put`, { type: "settings", id: "../../etc", entity: {} }, tokA);
  assert.equal(badId.status, 400);
  assert.match(badId.body.error, /identificador/i);

  const noEntity = await json("POST", `${base2}/api/vault?op=entities.put`, { type: "settings", id: "app" }, tokA);
  assert.equal(noEntity.status, 400);
  assert.match(noEntity.body.error, /contenido/i);

  const huge = await json(
    "POST",
    `${base2}/api/vault?op=entities.put`,
    { type: "settings", id: "app", entity: { relleno: "x".repeat(VAULT_MAX_ENTITY_BYTES) } },
    tokA
  );
  assert.equal(huge.status, 400);
  assert.match(huge.body.error, /límite/i);

  const traversalList = await json("GET", `${base2}/api/vault?op=entities.list&type=../files`, undefined, tokA);
  assert.equal(traversalList.status, 400, "el tipo también se valida contra la lista cerrada");
});

test("E6. Las dos formas de enrutado operan sobre las mismas entidades", async () => {
  // Escritura por forma anidada clásica…
  const putNested = await json("POST", `${base2}/api/vault/entities`, { type: "contracts", id: "ct_1", entity: { id: "ct_1", propertyId: "prop_1", monthlyRent: 900 } }, tokA);
  assert.equal(putNested.status, 201);
  // …lectura por la forma compatible.
  const listOp = await json("GET", `${base2}/api/vault?op=entities.list&type=contracts`, undefined, tokA);
  assert.equal(listOp.body.entities.length, 1);
  assert.equal(listOp.body.entities[0].data.propertyId, "prop_1");
  // Y al revés: escritura por ?op= y lectura anidada.
  await json("POST", `${base2}/api/vault?op=entities.put`, { type: "settings", id: "app", entity: { theme: "slate-indigo" } }, tokA);
  const settingsList = await fetch(`${base2}/api/vault/entities?type=settings`, { headers: { authorization: `Bearer ${tokA}` } });
  assert.equal(settingsList.status, 200);
  const parsed = await settingsList.json();
  assert.equal(parsed.entities[0].data.theme, "slate-indigo");
  // Sin tipo: error explícito (nunca un listado ambiguo ni un 404 de plataforma).
  const missingType = await json("GET", `${base2}/api/vault/entities`, undefined, tokA);
  assert.equal(missingType.status, 400);
  assert.match(missingType.body.error, /no admitido/i);
});

test("E7. Sin almacén remoto configurado: lecturas vacías y escrituras con error explícito", async () => {
  const baseNone = await startApp(new UnconfiguredVaultPersistence());
  // Sin destino no hay secretos ni cuentas: las lecturas autenticadas devuelven 401 y las
  // escrituras directas del driver fallan de forma explícita (comprobado a nivel de driver).
  const list = await json("GET", `${baseNone}/api/vault?op=entities.list&type=properties`, undefined, "token-cualquiera");
  assert.equal(list.status, 503, "sin almacén el error es explícito (503), nunca datos inventados");
  assert.match(list.body.error || "", /no está configurado|No se ha guardado nada/i);
  const persistence = new UnconfiguredVaultPersistence();
  await assert.rejects(
    () => persistence.putEntity("ana", "properties", "prop_1", { id: "prop_1" }),
    (err: any) => /no está configurado|No se ha guardado nada/i.test(err.message)
  );
  assert.deepEqual(await persistence.listEntities("ana", "properties"), []);
});
