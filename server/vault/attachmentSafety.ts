// Invariantes de referencias: datos de dominio existentes, sin columnas/revisiones nuevas.
export class VaultConflictError extends Error {
  readonly code = "vault/attachment-conflict";
  constructor(message = "La copia es antigua o cambia una asociación confirmada. Recarga antes de reintentar.") {
    super(message); this.name = "VaultConflictError";
  }
}
export interface RemoteDocumentReference { vaultId?: string; storagePath?: string; propertyId?: string; movementId?: string }
const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
export function expenseReferences(m: any): RemoteDocumentReference[] {
  if (!m) return [];
  const refs: RemoteDocumentReference[] = [];
  if (m.receiptVaultId || m.receiptPath) refs.push({ vaultId: m.receiptVaultId, storagePath: m.receiptPath, propertyId: m.propertyId, movementId: m.id });
  // El expediente histórico contiene también pdfVaultId/pdfPath: no son un bypass opcional.
  if (m.pdfVaultId || m.pdfPath) refs.push({ vaultId: m.pdfVaultId, storagePath: m.pdfPath, propertyId: m.propertyId, movementId: m.id });
  return refs;
}
export function propertyReferences(p: any): RemoteDocumentReference[] {
  if (!p || typeof p !== "object") return [];
  const refs: RemoteDocumentReference[] = [];
  for (const d of Array.isArray(p.documents) ? p.documents : []) {
    if (d?.vaultId || d?.storagePath) refs.push({ vaultId: d.vaultId, storagePath: d.storagePath, propertyId: p.id });
  }
  for (const c of [p.contract, ...(Array.isArray(p.tenantHistory) ? p.tenantHistory : [])]) {
    if (c?.pdfVaultId || c?.pdfPath) refs.push({ vaultId: c.pdfVaultId, storagePath: c.pdfPath, propertyId: p.id });
  }
  return refs;
}
const keys = (refs: RemoteDocumentReference[]) => refs.map((r) => JSON.stringify([
  nonempty(r.vaultId) ? r.vaultId : null, nonempty(r.storagePath) ? r.storagePath : null, r.propertyId ?? null, r.movementId ?? null,
]));
/** Sin versión explícita de usuario no se retira/cambia ningún vínculo remoto anterior. */
export function assertReferencesRetained(before: unknown, after: unknown, kind: "movement" | "property", explicitVersion = false): void {
  if (explicitVersion && kind === "movement") return;
  if (explicitVersion && kind === "property") {
    const a = before as any, b = after as any;
    // A new PDF may replace the current contract, but cannot erase unrelated documents/history.
    const retainedDocs = new Set(keys(propertyReferences({ id: b?.id, documents: b?.documents })));
    if (keys(propertyReferences({ id: a?.id, documents: a?.documents })).some((key) => !retainedDocs.has(key))) throw new VaultConflictError();
    const previousRows = new Map((Array.isArray(a?.tenantHistory) ? a.tenantHistory : []).map((r: any) => [r.id, r]));
    const nextRows = new Map((Array.isArray(b?.tenantHistory) ? b.tenantHistory : []).map((r: any) => [r.id, r]));
    for (const [id, row] of previousRows) {
      if (!nextRows.has(id)) throw new VaultConflictError();
      // Only the last/current history row may track an explicit current-contract PDF replacement.
      if (id !== a?.tenantHistory?.at(-1)?.id) {
        const refs = keys(propertyReferences({ id: a?.id, tenantHistory: [row] }));
        const next = new Set(keys(propertyReferences({ id: b?.id, tenantHistory: [nextRows.get(id)] })));
        if (refs.some((key) => !next.has(key))) throw new VaultConflictError();
      }
    }
    return;
  }
  const extract = kind === "movement" ? expenseReferences : propertyReferences;
  const next = new Set(keys(extract(after)));
  if (keys(extract(before)).some((key) => !next.has(key))) throw new VaultConflictError();
}
/** Metadatos de archivo son inmutables en identidad/contexto y solo se consolidan una vez. */
export function assertFileMetadataTransition(before: any, after: any): void {
  if (!before) return;
  if (before.deletedAt) throw new VaultConflictError("El documento fue retirado; el ID no se reutiliza ni se sobrescribe.");
  if (before.attachmentProtected && !after.attachmentProtected)
    throw new VaultConflictError("No se puede desproteger una referencia reservada o confirmada.");
  for (const k of ["id", "size", "contentType", "movementId", "propertyId"])
    if (before[k] !== after[k]) throw new VaultConflictError("El objeto ya está reservado/asociado a otro contexto; no se sobrescribe.");
  if ((before.sha256 && before.sha256 !== after.sha256) || (before.uploadSha256 && after.sha256 && before.uploadSha256 !== after.sha256))
    throw new VaultConflictError("Los metadatos no corresponden al contenido persistido.");
}
