// Pruebas del almacenamiento verificado de objetos (sin red ni Firebase).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { storeVerifiedObject, ObjectConflictError, VerifiedObjectPort } from "./verifiedObjectStore";
import { storageRuleProblem, MAX_ATTACHMENT_BYTES } from "./attachmentRules";
import { deterministicBytes } from "./migrationFakes";

/** Puerto en memoria que replica la semántica de storage.rules: crear falla si ya existe. */
class MemPort implements VerifiedObjectPort {
  objects = new Map<string, Uint8Array>();
  creates = 0;
  corruptReadback = false;
  raceCreate: Uint8Array | null = null; // otro cliente crea el mismo objeto justo antes
  async read(path: string) {
    const v = this.objects.get(path);
    if (!v) return null;
    return this.corruptReadback ? v.map((b, i) => (i === 0 ? b ^ 1 : b)) : new Uint8Array(v);
  }
  async create(path: string, bytes: Uint8Array) {
    this.creates++;
    if (this.raceCreate) {
      this.objects.set(path, this.raceCreate);
      this.raceCreate = null;
    }
    if (this.objects.has(path)) throw new Error("permission denied: update not allowed");
    this.objects.set(path, new Uint8Array(bytes));
  }
}

const P = "users/arquero/attachments/expenses/imp_1/ibi.pdf";

describe("storeVerifiedObject", () => {
  test("objeto nuevo: se crea y se verifica", async () => {
    const port = new MemPort();
    const bytes = deterministicBytes(1000, 7);
    assert.equal(await storeVerifiedObject(port, { path: P, bytes, contentType: "application/pdf" }), "uploaded");
    assert.equal(port.creates, 1);
    assert.deepEqual(port.objects.get(P), bytes);
  });

  test("reimportación con el mismo contenido: se reutiliza sin volver a subir (no hay update)", async () => {
    const port = new MemPort();
    const bytes = deterministicBytes(1000, 7);
    await storeVerifiedObject(port, { path: P, bytes, contentType: "application/pdf" });
    assert.equal(await storeVerifiedObject(port, { path: P, bytes: new Uint8Array(bytes), contentType: "application/pdf" }), "reused");
    assert.equal(port.creates, 1, "no se intenta sobrescribir");
  });

  test("objeto existente con OTRO contenido: se aborta y nunca se sobrescribe", async () => {
    const port = new MemPort();
    const original = deterministicBytes(500, 1);
    port.objects.set(P, original);
    await assert.rejects(
      storeVerifiedObject(port, { path: P, bytes: deterministicBytes(500, 2), contentType: "application/pdf" }),
      ObjectConflictError
    );
    assert.equal(port.creates, 0);
    assert.deepEqual(port.objects.get(P), original, "el original sigue intacto");
  });

  test("carrera: otro cliente crea el mismo objeto con el mismo contenido → se acepta", async () => {
    const port = new MemPort();
    const bytes = deterministicBytes(800, 3);
    port.raceCreate = new Uint8Array(bytes);
    assert.equal(await storeVerifiedObject(port, { path: P, bytes, contentType: "application/pdf" }), "reused");
  });

  test("error de creación sin objeto idéntico → se propaga (no se oculta)", async () => {
    const port = new MemPort();
    const failing: VerifiedObjectPort = {
      read: async () => null,
      create: async () => { throw new Error("network down"); },
    };
    await assert.rejects(storeVerifiedObject(failing, { path: P, bytes: new Uint8Array([1]), contentType: "application/pdf" }), /network down/);
  });

  test("verificación posterior fallida (contenido distinto al leer) → error de conflicto", async () => {
    const port = new MemPort();
    port.corruptReadback = true;
    await assert.rejects(
      storeVerifiedObject(port, { path: P, bytes: deterministicBytes(64, 9), contentType: "application/pdf" }),
      ObjectConflictError
    );
  });
});

describe("storageRuleProblem (alineado con storage.rules)", () => {
  test("admite PDF, imágenes y Word; rechaza otros tipos", () => {
    assert.equal(storageRuleProblem({ size: 10, contentType: "application/pdf" }), null);
    assert.equal(storageRuleProblem({ size: 10, contentType: "image/png" }), null);
    assert.equal(storageRuleProblem({ size: 10, contentType: "application/msword" }), null);
    assert.match(storageRuleProblem({ size: 10, contentType: "application/octet-stream" }) ?? "", /tipo no admitido/);
    assert.match(storageRuleProblem({ size: 10, contentType: "" }) ?? "", /sin tipo/);
  });

  test("límite de 10 MB inclusive; por encima se rechaza", () => {
    assert.equal(storageRuleProblem({ size: MAX_ATTACHMENT_BYTES, contentType: "application/pdf" }), null);
    assert.match(storageRuleProblem({ size: MAX_ATTACHMENT_BYTES + 1, contentType: "application/pdf" }) ?? "", /límite/);
  });
});
