// Doble en memoria del almacén remoto privado para pruebas: objetos por ruta, sobrescritura
// controlada y persistencia entre instancias del backend (el "almacén" sobrevive a los reinicios).
// No se usa en producción: el destino real es Vercel Blob (server/vault/blobPort.ts).
import { createHash } from "node:crypto";
import type { BlobObjectInfo, BlobPort, PresignedPut } from "./persistenceTypes.js";

export class MemoryBlobPort implements BlobPort {
  readonly kind = "memory";
  private objects = new Map<string, { bytes: Uint8Array; contentType: string; uploadedAt: string; etag: string }>();
  /** Subidas firmadas pendientes: pathname -> límites impuestos por el servidor. */
  pendingPresigns = new Map<string, { maxBytes: number; contentType: string; validUntil: number }>();
  putCalls = 0;

  /** Escritura directa "desde el navegador" a una URL firmada. */
  async directPut(pathname: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const pending = this.pendingPresigns.get(pathname);
    if (!pending) throw new Error("subida no firmada");
    if (bytes.length > pending.maxBytes) throw new Error("supera el tamaño firmado");
    if (contentType !== pending.contentType) throw new Error("tipo no firmado");
    if (Date.now() > pending.validUntil) throw new Error("firma caducada");
    this.pendingPresigns.delete(pathname);
    await this.putBytes(pathname, bytes, contentType);
  }

  async head(pathname: string): Promise<BlobObjectInfo | null> {
    const o = this.objects.get(pathname);
    return o ? { pathname, size: o.bytes.length, uploadedAt: o.uploadedAt, etag: o.etag } : null;
  }

  async getBytes(pathname: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const o = this.objects.get(pathname);
    return o ? { bytes: o.bytes, contentType: o.contentType } : null;
  }

  async putBytes(pathname: string, bytes: Uint8Array, contentType: string): Promise<BlobObjectInfo> {
    this.putCalls++;
    const etag = createHash("md5").update(bytes).digest("hex");
    const uploadedAt = new Date().toISOString();
    this.objects.set(pathname, { bytes, contentType, uploadedAt, etag });
    return { pathname, size: bytes.length, uploadedAt, etag };
  }

  async del(pathname: string): Promise<void> {
    this.objects.delete(pathname);
  }

  async list(prefix: string): Promise<BlobObjectInfo[]> {
    return [...this.objects.entries()]
      .filter(([p]) => p.startsWith(prefix))
      .map(([pathname, o]) => ({ pathname, size: o.bytes.length, uploadedAt: o.uploadedAt, etag: o.etag }));
  }

  async presignPut(options: { pathname: string; contentType: string; maxBytes: number; validUntil: number }): Promise<PresignedPut> {
    this.pendingPresigns.set(options.pathname, {
      maxBytes: options.maxBytes,
      contentType: options.contentType,
      validUntil: options.validUntil,
    });
    return {
      url: `https://blob.invalid/${options.pathname}?firma=sintetica`,
      headers: { "content-type": options.contentType },
      validUntil: options.validUntil,
    };
  }
}
