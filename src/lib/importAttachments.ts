// Externaliza a Storage los adjuntos Base64 que llegan en una importación o restauración,
// ANTES de que la cartera los reciba. Así ningún Base64 nuevo entra en el documento principal.
// Módulo puro: el subidor se inyecta (en la app, uploadVerifiedAttachment; en pruebas, un fake).

import { PropertyExpense, Property, PropertyDocument } from "../types";
import { AttachmentFolder, validateAttachment, resolveContentType, sanitizeFileName } from "./attachmentRules";
import { isDataUrl, parseDataUrl } from "./legacyDataUrl";
import { sha256Hex } from "./stableHash";

export interface UploadRequest {
  folder: AttachmentFolder;
  /** Identificador estable: en importaciones es el hash del contenido (idempotente). */
  attachmentId: string;
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface UploadedRef {
  storagePath: string;
  name: string;
  contentType: string;
  size: number;
}

export type AttachmentUploader = (req: UploadRequest) => Promise<UploadedRef>;

export class ImportAttachmentError extends Error {}

async function externalizeOne(
  dataUrl: string,
  folder: AttachmentFolder,
  fallbackName: string,
  uploader: AttachmentUploader,
  label: string
): Promise<UploadedRef> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    throw new ImportAttachmentError(`El adjunto de ${label} no es un Base64 válido. La importación se ha cancelado; el archivo original no se ha modificado.`);
  }
  const fileName = sanitizeFileName(fallbackName);
  const contentType = resolveContentType(fileName, parsed.mimeType);
  const invalid = validateAttachment({ name: fileName, size: parsed.bytes.length, type: contentType });
  if (invalid) {
    throw new ImportAttachmentError(`El adjunto de ${label} no se puede guardar: ${invalid} La importación se ha cancelado.`);
  }
  const attachmentId = `imp_${(await sha256Hex(parsed.bytes)).slice(0, 32)}`;
  return uploader({ folder, attachmentId, fileName, contentType, bytes: parsed.bytes });
}

/** Sustituye receiptUrl Base64 por receiptPath/receiptName/receiptType. Otros campos se conservan. */
export async function externalizeImportedExpenses(
  expenses: PropertyExpense[],
  uploader: AttachmentUploader
): Promise<PropertyExpense[]> {
  const out: PropertyExpense[] = [];
  for (const exp of expenses) {
    if (!isDataUrl(exp.receiptUrl)) {
      out.push(exp);
      continue;
    }
    const name = exp.receiptName?.trim() || `comprobante_${exp.id}`;
    const ref = await externalizeOne(exp.receiptUrl as string, "expenses", name, uploader, `la operación ${exp.id}`);
    const { receiptUrl: _legacy, ...rest } = exp;
    out.push({ ...rest, receiptPath: ref.storagePath, receiptName: ref.name, receiptType: ref.contentType });
  }
  return out;
}

/** Sustituye fileData Base64 de los documentos de inmuebles por storagePath. */
export async function externalizeImportedProperties(
  properties: Property[],
  uploader: AttachmentUploader
): Promise<Property[]> {
  const out: Property[] = [];
  for (const prop of properties) {
    if (!prop.documents?.some((d) => isDataUrl(d.fileData))) {
      out.push(prop);
      continue;
    }
    const docs: PropertyDocument[] = [];
    for (const doc of prop.documents) {
      if (!isDataUrl(doc.fileData)) {
        docs.push(doc);
        continue;
      }
      const name = doc.name?.trim() || `documento_${doc.id}`;
      const ref = await externalizeOne(doc.fileData as string, "property-documents", name, uploader, `el documento ${doc.id}`);
      const { fileData: _legacy, ...rest } = doc;
      docs.push({ ...rest, storagePath: ref.storagePath, contentType: ref.contentType, name: ref.name });
    }
    out.push({ ...prop, documents: docs });
  }
  return out;
}
