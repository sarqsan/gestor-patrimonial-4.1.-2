// Pruebas del servicio de entidades patrimoniales remotas (portfolioRemote).
// Ejecutar con: npm test (node:test + tsx; fetch y localStorage se stubban, sin red real)
import test from "node:test";
import assert from "node:assert/strict";
import {
  clearPortfolioSyncCache,
  entitiesToPortfolio,
  loadPortfolioEntities,
  portfolioToEntities,
  stableEntityId,
  syncPortfolioEntities,
} from "./portfolioRemote";
import { VaultAuthError, VaultError, storeVaultToken, clearVaultToken } from "./vaultClient";
import type { PortfolioBody } from "./portfolioRemote";

/** localStorage en memoria (el runner de Node 22 no tiene almacenamiento web). */
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  return store;
}

interface Call {
  method: string;
  url: string;
  body?: any;
}

/** Servidor falso del vault: almacén por `type/id` con registro de llamadas. */
function installVaultServer(): {
  calls: Call[];
  store: Map<string, any>;
  failMode: { on: boolean };
} {
  const calls: Call[] = [];
  const store = new Map<string, any>();
  const failMode = { on: false };
  (globalThis as any).fetch = async (url: string, init?: any) => {
    const method = init?.method ?? "GET";
    const payload = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body: payload });
    const u = new URL(url, "http://fake");
    const op = u.searchParams.get("op");
    const type = u.searchParams.get("type") as string | null;
    const id = u.searchParams.get("id");
    if (init?.headers?.authorization !== "Bearer tok-ana") {
      return { ok: false, status: 401, json: async () => ({ ok: false, error: "sesión" }) };
    }
    if (failMode.on) {
      return { ok: false, status: 503, json: async () => ({ ok: false, error: "almacén no disponible" }) };
    }
    if (op === "entities.list") {
      const entities = [...store.entries()]
        .filter(([k]) => k.startsWith(`${type}/`))
        .map(([k, data]) => ({ id: k.slice((type as string).length + 1), updatedAt: "t", data }));
      return { ok: true, status: 200, json: async () => ({ ok: true, entities }) };
    }
    if (op === "entities.put") {
      store.set(`${payload.type}/${payload.id}`, payload.entity);
      return { ok: true, status: 201, json: async () => ({ ok: true, entity: { id: payload.id, updatedAt: "t" } }) };
    }
    if (op === "entities.delete") {
      const key = `${type}/${id}`;
      const existed = store.delete(key);
      return existed
        ? { ok: true, status: 204, json: async () => null }
        : { ok: false, status: 404, json: async () => ({ ok: false, error: "no existe" }) };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false, error: `op? ${op}` }) };
  };
  return { calls, store, failMode };
}

const NATIVE_FETCH = (globalThis as any).fetch;

test.beforeEach(() => {
  installLocalStorage();
  clearPortfolioSyncCache();
  storeVaultToken("ana", "tok-ana");
});
test.afterEach(() => {
  delete (globalThis as any).localStorage;
  (globalThis as any).fetch = NATIVE_FETCH;
  clearVaultToken("ana");
});

function sampleBody(): PortfolioBody {
  return {
    user1: { name: "Ana", dni: "00000001R", brutoTrabajo: 30000, netoTrabajo: 24000 },
    user2: { name: "Beto", dni: "00000002R", brutoTrabajo: 20000, netoTrabajo: 16000, hasPartner: true },
    properties: [
      {
        id: "prop_1",
        address: "Calle 1",
        cadastralReference: "cc1",
        owner: "both",
        ownershipPercentageUser1: 60,
        ownershipPercentageUser2: 40,
        tenantName: "Inq",
        tenantDni: "00000003T",
        monthlyRent: 900,
        purchasePrice: 100000,
        landValuePercent: 30,
        amortizationAmount: 700,
        expensesCommunity: 0,
        expensesIBI: 0,
        expensesInsurance: 0,
        expensesRepairs: 0,
        registrationDate: "2026-01-01",
        contract: { startDate: "2026-01-01", monthlyRent: 900, pdfVaultId: "file_c1" },
        tenantHistory: [{ id: "ct_1", tenantName: "Inq", tenantDni: "00000003T", startDate: "2026-01-01", monthlyRent: 900 }],
        documents: [{ id: "doc_1", name: "ibi.pdf", size: "1 KB", type: "application/pdf", category: "ibi", year: 2026, uploadDate: "2026-02-01", vaultId: "file_d1" }],
      } as any,
    ],
    payments: [{ id: "pay_1", propertyId: "prop_1", month: "Enero", year: 2026, amount: 900, status: "pending" }],
    expenses: [{ id: "mov_1", propertyId: "prop_1", category: "rent", type: "ingreso", amount: 900, date: "2026-01-01", receiptVaultId: "file_r1" }] as any,
    contracts: [{ titulo: "cláusulas", propertyId: "prop_1" }],
    syncEvents: [{ id: "evt_1", timestamp: "t", sourceModule: "a", targetModule: "b", action: "x", details: "y" }],
    syncEnabled: true,
    isOnboarded: true,
    currentYear: 2026,
    yearlyProfiles: {},
    theme: "slate-indigo",
  } as unknown as PortfolioBody;
}

test("PR1. La cartera se divide en entidades por tipo con identificadores estables y relaciones íntegras", async () => {
  const entities = await portfolioToEntities(sampleBody());
  const byType = (t: string) => entities.filter((e) => e.type === t);
  assert.equal(byType("owners").length, 2);
  assert.equal(byType("properties").length, 1);
  assert.equal(byType("payments").length, 1);
  assert.equal(byType("contracts").length, 1);
  assert.equal(byType("settings").length, 1);
  // El contrato sin id propio recibe uno estable derivado del contenido.
  assert.match(byType("contracts")[0].id, /^ent_[0-9a-f]{16}$/);
  assert.equal(byType("contracts")[0].id, await stableEntityId(undefined, { titulo: "cláusulas", propertyId: "prop_1" }));
  // Relaciones preservadas dentro de la entidad del inmueble.
  const prop = byType("properties")[0].entity as any;
  assert.equal(prop.contract.pdfVaultId, "file_c1");
  assert.equal(prop.tenantHistory[0].id, "ct_1");
  assert.equal(prop.documents[0].vaultId, "file_d1");
  assert.equal(prop.ownershipPercentageUser1, 60);
  // El orden de visualización se guarda en settings.
  const settings = byType("settings")[0].entity as any;
  assert.deepEqual(settings.order.properties, ["prop_1"]);
});

test("PR2. Recomposición: entitiesToPortfolio reconstruye la cartera con orden y relaciones", async () => {
  const original = sampleBody();
  const entities = await portfolioToEntities(original);
  const groups: any = { owners: [], properties: [], contracts: [], payments: [], settings: [] };
  for (const e of entities) {
    groups[e.type].push({ id: e.id, updatedAt: "t", data: e.entity });
  }
  const rebuilt = await entitiesToPortfolio(groups);
  assert.deepEqual(rebuilt.user1, original.user1);
  assert.deepEqual(rebuilt.properties, original.properties);
  assert.deepEqual(rebuilt.payments, original.payments);
  assert.deepEqual(rebuilt.contracts, original.contracts);
  assert.equal(rebuilt.currentYear, 2026);
  assert.equal(rebuilt.theme, "slate-indigo");
});

test("PR3. syncPortfolioEntities solo escribe lo que cambia y elimina lo desaparecido", async () => {
  const { calls, store } = installVaultServer();
  const body = sampleBody();

  const first = await syncPortfolioEntities("ana", body);
  assert.equal(first.saved, 6, "owners×2 + property + contract + payment + settings");
  assert.ok(store.has("settings/app"));
  assert.ok(store.has("properties/prop_1"));

  const putsAfterFirst = calls.filter((c) => c.method === "POST").length;
  // Segunda sincronización sin cambios: cero escrituras (la caché filtra).
  const second = await syncPortfolioEntities("ana", body);
  assert.equal(second.saved, 0);
  assert.equal(calls.filter((c) => c.method === "POST").length, putsAfterFirst);

  // Se modifica un inmueble: solo esa entidad se reescribe.
  body.properties[0] = { ...(body.properties[0] as any), address: "Calle 1 bis" };
  const third = await syncPortfolioEntities("ana", body);
  assert.equal(third.saved, 1);
  assert.equal((store.get("properties/prop_1") as any).address, "Calle 1 bis");

  // Desaparece el recibo: se borra del remoto.
  body.payments = [];
  const fourth = await syncPortfolioEntities("ana", body);
  assert.equal(fourth.deleted, 1);
  assert.ok(!store.has("payments/pay_1"));
  // settings nunca se borra (marcador de estado remoto).
  assert.ok(store.has("settings/app"));
});

test("PR4. loadPortfolioEntities: sin marcador devuelve null; con marcador reconstruye la cartera", async () => {
  const { calls, store } = installVaultServer();
  clearPortfolioSyncCache();
  assert.equal(await loadPortfolioEntities("ana"), null, "cuenta nueva: sin estado remoto todavía");

  store.set("settings/app", { syncEvents: [], syncEnabled: true, isOnboarded: true, currentYear: 2026, yearlyProfiles: {}, theme: "slate-indigo", order: { properties: ["prop_2", "prop_1"], contracts: [], payments: [] } });
  store.set("owners/user1", { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0 });
  store.set("owners/user2", { name: "", dni: "", brutoTrabajo: 0, netoTrabajo: 0, hasPartner: false });
  store.set("properties/prop_1", { id: "prop_1", address: "Uno", cadastralReference: "", owner: "user1", ownershipPercentageUser1: 100, ownershipPercentageUser2: 0, tenantName: "", tenantDni: "", monthlyRent: 0, purchasePrice: 0, landValuePercent: 0, amortizationAmount: 0, expensesCommunity: 0, expensesIBI: 0, expensesInsurance: 0, expensesRepairs: 0, registrationDate: "" });
  store.set("properties/prop_2", { id: "prop_2", address: "Dos", cadastralReference: "", owner: "user1", ownershipPercentageUser1: 100, ownershipPercentageUser2: 0, tenantName: "", tenantDni: "", monthlyRent: 0, purchasePrice: 0, landValuePercent: 0, amortizationAmount: 0, expensesCommunity: 0, expensesIBI: 0, expensesInsurance: 0, expensesRepairs: 0, registrationDate: "" });
  const body = await loadPortfolioEntities("ana");
  assert.ok(body);
  assert.deepEqual(body!.properties.map((p: any) => p.id), ["prop_2", "prop_1"], "el orden remoto se respeta");

  // Lo cargado ya está en la caché de sincronización: reempujarlo no reescribe nada.
  const pushes = calls.filter((c) => c.method === "POST").length;
  const again = await syncPortfolioEntities("ana", body!);
  assert.equal(again.saved, 0);
  assert.equal(calls.filter((c) => c.method === "POST").length, pushes);
});

test("PR5. Errores explícitos: sin sesión, sesión inválida y almacén caído", async () => {
  const { failMode } = installVaultServer();
  clearVaultToken("ana");
  await assert.rejects(() => syncPortfolioEntities("ana", sampleBody()), (e: unknown) => e instanceof VaultAuthError);

  storeVaultToken("ana", "tok-ana");
  failMode.on = true;
  await assert.rejects(
    () => syncPortfolioEntities("ana", sampleBody()),
    (e: unknown) => e instanceof VaultError && /no ha confirmado/i.test((e as Error).message)
  );

  failMode.on = false;
  (globalThis as any).fetch = async () => {
    throw new Error("red caída");
  };
  await assert.rejects(() => loadPortfolioEntities("ana"), (e: unknown) => e instanceof VaultError);
});
