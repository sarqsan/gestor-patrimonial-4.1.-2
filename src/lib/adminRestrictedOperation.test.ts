/**
 * adminRestrictedOperation.test.ts
 *
 * Pruebas de la incidencia de producción `auth/admin-restricted-operation`.
 *
 * El backend de Firebase Identity Platform responde ADMIN_ONLY_OPERATION y el SDK
 * lo traduce al código `auth/admin-restricted-operation` ("This operation is
 * restricted to administrators only."). Ese rechazo es una restricción
 * administrativa del proyecto Firebase: NO es un fallo transitorio de red y
 * ningún reintento de cliente puede resolverlo.
 *
 * Estas pruebas reproducen el rechazo de forma determinista mediante el punto de
 * inyección __setSignInDriverForTests (sin red y sin tocar el proyecto real) y
 * demuestran que:
 *   1. El error original (código y mensaje) se propaga sin enmascararse.
 *   2. El cliente NO lo clasifica ni lo comunica como fallo transitorio de red.
 *   3. La subida del archivo se cancela ANTES de intentar el upload a Storage,
 *      con un mensaje que identifica la restricción administrativa.
 *   4. No se generan tormentas de reintentos automáticos ni bloqueos permanentes.
 *   5. Por contraste, un fallo de red real sigue clasificándose como transitorio.
 *
 * Nota: estas pruebas son simuladas a propósito (el entorno de integración no
 * puede alcanzar el servicio Firebase real). NO certifican que la incidencia esté
 * resuelta en producción; eso exige el cambio administrativo descrito en
 * docs/incidencia-auth-admin-restricted-operation.md.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureFirebaseAuth,
  getLastAuthError,
  describeAuthError,
  classifyAuthError,
  isAdministrativeAuthError,
  isTransientNetworkAuthError,
  __setSignInDriverForTests,
  auth,
} from "./firebase";
import { ensureFirebaseSession, uploadAttachment, AttachmentError } from "./attachments";

const ADMIN_CODE = "auth/admin-restricted-operation";
const NETWORK_CODE = "auth/network-request-failed";

/** Mensaje exacto que el SDK de Firebase (v12) asigna al rechazo ADMIN_ONLY_OPERATION del backend. */
const ADMIN_SERVER_MESSAGE = "This operation is restricted to administrators only.";

/** Construye un error con la misma forma que produce el SDK de Firebase Auth. */
function makeFirebaseAuthError(code: string, message: string): Error {
  const err = new Error(`${code}: ${message}`);
  (err as { code?: string }).code = code;
  (err as { name: string }).name = "FirebaseError";
  return err;
}

/** Driver que reproduce el rechazo administrativo real notificado en la incidencia. */
function adminRestrictedDriver() {
  const calls = { count: 0 };
  const driver = async () => {
    calls.count += 1;
    throw makeFirebaseAuthError(ADMIN_CODE, ADMIN_SERVER_MESSAGE);
  };
  return { driver, calls };
}

test("R1. El rechazo administrativo se propaga con su código y mensaje originales", async (t) => {
  const { driver, calls } = adminRestrictedDriver();
  __setSignInDriverForTests(driver);
  try {
    await t.test("ensureFirebaseAuth rechaza con auth/admin-restricted-operation intacto", async () => {
      assert.equal(auth.currentUser, null, "precondición: sin sesión local en el entorno de prueba");
      await assert.rejects(
        () => ensureFirebaseAuth(),
        (err: any) => {
          assert.equal(err.code, ADMIN_CODE, "el código del servicio no puede perderse ni traducirse");
          assert.match(err.message, /restricted to administrators/i, "el mensaje del servicio se conserva");
          return true;
        }
      );
      assert.equal(calls.count, 1, "una única llamada al servicio por intento explícito");
    });

    await t.test("getLastAuthError conserva el error original para diagnóstico", () => {
      const last = getLastAuthError();
      assert.ok(last, "el último fallo debe quedar registrado");
      assert.equal((last as any)?.code, ADMIN_CODE);
    });

    await t.test("no queda bloqueado permanentemente: el reintento explícito vuelve a consultar al servicio", async () => {
      await assert.rejects(() => ensureFirebaseAuth(), (err: any) => err.code === ADMIN_CODE);
      await assert.rejects(() => ensureFirebaseAuth(), (err: any) => err.code === ADMIN_CODE);
      assert.equal(calls.count, 3, "cada intento explícito consulta una vez; sin tormentas ni bloqueos");
    });
  } finally {
    __setSignInDriverForTests(null);
  }
});

test("R2. Llamadas concurrentes comparten una única petición en vuelo incluso bajo rechazo administrativo", async () => {
  const { driver, calls } = adminRestrictedDriver();
  __setSignInDriverForTests(driver);
  try {
    const results = await Promise.allSettled([ensureFirebaseAuth(), ensureFirebaseAuth(), ensureFirebaseAuth()]);
    for (const r of results) {
      assert.equal(r.status, "rejected");
      if (r.status === "rejected") {
        assert.equal((r.reason as any)?.code, ADMIN_CODE);
      }
    }
    assert.equal(calls.count, 1, "las llamadas concurrentes no deben duplicar peticiones al servicio");
  } finally {
    __setSignInDriverForTests(null);
  }
});

test("R3. Clasificación: el rechazo administrativo NO es un fallo transitorio de red", () => {
  const adminErr = makeFirebaseAuthError(ADMIN_CODE, ADMIN_SERVER_MESSAGE);
  const networkErr = makeFirebaseAuthError(NETWORK_CODE, "Network request failed");
  const timeoutErr = makeFirebaseAuthError("auth/timeout", "Operation timed out");

  assert.equal(classifyAuthError(adminErr), "administrative");
  assert.equal(isAdministrativeAuthError(adminErr), true);
  assert.equal(isTransientNetworkAuthError(adminErr), false, "el rechazo administrativo no puede clasificarse como red");

  assert.equal(classifyAuthError(networkErr), "transient-network");
  assert.equal(isTransientNetworkAuthError(networkErr), true);
  assert.equal(isAdministrativeAuthError(networkErr), false);

  assert.equal(classifyAuthError(timeoutErr), "transient-network");
  assert.equal(classifyAuthError(new Error("otra cosa")), "other");
  assert.equal(classifyAuthError(null), "other");
});

test("R4. Los mensajes traducidos distinguen restricción administrativa de fallo de red", () => {
  const adminMsg = describeAuthError(makeFirebaseAuthError(ADMIN_CODE, ADMIN_SERVER_MESSAGE));
  const networkMsg = describeAuthError(makeFirebaseAuthError(NETWORK_CODE, "Network request failed"));

  // El mensaje administrativo identifica la restricción y no habla de conexión a internet.
  assert.match(adminMsg, /restricción administrativa|restringe/i);
  assert.match(adminMsg, /consola de Firebase|Identity Platform/i);
  assert.doesNotMatch(adminMsg, /conexión a internet/i, "no debe presentarse como problema de conexión");

  // El mensaje de red sigue siendo el de conectividad.
  assert.match(networkMsg, /conexión a internet/i);
  assert.doesNotMatch(networkMsg, /restricción administrativa/i);
});

test("R5. La capa de adjuntos comunica la restricción administrativa sin confundirla con red ni con timeout", { timeout: 20_000 }, async () => {
  const { driver } = adminRestrictedDriver();
  __setSignInDriverForTests(driver);
  const started = Date.now();
  try {
    await assert.rejects(
      () => ensureFirebaseSession(),
      (err: any) => {
        assert.ok(err instanceof AttachmentError, "debe fallar como AttachmentError");
        assert.match(err.message, new RegExp(ADMIN_CODE.replace("/", "\\/")), "el código del servicio debe ser visible para el usuario");
        assert.match(err.message, /restricción administrativa/i);
        // Prueba clave de no-confusión: ni mensaje de red ni mensaje de tiempo de espera.
        assert.doesNotMatch(err.message, /conexión a internet/i);
        assert.doesNotMatch(err.message, /tiempo de espera agotado/i);
        assert.doesNotMatch(err.message, /sin conexión/i);
        assert.doesNotMatch(err.message, /comprueba la conexión/i);
        return true;
      }
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `el rechazo administrativo debe propagarse de inmediato (${elapsed} ms), no por el timeout de 15 s reservado a fallos de red`);
  } finally {
    __setSignInDriverForTests(null);
  }
});

test("R6. uploadAttachment se cancela por la restricción administrativa ANTES de intentar la subida a Storage", { timeout: 20_000 }, async () => {
  const { driver, calls } = adminRestrictedDriver();
  __setSignInDriverForTests(driver);
  try {
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "comprobante.png", { type: "image/png" });
    await assert.rejects(
      () => uploadAttachment({ userId: "rentasync", folder: "expenses", file }),
      (err: any) => {
        assert.ok(err instanceof AttachmentError);
        assert.match(err.message, new RegExp(ADMIN_CODE.replace("/", "\\/")));
        assert.match(err.message, /El archivo no se ha subido/i, "la subida queda cancelada");
        assert.doesNotMatch(err.message, /storage\//i, "no debe llegar a producirse un error de Storage: la subida no se intenta");
        return true;
      }
    );
    assert.equal(calls.count, 1, "se consulta una sola vez al servicio de autenticación");
  } finally {
    __setSignInDriverForTests(null);
  }
});

test("R7. Contraste: un fallo de red real sigue comunicándose como conectividad (reintentable)", async () => {
  __setSignInDriverForTests(async () => {
    throw makeFirebaseAuthError(NETWORK_CODE, "Network request failed");
  });
  try {
    await assert.rejects(
      () => ensureFirebaseSession(),
      (err: any) => {
        assert.ok(err instanceof AttachmentError);
        assert.match(err.message, new RegExp(NETWORK_CODE.replace("/", "\\/")));
        assert.match(err.message, /conexión a internet/i, "el fallo de red sí debe comunicarse como conectividad");
        assert.doesNotMatch(err.message, /restricción administrativa/i, "el fallo de red no puede presentarse como bloqueo administrativo");
        return true;
      }
    );
  } finally {
    __setSignInDriverForTests(null);
  }
});

test("R8. Si el servicio autorizara la operación, la sesión se obtiene (el mecanismo en sí es válido)", async () => {
  const fakeUser = { uid: "anon_simulado", isAnonymous: true } as any;
  __setSignInDriverForTests(async () => ({ user: fakeUser }));
  try {
    const user = await ensureFirebaseAuth();
    assert.equal(user.uid, "anon_simulado");
    assert.equal(getLastAuthError(), null, "tras un éxito el último fallo se limpia");
  } finally {
    __setSignInDriverForTests(null);
  }
});
