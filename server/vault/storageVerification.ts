// Puerto AUTORITATIVO exclusivamente de servidor. Ninguna prueba viene del body del cliente.
// No configura Firebase ni añade credenciales: sin un verificador seguro se rechaza el adjunto.
import { createHash } from "node:crypto";
import type { RemoteDocumentReference } from "./attachmentSafety.js";

export class VaultAttachmentPolicyError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = "VaultAttachmentPolicyError"; }
}
export interface AuthorizedStorageObject {
  /** Identidad/cartera acreditada por el backend/ACL, no customMetadata libre del cliente. */
  owner: string;
  path: string;
  bytes: Uint8Array;
  /** Checksum independiente del objeto persistido; cuerpo y versión pertenecen a la misma lectura. */
  sha256: string;
  generation: string;
  propertyId?: string;
  movementId?: string;
}
export interface ServerStorageVerifier {
  readAuthorized(actor: string, path: string): Promise<AuthorizedStorageObject | null>;
}
export async function verifyStorageReference(actor: string, source: RemoteDocumentReference, verifier?: ServerStorageVerifier): Promise<void> {
  const path = source.storagePath;
  if (typeof path !== "string" || !path.startsWith(`users/${encodeURIComponent(actor)}/attachments/`) || /(?:^|\/)\.\.(?:\/|$)/.test(path))
    throw new VaultAttachmentPolicyError("storage/unauthorized", "La referencia Storage no pertenece a la cartera autorizada.", 403);
  if (!verifier) throw new VaultAttachmentPolicyError("storage/server-verifier-required", "No existe verificación autorizada de Storage en este servidor. No se confirma el adjunto.");
  const got = await verifier.readAuthorized(actor, path);
  if (!got || !got.generation || !got.bytes.length) throw new VaultAttachmentPolicyError("storage/object-not-found", "El documento no existe o no puede verificarse en el destino autorizado.");
  if (got.owner !== actor || got.path !== path) throw new VaultAttachmentPolicyError("storage/unauthorized", "El objeto persistido no está autorizado para esta cuenta.", 403);
  if (createHash("sha256").update(got.bytes).digest("hex") !== got.sha256)
    throw new VaultAttachmentPolicyError("attachment/integrity", "Los bytes del objeto persistido no coinciden con su hash independiente.");
  if ((source.propertyId && got.propertyId !== source.propertyId) || (source.movementId && got.movementId !== source.movementId))
    throw new VaultAttachmentPolicyError("attachment/association-conflict", "El objeto persistido no corresponde al inmueble/gasto requerido.");
}
