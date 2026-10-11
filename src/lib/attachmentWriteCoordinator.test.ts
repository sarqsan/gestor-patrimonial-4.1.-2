import test from "node:test";
import assert from "node:assert/strict";
import { AttachmentWriteCoordinator } from "./attachmentWriteCoordinator";
import { attachmentPhase } from "./attachmentErrors";
function gate() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

test("Q1. La escritura ya iniciada acaba antes del commit del adjunto; snapshots viejos no se ejecutan", async () => {
  const queue = new AttachmentWriteCoordinator();
  const wait = gate(), started = gate();
  const order: string[] = [];
  const before = queue.capture("cuenta");
  const active = queue.snapshot("cuenta", before, async () => { order.push("cartera-inicio"); started.resolve(); await wait.promise; order.push("cartera-fin"); });
  await started.promise;
  const attached = queue.attachment("cuenta", async () => { order.push("adjunto-confirmado"); });
  const stale = queue.snapshot("cuenta", before, async () => { order.push("OBSOLETO"); });
  const during = queue.snapshot("cuenta", queue.capture("cuenta"), async () => { order.push("OBSOLETO-DURANTE"); });
  wait.resolve();
  assert.equal(await active, true);
  await attached;
  assert.equal(await stale, false);
  assert.equal(await during, false);
  assert.deepEqual(order, ["cartera-inicio", "cartera-fin", "adjunto-confirmado"]);
});

test("Q2. El estado actualizado después del commit se sincroniza normalmente", async () => {
  const queue = new AttachmentWriteCoordinator();
  let writes = 0;
  await queue.attachment("cuenta", async () => { writes++; });
  assert.equal(await queue.snapshot("cuenta", queue.capture("cuenta"), async () => { writes++; }), true);
  assert.equal(writes, 2);
});

test("Q3. Un error original se propaga, sin bloquear el reintento ni otras cuentas", async () => {
  const queue = new AttachmentWriteCoordinator(), wait = gate();
  const blocked = queue.snapshot("a", queue.capture("a"), () => wait.promise);
  assert.equal(await queue.snapshot("b", queue.capture("b"), async () => {}), true);
  wait.resolve(); await blocked;
  const original = Object.assign(new Error("permission denied"), { code: "permission-denied" });
  await assert.rejects(() => queue.attachment("a", async () => { throw original; }), (e) => e === original);
  assert.equal(await queue.attachment("a", async () => "confirmado"), "confirmado");
});

test("Q4. Timeout mientras espera la cola conserva el rechazo; no hace una escritura tardía", async () => {
  const queue = new AttachmentWriteCoordinator(), wait = gate(), started = gate();
  const active = queue.snapshot("a", 0, async () => { started.resolve(); await wait.promise; });
  await started.promise;
  let writes = 0;
  await assert.rejects(() => attachmentPhase("persistence", "vault", 10, (signal) => queue.attachment("a", async () => { writes++; }, signal)),
    (e: any) => e.code === "attachment/timeout" && e.phase === "persistence");
  const capturedWhileWaiting = queue.capture("a");
  wait.resolve(); await active;
  assert.equal(await queue.snapshot("a", capturedWhileWaiting, async () => {}), false, "también invalida las copias creadas mientras esperaba");
  assert.equal(writes, 0);
  assert.equal(await queue.snapshot("a", queue.capture("a"), async () => {}), true);
});

test("Q5. Copia pendiente que queda invalidada no borra asociaciones tras un commit fallido", async () => {
  const queue = new AttachmentWriteCoordinator();
  const before = queue.capture("a");
  const failure = queue.attachment("a", async () => { throw new Error("respuesta perdida: guardado sin confirmar"); });
  let bulkWrites = 0;
  const stale = queue.snapshot("a", before, async () => { bulkWrites++; });
  await assert.rejects(() => failure);
  assert.equal(await stale, false);
  assert.equal(bulkWrites, 0);
});
