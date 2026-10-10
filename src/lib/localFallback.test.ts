/**
 * localFallback.test.ts
 *
 * Pruebas de la vía de contingencia local para adjuntos cuando el proyecto Firebase
 * bloquea la sesión con auth/admin-restricted-operation.
 *
 * La vía local guarda el contenido como data URL (formato LEGADO de la aplicación,
 * soportado por visor, descarga, exportación y reconciliación) dentro de la copia
 * local del usuario, sin tocar Firebase, sin cambiar reglas y sin reasignar datos.
 *
 * Cobertura:
 *   L1. Con bloqueo administrativo, un comprobante de gasto se guarda en modo
 *       local-inline y el contenido es recuperable byte a byte.
 *   L2. Documentos de inmueble también usan la vía local (carpeta property-documents).
 *   L3. Los contratos NO usan la vía local (no tienen campo legado equivalente):
 *       se comunican con el error administrativo, sin falso éxito.
 *   L4. Un archivo que excede el presupuesto local y no es comprimible (PDF) se
 *       rechaza con mensaje claro: sin falso éxito ni escritura parcial.
 *   L5. Un fallo de red NO activa la vía local (solo el rechazo administrativo la
 *       activa): se evita la bifurcación de datos por fallos transitorios.
 *   L6. expenseReceiptFieldsFromStored escribe los campos correctos por modo,
 *       sin mezclar receiptPath y receiptUrl.
 *   L7. Helpers puros de presupuesto y data URL (límites inclusive/exclusive).
 *   L8. La recuperación del adjunto local funciona por la misma vía que los
 *       adjuntos históricos (getAttachmentBlob con inlineData).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  uploadAttachment,
  getAttachmentBlob,
  AttachmentError,
  AdminRestrictedAttachmentError,
  expenseReceiptFieldsFromStored,
  StoredAttachment,
} from "./attachments";
import {
  LOCAL_INLINE_MAX_RAW_BYTES,
  blobToDataUrl,
  dataUrlApproxChars,
  dataUrlToBytes,
  localInlineBudgetProblem,
} from "./localVault";
import { __setSignInDriverForTests } from "./firebase";

const ADMIN_CODE = "auth/admin-restricted-operation";
const NETWORK_CODE = "auth/network-request-failed";

function makeFirebaseAuthError(code: string, message: string): Error {
  const err = new Error(`${code}: ${message}`);
  (err as { code?: string }).code = code;
  return err;
}

function adminBlockedDriver() {
  return async () => {
    throw makeFirebaseAuthError(ADMIN_CODE, "This operation is restricted to administrators only.");
  };
}

/** PNG mínimo válido + bytes de relleno controlados. */
function pngFile(bytes: Uint8Array, name = "comprobante.png"): File {
  const header = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header, 0);
  all.set(bytes, header.length);
  return new File([all], name, { type: "image/png" });
}

function pdfFile(size: number, name = "factura.pdf"): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  return new File([bytes], name, { type: "application/pdf" });
}

test("L1. Con bloqueo administrativo, el comprobante se guarda en la vía local y es recuperable byte a byte", async () => {
  __setSignInDriverForTests(adminBlockedDriver());
  try {
    const payload = new Uint8Array(2048);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) % 256;
    const file = pngFile(payload, "recibo_ibi.png");

    const stored = await uploadAttachment({ userId: "rentasync", folder: "expenses", file });

    assert.equal(stored.mode, "local-inline", "debe activarse la vía local");
    assert.equal(stored.storagePath, undefined, "no puede inventarse una ruta de Storage");
    assert.ok(stored.inlineData?.startsWith("data:image/png;base64,"), "data URL del tipo correcto");
    assert.equal(stored.name, "recibo_ibi.png");
    assert.equal(stored.contentType, "image/png");

    // Recuperación byte a byte (misma vía que los adjuntos históricos).
    const roundTrip = dataUrlToBytes(stored.inlineData!);
    assert.ok(roundTrip, "la data URL debe ser válida y decodificable");
    assert.deepEqual(Array.from(roundTrip!), Array.from(new Uint8Array(await file.arrayBuffer())), "el contenido debe conservarse íntegro");
  } finally {
    __setSignInDriverForTests(null);
  }
});

test("L2. Los documentos de inmueble también usan la vía local", async () => {
  __setSignInDriverForTests(adminBlockedDriver());
  try {
    const file = pdfFile(50_000, "escritura.pdf");
    const stored = await uploadAttachment({ userId: "rentasync", folder: "property-documents", file });
    assert.equal(stored.mode, "local-inline");
    assert.ok(stored.inlineData?.startsWith("data:application/pdf;base64,"));
    assert.equal(stored.size, 50_000);
  } finally {
    __setSignInDriverForTests(null);
  }
});

test("L3. Los contratos NO usan la vía local: se comunican con el error administrativo", async () => {
  __setSignInDriverForTests(adminBlockedDriver());
  try {
    const file = new File([new Uint8Array(1024)], "contrato.doc", { type: "application/msword" });
    await assert.rejects(
      () => uploadAttachment({ userId: "rentasync", folder: "contracts", file, allowWordDocument: true }),
      (err: any) => {
        assert.ok(err instanceof AdminRestrictedAttachmentError, "debe clasificarse como restricción administrativa");
        assert.match(err.message, new RegExp(ADMIN_CODE.replace("/", "\\/")));
        return true;
      }
    );
  } finally {
    __setSignInDriverForTests(null);
  }
});

test("L4. Archivo grande no comprimible: rechazo claro, sin falso éxito", async () => {
  __setSignInDriverForTests(adminBlockedDriver());
  try {
    const file = pdfFile(LOCAL_INLINE_MAX_RAW_BYTES + 1, "informe_grande.pdf");
    await assert.rejects(
      () => uploadAttachment({ userId: "rentasync", folder: "expenses", file }),
      (err: any) => {
        assert.ok(err instanceof AdminRestrictedAttachmentError);
        assert.match(err.message, /presupuesto local/i, "debe explicar el límite de la vía local");
        return true;
      }
    );
  } finally {
    __setSignInDriverForTests(null);
  }
});

test("L5. Un fallo de red NO activa la vía local (evita bifurcar datos por fallo transitorio)", async () => {
  __setSignInDriverForTests(async () => {
    throw makeFirebaseAuthError(NETWORK_CODE, "Network request failed");
  });
  try {
    const file = pngFile(new Uint8Array(512), "foto.png");
    await assert.rejects(
      () => uploadAttachment({ userId: "rentasync", folder: "expenses", file }),
      (err: any) => {
        assert.ok(err instanceof AttachmentError);
        assert.ok(!(err instanceof AdminRestrictedAttachmentError), "un fallo de red no es una restricción administrativa");
        return true;
      }
    );
  } finally {
    __setSignInDriverForTests(null);
  }
});

test("L6. expenseReceiptFieldsFromStored escribe campos correctos por modo y sin mezclar", () => {
  const local: StoredAttachment = {
    mode: "local-inline",
    inlineData: "data:image/png;base64,QUJD",
    name: "a.png",
    contentType: "image/png",
    size: 3,
  };
  const cloud: StoredAttachment = {
    mode: "storage",
    storagePath: "users/u/attachments/expenses/id/a.png",
    name: "a.png",
    contentType: "image/png",
    size: 3,
  };

  const localFields = expenseReceiptFieldsFromStored(local);
  assert.equal(localFields.receiptUrl, local.inlineData, "modo local escribe receiptUrl (campo legado)");
  assert.equal(localFields.receiptPath, undefined, "modo local no escribe receiptPath");
  assert.equal(localFields.receiptName, "a.png");

  const cloudFields = expenseReceiptFieldsFromStored(cloud);
  assert.equal(cloudFields.receiptPath, cloud.storagePath, "modo Storage escribe receiptPath");
  assert.equal(cloudFields.receiptUrl, undefined, "modo Storage no escribe receiptUrl");
});

test("L7. Helpers de presupuesto y data URL (límites y tamaño)", () => {
  assert.equal(localInlineBudgetProblem({ size: LOCAL_INLINE_MAX_RAW_BYTES }), null, "el límite es inclusive");
  assert.notEqual(localInlineBudgetProblem({ size: LOCAL_INLINE_MAX_RAW_BYTES + 1 }), null);
  assert.notEqual(localInlineBudgetProblem({ size: 0 }), null, "vacío se rechaza");

  // Redondeo base64: 3 bytes -> 4 chars; cabecera ~22 chars.
  assert.equal(dataUrlApproxChars(3), 22 + 4);
  assert.equal(dataUrlApproxChars(0), 22);

  const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
  return blobToDataUrl(new Blob([bytes], { type: "application/octet-stream" })).then((url) => {
    const decoded = dataUrlToBytes(url);
    assert.deepEqual(Array.from(decoded!), Array.from(bytes), "round-trip de bytes arbitrarios");
  });
});

test("L8. La recuperación del adjunto local usa la misma vía que los históricos (getAttachmentBlob)", async () => {
  __setSignInDriverForTests(adminBlockedDriver());
  try {
    const payload = new Uint8Array(777);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13) % 256;
    const file = pngFile(payload, "recibo.png");

    const stored = await uploadAttachment({ userId: "rentasync", folder: "expenses", file });
    assert.equal(stored.mode, "local-inline");

    const blob = await getAttachmentBlob({ inlineData: stored.inlineData });
    const recovered = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual(Array.from(recovered), Array.from(new Uint8Array(await file.arrayBuffer())), "descarga íntegra por la vía histórica");
  } finally {
    __setSignInDriverForTests(null);
  }
});
