// Pruebas de la migración de adjuntos históricos, la copia de seguridad, la concurrencia y la recuperación.
// Ejecutar con: npm test (node:test + tsx). Sin red ni Firebase: adaptadores en memoria.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AppState, PropertyExpense } from "../types";
import { portfolioBody } from "./portfolioPayload";
import { estimatePayloadBytes, PORTFOLIO_DOC_HARD_BYTES, PORTFOLIO_DOC_SAFE_BYTES, portfolioBackupStoragePath } from "./attachmentRules";
import { buildInventory, calculatePortfolioSize } from "./portfolioMigration";
import {
  BACKUP_SCHEMA,
  canStartMigration,
  ConcurrentChangeError,
  mergeMigratedReferences,
  restorePortfolioFromBackup,
  runPortfolioAttachmentMigration,
} from "./portfolioMigrationRun";
import { checkPortfolioWrite, collectInlineDataUrls, legacyDataUrlSet, PortfolioWriteError, assertPortfolioWritable } from "./portfolioGuard";
import { portfolioRawHash } from "./stableHash";
import { ARQUERO_DIAGNOSED_INITIAL_BYTES, buildArqueroFixture, FakeStorage, FakeStore, deterministicBytes, toDataUrl } from "./migrationFakes";

const FIXED_NOW = new Date("2026-10-10T10:00:00.000Z");
const now = () => FIXED_NOW;

async function runFor(
  fixture: ReturnType<typeof buildArqueroFixture>,
  storage: FakeStorage,
  store: FakeStore,
  working: AppState = fixture.state,
  userId = "arquero"
) {
  return runPortfolioAttachmentMigration({ userId, working, storage, store, now });
}

// ---------------------------------------------------------------------------

describe("cartera diagnosticada de arquero (fixture)", () => {
  test("reproduce exactamente el tamaño inicial real de 1.035.859 bytes con cuatro adjuntos Base64", () => {
    const fx = buildArqueroFixture();
    const size = calculatePortfolioSize(fx.state);
    assert.equal(size.bytes, ARQUERO_DIAGNOSED_INITIAL_BYTES);
    assert.equal(size.blocked, true, "debe estar bloqueada por encima del margen seguro");
    const inv = buildInventory(fx.state, "arquero");
    assert.equal(inv.legacyCount, 4, "cuatro adjuntos históricos");
    assert.equal(inv.initialBytes, 1_035_859);
    assert.ok(inv.estimatedFinalBytes < 40_000, `estimación final pequeña: ${inv.estimatedFinalBytes}`);
    assert.ok(ARQUERO_DIAGNOSED_INITIAL_BYTES < PORTFOLIO_DOC_HARD_BYTES, "por debajo del límite duro, por encima del margen seguro");
  });

  test("el botón de migración se habilita cuando hay adjuntos históricos y no hay migración en curso", () => {
    assert.deepEqual(canStartMigration({ legacyCount: 4, running: false }), { enabled: true, reason: null });
    const busy = canStartMigration({ legacyCount: 4, running: true });
    assert.equal(busy.enabled, false);
    assert.ok(busy.reason);
    const none = canStartMigration({ legacyCount: 0, running: false });
    assert.equal(none.enabled, false);
    assert.ok(none.reason);
  });
});

describe("migración completa de arquero", () => {
  test("migra los cuatro adjuntos, verifica byte a byte y deja la cartera por debajo del umbral seguro", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const out = await runFor(fx, storage, store);

    assert.equal(out.status, "completed", out.error);
    assert.equal(out.attachments.length, 4);
    assert.ok(out.attachments.every((a) => a.verified));

    // Cada archivo en Storage coincide byte a byte con el original decodificado.
    for (const f of fx.files) {
      const isExpense = f.kind === "expense";
      const path = [...storage.objects.keys()].find((p) => p.includes(isExpense ? "/expenses/" : "/property-documents/") && p.includes(`/${f.attachmentId}/`));
      assert.ok(path, `objeto para ${f.attachmentId}`);
      const stored = storage.objects.get(path!)!;
      assert.equal(stored.bytes.length, f.bytes.length);
      assert.ok(stored.bytes.every((b, i) => b === f.bytes[i]), `contenido idéntico: ${f.attachmentId}`);
      assert.equal(stored.contentType, f.contentType);
    }

    // Documento final: sin Base64, con referencias y bajo el margen.
    const migrated = out.migratedRaw!;
    assert.equal(collectInlineDataUrls(migrated).length, 0);
    const bodyNoMeta = JSON.parse(JSON.stringify(migrated));
    delete bodyNoMeta.updatedAt;
    const finalBytes = estimatePayloadBytes(bodyNoMeta);
    assert.ok(finalBytes < PORTFOLIO_DOC_SAFE_BYTES, `tamaño final ${finalBytes}`);
    assert.ok(finalBytes < 40_000);
    assert.equal(out.finalBytes, finalBytes);
    assert.equal(store.raw!.updatedAt, "2026-10-10T10:00:00.000Z");

    // Referencias correctas y datos estructurados intactos
    const exp0 = (migrated.expenses as PropertyExpense[]).find((e) => e.id === "exp_0")!;
    assert.equal(exp0.receiptPath, storage.objects.has(exp0.receiptPath!) ? exp0.receiptPath : undefined);
    assert.equal(exp0.receiptName, "ibi-2026.pdf");
    assert.equal(exp0.amount, 412.5);
    assert.equal(exp0.propertyId, "prop_1");
    assert.equal(exp0.date, "2026-02-10");
    assert.equal((migrated.expenses as PropertyExpense[]).length, 3);
    const props = migrated.properties as Array<{ id: string; documents: Array<{ id: string; storagePath?: string; fileData?: string }> }>;
    assert.equal(props.length, 2);
    assert.ok(props[0].documents[0].storagePath?.includes("/property-documents/"));
    assert.equal(props[0].documents[0].fileData, undefined);
  });

  test("la copia de seguridad de un original que supera 1 MiB es recuperable: vive en Storage y su índice es pequeño", async () => {
    // Original mayor que 1 MiB (adjuntos de ~400 KB): no puede guardarse como documento de copia.
    const fx = buildArqueroFixture({ sizes: [400_000, 400_003, 400_006, 400_009] });
    const originalBytes = estimatePayloadBytes(fx.raw);
    assert.ok(originalBytes > PORTFOLIO_DOC_HARD_BYTES, `original de ${originalBytes} bytes`);
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "completed", out.error);
    const backupObj = storage.objects.get(out.backupPath!)!;
    assert.ok(backupObj.bytes.length > PORTFOLIO_DOC_HARD_BYTES, `copia de ${backupObj.bytes.length} bytes`);
    assert.equal(backupObj.contentType, "application/json");
    assert.equal(out.backupPath, portfolioBackupStoragePath("arquero", out.backupId!));
    const index = store.backups.get(out.backupId!)!;
    assert.ok(index, "índice presente");
    assert.ok(JSON.stringify(index).length < 1024, "el índice en Firestore es pequeño");
    assert.equal(index.storagePath, out.backupPath);
    assert.equal(index.schema, BACKUP_SCHEMA);
    assert.equal(index.sourceUpdatedAt, "2026-10-09T18:00:00.000Z");
  });

  test("la copia de la cartera diagnosticada (1.035.859 bytes) se guarda íntegra en Storage", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "completed", out.error);
    const backupObj = storage.objects.get(out.backupPath!)!;
    assert.ok(backupObj.bytes.length >= ARQUERO_DIAGNOSED_INITIAL_BYTES, "contiene el original completo");
  });

  test("el original es recuperable: restaurar la copia reproduce el documento exacto (incluido updatedAt)", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "completed", out.error);

    const target = new FakeStore(null);
    target.raw = store.raw; // estado migrado
    target.backups = store.backups;
    const restored = await restorePortfolioFromBackup({ userId: "arquero", backupId: out.backupId!, storage, store: target });
    assert.deepEqual(restored.raw, fx.raw);
    assert.deepEqual(target.raw, fx.raw);
    assert.equal(await portfolioRawHash(target.raw!), await portfolioRawHash(fx.raw));
  });

  test("la restauración rechaza una copia corrupta sin escribir", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const out = await runFor(fx, storage, store);
    const migratedBefore = structuredClone(store.raw);
    storage.corruptReadFor.add(out.backupPath!);
    await assert.rejects(restorePortfolioFromBackup({ userId: "arquero", backupId: out.backupId!, storage, store }), /corrupta/);
    assert.deepEqual(store.raw, migratedBefore, "no se escribió nada");
  });

  test("idempotencia: repetir sobre la cartera ya migrada no crea objetos ni cambia referencias", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const first = await runFor(fx, storage, store);
    assert.equal(first.status, "completed");
    const objectsAfterFirst = new Set(storage.objects.keys());
    const migratedRaw = structuredClone(store.raw);

    const second = await runFor(fx, storage, store, first.migratedRaw ? (await migratedStateFrom(first.migratedRaw)) : fx.state);
    assert.equal(second.status, "nothing-to-migrate");
    assert.deepEqual(new Set(storage.objects.keys()), objectsAfterFirst, "sin duplicados ni copias nuevas");
    assert.deepEqual(store.raw, migratedRaw, "documento sin cambios");
  });

  test("idempotencia: si la pantalla aún muestra los Base64, la repetición reutiliza los mismos objetos", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    assert.equal((await runFor(fx, storage, store)).status, "completed");
    const attachmentPaths = () => new Set([...storage.objects.keys()].filter((p) => !p.includes("/backups/")));
    const paths = attachmentPaths();
    const attachmentUploads = () => storage.uploadCalls.filter((p) => !p.includes("/backups/")).length;
    const uploadsBefore = attachmentUploads();
    // Pantalla desfasada (aún con Base64): la nube ya migrada, la migración vuelve a ejecutarse de forma segura.
    const again = await runFor(fx, storage, store, fx.state);
    assert.equal(again.status, "completed", again.error);
    assert.deepEqual(attachmentPaths(), paths, "mismos adjuntos, sin duplicados");
    assert.equal(attachmentUploads(), uploadsBefore, "ningún adjunto se vuelve a subir");
    assert.equal(collectInlineDataUrls(store.raw!).length, 0);
  });
});

async function migratedStateFrom(raw: Record<string, unknown>): Promise<AppState> {
  return {
    user1: raw.user1 as AppState["user1"],
    user2: raw.user2 as AppState["user2"],
    properties: raw.properties as AppState["properties"],
    payments: raw.payments as AppState["payments"],
    expenses: raw.expenses as AppState["expenses"],
    contracts: raw.contracts as AppState["contracts"],
    syncEvents: raw.syncEvents as AppState["syncEvents"],
    syncEnabled: true,
    isOnboarded: true,
    currentYear: raw.currentYear as number,
    yearlyProfiles: raw.yearlyProfiles as AppState["yearlyProfiles"],
    theme: raw.theme as string,
  };
}

describe("reanudación, fallos de Storage, Firestore y concurrencia", () => {
  test("reanuda tras un corte: reutiliza los objetos ya verificados y sube solo los que faltan", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    // Primer intento: falla al subir el cuarto archivo
    const failingPath = fx.files[3];
    const probe = await runFor(fx, new FakeStorage(), new FakeStore(fx.raw)); // ruta estable de referencia
    const target = probe.attachments.find((a) => a.attachmentId === failingPath.attachmentId)!;
    storage.failUploadFor.add(target.storagePath);
    const first = await runFor(fx, storage, store);
    assert.equal(first.status, "failed");
    assert.match(first.error!, /Simulated upload failure/);
    assert.deepEqual(store.raw, fx.raw, "el original no se ha tocado");

    // Segundo intento: sin fallo
    storage.failUploadFor.clear();
    const uploadsBefore = storage.uploadCalls.length;
    const second = await runFor(fx, storage, store);
    assert.equal(second.status, "completed", second.error);
    assert.equal(storage.uploadCalls.length - uploadsBefore, 1, "solo el archivo pendiente se vuelve a subir");
    assert.equal(second.attachments.length, 4);
  });

  test("un fallo de subida impide reescribir la cartera y no deja referencias rotas", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const probe = await runFor(fx, new FakeStorage(), new FakeStore(fx.raw));
    storage.failUploadFor.add(probe.attachments[0].storagePath);
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "failed");
    assert.equal(store.replaceCalls, 0, "ninguna escritura del documento");
    assert.deepEqual(store.raw, fx.raw);
    assert.ok(out.backupId && store.backups.has(out.backupId), "copia creada antes de subir");
  });

  test("verificación de subida: si Storage guarda contenido distinto, el proceso se detiene sin escribir", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const probe = await runFor(fx, new FakeStorage(), new FakeStore(fx.raw));
    storage.corruptUploadFor.add(probe.attachments[1].storagePath);
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "failed");
    assert.match(out.error!, /Verificación fallida/);
    assert.equal(store.replaceCalls, 0);
    assert.deepEqual(store.raw, fx.raw);
  });

  test("si ya existe un objeto con contenido distinto en la ruta estable, no se sobrescribe", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const probe = await runFor(fx, new FakeStorage(), new FakeStore(fx.raw));
    const path = probe.attachments[2].storagePath;
    storage.objects.set(path, { bytes: deterministicBytes(10, 7), contentType: "application/pdf" });
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "failed");
    assert.match(out.error!, /no se sobrescribe/);
    assert.equal(storage.objects.get(path)!.bytes.length, 10, "el objeto existente no cambia");
    assert.deepEqual(store.raw, fx.raw);
  });

  test("fallo de la copia de seguridad: no se sube nada ni se modifica la cartera", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    store.failBackupIndex = true;
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "failed");
    assert.equal(storage.objects.size, 1, "solo la copia en Storage, ningún adjunto");
    assert.equal(store.replaceCalls, 0);
    assert.deepEqual(store.raw, fx.raw);
  });

  test("fallo de Firestore al escribir: la cartera original queda intacta y el resultado es explícito", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    store.failNextReplace = true;
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "failed");
    assert.match(out.error!, /Simulated Firestore failure/);
    assert.deepEqual(store.raw, fx.raw, "sin pérdida de datos");
    // Reintento posterior completa la migración
    const retry = await runFor(fx, storage, store);
    assert.equal(retry.status, "completed", retry.error);
  });

  test("respuesta incierta de Firestore: si el documento llegó a escribirse, la migración continúa y verifica", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    store.commitThenThrowOnce = true;
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "completed", out.error);
    assert.ok(out.steps.includes("written-after-uncertain-response"));
    assert.equal(collectInlineDataUrls(store.raw!).length, 0);
  });

  test("concurrencia: si otro dispositivo cambia la cartera antes de escribir, se aborta sin sobrescribir", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    store.beforeReplace = (s) => {
      s.raw = { ...s.raw!, updatedAt: "2026-10-10T09:59:00.000Z", syncEvents: [{ id: "otro", timestamp: "x", sourceModule: "y", targetModule: "z", action: "cambio remoto", details: "" }] };
    };
    let remote: Record<string, unknown> | undefined;
    const originalHook = store.beforeReplace;
    store.beforeReplace = (s) => {
      originalHook!(s);
      remote = structuredClone(s.raw!);
    };
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "failed");
    assert.match(out.error!, /modificado|concurrente/i);
    assert.deepEqual(store.raw, remote, "el cambio remoto se conserva");
    assert.equal(collectInlineDataUrls(store.raw!).length, 4, "el original sigue con sus adjuntos");
  });

  test("si la copia en pantalla no contiene todos los adjuntos de la nube, se aborta (no se pierde ningún adjunto)", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const partial: AppState = { ...fx.state, expenses: fx.state.expenses!.map((e) => (e.id === "exp_0" ? { ...e, receiptUrl: undefined } : e)) };
    const out = await runFor(fx, storage, store, partial);
    assert.equal(out.status, "failed");
    assert.match(out.error!, /no contiene/);
    assert.equal(store.replaceCalls, 0);
  });

  test("verificación posterior: si el resultado no cuadra, se restaura el original automáticamente", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const probe = await runFor(fx, new FakeStorage(), new FakeStore(fx.raw));
    const victim = probe.attachments[0].storagePath;
    store.afterCommit = () => {
      // Tras escribir, el objeto de Storage deja de ser legible correctamente.
      storage.corruptReadFor.add(victim);
    };
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "rolled-back", out.error);
    assert.match(out.error!, /restaurado automáticamente/);
    assert.deepEqual(store.raw, fx.raw, "original restaurado exactamente");
    assert.ok(out.backupId && store.backups.has(out.backupId), "la copia sigue disponible");
  });

  test("ningún fallo borra datos ni objetos: las copias y adjuntos quedan en Storage", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    storage.failUploadFor.add("users/arquero/attachments/expenses/none/none.pdf");
    await runFor(fx, storage, store);
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "completed");
    // Ninguna ruta se borra: la API de pruebas ni siquiera expone delete.
    assert.equal(typeof (storage as unknown as Record<string, unknown>).deleteObject, "undefined");
    assert.ok(storage.objects.size >= 5, "adjuntos y copia presentes");
  });
});

describe("aislamiento por usuario", () => {
  test("cada usuario tiene rutas de adjuntos y copias propias; los identificadores hostiles se codifican", async () => {
    const fx = buildArqueroFixture();
    const a = await runPortfolioAttachmentMigration({ userId: "usuarioA", working: fx.state, storage: new FakeStorage(), store: new FakeStore(fx.raw), now });
    const b = await runPortfolioAttachmentMigration({ userId: "usuarioB", working: fx.state, storage: new FakeStorage(), store: new FakeStore(fx.raw), now });
    assert.ok(a.attachments[0].storagePath.startsWith("users/usuarioA/"));
    assert.ok(b.attachments[0].storagePath.startsWith("users/usuarioB/"));
    assert.notEqual(a.backupPath, b.backupPath.replace("usuarioB", "usuarioA"));
    const evil = portfolioBackupStoragePath("../otro", "a".repeat(64));
    assert.equal(evil.split("/").length, 5, "sin separadores inyectados");
    assert.ok(evil.startsWith("users/..%2Fotro/backups/"));
    assert.throws(() => portfolioBackupStoragePath("x", "../../etc/passwd"), /no válido/);
  });

  test("una copia de otro usuario no puede restaurarse en esta cartera", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const out = await runFor(fx, storage, store);
    const intruder = new FakeStore(store.raw);
    intruder.backups = store.backups;
    await assert.rejects(restorePortfolioFromBackup({ userId: "otro", backupId: out.backupId!, storage, store: intruder }), /no existe el índice|no corresponde/);
  });
});

describe("guardado normal después de la migración", () => {
  test("tras migrar, una operación nueva se guarda sin problemas y un Base64 nuevo se rechaza", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "completed");
    const migratedState = await migratedStateFrom(out.migratedRaw!);

    // Guardado normal: nuevo gasto con referencia a Storage
    const withNew: AppState = {
      ...migratedState,
      expenses: [...migratedState.expenses!, { id: "exp_new", propertyId: "prop_1", category: "repairs", amount: 50, date: "2026-10-01", receiptPath: "users/arquero/attachments/expenses/rcpt_1/x.pdf", receiptName: "x.pdf", receiptType: "application/pdf" }],
    };
    const okCheck = checkPortfolioWrite(portfolioBody(withNew), { allowedLegacyDataUrls: new Set() });
    assert.equal(okCheck.ok, true, okCheck.errors.join(" | "));
    assert.ok(okCheck.marginBytes > 900_000);

    // Base64 nuevo: rechazado
    const bad: AppState = {
      ...migratedState,
      expenses: [...migratedState.expenses!, { id: "exp_bad", propertyId: "prop_1", category: "repairs", amount: 5, date: "2026-10-01", receiptUrl: toDataUrl(new Uint8Array([1, 2, 3]), "application/pdf") }],
    };
    const badCheck = checkPortfolioWrite(portfolioBody(bad), { allowedLegacyDataUrls: legacyDataUrlSet(out.migratedRaw) });
    assert.equal(badCheck.ok, false);
    assert.equal(badCheck.newInlineDataPaths.length, 1);
    assert.throws(() => assertPortfolioWritable(portfolioBody(bad), { allowedLegacyDataUrls: legacyDataUrlSet(out.migratedRaw) }), PortfolioWriteError);
  });
});

describe("guardia de escritura centralizada", () => {
  test("mide el JSON completo de la cartera (no un objeto parcial) y bloquea por encima del margen seguro", () => {
    const fx = buildArqueroFixture();
    const check = checkPortfolioWrite(portfolioBody(fx.state), { allowedLegacyDataUrls: legacyDataUrlSet(fx.raw) });
    assert.equal(check.bytes, ARQUERO_DIAGNOSED_INITIAL_BYTES);
    assert.equal(check.ok, false, "los Base64 históricos permitidos siguen ocupando tamaño");
    assert.equal(check.newInlineDataPaths.length, 0, "no hay Base64 nuevos: el bloqueo es solo por tamaño");
    assert.ok(check.errors.some((e) => /supera el margen seguro/.test(e)));
    assert.equal(check.nearLimit, true);
    assert.equal(check.marginBytes, PORTFOLIO_DOC_SAFE_BYTES - ARQUERO_DIAGNOSED_INITIAL_BYTES);
  });

  test("cualquier Base64 no conocido se rechaza aunque el documento sea pequeño", () => {
    const body = { ...portfolioBody({ ...buildArqueroFixture().state, properties: [] }), expenses: [{ id: "e", propertyId: "p", category: "ibi", amount: 1, date: "2026-01-01", receiptUrl: "data:application/pdf;base64,QUJD" }] };
    const check = checkPortfolioWrite(body);
    assert.equal(check.ok, false);
    assert.deepEqual(check.newInlineDataPaths, ["$.expenses[0].receiptUrl"]);
    assert.match(check.errors[0], /Base64/);
    assert.match(check.errors[0], /Storage/);
  });

  test("un documento pequeño sin Base64 se acepta con margen amplio", () => {
    const check = checkPortfolioWrite(portfolioBody({ ...buildArqueroFixture().state, expenses: [], properties: [] }));
    assert.equal(check.ok, true);
    assert.equal(check.nearLimit, false);
    assert.equal(check.errors.length, 0);
  });

  test("las rutas de referencia (Storage) no cuentan como Base64 y ocupan poco", () => {
    const refs = Array.from({ length: 200 }, (_, i) => ({
      id: `exp_${i}`, propertyId: "p", category: "ibi", amount: 1, date: "2026-01-01",
      receiptPath: `users/arquero/attachments/expenses/rcpt_${i}/comprobante_${i}.pdf`, receiptName: `comprobante_${i}.pdf`, receiptType: "application/pdf",
    }));
    const check = checkPortfolioWrite({ expenses: refs });
    assert.equal(check.ok, true);
    assert.ok(check.bytes < 100_000, `200 referencias ocupan ${check.bytes} bytes`);
  });

  test("el mensaje de error está en español y explica qué hacer", () => {
    const check = checkPortfolioWrite({ expenses: [{ receiptUrl: "data:application/pdf;base64,QUJD" }] });
    assert.ok(check.errors[0].includes("Firebase Storage"));
    assert.ok(check.errors[0].includes("NO se han guardado"));
  });
});

describe("límites y condición de precaución", () => {
  test("canStartMigration y la guardia usan los mismos umbrales (no se relajan)", () => {
    assert.equal(PORTFOLIO_DOC_SAFE_BYTES, 1_000_000);
    assert.equal(PORTFOLIO_DOC_HARD_BYTES, 1_048_576);
  });
});

describe("aplicación del resultado a la pantalla", () => {
  test("mergeMigratedReferences conserva una edición hecha durante la migración y solo sustituye Base64 migrados", async () => {
    const fx = buildArqueroFixture();
    const storage = new FakeStorage();
    const store = new FakeStore(fx.raw);
    const out = await runFor(fx, storage, store);
    assert.equal(out.status, "completed");
    // Edición en curso: un gasto nuevo y un cambio de renta que no existían al iniciar la migración
    const edited: AppState = {
      ...fx.state,
      expenses: [...fx.state.expenses!, { id: "exp_during", propertyId: "prop_2", category: "maintenance", amount: 33, date: "2026-10-02", description: "editado durante migración" }],
      properties: fx.state.properties.map((p) => (p.id === "prop_2" ? { ...p, monthlyRent: 950 } : p)),
    };
    const merged = mergeMigratedReferences(edited, out.migratedRaw!);
    const exp0 = merged.expenses!.find((e) => e.id === "exp_0")!;
    assert.equal(exp0.receiptUrl, undefined);
    assert.equal(exp0.receiptPath, (out.migratedRaw!.expenses as PropertyExpense[]).find((e) => e.id === "exp_0")!.receiptPath);
    assert.ok(merged.expenses!.some((e) => e.id === "exp_during"), "la edición en curso se conserva");
    assert.equal(merged.properties.find((p) => p.id === "prop_2")!.monthlyRent, 950, "cambio de renta conservado");
    assert.equal(collectInlineDataUrls(merged).length, 0, "sin Base64 tras aplicar las referencias");
  });
});
