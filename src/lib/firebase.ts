import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, onSnapshot, getDocFromServer } from "firebase/firestore";
import { getAuth, signInAnonymously, User, Auth } from "firebase/auth";
import { getStorage } from "firebase/storage";
import firebaseConfig from "../../firebase-applet-config.json" with { type: "json" };

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const db = firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== "(default)"
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
  : getFirestore(app);

export const auth = getAuth(app);

// Firebase Storage usa el storageBucket de firebase-applet-config.json (no se inventa ningún bucket).
export const storage = getStorage(app);

/**
 * Punto de inyección del mecanismo de inicio de sesión.
 *
 * La aplicación utiliza exclusivamente `signInAnonymously`. El punto de inyección
 * existe únicamente para que las pruebas puedan reproducir de forma determinista
 * los rechazos que devuelve el servicio (p. ej. `auth/admin-restricted-operation`,
 * que el backend de Identity Platform devuelve como ADMIN_ONLY_OPERATION) sin
 * depender de la red ni de la configuración administrativa del proyecto real.
 */
export type SignInDriver = (authInstance: Auth) => Promise<{ user: User }>;

const defaultSignInDriver: SignInDriver = (authInstance) => signInAnonymously(authInstance);
let activeSignInDriver: SignInDriver = defaultSignInDriver;

/** SOLO PRUEBAS: sustituye la llamada real de inicio de sesión. `null` restaura la real. */
export function __setSignInDriverForTests(driver: SignInDriver | null): void {
  activeSignInDriver = driver ?? defaultSignInDriver;
}

/**
 * Clasificación de errores de Firebase Auth a efectos de reintentos y mensajes.
 *
 * - "administrative": rechazo impuesto por la configuración administrativa del
 *   proyecto Firebase (Identity Platform). No es un fallo transitorio de red y
 *   ningún reintento de cliente puede resolverlo: exige un cambio en la consola
 *   del proyecto (Authentication / Identity Platform).
 * - "transient-network": fallo transitorio de red o de tiempo de espera; tiene
 *   sentido reintentar.
 * - "other": cualquier otro error (credenciales, configuración del cliente, etc.).
 */
export type AuthErrorClass = "administrative" | "transient-network" | "other";

/** Códigos que el backend devuelve cuando la operación está restringida por administración. */
export const ADMIN_RESTRICTED_AUTH_CODES: ReadonlySet<string> = new Set([
  "auth/admin-restricted-operation",
]);

/** Códigos considerados fallo transitorio de red / tiempo de espera. */
export const TRANSIENT_AUTH_CODES: ReadonlySet<string> = new Set([
  "auth/network-request-failed",
  "auth/timeout",
]);

/** Clasifica un error de Firebase Auth sin enmascarar su código original. */
export function classifyAuthError(err: unknown): AuthErrorClass {
  const code = (err as { code?: string })?.code ?? "";
  if (ADMIN_RESTRICTED_AUTH_CODES.has(code)) return "administrative";
  if (TRANSIENT_AUTH_CODES.has(code)) return "transient-network";
  return "other";
}

/** Indica si el error es un rechazo administrativo del proyecto Firebase (no transitorio). */
export function isAdministrativeAuthError(err: unknown): boolean {
  return classifyAuthError(err) === "administrative";
}

/** Indica si el error es un fallo transitorio de red (reintentable). */
export function isTransientNetworkAuthError(err: unknown): boolean {
  return classifyAuthError(err) === "transient-network";
}

/** Traduce códigos de error de Firebase Auth a descripciones inteligibles para el usuario */
export function describeAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "auth/network-request-failed":
      return "Error de red al conectar con Firebase Auth. Comprueba tu conexión a internet.";
    case "auth/operation-not-allowed":
      return "El proveedor de autenticación anónima no está habilitado en este proyecto de Firebase.";
    case "auth/admin-restricted-operation":
      return "La configuración administrativa del proyecto Firebase restringe esta operación de autenticación (rechazo ADMIN_ONLY_OPERATION del servicio). No es un fallo de red ni de la aplicación: debe revisarse la configuración de Authentication/Identity Platform del proyecto en la consola de Firebase.";
    case "auth/invalid-api-key":
      return "La API Key de Firebase no es válida.";
    case "auth/app-deleted":
      return "La instancia de la aplicación Firebase ha sido eliminada.";
    case "auth/user-disabled":
      return "La cuenta de usuario ha sido inhabilitada.";
    case "auth/timeout":
      return "Tiempo de espera agotado al conectar con el servicio de autenticación de Firebase.";
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

// Promesa en vuelo y último error para coordinar sesiones sin carreras ni duplicados
let inFlightAuthPromise: Promise<User> | null = null;
let lastAuthFailure: Error | null = null;

/**
 * Garantiza que existe una sesión activa de Firebase Auth.
 * - Si auth.currentUser ya existe (sesión restaurada de IndexedDB), la devuelve de inmediato.
 * - Si hay una autenticación en curso, reutiliza la misma promesa evitando carreras y llamadas duplicadas.
 * - Si no hay sesión, invoca signInAnonymously.
 * - Si falla, limpia la promesa en vuelo (permitiendo reintentar al usuario) y propaga el error original.
 */
export async function ensureFirebaseAuth(): Promise<User> {
  // 1. Si ya hay usuario autenticado activo, resolver de inmediato
  if (auth.currentUser) {
    lastAuthFailure = null;
    return auth.currentUser;
  }

  // 2. Si hay una petición de autenticación en curso, reutilizarla
  if (inFlightAuthPromise) {
    return inFlightAuthPromise;
  }

  // 3. Crear promesa de autenticación controlada
  let p: Promise<User> | null = null;
  p = (async () => {
    try {
      // Si el SDK soporta authStateReady, esperar primero a la restauración local de IndexedDB
      if (typeof (auth as any).authStateReady === "function") {
        try {
          await (auth as any).authStateReady();
          if (auth.currentUser) {
            lastAuthFailure = null;
            return auth.currentUser;
          }
        } catch {
          // Si authStateReady falla, continuar hacia signInAnonymously
        }
      }

      // La llamada real pasa por el punto de inyección (idéntica a signInAnonymously(auth)
      // fuera de las pruebas), para poder reproducir determinísticamente los rechazos del servicio.
      const cred = await activeSignInDriver(auth);
      lastAuthFailure = null;
      return cred.user;
    } catch (err: any) {
      lastAuthFailure = err instanceof Error ? err : new Error(String(err));
      console.warn("Firebase Auth signInAnonymously warning:", err);
      throw err;
    } finally {
      if (inFlightAuthPromise === p) {
        inFlightAuthPromise = null;
      }
    }
  })();

  inFlightAuthPromise = p;
  try {
    return await p;
  } finally {
    if (inFlightAuthPromise === p) {
      inFlightAuthPromise = null;
    }
  }
}

/** Devuelve el último error de autenticación registrado, si lo hubo. */
export function getLastAuthError(): Error | null {
  return lastAuthFailure;
}

/**
 * Promesa Thenable de compatibilidad que espera la sesión de Firebase Auth.
 * Se resuelve a true cuando la sesión es válida o reintenta bajo demanda si falló inicialmente.
 */
export const authReady: Promise<boolean> = {
  then<TResult1 = boolean, TResult2 = never>(
    onfulfilled?: ((value: boolean) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return ensureFirebaseAuth()
      .then(() => true)
      .then(onfulfilled, onrejected);
  },
  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
  ): Promise<boolean | TResult> {
    return this.then(undefined, onrejected);
  },
  finally(onfinally?: (() => void) | null): Promise<boolean> {
    return this.then(
      (val) => { onfinally?.(); return val; },
      (err) => { onfinally?.(); throw err; }
    );
  },
  [Symbol.toStringTag]: "Promise",
} as Promise<boolean>;

// Disparar autenticación inicial en segundo plano en entornos con navegador
if (typeof window !== "undefined") {
  ensureFirebaseAuth().catch((err) => {
    console.warn("Firebase anonymous auth initial background attempt failed:", err);
  });
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  return errInfo;
}

// Validate Connection to Firestore on boot (only in browser environment)
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}

if (typeof window !== "undefined") {
  testConnection();
}

export { doc, getDoc, setDoc, onSnapshot };
