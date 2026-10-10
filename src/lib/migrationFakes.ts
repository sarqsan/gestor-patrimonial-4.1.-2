// Kit de pruebas: adaptadores en memoria con inyección de fallos y cartera de fixture.
// NO toca Firebase. Usado por portfolioMigrationRun.test.ts.
import { AppState, Property, PropertyExpense, PropertyDocument } from "../types";
import { portfolioBody } from "./portfolioPayload";
import { estimatePayloadBytes } from "./attachmentRules";
import { assertPortfolioWritable } from "./portfolioGuard";
import { portfolioRawHash } from "./stableHash";
import {
  BackupIndexEntry,
  ConcurrentChangeError,
  MigrationRecord,
  MigrationStorage,
  MigrationStore,
} from "./portfolioMigrationRun";

/** Tamaño exacto diagnosticado por el usuario para la cartera de arquero. */
export const ARQUERO_DIAGNOSED_INITIAL_BYTES = 1_035_859;

export class FakeStorage implements MigrationStorage {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  uploadCalls: string[] = [];
  /** Fallos inyectados */
  failUploadFor = new Set<string>();
  /** Guarda bytes distintos a los enviados (corrupción en tránsito). */
  corruptUploadFor = new Set<string>();
  /** Lecturas que devuelven contenido alterado. */
  corruptReadFor = new Set<string>();
  failReadFor = new Set<string>();

  async uploadBytes(path: string, bytes: Uint8Array, contentType: string) {
    this.uploadCalls.push(path);
    if (this.failUploadFor.has(path)) throw new Error(`Simulated upload failure: ${path}`);
    const stored = this.corruptUploadFor.has(path) ? flip(bytes) : new Uint8Array(bytes);
    this.objects.set(path, { bytes: stored, contentType });
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    if (this.failReadFor.has(path)) throw new Error(`Simulated read failure: ${path}`);
    const rec = this.objects.get(path);
    if (!rec) return null;
    return this.corruptReadFor.has(path) ? flip(rec.bytes) : new Uint8Array(rec.bytes);
  }

  totalBytes(): number {
    let n = 0;
    for (const v of this.objects.values()) n += v.bytes.length;
    return n;
  }
}

function flip(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  if (out.length > 0) out[0] = out[0] ^ 0xff;
  return out;
}

export class FakeStore implements MigrationStore {
  raw: Record<string, unknown> | null;
  backups = new Map<string, BackupIndexEntry>();
  records = new Map<string, MigrationRecord>();
  /** Antes de la siguiente escritura, otro dispositivo modifica la cartera. */
  beforeReplace: ((store: FakeStore) => void) | null = null;
  /** Falla antes de confirmar (la escritura no llega). */
  failNextReplace = false;
  /** Confirma la escritura pero devuelve error (respuesta incierta). */
  commitThenThrowOnce = false;
  /** Se ejecuta tras cada escritura confirmada (para simular fallos posteriores). */
  afterCommit: ((store: FakeStore) => void) | null = null;
  replaceCalls = 0;
  failBackupIndex = false;

  constructor(raw: Record<string, unknown> | null) {
    this.raw = raw ? structuredClone(raw) : null;
  }

  async readRaw(_userId: string) {
    return this.raw ? structuredClone(this.raw) : null;
  }

  async replaceIfUnchanged(userId: string, expectedHash: string, next: Record<string, unknown>, opts?: { enforceGuard?: boolean }) {
    this.replaceCalls++;
    if (this.beforeReplace) {
      const hook = this.beforeReplace;
      this.beforeReplace = null;
      hook(this);
    }
    if (this.failNextReplace) {
      this.failNextReplace = false;
      throw new Error("Simulated Firestore failure (UNAVAILABLE)");
    }
    const current = this.raw ? await portfolioRawHash(this.raw) : "";
    if (current !== expectedHash) throw new ConcurrentChangeError();
    const payload = JSON.parse(JSON.stringify(next));
    if (opts?.enforceGuard !== false) {
      const { updatedAt: _u, ...body } = payload;
      assertPortfolioWritable(body);
    }
    this.raw = payload;
    if (this.afterCommit) {
      const hook = this.afterCommit;
      this.afterCommit = null;
      hook(this);
    }
    if (this.commitThenThrowOnce) {
      this.commitThenThrowOnce = false;
      throw new Error("Simulated timeout after commit");
    }
  }

  async writeBackupIndex(_userId: string, entry: BackupIndexEntry) {
    if (this.failBackupIndex) throw new Error("Simulated backup index failure");
    this.backups.set(entry.backupId, entry);
  }
  async readBackupIndex(_userId: string, backupId: string) {
    return this.backups.get(backupId) ?? null;
  }
  async readMigrationRecord(userId: string) {
    return this.records.get(userId) ?? null;
  }
  async writeMigrationRecord(userId: string, record: MigrationRecord) {
    this.records.set(userId, structuredClone(record));
  }
}

// ---------------------------------------------------------------------------
// Fixture: cartera de arquero con cuatro adjuntos Base64 históricos
// ---------------------------------------------------------------------------

/** Bytes pseudoaleatorios deterministas (LCG) para que los adjuntos no sean triviales. */
export function deterministicBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x = (1664525 * x + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

export function toDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

export interface ArqueroFixture {
  state: AppState;
  /** Attachments exactly as stored in the cloud (raw Firestore document, with updatedAt). */
  raw: Record<string, unknown>;
  files: Array<{ attachmentId: string; kind: "expense" | "document"; fileName: string; contentType: string; bytes: Uint8Array }>;
}

/**
 * Reproduce la cartera diagnosticada: 4 adjuntos Base64 y tamaño serializado de 1.035.859 bytes.
 * El relleno de texto (descripción) ajusta el tamaño al byte; los contenidos binarios son reales.
 */
export interface ArqueroFixtureOptions {
  /** Tamaño binario de los cuatro adjuntos. Por defecto, ajustados a los 1.035.859 bytes diagnosticados. */
  sizes?: [number, number, number, number];
  /** Si se indica, la cartera se ajusta exactamente a este tamaño serializado (solo con sizes por defecto). */
  targetBytes?: number;
}

export function buildArqueroFixture(opts: ArqueroFixtureOptions = {}): ArqueroFixture {
  const userId = "arquero";
  const files: ArqueroFixture["files"] = [];
  const fit = opts.sizes === undefined;
  // Tamaños binarios: el Base64 ocupa ~4/3 del binario; cuatro adjuntos de ~180 KB ≈ 0,96 MB de Base64.
  const sizes = opts.sizes ?? [180_000, 180_003, 180_006, 180_009];
  const mk = (i: number, kind: "expense" | "document", fileName: string, contentType: string) => {
    const bytes = deterministicBytes(sizes[i], 1000 + i);
    const attachmentId = kind === "expense" ? `exp_${i}` : `doc_${i - 2}`;
    files.push({ attachmentId, kind, fileName, contentType, bytes });
    return toDataUrl(bytes, contentType);
  };

  const prop1Id = "prop_1";
  const prop2Id = "prop_2";
  const expenses: PropertyExpense[] = [
    { id: "exp_0", propertyId: prop1Id, category: "ibi", type: "gasto", amount: 412.5, date: "2026-02-10", description: "IBI 2026", receiptUrl: mk(0, "expense", "ibi-2026.pdf", "application/pdf"), receiptName: "ibi-2026.pdf", receiptType: "application/pdf" },
    { id: "exp_1", propertyId: prop2Id, category: "repairs", type: "gasto", amount: 180, date: "2026-03-05", description: "Reparación caldera", receiptUrl: mk(1, "expense", "caldera.png", "image/png"), receiptName: "caldera.png", receiptType: "image/png" },
    { id: "exp_2", propertyId: prop1Id, category: "community", type: "gasto", amount: 95, date: "2026-04-01", description: "Comunidad", },
  ];
  const doc1: PropertyDocument = { id: "doc_0", name: "Escritura.pdf", size: "240 KB", type: "application/pdf", category: "otros", year: 2026, uploadDate: "10/03/2026", fileData: mk(2, "document", "Escritura.pdf", "application/pdf") };
  const doc2: PropertyDocument = { id: "doc_1", name: "Seguro.pdf", size: "240 KB", type: "application/pdf", category: "seguros", year: 2026, uploadDate: "11/03/2026", fileData: mk(3, "document", "Seguro.pdf", "application/pdf") };

  const properties: Property[] = [
    makeProp(prop1Id, "Calle Mayor 1, Madrid", [doc1]),
    makeProp(prop2Id, "Avenida Sur 22, Sevilla", [doc2]),
  ];

  const base: AppState = {
    user1: { name: "Titular 1", dni: "12345678A", brutoTrabajo: 36200, netoTrabajo: 31800 },
    user2: { name: "Titular 2", dni: "87654321B", brutoTrabajo: 29500, netoTrabajo: 25100, hasPartner: true },
    properties,
    payments: [],
    expenses,
    contracts: [],
    syncEvents: [],
    syncEnabled: true,
    isOnboarded: true,
    currentYear: 2026,
    yearlyProfiles: {},
    theme: "slate-indigo",
  };

  // Ajuste exacto: 4 caracteres de Base64 = 3 bytes binarios (el último adjunto absorbe el ajuste)
  // y el resto (< 4 bytes) va en la descripción de una operación (texto libre).
  const measure = (s: AppState) => estimatePayloadBytes(portfolioBody(s));
  const target = opts.targetBytes ?? ARQUERO_DIAGNOSED_INITIAL_BYTES;
  if (!fit) {
    const raw0 = { ...JSON.parse(JSON.stringify(portfolioBody(base))), updatedAt: "2026-10-09T18:00:00.000Z" } as Record<string, unknown>;
    return { state: base, raw: raw0, files };
  }
  const diff = target - measure(base);
  if (diff < 0) throw new Error("La fixture supera el tamaño diagnosticado");
  const extraChars = Math.floor(diff / 4) * 4;
  if (extraChars > 0) {
    // Ampliar el último binario en extraChars*3/4 bytes (4 chars de Base64 por 3 bytes).
    const extraBytes = (extraChars / 4) * 3;
    const last = files[3];
    const grown = deterministicBytes(last.bytes.length + extraBytes, 1000 + 3);
    last.bytes = grown;
    base.properties![1].documents![0].fileData = toDataUrl(grown, last.contentType);
  }
  const remainder = target - measure(base);
  if (remainder < 0 || remainder > 3) throw new Error(`Fixture no ajustable: resto ${remainder}`);
  base.expenses![2].description = "Comunidad" + "x".repeat(remainder);
  const state = base;
  if (measure(state) !== target) throw new Error("Fixture no ajustada al byte");

  const raw = {
    ...JSON.parse(JSON.stringify(portfolioBody(state))),
    updatedAt: "2026-10-09T18:00:00.000Z",
  } as Record<string, unknown>;
  return { state, raw, files };
}

function makeProp(id: string, address: string, documents: PropertyDocument[]): Property {
  return {
    id,
    address,
    cadastralReference: `REF-${id}`,
    owner: "both",
    ownershipPercentageUser1: 50,
    ownershipPercentageUser2: 50,
    tenantName: "Inquilino",
    tenantDni: "00000000T",
    monthlyRent: 900,
    purchasePrice: 200000,
    landValuePercent: 30,
    amortizationAmount: 4200,
    expensesCommunity: 0,
    expensesIBI: 0,
    expensesInsurance: 0,
    expensesRepairs: 0,
    registrationDate: "2025-01-01",
    documents,
  };
}
