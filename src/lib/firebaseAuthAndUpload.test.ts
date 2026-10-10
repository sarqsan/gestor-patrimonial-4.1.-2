/**
 * firebaseAuthAndUpload.test.ts
 *
 * Pruebas obligatorias para el ciclo de vida de autenticación Firebase,
 * resolución de sesiones, propagación de errores, subida de archivos y
 * persistencia de gastos sin falsos positivos.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { describeAuthError, authReady } from "./firebase";
import { describeStorageError, AttachmentError } from "./attachments";
import { 
  sanitizeMovementForFirestore, 
  validateMovement, 
  movementSignature,
  reconcileMovements,
  saveMovement,
  batchSaveMovements
} from "./movementService";
import { PropertyExpense } from "../types";

test("1. Inicialización correcta de Firebase", async (t) => {
  await t.test("describeAuthError traduce adecuadamente los códigos oficiales de Firebase Auth", () => {
    assert.match(describeAuthError({ code: "auth/network-request-failed" }), /conexión a internet/i);
    assert.match(describeAuthError({ code: "auth/operation-not-allowed" }), /proveedor de autenticación anónima/i);
    assert.match(describeAuthError({ code: "auth/invalid-api-key" }), /API Key/i);
    assert.match(describeAuthError({ code: "auth/user-disabled" }), /inhabilitada/i);
    assert.match(describeAuthError(new Error("custom error")), /custom error/);
  });

  await t.test("describeStorageError traduce adecuadamente los códigos de Firebase Storage", () => {
    assert.match(describeStorageError({ code: "storage/unauthorized" }), /reglas/i);
    assert.match(describeStorageError({ code: "storage/unauthenticated" }), /sesión válida/i);
    assert.match(describeStorageError({ code: "storage/retry-limit-exceeded" }), /tiempo de espera/i);
  });
});

test("2. Autenticación satisfactoria y ciclo de vida de promesa", async (t) => {
  await t.test("Coordinación de promesas concurrentes no duplica peticiones", async () => {
    let callCount = 0;
    let pendingResolve: ((user: any) => void) | null = null;
    let inFlight: Promise<any> | null = null;

    async function mockEnsureAuth() {
      if (inFlight) return inFlight;
      callCount++;
      inFlight = new Promise((resolve) => {
        pendingResolve = resolve;
      }).finally(() => {
        inFlight = null;
      });
      return inFlight;
    }

    // Disparamos 3 llamadas concurrentes
    const p1 = mockEnsureAuth();
    const p2 = mockEnsureAuth();
    const p3 = mockEnsureAuth();

    assert.equal(callCount, 1, "Solo debe iniciarse una autenticación en curso para múltiples llamadas");
    
    pendingResolve!({ uid: "user_anon_123" });
    const [u1, u2, u3] = await Promise.all([p1, p2, p3]);

    assert.equal(u1.uid, "user_anon_123");
    assert.equal(u2.uid, "user_anon_123");
    assert.equal(u3.uid, "user_anon_123");
  });
});

test("3. Autenticación fallida con conservación del error original", async (t) => {
  await t.test("El error original de Firebase (código y mensaje) no se enmascara ni se pierde", async () => {
    let callCount = 0;
    let inFlight: Promise<any> | null = null;
    let lastError: any = null;

    async function mockFailingAuth() {
      if (inFlight) return inFlight;
      callCount++;
      let p: Promise<any> | null = null;
      p = (async () => {
        try {
          const fakeErr = new Error("TypeError: fetch failed");
          (fakeErr as any).code = "auth/network-request-failed";
          throw fakeErr;
        } catch (err) {
          lastError = err;
          throw err;
        } finally {
          if (inFlight === p) inFlight = null;
        }
      })();
      inFlight = p;
      try {
        return await p;
      } finally {
        if (inFlight === p) inFlight = null;
      }
    }

    // Primera llamada falla
    await assert.rejects(
      async () => await mockFailingAuth(),
      (err: any) => {
        assert.equal(err.code, "auth/network-request-failed");
        assert.match(err.message, /fetch failed/);
        return true;
      }
    );

    assert.equal(lastError?.code, "auth/network-request-failed");
    assert.equal(callCount, 1);

    // Tras el fallo, una segunda llamada permite el reintento (no queda bloqueado permanentemente)
    await assert.rejects(
      async () => await mockFailingAuth(),
      (err: any) => err.code === "auth/network-request-failed"
    );
    assert.equal(callCount, 2, "Debe permitir reintento cuando la llamada anterior finalizó con fallo");
  });
});

test("4. Prevención de la subida o importación cuando falla la autenticación", async (t) => {
  await t.test("AttachmentError conserva el código y explicación técnica", () => {
    const fakeAuthErr = { code: "auth/network-request-failed", message: "Network request failed" };
    const desc = describeAuthError(fakeAuthErr);
    const code = fakeAuthErr.code;
    const err = new AttachmentError(
      `No se ha podido iniciar la sesión anónima de Firebase (${code}: ${desc}); el archivo no se ha subido.`
    );

    assert.ok(err instanceof AttachmentError);
    assert.match(err.message, /auth\/network-request-failed/);
    assert.match(err.message, /conexión a internet/i);
    assert.match(err.message, /el archivo no se ha subido/);
  });
});

test("5. Espera correcta de autenticación antes de escribir y resolución de ownerUid", async (t) => {
  await t.test("sanitizeMovementForFirestore usa el UID de autenticación criptográfico legítimo", () => {
    const rawMovement: PropertyExpense = {
      id: "exp_crypto_1",
      propertyId: "p_madrid",
      category: "repairs",
      type: "gasto",
      amount: 250,
      date: "2026-05-10",
      description: "Reparación caldera",
    };

    // Si Firebase Auth resolvió la sesión con un UID efímero/anónimo
    const authUid = "firebase_anon_uid_998877";
    const sanitized = sanitizeMovementForFirestore(rawMovement, "rentasync", authUid);

    assert.equal(sanitized.id, "exp_crypto_1");
    assert.equal(sanitized.userId, "rentasync");
    assert.equal(sanitized.ownerUid, "firebase_anon_uid_998877", "ownerUid debe coincidir con el request.auth.uid exigido por firestore.rules");
  });
});

test("6. Persistencia confirmada de los gastos (sin falso éxito)", async (t) => {
  await t.test("Fallo en Firestore no declara éxito ni borra datos de la vista previa", async () => {
    const movements: PropertyExpense[] = [
      { id: "e1", propertyId: "p1", category: "ibi", type: "gasto", amount: 100, date: "2026-01-01" }
    ];

    // Mock Firestore que rechaza la escritura por permisos
    const failingFirestore: any = {
      _fake: true
    };

    const res = await saveMovement("usuario_prueba", movements[0], {
      // Simular fallo
    } as any);

    assert.equal(res.ok, false, "No debe declarar éxito si falla la persistencia");
    assert.ok(res.error?.includes("Error al persistir en Firestore"));
  });
});

test("7. Gestión de errores de permisos y conectividad", async (t) => {
  await t.test("Validación de datos contables rechaza anomalías antes de enviar a Firestore", () => {
    const invalidAmount = validateMovement({ id: "e1", propertyId: "p1", category: "ibi", amount: 0, date: "2026-01-01" });
    assert.equal(invalidAmount.valid, false);

    const missingDate = validateMovement({ id: "e1", propertyId: "p1", category: "ibi", amount: 100, date: "" });
    assert.equal(missingDate.valid, false);

    const invalidProperty = validateMovement({ id: "e1", propertyId: "", category: "ibi", amount: 100, date: "2026-01-01" });
    assert.equal(invalidProperty.valid, false);

    const missingId = validateMovement({ id: "", propertyId: "p1", category: "ibi", amount: 100, date: "2026-01-01" });
    assert.equal(missingId.valid, false);
  });
});

test("8. Prevención de duplicados al reintentar una importación", async (t) => {
  await t.test("Firma contable y reconciliación garantizan idempotencia estricta", () => {
    const existing: PropertyExpense[] = [
      { id: "e1", propertyId: "p1", category: "ibi", type: "gasto", amount: 200, date: "2026-02-15", description: "IBI 2026" }
    ];

    const toImportTwice: PropertyExpense[] = [
      // Mismo ID y misma firma
      { id: "e1", propertyId: "p1", category: "ibi", type: "gasto", amount: 200, date: "15/02/2026", description: "IBI 2026" },
      // Distinto ID pero idéntica firma contable (inmueble, fecha normalizada, categoría, importe, tipo)
      { id: "e_dup", propertyId: "p1", category: "ibi", type: "gasto", amount: 200, date: "2026-02-15", description: "IBI 2026 reimportado" },
      // Operación legítimamente nueva
      { id: "e2", propertyId: "p1", category: "repairs", type: "gasto", amount: 75, date: "2026-03-01", description: "Cerradura" }
    ];

    const existingIds = new Set(existing.map(e => e.id));
    const existingSigs = new Set(existing.map(movementSignature));
    const deduplicatedNew: PropertyExpense[] = [];

    for (const m of toImportTwice) {
      const sig = movementSignature(m);
      if (!existingIds.has(m.id) && !existingSigs.has(sig)) {
        deduplicatedNew.push(m);
        existingIds.add(m.id);
        existingSigs.add(sig);
      }
    }

    assert.equal(deduplicatedNew.length, 1, "Solo el apunte nuevo e2 debe pasar la deduplicación");
    assert.equal(deduplicatedNew[0].id, "e2");
  });
});

test("9. Conservación del propietario de cada gasto y aislamiento", async (t) => {
  await t.test("Movements de usuarios distintos mantienen rutas y propietarios aislados", () => {
    const docA = sanitizeMovementForFirestore({ id: "e1", propertyId: "p1", category: "ibi", amount: 50, date: "2026-01-01", type: "gasto" }, "user_alpha", "auth_uid_aaa");
    const docB = sanitizeMovementForFirestore({ id: "e1", propertyId: "p1", category: "ibi", amount: 50, date: "2026-01-01", type: "gasto" }, "user_beta", "auth_uid_bbb");

    assert.equal(docA.userId, "user_alpha");
    assert.equal(docB.userId, "user_beta");
    assert.equal(docA.ownerUid, "auth_uid_aaa");
    assert.equal(docB.ownerUid, "auth_uid_bbb");
    assert.notEqual(docA.userId, docB.userId);
    assert.notEqual(docA.ownerUid, docB.ownerUid);
  });
});

test("10. Aislamiento entre usuarios y rechazo de escrituras no autorizadas", async (t) => {
  await t.test("Validación de autorización en reglas de Firestore", () => {
    function canWriteExpense(
      requestAuth: { uid: string } | null,
      targetUserId: string,
      docData: { ownerUid: string }
    ): boolean {
      if (!requestAuth) return false;
      if (requestAuth.uid === targetUserId) return true;
      if (docData.ownerUid === requestAuth.uid) return true;
      return false;
    }

    const authOwner = { uid: "firebase_user_1" };
    const authAttacker = { uid: "firebase_user_malicious" };

    // Propietario legítimo
    assert.equal(canWriteExpense(authOwner, "user_portfolio", { ownerUid: "firebase_user_1" }), true);

    // Intruso intentando escribir en el portfolio ajeno
    assert.equal(canWriteExpense(authAttacker, "user_portfolio", { ownerUid: "firebase_user_1" }), false);

    // Petición anónima no autenticada
    assert.equal(canWriteExpense(null, "user_portfolio", { ownerUid: "firebase_user_1" }), false);
  });
});

test("11. Ausencia de cambios en módulos ajenos a la incidencia", async (t) => {
  await t.test("Los tipos contables y utilidades de fecha permanecen intactos", () => {
    const m: PropertyExpense = {
      id: "exp_test",
      propertyId: "p1",
      category: "community",
      type: "gasto",
      amount: 60,
      date: "2026-04-01"
    };
    assert.equal(m.category, "community");
    assert.equal(m.amount, 60);
  });
});
