// Confirmación de operaciones CON adjunto. El formulario solo se limpia al resolver esta promesa.
// No cambia el modelo patrimonial ni el guardado de operaciones sin adjunto.
import { verifyAttachmentReference } from "./attachments";
import { AttachmentError, attachmentFailure, attachmentPhase, ATTACHMENT_TIMEOUTS, logAttachmentFailure } from "./attachmentErrors";
import { getVaultToken, vaultCapabilities, vaultSaveAttachmentMovement, vaultSaveAttachmentProperty } from "./vaultClient";
import { validateMovement } from "./movementService";
import { normalizeDateToIso } from "./dateUtils";
import { stableStringify } from "./stableHash";
import type { PropertyExpense, Property } from "../types";

export interface PendingAttachmentReference {
  vaultId?: string;
  storagePath?: string;
  movementId?: string;
  propertyId?: string;
}

/** Puerto para probar el flujo real sin sustituir la lógica de asociación/confirmación. */
export interface AttachmentPersistencePort {
  hasVaultSession(user: string): boolean;
  assertDurableVault(): Promise<void>;
  verify(user: string, source: PendingAttachmentReference, signal?: AbortSignal): Promise<void>;
  saveVaultMovement(user: string, movement: PropertyExpense, signal: AbortSignal): Promise<Record<string, any>>;
  saveFirebaseMovement(user: string, movement: PropertyExpense, signal: AbortSignal): Promise<Record<string, any>>;
  saveVaultProperty(user: string, property: Property, ids: string[], signal: AbortSignal): Promise<Record<string, any>>;
  saveFirebaseProperty(user: string, property: Property, properties: Property[], signal: AbortSignal): Promise<Record<string, any>>;
}

const defaultPort: AttachmentPersistencePort = {
  hasVaultSession: (user) => Boolean(getVaultToken(user)),
  async assertDurableVault() {
    const caps = await vaultCapabilities();
    if (!caps.storageOk || !caps.durable) {
      throw new AttachmentError("No hay almacenamiento remoto persistente operativo para confirmar la operación.",
        { phase: "persistence", backend: "vault", code: "vault/not-durable", retryable: true });
    }
  },
  async verify(user, source, signal) {
    if (source.storagePath) throw new AttachmentError("Storage no dispone de verificación de titularidad autorizada en servidor. No se confirma ni se cambia de proveedor; conserva el formulario.",
      { phase: "authorization", backend: "firebase", code: "attachment/server-authorization-required" });
    await verifyAttachmentReference(user, source, signal);
  },
  saveVaultMovement: vaultSaveAttachmentMovement,
  async saveFirebaseMovement(user, movement, signal) {
    // No hay vínculo servidor entre username y UID anónimo ni verificador Storage autorizado.
    // No ejecutar una escritura SDK que el servidor no puede acreditar como asociación privada.
    throw new AttachmentError("La confirmación privada de adjuntos Firebase requiere una sesión y verificador autorizados de servidor. El formulario se conserva.",
      { phase: "authorization", backend: "firebase", code: "attachment/server-authorization-required" });
  },
  saveVaultProperty: vaultSaveAttachmentProperty,
  async saveFirebaseProperty(user, property, properties, signal) {
    // No hay vínculo servidor entre username y UID anónimo ni verificador Storage autorizado.
    // No ejecutar una escritura SDK que el servidor no puede acreditar como asociación privada.
    throw new AttachmentError("La confirmación privada de adjuntos Firebase requiere una sesión y verificador autorizados de servidor. El formulario se conserva.",
      { phase: "authorization", backend: "firebase", code: "attachment/server-authorization-required" });
  },
};

function requireRemoteReference(source: PendingAttachmentReference): void {
  if (!source.vaultId && !source.storagePath) {
    throw new AttachmentError("Falta el documento obligatorio en almacenamiento definitivo. La operación no se ha guardado.",
      { phase: "association", code: "attachment/required" });
  }
}

function receiptMatches(expected: PropertyExpense, stored: Record<string, any>): boolean {
  // Solo campos patrimoniales/asociación; timestamps y ownerUid los determina el backend.
  const keys = ["id", "propertyId", "category", "type", "amount", "date", "description", "receiptPath", "receiptVaultId", "receiptName", "receiptType"] as const;
  return keys.every((key) => stored[key] === expected[key]) && !stored.receiptUrl;
}

export async function persistAttachedExpense(user: string, input: PropertyExpense, port = defaultPort, parentSignal?: AbortSignal): Promise<PropertyExpense> {
  const movement: PropertyExpense = {
    ...input, date: normalizeDateToIso(input.date) || input.date,
    type: input.type || (input.category === "rent" ? "ingreso" : "gasto"),
    description: input.description?.trim() || undefined,
    receiptUrl: undefined, status: "synced",
  };
  const source = { vaultId: movement.receiptVaultId, storagePath: movement.receiptPath, movementId: movement.id, propertyId: movement.propertyId };
  requireRemoteReference(source);
  const validation = validateMovement(movement);
  if (!validation.valid) throw new AttachmentError(validation.errors.join(" "), { phase: "validation", code: "attachment/invalid-operation" });
  const backend = source.vaultId || port.hasVaultSession(user) ? "vault" : "firebase";
  try {
    parentSignal?.throwIfAborted();
    await port.verify(user, source, parentSignal);
    if (backend === "vault") await port.assertDurableVault();
    parentSignal?.throwIfAborted();
    const persisted = await attachmentPhase("persistence", backend, ATTACHMENT_TIMEOUTS.persistence, (signal) =>
      backend === "vault" ? port.saveVaultMovement(user, movement, signal) : port.saveFirebaseMovement(user, movement, signal), parentSignal);
    if (!receiptMatches(movement, persisted)) {
      throw new AttachmentError("La operación recuperada no conserva los datos y la referencia de su comprobante. No se confirma el guardado.",
        { phase: "persistence", backend, code: "attachment/association-conflict" });
    }
    return movement;
  } catch (err) {
    const failure = attachmentFailure(err, "persistence", backend);
    logAttachmentFailure(failure);
    throw failure;
  }
}

/** Solo confirma el inmueble que recibe documentos nuevos; no toca titulares, contratos ni movimientos ajenos. */
export async function persistAttachedProperty(user: string, property: Property, properties: Property[], sources: PendingAttachmentReference[], port = defaultPort, parentSignal?: AbortSignal): Promise<void> {
  const backend = sources.some((s) => s.vaultId) || port.hasVaultSession(user) ? "vault" : "firebase";
  try {
    for (const source of sources) {
      parentSignal?.throwIfAborted();
      requireRemoteReference(source);
      if (source.propertyId && source.propertyId !== property.id) throw new AttachmentError("El documento corresponde a otro inmueble.",
        { phase: "association", backend, code: "attachment/association-conflict" });
      const linked = property.documents?.some((d) => source.vaultId ? d.vaultId === source.vaultId : d.storagePath === source.storagePath) ||
        (source.vaultId ? property.contract?.pdfVaultId === source.vaultId : property.contract?.pdfPath === source.storagePath) ||
        property.tenantHistory?.some((r) => source.vaultId ? r.pdfVaultId === source.vaultId : r.pdfPath === source.storagePath);
      if (!linked) throw new AttachmentError("El documento no está vinculado al inmueble.", { phase: "association", backend, code: "attachment/association-conflict" });
      await port.verify(user, { ...source, propertyId: property.id }, parentSignal);
    }
    if (backend === "vault") await port.assertDurableVault();
    parentSignal?.throwIfAborted();
    const persisted = await attachmentPhase("persistence", backend, ATTACHMENT_TIMEOUTS.persistence, (signal) => backend === "vault"
      ? port.saveVaultProperty(user, property, sources.flatMap((s) => s.vaultId ? [s.vaultId] : []), signal)
      : port.saveFirebaseProperty(user, property, properties, signal), parentSignal);
    if (stableStringify(persisted) !== stableStringify(property)) {
      throw new AttachmentError("El inmueble recuperado no conserva la asociación del documento. No se confirma el guardado.",
        { phase: "persistence", backend, code: "attachment/association-conflict" });
    }
  } catch (err) {
    const failure = attachmentFailure(err, "persistence", backend);
    logAttachmentFailure(failure);
    throw failure;
  }
}
