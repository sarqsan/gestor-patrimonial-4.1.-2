import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, onSnapshot, getDocFromServer } from "firebase/firestore";
import { getAuth, signInAnonymously, User } from "firebase/auth";
import { getStorage } from "firebase/storage";
import firebaseConfig from "../../firebase-applet-config.json" with { type: "json" };

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const db = firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== "(default)"
  ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
  : getFirestore(app);

export const auth = getAuth(app);

// Firebase Storage usa el storageBucket de firebase-applet-config.json (no se inventa ningún bucket).
export const storage = getStorage(app);

/** Traduce códigos de error de Firebase Auth a descripciones inteligibles para el usuario */
export function describeAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "auth/network-request-failed":
      return "Error de red al conectar con Firebase Auth. Comprueba tu conexión a internet.";
    case "auth/operation-not-allowed":
      return "El proveedor de autenticación anónima no está habilitado en este proyecto de Firebase.";
    case "auth/admin-restricted-operation":
      return "Operación de autenticación restringida por el administrador de Firebase.";
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

      const cred = await signInAnonymously(auth);
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
