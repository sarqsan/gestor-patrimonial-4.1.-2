// Almacenamiento verificado de objetos inmutables en Storage (sin SDK de Firebase: testeable con node:test).
//
// Regla: un objeto nunca se sobrescribe. Las reglas de storage.rules no permiten `update` en adjuntos,
// así que:
//  - si el objeto ya existe con el MISMO contenido, se reutiliza sin subirlo de nuevo;
//  - si existe con OTRO contenido, se aborta (no se sobrescribe);
//  - si no existe, se crea y se verifica byte a byte leyéndolo de nuevo.

export interface VerifiedObjectPort {
  /** Bytes del objeto, o null si no existe. Cualquier otro error debe lanzarse. */
  read(path: string): Promise<Uint8Array | null>;
  /** Crea el objeto. Debe fallar si ya existe (las reglas no permiten sobrescribir). */
  create(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export type StoreOutcome = "uploaded" | "reused";

/** Conflicto: existe un objeto distinto en la misma ruta o la verificación no coincide. */
export class ObjectConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectConflictError";
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function storeVerifiedObject(
  port: VerifiedObjectPort,
  req: { path: string; bytes: Uint8Array; contentType: string }
): Promise<StoreOutcome> {
  const { path, bytes, contentType } = req;
  const existing = await port.read(path);
  if (existing) {
    if (bytesEqual(existing, bytes)) return "reused";
    throw new ObjectConflictError(`Ya existe un objeto distinto en ${path}; no se sobrescribe.`);
  }
  try {
    await port.create(path, bytes, contentType);
  } catch (err) {
    // Otra operación pudo crear el mismo objeto a la vez: solo se acepta si el contenido es idéntico.
    const after = await port.read(path).catch(() => null);
    if (after && bytesEqual(after, bytes)) return "reused";
    throw err;
  }
  const back = await port.read(path);
  if (!back || !bytesEqual(back, bytes)) {
    throw new ObjectConflictError(`Verificación fallida en ${path}: el contenido en Storage no coincide con el enviado.`);
  }
  return "uploaded";
}
