// Puerto de objetos binarios/JSON sobre Vercel Blob (almacén PRIVADO).
//
// Todo el acceso al almacén remoto pasa por esta interfaz, de modo que:
//  - la lógica de negocio (persistencia, rutas, autorización) se prueba sin red con
//    `MemoryBlobPort`, y
//  - en producción se usa `VercelBlobPort` con el SDK oficial `@vercel/blob`.
//
// Seguridad: NUNCA se devuelve al navegador la URL del blob. Los objetos se leen y se
// escriben exclusivamente desde el servidor con las credenciales inyectadas por Vercel
// (`BLOB_READ_WRITE_TOKEN` o el token OIDC + `BLOB_STORE_ID`); el cliente solo recibe
// contenido a través de las rutas autenticadas de la API.
import type { BlobObjectInfo, BlobPort, PresignedPut } from "./persistenceTypes.js";

export function blobStoreConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID);
}

/** Implementación real: SDK oficial de Vercel Blob contra un almacén privado. */
export class VercelBlobPort implements BlobPort {
  readonly kind = "vercel-blob";

  private async sdk() {
    // Import perezoso: si el paquete no estuviera instalado, el resto de la aplicación
    // (y las pruebas con el puerto en memoria) seguiría funcionando.
    return import("@vercel/blob");
  }

  async head(pathname: string): Promise<BlobObjectInfo | null> {
    const { head, BlobNotFoundError } = await this.sdk();
    try {
      const result = await head(pathname);
      return {
        pathname: result.pathname,
        size: result.size,
        uploadedAt: new Date(result.uploadedAt).toISOString(),
        etag: result.etag,
      };
    } catch (err) {
      if (err instanceof BlobNotFoundError || (err as { name?: string })?.name === "BlobNotFoundError") return null;
      throw err;
    }
  }

  async getBytes(pathname: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const { get } = await this.sdk();
    const result = await get(pathname, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
    return { bytes, contentType: result.blob.contentType || "application/octet-stream" };
  }

  async putBytes(pathname: string, bytes: Uint8Array, contentType: string): Promise<BlobObjectInfo> {
    const { put } = await this.sdk();
    const result = await put(pathname, Buffer.from(bytes), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
    });
    return {
      pathname: result.pathname,
      size: bytes.length,
      uploadedAt: new Date().toISOString(),
      etag: (result as { etag?: string }).etag ?? "",
    };
  }

  async del(pathname: string): Promise<void> {
    const { del } = await this.sdk();
    try {
      await del(pathname);
    } catch (err) {
      // Un objeto ya ausente no es un error para el llamador (borrado idempotente).
      if ((err as { name?: string })?.name !== "BlobNotFoundError") throw err;
    }
  }

  async list(prefix: string): Promise<BlobObjectInfo[]> {
    const { list } = await this.sdk();
    const out: BlobObjectInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, limit: 1000, cursor });
      for (const b of page.blobs) {
        out.push({
          pathname: b.pathname,
          size: b.size,
          uploadedAt: new Date(b.uploadedAt).toISOString(),
          etag: b.etag,
        });
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  /**
   * URL de subida directa (PUT desde el navegador) limitada por el servidor:
   * un único pathname, solo operación `put`, tamaño y tipos acotados y caducidad corta.
   * Así los archivos grandes no pasan por la función serverless (límite de cuerpo de Vercel)
   * sin que el cliente reciba ninguna credencial del almacén.
   */
  async presignPut(options: {
    pathname: string;
    contentType: string;
    maxBytes: number;
    validUntil: number;
  }): Promise<PresignedPut> {
    const { issueSignedToken, presignUrl } = await this.sdk();
    const signed = await issueSignedToken({
      pathname: options.pathname,
      operations: ["put"],
      validUntil: options.validUntil,
      allowedContentTypes: [options.contentType],
      maximumSizeInBytes: options.maxBytes,
    });
    const { presignedUrl } = await presignUrl(signed, {
      access: "private",
      operation: "put",
      pathname: options.pathname,
      validUntil: options.validUntil,
      allowedContentTypes: [options.contentType],
      maximumSizeInBytes: options.maxBytes,
      allowOverwrite: false,
      addRandomSuffix: false,
    });
    return { url: presignedUrl, headers: { "content-type": options.contentType }, validUntil: options.validUntil };
  }
}

export async function createVercelBlobPort(): Promise<VercelBlobPort> {
  return new VercelBlobPort();
}
