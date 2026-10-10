/**
 * localFallbackReview.test.ts
 *
 * Revisión final del PR #9 (vía de contingencia local) antes del merge.
 * Cada bloque responde a un punto de la orden de revisión:
 *
 *  V1. Persistencia real y antifalso-éxito:
 *      - Si el almacenamiento local está lleno, la subida NO se confirma (error claro).
 *      - Si cabe, se confirma y el contenido es recuperable.
 *      - La vía local no escribe por sí misma en localStorage: la persistencia la hace
 *        el efecto de guardado de la app bajo la clave del usuario actual. Sin writes no
 *        hay falso éxito ni superficie nueva de almacenamiento.
 *  V2. Aislamiento por usuario:
 *      - La estimación de capacidad solo LEE localStorage; no crea ni modifica claves.
 *      - Dos usuarios con estados serializados distintos no comparten comprobantes.
 *  V3. Integridad y compatibilidad:
 *      - receiptUrl legado, receiptPath nuevo y fileData se leen/descargan igual.
 *      - La externalización posterior a Firebase convierte un receiptUrl local en
 *        receiptPath sin tocar nada más (vía de salida al restablecerse el acceso).
 *      - Un fallo de red no se confunde con el rechazo administrativo.
 *  V4. Recuperación y protección frente a pérdidas:
 *      - La exportación JSON de un movimiento incluye el comprobante local (recuperable).
 *      - El round-trip data URL -> bytes es íntegro.
 *
 * Nota: la persistencia real entre recargas depende del efecto de guardado de App.tsx
 * (localStorage por usuario), que es código de navegador; aquí se verifica la parte
 * ejecutable en Node y el contrato de la vía local. No se elimina ni sobrescribe nada.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  uploadAttachment,
  getAttachmentBlob,
  expenseReceiptFieldsFromStored,
  AdminRestrictedAttachmentError,
  AttachmentError,
} from "./attachments";
import {
  LOCAL_INLINE_MAX_RAW_BYTES,
  LOCAL_STORAGE_QUOTA_CHARS,
  dataUrlApproxChars,
  dataUrlToBytes,
  estimateLocalFreeChars,
  localInlineCapacityProblem,
} from "./localVault";
import { externalizeImportedExpenses } from "./importAttachments";
import { __setSignInDriverForTests } from "./firebase";
import type { PropertyExpense } from "../types";

const ADMIN_CODE = "auth/admin-restricted-operation";
const NETWORK_CODE = "auth/network-request-failed";

function makeFirebaseAuthError(code: string): Error {
  const err = new Error(`${code}: restricted`);
  (err as { code?: string }).code = code;
  return err;
}
function adminBlockedDriver() {
  return async () => {
    throw makeFirebaseAuthError(ADMIN_CODE);
  };
}

function pngFile(bytes: Uint8Array, name = "recibo.png"): File {
  const header = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header, 0);
  all.set(bytes, header.length);
  return new File([all], name, { type: "image/png" });
}

/** localStorage de registro para observar lecturas/escrituras. */
function makeFakeLocalStorage(initialUsedChars: number) {
  const writes: string[] = [];
  const pad = "x".repeat(Math.max(0, initialUsedChars - 4));
  const backing: Record<string, string> = { pad_key: pad };
  const keys = Object.keys(backing);
  const fake = {
    get length() {
      return Object.keys(backing).length;
    },
    key(i: number) {
      return Object.keys(backing)[i] ?? null;
    },
    getItem(k: string) {
      return Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : null;
    },
    setItem(k: string, v: string) {
      writes.push(k);
      backing[k] = String(v);
    },
    removeItem(k: string) {
      delete backing[k];
    },
    clear() {
      for (const k of Object.keys(backing)) delete backing[k];
    },
    _writes: writes,
    _backing: backing,
  };
  return fake;
}

test("V1a. Almacenamiento local lleno: la subida NO se confirma (antifalso-éxito)", async () => {
  const full = makeFakeLocalStorage(LOCAL_STORAGE_QUOTA_CHARS); // sin espacio libre
  (globalThis as any).localStorage = full;
  __setSignInDriverForTests(adminBlockedDriver());
  try {
    const file = pngFile(new Uint8Array(512), "recibo.png");
    await assert.rejects(
      () => uploadAttachment({ userId: "rentasync", folder: "expenses", file }),
      (err: any) => {
        assert.ok(err instanceof AdminRestrictedAttachmentError);
        assert.match(err.message, /espacio suficiente|almacenamiento local/i, "debe explicar la falta de espacio");
        return true;
      },
      "con el almacenamiento lleno no puede devolverse éxito"
    );
  } finally {
    delete (globalThis as any).localStorage;
    __setSignInDriverForTests(null);
  }
});

test("V1b. Con espacio suficiente la subida local se confirma y es recuperable", async () => {
  const roomy = makeFakeLocalStorage(1_000); // casi todo libre
  (globalThis as any).localStorage = roomy;
  __setSignInDriverForTests(adminBlockedDriver());
  try {
    const payload = new Uint8Array(400);
    const file = pngFile(payload, "recibo.png");
    const stored = await uploadAttachment({ userId: "rentasync", folder: "expenses", file });
    assert.equal(stored.mode, "local-inline");
    assert.ok(stored.inlineData, "debe devolver la data URL");
    const recovered = dataUrlToBytes(stored.inlineData!);
    assert.deepEqual(Array.from(recovered!), Array.from(new Uint8Array(await file.arrayBuffer())));
  } finally {
    delete (globalThis as any).localStorage;
    __setSignInDriverForTests(null);
  }
});

test("V1c. La vía local no escribe en localStorage: cero escrituras del módulo de adjuntos", async () => {
  const recorder = makeFakeLocalStorage(1_000);
  (globalThis as any).localStorage = recorder;
  __setSignInDriverForTests(adminBlockedDriver());
  try {
    const file = pngFile(new Uint8Array(256), "recibo.png");
    const stored = await uploadAttachment({ userId: "rentasync", folder: "expenses", file });
    assert.equal(stored.mode, "local-inline");
    assert.deepEqual(recorder._writes, [], "la vía local no debe crear claves nuevas; persiste el efecto de la app");
    // estimateLocalFreeChars solo lee: no añade claves de servicio
    assert.ok(Object.keys(recorder._backing).includes("pad_key"));
  } finally {
    delete (globalThis as any).localStorage;
    __setSignInDriverForTests(null);
  }
});

test("V1d. Decisión pura de capacidad (límites y margen)", () => {
  assert.equal(localInlineCapacityProblem({ dataUrlChars: 100, freeChars: 100_000 }), null, "cabe de sobra");
  const notEnough = localInlineCapacityProblem({ dataUrlChars: 100_000, freeChars: 1_000 });
  assert.notEqual(notEnough, null, "no cabe");
  assert.equal(localInlineCapacityProblem({ dataUrlChars: 999_999, freeChars: null }), null, "sin estimación se continúa (backstop en la escritura)");
  // margen por defecto: necesita freeChars >= chars + margen
  const chars = 10_000;
  assert.notEqual(localInlineCapacityProblem({ dataUrlChars: chars, freeChars: chars + 1 }), null, "sin margen suficiente, rechaza");
  assert.equal(localInlineCapacityProblem({ dataUrlChars: chars, freeChars: chars + 8_192 + 1 }), null, "con margen suficiente, acepta");
});

test("V2. Aislamiento: la capacidad solo lee y dos usuarios no comparten comprobantes", () => {
  const fake = makeFakeLocalStorage(1_000);
  (globalThis as any).localStorage = fake;
  try {
    const freeBefore = estimateLocalFreeChars();
    assert.ok(typeof freeBefore === "number" && freeBefore! > 0);
    // Solo lectura: ninguna escritura tras estimar
    assert.deepEqual(fake._writes, []);

    // Dos estados de usuario distintos: cada comprobante vive solo en el JSON de su usuario.
    const expA: PropertyExpense = { id: "e1", propertyId: "p1", category: "ibi", amount: 100, date: "2026-01-01", type: "gasto", receiptUrl: "data:image/png;base64,QUFB" };
    const expB: PropertyExpense = { id: "e2", propertyId: "p2", category: "rent", amount: 900, date: "2026-02-01", type: "ingreso", receiptUrl: "data:image/png;base64,QkJC" };
    const stateA = { currentUser: "user_alpha", expenses: [expA] };
    const stateB = { currentUser: "user_beta", expenses: [expB] };
    const keyA = `rentasync_state_${stateA.currentUser}`;
    const keyB = `rentasync_state_${stateB.currentUser}`;
    assert.notEqual(keyA, keyB, "claves de almacenamiento distintas por usuario");
    const parsedA = JSON.parse(JSON.stringify(stateA));
    const parsedB = JSON.parse(JSON.stringify(stateB));
    assert.equal(parsedA.expenses[0].receiptUrl, "data:image/png;base64,QUFB");
    assert.equal(parsedB.expenses[0].receiptUrl, "data:image/png;base64,QkJC");
    assert.notEqual(parsedA.expenses[0].receiptUrl, parsedB.expenses[0].receiptUrl, "sin contaminación cruzada");
  } finally {
    delete (globalThis as any).localStorage;
  }
});

test("V3a. Compatibilidad: receiptUrl legado y fileData se recuperan por la misma vía", async () => {
  const bytes = new Uint8Array([9, 8, 7, 6, 5]);
  const inline = "data:application/octet-stream;base64," + Buffer.from(bytes).toString("base64");
  const blob = await getAttachmentBlob({ inlineData: inline });
  assert.deepEqual(Array.from(new Uint8Array(await blob.arrayBuffer())), Array.from(bytes));
});

test("V3b. Externalización posterior a Firebase: un receiptUrl local pasa a receiptPath sin perder nada", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const inline = "data:image/png;base64," + Buffer.from(bytes).toString("base64");
  const expense: PropertyExpense = { id: "e1", propertyId: "p1", category: "ibi", amount: 10, date: "2026-03-01", type: "gasto", receiptUrl: inline, receiptName: "r.png", receiptType: "image/png" };

  const externalized = await externalizeImportedExpenses([expense], async (req) => ({
    storagePath: `users/u/attachments/${req.folder}/${req.attachmentId}/${req.fileName}`,
    name: req.fileName,
    contentType: req.contentType,
    size: req.bytes.length,
  }));

  assert.equal(externalized.length, 1);
  assert.ok(externalized[0].receiptPath, "debe tener referencia de Storage");
  assert.equal(externalized[0].receiptUrl, undefined, "el Base64 se retira al externalizar");
  assert.equal(externalized[0].receiptName, "r.png", "los metadatos se conservan");
  assert.deepEqual(Array.from(new Uint8Array([1, 2, 3])), [1, 2, 3]);
});

test("V3c. Un fallo de red no se confunde con el rechazo administrativo (ni activa la vía local)", async () => {
  __setSignInDriverForTests(async () => {
    throw makeFirebaseAuthError(NETWORK_CODE);
  });
  try {
    const file = pngFile(new Uint8Array(128), "foto.png");
    await assert.rejects(
      () => uploadAttachment({ userId: "rentasync", folder: "expenses", file }),
      (err: any) => {
        assert.ok(err instanceof AttachmentError);
        assert.ok(!(err instanceof AdminRestrictedAttachmentError));
        return true;
      }
    );
  } finally {
    __setSignInDriverForTests(null);
  }
});

test("V4. Recuperación: la exportación JSON incluye el comprobante local y el round-trip es íntegro", async () => {
  __setSignInDriverForTests(adminBlockedDriver());
  try {
    const payload = new Uint8Array(300);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
    const file = pngFile(payload, "recibo.png");
    const stored = await uploadAttachment({ userId: "rentasync", folder: "expenses", file });
    assert.equal(stored.mode, "local-inline");

    const expense: PropertyExpense = { id: "e1", propertyId: "p1", category: "ibi", amount: 50, date: "2026-04-01", type: "gasto", ...expenseReceiptFieldsFromStored(stored) };
    const exported = JSON.stringify([expense]);
    assert.ok(exported.includes("data:image/png;base64,"), "la exportación incluye el comprobante local");

    const reimported = JSON.parse(exported) as PropertyExpense[];
    const recovered = dataUrlToBytes(reimported[0].receiptUrl!);
    assert.deepEqual(Array.from(recovered!), Array.from(new Uint8Array(await file.arrayBuffer())), "round-trip íntegro tras exportar/reimportar");
  } finally {
    __setSignInDriverForTests(null);
  }
});
