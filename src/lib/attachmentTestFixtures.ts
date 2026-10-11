// Solo fixtures de pruebas. Ningún import de la aplicación usa este módulo.
import { createHash } from "node:crypto";
import type { Property } from "../types";
import type { StorageAttachmentPort, StoredObjectMetadata } from "./storageAttachment";

export const TEST_BUCKET = "startup-sanctuary-sln7n.firebasestorage.app";
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function syntheticIbiPdf(paddingBytes = 0): Uint8Array {
  const content = "BT /F1 12 Tf 40 100 Td (PRUEBA IBI - SIN VALIDEZ FISCAL - SIN DATOS REALES) Tj ET" + (paddingBytes ? `\n%${"P".repeat(paddingBytes)}\n` : "");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
export const PNG_BYTES = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC", "base64"));

// JPEG válido de 1x1 blanco, generado localmente (no factura ni datos personales).
export const JPG_BYTES = new Uint8Array(Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==", "base64"));
export const WORD_BYTES = new TextEncoder().encode("<html><body>CONTRATO SINTETICO - SIN VALIDEZ</body></html>");

export const TEST_PROPERTY: Property = {
  id: "prop_prueba", address: "INMUEBLE SINTETICO", cadastralReference: "SINTETICO",
  owner: "user1", ownershipPercentageUser1: 100, ownershipPercentageUser2: 0,
  tenantName: "", tenantDni: "", monthlyRent: 0, purchasePrice: 0, landValuePercent: 25,
  amortizationAmount: 0, expensesCommunity: 0, expensesIBI: 0, expensesInsurance: 0,
  expensesRepairs: 0, registrationDate: "2026-10-11", documents: [],
};

export function installTestLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k), clear: () => store.clear(),
  };
  return store;
}

/** Checksum del fake calculado con node:crypto, independiente del MD5 del cliente. */
export class MemoryStorageAttachmentPort implements StorageAttachmentPort {
  objects = new Map<string, { bytes: Uint8Array; meta: StoredObjectMetadata }>();
  reads: string[] = [];
  creates: string[] = [];
  async metadata(path: string): Promise<StoredObjectMetadata | null> {
    this.reads.push(path);
    return this.objects.get(path)?.meta ?? null;
  }
  async create(path: string, bytes: Uint8Array, metadata: Parameters<StorageAttachmentPort["create"]>[2], signal: AbortSignal): Promise<StoredObjectMetadata> {
    signal.throwIfAborted();
    this.creates.push(path);
    if (this.objects.has(path)) throw Object.assign(new Error("No se permite sobrescribir"), { code: "storage/unauthorized" });
    const meta = {
      fullPath: path, bucket: TEST_BUCKET, size: bytes.length, contentType: metadata.contentType,
      generation: "1", md5Hash: createHash("md5").update(bytes).digest("base64"), customMetadata: metadata.customMetadata,
    };
    this.objects.set(path, { bytes: bytes.slice(), meta });
    return meta;
  }
}

/** Fake HTTP de Vault con hashes reales para las pruebas de contrato/UI (NO prueba un proveedor remoto). */
export function verifiedVaultFetchFake() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const files = new Map<string, { meta: any; bytes?: Uint8Array }>();
  const fetchFake = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://blob.invalid/")) {
      const id = new URL(url).pathname.slice(1);
      const file = files.get(id)!;
      file.bytes = new Uint8Array(await (init.body as Blob).arrayBuffer());
      return new Response(null, { status: 200 });
    }
    const query = new URL(url, "http://test.invalid").searchParams;
    const op = query.get("op");
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (op === "health") return Response.json({ ok: true, storageOk: true, durable: true, driver: "vercel-blob", directUpload: true, maxFileBytes: 10 * 1024 * 1024 });
    if (op === "files.upload" || op === "files.presign") {
      const bytes = op === "files.upload" ? new Uint8Array(Buffer.from(body.bytesBase64, "base64")) : undefined;
      const meta = { id: body.id, name: body.name, contentType: body.contentType, size: bytes?.length ?? body.size,
        sha256: bytes ? sha256(bytes) : "", movementId: body.movementId, propertyId: body.propertyId, createdAt: "2026-10-11T00:00:00.000Z" };
      files.set(body.id, { meta, bytes });
      if (op === "files.presign") return Response.json({ ok: true, fileId: body.id,
        upload: { url: `https://blob.invalid/${body.id}`, headers: {}, validUntil: Date.now() + 600_000 } }, { status: 201 });
      return Response.json({ ok: true, storageOk: true, file: meta }, { status: 201 });
    }
    const file = files.get(query.get("id") ?? "");
    if (op === "files.commit" && file?.bytes) file.meta.sha256 = sha256(file.bytes);
    if ((op === "files.commit" || op === "files.verify") && file?.meta.sha256) return Response.json({ ok: true, storageOk: true, file: file.meta });
    if (op === "files.get" && file?.bytes) return new Response(file.bytes, { headers: { "content-type": file.meta.contentType, "x-vault-sha256": sha256(file.bytes) } });
    return Response.json({ ok: false, error: "Objeto no disponible en el fake" }, { status: 404 });
  };
  return { calls, files, fetch: fetchFake as typeof globalThis.fetch };
}
