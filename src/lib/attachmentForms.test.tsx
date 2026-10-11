// Ejecuta los componentes reales y sus handlers (no una simulación de su lógica).
// Renderizador React sin navegador + HTTP fake con hashes auténticos; no proveedor de producción.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act, ReactTestRenderer, ReactTestInstance } from "react-test-renderer";
import Expenses from "../components/Expenses";
import Properties from "../components/Properties";
import { installTestLocalStorage, verifiedVaultFetchFake, syntheticIbiPdf, TEST_PROPERTY, MemoryStorageAttachmentPort } from "./attachmentTestFixtures";
import { storeVaultToken, __resetVaultCapabilitiesCacheForTests } from "./vaultClient";
import { AttachmentError, ATTACHMENT_TIMEOUTS } from "./attachmentErrors";
import { __setStorageAttachmentPortForTests, invalidateFirebaseStorageProbe } from "./attachments";
import { __setSignInDriverForTests } from "./firebase";
import { persistAttachedExpense } from "./attachmentPersistence";
import type { PropertyExpense, Property } from "../types";

const nativeFetch = globalThis.fetch;
let fake: ReturnType<typeof verifiedVaultFetchFake>;
let renderer: ReactTestRenderer;
const alerts: string[] = [];
function nodeText(node: ReactTestInstance): string { return node.children.map((c) => typeof c === "string" ? c : nodeText(c)).join(" "); }
const button = (text: string) => renderer.root.findAllByType("button").find((b) => nodeText(b).includes(text))!;
const pdf = () => new File([syntheticIbiPdf()], "ibi-prueba.pdf", { type: "application/pdf" });

test.beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).alert = (message: string) => { alerts.push(message); };
  alerts.length = 0;
  installTestLocalStorage(); storeVaultToken("prueba", "token_sintetico");
  __resetVaultCapabilitiesCacheForTests();
  fake = verifiedVaultFetchFake(); globalThis.fetch = fake.fetch;
});
test.afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  globalThis.fetch = nativeFetch;
  delete (globalThis as any).localStorage;
  delete (globalThis as any).alert;
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  __resetVaultCapabilitiesCacheForTests();
  __setStorageAttachmentPortForTests(null); __setSignInDriverForTests(null); invalidateFirebaseStorageProbe();
});

async function openExpenseForm(save: (m: PropertyExpense) => void | Promise<void>) {
  await act(() => { renderer = create(<Expenses properties={[TEST_PROPERTY]} expenses={[]} currentUser="prueba" user1Name="PRUEBA"
    onAddExpense={save} onDeleteExpense={() => {}} />); });
  await act(() => button("Registrar Transacción").props.onClick());
  await act(() => {
    const form = renderer.root.findByType("form");
    form.findAllByType("input").find((n) => n.props.inputMode === "decimal")!.props.onChange({ target: { value: "123,45" } });
    form.findAllByType("input").find((n) => String(n.props.placeholder).includes("Ej. Factura"))!.props.onChange({ target: { value: "IBI SINTETICO" } });
    form.findAllByType("select").find((n) => n.props.value === "repairs")!.props.onChange({ target: { value: "ibi" } });
    form.findAllByType("input").find((n) => n.props.type === "date")!.props.onChange({ target: { value: "2026-10-11" } });
    form.findAllByType("input").find((n) => n.props.type === "file")!.props.onChange({ target: { files: [pdf()], value: "" } });
  });
}
const submit = () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
function assertDraftRetained() {
  const form = renderer.root.findByType("form");
  assert.equal(form.findAllByType("input").find((n) => n.props.inputMode === "decimal")!.props.value, "123,45");
  assert.equal(form.findAllByType("input").find((n) => String(n.props.placeholder).includes("Ej. Factura"))!.props.value, "IBI SINTETICO");
  assert.equal(form.findAllByType("select").find((n) => n.props.value === "ibi")!.props.value, "ibi");
  assert.equal(form.findAllByType("input").find((n) => n.props.type === "date")!.props.value, "2026-10-11");
  assert.ok(nodeText(form).includes("ibi-prueba.pdf"));
}

test("UI1. Upload rechazado conserva archivo, importe, fecha, inmueble y concepto; permite reintento con el mismo ID", async () => {
  const operations: PropertyExpense[] = [];
  await openExpenseForm((m) => { operations.push(m); });
  let uploads = 0;
  const requests: any[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/vault?op=files.upload") {
      requests.push(JSON.parse(String(init!.body)));
      if (++uploads === 1) return Response.json({ error: "Sin permiso" }, { status: 403 });
    }
    return fake.fetch(input, init);
  };
  await act(async () => { await submit(); });
  assertDraftRetained();
  assert.equal(operations.length, 0);
  assert.ok(nodeText(renderer.root).includes("vault/http-403"));
  await act(async () => { await submit(); });
  assert.equal(requests[0].id, requests[1].id);
  assert.equal(requests[0].movementId, requests[1].movementId);
  assert.equal(requests[1].propertyId, TEST_PROPERTY.id);
  assert.equal(operations.length, 1);
  assert.equal(renderer.root.findAllByType("form").length, 0);
});

test("UI2. Asociación/persistencia fallida no cierra formulario; el reintento no vuelve a subir ni duplica operación", async () => {
  const operations: PropertyExpense[] = [];
  let first = true;
  await openExpenseForm(async (m) => {
    operations.push(m);
    if (first) { first = false; throw new AttachmentError("Fallo de persistencia de prueba", { phase: "persistence", code: "permission-denied" }); }
  });
  await act(async () => { await submit(); });
  assertDraftRetained();
  assert.equal(renderer.root.findByType("fieldset").props.disabled, false);
  await act(async () => { await submit(); });
  assert.equal(operations[0].id, operations[1].id);
  assert.equal(operations[0].receiptVaultId, operations[1].receiptVaultId);
  assert.equal(fake.calls.filter((c) => c.url === "/api/vault?op=files.upload").length, 1);
  assert.equal(renderer.root.findAllByType("form").length, 0);
});

test("UI3. Mientras no haya confirmación remota, formulario bloqueado; doble submit no duplica", async () => {
  let resolve!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => { started = r; });
  let saves = 0;
  await openExpenseForm(async () => { saves++; started(); await new Promise<void>((r) => { resolve = r; }); });
  let pending!: Promise<void>;
  await act(async () => {
    pending = submit();
    await ready;
    await submit();
  });
  assert.equal(renderer.root.findByType("fieldset").props.disabled, true);
  assertDraftRetained();
  assert.equal(saves, 1);
  await act(async () => { resolve(); await pending; });
  assert.equal(renderer.root.findAllByType("form").length, 0);
  assert.equal(fake.files.size, 1);
});

test("UI4. Adjuntar desde tabla conserva File y muestra reintento cuando falla la asociación", async () => {
  const expense: PropertyExpense = { id: "mov_tabla", propertyId: TEST_PROPERTY.id, category: "ibi", type: "gasto", amount: 1, date: "2026-10-11" };
  const patches: Array<Partial<PropertyExpense>> = [];
  let first = true;
  await act(() => { renderer = create(<Expenses properties={[TEST_PROPERTY]} expenses={[expense]} currentUser="prueba" user1Name="PRUEBA"
    onAddExpense={() => {}} onDeleteExpense={() => {}} onUpdateExpenseReceipt={async (_id, patch) => {
      patches.push(patch); if (first) { first = false; throw new Error("No se confirmó la asociación"); }
    }} />); });
  const input = renderer.root.findAllByType("input").find((n) => n.props.type === "file")!;
  await act(async () => { await input.props.onChange({ target: { files: [pdf()], value: "" } }); });
  assert.ok(button("Reintentar adjunto"));
  assert.ok(nodeText(renderer.root).includes("ibi-prueba.pdf"));
  await act(async () => { await button("Reintentar adjunto").props.onClick(); });
  assert.equal(patches.length, 2);
  assert.equal(patches[0].receiptVaultId, patches[1].receiptVaultId);
  assert.equal(fake.calls.filter((c) => c.url === "/api/vault?op=files.upload").length, 1);
  const meta = [...fake.files.values()][0].meta;
  assert.equal(meta.movementId, expense.id);
  assert.equal(meta.propertyId, expense.propertyId);
});

test("UI5. Documento de inmueble falla sin perder selección; reintento conserva ID y espera la persistencia", async () => {
  const writes: Property[] = [];
  let first = true;
  await act(() => { renderer = create(<Properties currentUser="prueba" properties={[TEST_PROPERTY]} user1Name="PRUEBA" user2Name="" hasPartner={false}
    onAddProperty={() => {}} onDeleteProperty={() => {}} onDeleteExpense={() => {}}
    onEditProperty={async (p, refs) => { writes.push(p); assert.equal(refs![0].propertyId, TEST_PROPERTY.id); if (first) { first = false; throw new Error("Fallo de asociación de prueba"); } }} />); });
  await act(() => button("Recibos/Docs").props.onClick());
  const input = renderer.root.findAllByType("input").find((n) => n.props.type === "file")!;
  await act(() => input.props.onChange({ target: { files: [pdf()], value: "" } }));
  assert.ok(nodeText(renderer.root).includes("pendiente de guardar"), "seleccionar no declara éxito de subida");
  await act(async () => { await button("Integrar Documento").props.onClick(); });
  assert.ok(nodeText(renderer.root).includes("Fallo de asociación de prueba"));
  assert.ok(nodeText(renderer.root).includes("ibi-prueba.pdf"));
  assert.equal(alerts.length, 0, "no hay alerta de éxito si falló la confirmación");
  await act(async () => { await button("Integrar Documento").props.onClick(); });
  assert.equal(writes[0].documents![0].id, writes[1].documents![0].id);
  assert.equal(writes[0].documents![0].vaultId, writes[1].documents![0].vaultId);
  assert.equal(fake.calls.filter((c) => c.url === "/api/vault?op=files.upload").length, 1);
  assert.equal(alerts.length, 1);
});

test("UI6. Timeout real del servicio de persistencia no anuncia éxito ni borra formulario/File; reintento seguro", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started!: () => void;
  const ready = new Promise<void>((r) => { started = r; });
  let signal!: AbortSignal;
  let lose = true;
  const requests: any[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("/api/vault?op=movimientos.save")) {
      const movement = JSON.parse(String(init!.body)).movement;
      requests.push(movement);
      if (lose) {
        lose = false; signal = init!.signal!; started();
        return new Promise<Response>((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return Response.json({ ok: true, storageOk: true, movement });
    }
    return fake.fetch(input, init);
  };
  await openExpenseForm(async (m) => { await persistAttachedExpense("prueba", m); });
  let pending!: Promise<void>;
  await act(async () => { pending = submit(); await ready; });
  assertDraftRetained();
  assert.equal(renderer.root.findByType("fieldset").props.disabled, true);
  await act(async () => { t.mock.timers.tick(ATTACHMENT_TIMEOUTS.persistence); await pending; });
  assert.equal(signal.aborted, true);
  assertDraftRetained();
  assert.ok(nodeText(renderer.root).includes("tiempo de espera en guardado de la operación"));
  await act(async () => { await submit(); });
  assert.equal(requests[0].id, requests[1].id);
  assert.equal(requests[0].receiptVaultId, requests[1].receiptVaultId);
  assert.equal(fake.calls.filter((c) => c.url === "/api/vault?op=files.upload").length, 1);
  assert.equal(renderer.root.findAllByType("form").length, 0);
});


for (const mode of ["vault", "storage"] as const) {
  test(`UI7.${mode}. PDF del inmueble: reintento conserva archivo y nueva referencia sin revivir la del proveedor anterior`, async () => {
    const old = { startDate: "2026-01-01", endDate: "2027-01-01", monthlyRent: 10, pdfName: "viejo.pdf", pdfSize: "1 KB",
      pdfPath: "users/prueba/attachments/contracts/viejo/viejo.pdf", pdfVaultId: "file_viejo" };
    const property = { ...TEST_PROPERTY, monthlyRent: 10, tenantName: "SINTETICO", tenantDni: "SINTETICO", contract: old,
      tenantHistory: [{ ...old, id: "rec_previo", tenantName: "SINTETICO", tenantDni: "SINTETICO" }] };
    const writes: Property[] = [];
    let fail = true;
    const storagePort = new MemoryStorageAttachmentPort();
    if (mode === "storage") {
      __setStorageAttachmentPortForTests(storagePort);
      __setSignInDriverForTests(async () => ({ user: { uid: "uid_prueba" } as any }));
      globalThis.fetch = async (input, init) => String(input) === "/api/vault?op=health"
        ? Response.json({ storageOk: false, durable: true, driver: "vercel-blob", directUpload: false }) : fake.fetch(input, init);
    }
    await act(() => { renderer = create(<Properties currentUser="prueba" properties={[property]} user1Name="PRUEBA" user2Name="" hasPartner={false}
      onAddProperty={() => {}} onDeleteProperty={() => {}} onDeleteExpense={() => {}}
      onEditProperty={async (p, refs) => { writes.push(p); assert.equal(refs![0].propertyId, property.id); if (fail) { fail = false; throw new Error("No confirmado"); } }} />); });
    await act(() => button("Contrato 📄").props.onClick());
    const input = renderer.root.findAllByType("input").find((n) => n.props.type === "file")!;
    await act(() => input.props.onChange({ target: { files: [pdf()], value: "" } }));
    await act(async () => { await button("Guardar Contrato").props.onClick(); });
    assert.ok(nodeText(renderer.root).includes("No confirmado"));
    assert.equal(alerts.length, 0);
    assert.ok(nodeText(renderer.root).includes("ibi-prueba.pdf"));
    await act(async () => { await button("Guardar Contrato").props.onClick(); });
    const a = writes[0], b = writes[1];
    assert.equal(a.monthlyRent, property.monthlyRent);
    assert.equal(a.tenantHistory![0].id, property.tenantHistory[0].id);
    assert.equal(a.contract!.pdfPath, b.contract!.pdfPath);
    assert.equal(a.contract!.pdfVaultId, b.contract!.pdfVaultId);
    assert.equal(a.contract!.pdfPath, a.tenantHistory![0].pdfPath);
    assert.equal(a.contract!.pdfVaultId, a.tenantHistory![0].pdfVaultId);
    assert.notEqual(a.contract!.pdfVaultId, "file_viejo");
    assert.notEqual(a.contract!.pdfPath, old.pdfPath);
    if (mode === "vault") { assert.ok(a.contract!.pdfVaultId); assert.equal(a.contract!.pdfPath, undefined); assert.equal(fake.files.size, 1); }
    else { assert.ok(a.contract!.pdfPath); assert.equal(a.contract!.pdfVaultId, undefined); assert.equal(storagePort.creates.length, 1); }
    assert.equal(alerts.length, 1);
  });
}
