// Lógica pura de importación de inmuebles y gastos/ingresos (sin DOM ni React),
// para poder comprobarla en pruebas. Módulo al estilo de portfolioPayload.ts.
//
// Principios (obligatorios):
//  - No se inventan importes, fechas, titulares, identificadores ni relaciones
//    entre operaciones e inmuebles: si un dato no viene en el archivo, se omite
//    o se rechaza el registro con motivo explícito.
//  - No se descartan registros en silencio: todo registro no importable queda en
//    `rejected` con su motivo, y los campos faltantes generan `warnings`.
//  - Se reconoce la estructura real de las exportaciones de la aplicación
//    (listas aisladas) y de las copias de seguridad integrales de la cartera,
//    sin confundir una cosa con la otra.

import { Property, PropertyExpense } from "../types";

// ---------------------------------------------------------------------------
// Selección y validación de archivos
// ---------------------------------------------------------------------------

/** Extensiones admitidas para importación (se validan SIEMPRE tras la selección). */
export const IMPORT_EXTENSIONS = [".json", ".xlsx", ".xls", ".csv"] as const;

/**
 * Valor para el atributo `accept` de los selectores de importación.
 * Incluye extensiones Y tipos MIME. En Android el selector del sistema filtra
 * por MIME: si solo se declaran extensiones, los .json (que a menudo llegan
 * como `application/octet-stream` o `text/plain`) aparecen en gris /
 * deshabilitados y no se pueden elegir. La validación definitiva de formato se
 * hace después de seleccionar el archivo mediante validateImportFileName().
 */
export const IMPORT_ACCEPT = [
  ...IMPORT_EXTENSIONS,
  "application/json",
  "text/json",
  "text/plain",
  "text/csv",
  "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/excel",
].join(",");

/**
 * Valida la extensión del fichero YA SELECCIONADO.
 * Devuelve un mensaje de error claro para formatos no admitidos, o null si es válido.
 */
export function validateImportFileName(fileName: string): string | null {
  const lower = (fileName || "").trim().toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  if (!IMPORT_EXTENSIONS.includes(ext as (typeof IMPORT_EXTENSIONS)[number])) {
    const shown = ext || "sin extensión";
    return `Formato no admitido (${shown}). Selecciona un archivo JSON, XLSX, XLS o CSV.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Utilidades de parseo (sin inventar datos)
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasValue = (v: unknown): boolean =>
  v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");

/** Primer valor presente entre las claves admitidas (canónicas o alias de exportación). */
function pick(row: Record<string, any>, ...keys: string[]): { value: any; key: string } | null {
  for (const k of keys) {
    if (hasValue(row[k])) return { value: row[k], key: k };
  }
  return null;
}

/**
 * Número flexible sin inventar: acepta 1234.56, "1234,56", "1.234,56", "1 234,56".
 * Devuelve null si no se puede interpretar (nunca un 0 por defecto).
 */
export function parseFlexibleNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let s = value.trim().replace(/[€\s\u00a0]/g, "");
  if (s === "") return null;
  const neg = s.startsWith("(") && s.endsWith(")");
  if (neg) s = s.slice(1, -1);
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // El separador decimal es el que aparece más a la derecha.
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // Solo comas: "1,5" decimal; "1.234,56" ya tratado; "1,234" con 3 decimales → miles.
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (lastDot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    // Solo puntos con patrón de miles: "1.234" → 1234.
    s = s.replace(/\./g, "");
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** Fecha en claro: números seriales de Excel (p. ej. 45000) → YYYY-MM-DD; texto se conserva. */
function normalizeDateValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 20000 && value < 80000) {
    const ms = Math.round((value - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

// ---------------------------------------------------------------------------
// Detección de estructura de los archivos JSON
// ---------------------------------------------------------------------------

export type ImportStructureKind =
  | "property-list"
  | "expense-list"
  | "portfolio-backup"
  | "unknown";

export interface DetectedStructure {
  kind: ImportStructureKind;
  /** Descripción legible para la vista previa. */
  label: string;
  propertyRows: any[];
  expenseRows: any[];
}

const PROPERTY_ROW_KEYS = [
  "address", "Dirección Completa", "Dirección", "Direccion", "direccion",
  "cadastralReference", "Referencia Catastral", "refCatastral",
  "tenantName", "Inquilino", "monthlyRent", "Renta Mensual (€)", "purchasePrice",
];
const EXPENSE_ROW_KEYS = [
  "amount", "Importe", "Importe (€)", "Importe_EUR", "importe",
  "category", "Categoría Fiscal", "Categoría", "receiptName", "receiptPath",
];

function rowHasAnyKey(row: unknown, keys: string[]): boolean {
  return isObj(row) && keys.some((k) => hasValue(row[k]));
}

function looksLikePropertyRow(row: unknown): boolean {
  return rowHasAnyKey(row, ["address", "Dirección Completa", "Dirección", "Direccion", "direccion", "cadastralReference", "Referencia Catastral"]);
}

function looksLikeExpenseRow(row: unknown): boolean {
  if (!isObj(row)) return false;
  if (looksLikePropertyRow(row)) return false;
  return rowHasAnyKey(row, EXPENSE_ROW_KEYS);
}

const EMPTY_STRUCTURE: DetectedStructure = {
  kind: "unknown",
  label: "Estructura no reconocida",
  propertyRows: [],
  expenseRows: [],
};

/** ¿Copia de seguridad integral de la cartera (estado completo del perfil)? */
function isPortfolioBackup(obj: Record<string, any>): boolean {
  if (!Array.isArray(obj.properties)) return false;
  return (
    "payments" in obj || "expenses" in obj || "user1" in obj ||
    "syncEvents" in obj || "isOnboarded" in obj || "yearlyProfiles" in obj ||
    "contracts" in obj
  );
}

function classifyArray(rows: any[], contextLabel: string): DetectedStructure {
  if (rows.length === 0) return EMPTY_STRUCTURE;
  const sample = rows.find((r) => isObj(r));
  if (!sample) return EMPTY_STRUCTURE;
  if (looksLikePropertyRow(sample)) {
    return { kind: "property-list", label: `Lista de inmuebles (${contextLabel})`, propertyRows: rows, expenseRows: [] };
  }
  if (looksLikeExpenseRow(sample)) {
    return { kind: "expense-list", label: `Lista de gastos/ingresos (${contextLabel})`, propertyRows: [], expenseRows: rows };
  }
  return EMPTY_STRUCTURE;
}

/**
 * Identifica qué contiene el JSON: una lista aislada de inmuebles, una lista de
 * gastos/ingresos o una copia de seguridad integral de la cartera. Nunca trata
 * una copia integral como si fuera una lista aislada: solo se toma la sección
 * correspondiente al tipo de importación.
 */
export function detectImportStructure(parsed: unknown): DetectedStructure {
  if (Array.isArray(parsed)) return classifyArray(parsed, "lista raíz");

  if (!isObj(parsed)) return EMPTY_STRUCTURE;

  // Copia de seguridad integral (documento portfolio de Firestore / respaldo completo).
  if (isPortfolioBackup(parsed)) {
    return {
      kind: "portfolio-backup",
      label: "Copia de seguridad integral de la cartera (respaldo completo)",
      propertyRows: Array.isArray(parsed.properties) ? parsed.properties : [],
      expenseRows: Array.isArray(parsed.expenses) ? parsed.expenses : [],
    };
  }

  // Contenedores anidados habituales: data / portfolio / state.
  for (const containerKey of ["data", "portfolio", "state"]) {
    const nested = parsed[containerKey];
    if (isObj(nested) && !Array.isArray(nested)) {
      const inner = detectImportStructure(nested);
      if (inner.kind !== "unknown") return inner;
    }
    if (Array.isArray(nested)) {
      const inner = classifyArray(nested, containerKey);
      if (inner.kind !== "unknown") return inner;
    }
  }

  // Envoltorios de lista de inmuebles (la clave `properties` exige filas con forma
  // de inmueble para no confundir archivos con esa etiqueta pero otros contenidos).
  for (const key of ["properties", "inmuebles"]) {
    if (Array.isArray(parsed[key]) && parsed[key].length > 0) {
      const firstObj = parsed[key].find((r: unknown) => isObj(r));
      if (key === "inmuebles" || (firstObj && looksLikePropertyRow(firstObj))) {
        return { kind: "property-list", label: `Lista de inmuebles (${key})`, propertyRows: parsed[key], expenseRows: [] };
      }
    }
  }

  // Envoltorios de lista de gastos/ingresos (se combinan gastos e ingresos si vienen separados).
  const expenseParts: any[] = [];
  for (const key of ["expenses", "gastos", "ingresos", "transacciones", "movimientos"]) {
    if (Array.isArray(parsed[key])) expenseParts.push(...parsed[key]);
  }
  if (expenseParts.length > 0) {
    return { kind: "expense-list", label: "Lista de gastos/ingresos", propertyRows: [], expenseRows: expenseParts };
  }

  // Objeto único.
  if (looksLikePropertyRow(parsed)) {
    return { kind: "property-list", label: "Inmueble individual", propertyRows: [parsed], expenseRows: [] };
  }
  if (looksLikeExpenseRow(parsed)) {
    return { kind: "expense-list", label: "Operación individual", propertyRows: [], expenseRows: [parsed] };
  }

  // Último recurso: primera clave con un array de filas reconocibles.
  for (const [key, value] of Object.entries(parsed)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const inner = classifyArray(value, key);
    if (inner.kind !== "unknown") return inner;
  }

  return EMPTY_STRUCTURE;
}

// ---------------------------------------------------------------------------
// Mapeo de inmuebles
// ---------------------------------------------------------------------------

export interface ImportIssue {
  index: number;
  key: string;
  reason: string;
}

export interface PropertyImportResult {
  properties: Property[];
  rejected: ImportIssue[];
  warnings: ImportIssue[];
  structure: DetectedStructure;
  error: string | null;
}

function normalizeOwner(value: unknown): Property["owner"] | null {
  const s = String(value ?? "").trim().toLowerCase();
  if (["user1", "usuario1", "usuario 1", "titular1", "titular 1", "u1", "1"].includes(s)) return "user1";
  if (["user2", "usuario2", "usuario 2", "titular2", "titular 2", "u2", "2"].includes(s)) return "user2";
  if (["both", "joint", "ambos", "conjunto", "ambos cónyuges", "ambos conyuges", "user1+user2", "u1+u2"].includes(s)) return "both";
  return null;
}

type PropertyRowMap =
  | { ok: true; property: Property; warnings: ImportIssue[] }
  | { ok: false; reason: string };

const OPTIONAL_MONEY_FIELDS: Array<[keyof Property, string[]]> = [
  ["monthlyRent", ["monthlyRent", "Renta Mensual (€)", "Renta Mensual"]],
  ["purchasePrice", ["purchasePrice", "Precio Adquisición (€)", "Precio Adquisicion"]],
  ["landValuePercent", ["landValuePercent", "% Suelo Catastral"]],
  ["amortizationAmount", ["amortizationAmount", "Amortización Anual (€)", "Amortizacion Anual (€)", "Amortización Anual"]],
  ["expensesCommunity", ["expensesCommunity", "Gastos Comunidad (€)", "Gastos Comunidad"]],
  ["expensesIBI", ["expensesIBI", "Gastos IBI (€)"]],
  ["expensesInsurance", ["expensesInsurance", "Gastos Seguro (€)", "Gastos Seguros (€)"]],
  ["expensesRepairs", ["expensesRepairs", "Gastos Reparaciones (€)", "Gastos Reparaciones"]],
];

/** Campos opcionales que se conservan tal cual cuando vienen en la exportación. */
const PROPERTY_EXTRA_NUMBER_FIELDS: Array<[keyof Property, string[]]> = [
  ["currentValue", ["currentValue", "Valor Actual (€)", "Valor Actual"]],
  ["mortgageDebt", ["mortgageDebt", "Deuda Hipotecaria (€)"]],
  ["monthlyMortgagePayment", ["monthlyMortgagePayment", "Cuota Hipoteca (€)"]],
  ["mortgageInterestRate", ["mortgageInterestRate", "Tipo Interés Hipoteca (%)"]],
  ["mortgageTermYears", ["mortgageTermYears", "Plazo Hipoteca (años)"]],
];
const PROPERTY_EXTRA_RAW_FIELDS: Array<[keyof Property, string[]]> = [
  ["mortgageStartDate", ["mortgageStartDate", "Fecha Inicio Hipoteca"]],
  ["contract", ["contract"]],
  ["tenantHistory", ["tenantHistory"]],
  ["yearlyFinancials", ["yearlyFinancials"]],
  ["documents", ["documents"]],
];

function mapPropertyRow(row: Record<string, any>, index: number): PropertyRowMap {
  const warnings: ImportIssue[] = [];

  const addrPick = pick(row, "address", "Dirección Completa", "Dirección", "Direccion", "direccion", "Address");
  if (!addrPick) return { ok: false, reason: "dirección no informada" };
  const address = String(addrPick.value).trim();
  if (address === "") return { ok: false, reason: "dirección vacía" };

  const ownerPick = pick(row, "owner", "Titularidad", "Titular", "titularidad");
  if (!ownerPick) return { ok: false, reason: "titularidad no informada (no se inventan titulares)" };
  const owner = normalizeOwner(ownerPick.value);
  if (!owner) return { ok: false, reason: `titularidad «${String(ownerPick.value)}» no reconocida (user1, user2 o both)` };

  // Porcentajes de titularidad: solo se derivan cuando la titularidad única los implica.
  const pct1Pick = pick(row, "ownershipPercentageUser1", "% Propietario 1", "%Propietario 1");
  const pct2Pick = pick(row, "ownershipPercentageUser2", "% Propietario 2", "%Propietario 2");
  let pct1: number;
  let pct2: number;
  if (pct1Pick && pct2Pick) {
    const a = parseFlexibleNumber(pct1Pick.value);
    const b = parseFlexibleNumber(pct2Pick.value);
    if (a === null || b === null) return { ok: false, reason: "porcentajes de titularidad no numéricos" };
    pct1 = a;
    pct2 = b;
  } else if (!pct1Pick && !pct2Pick && owner !== "both") {
    pct1 = owner === "user1" ? 100 : 0;
    pct2 = owner === "user2" ? 100 : 0;
    warnings.push({ index, key: "ownershipPercentage", reason: "porcentajes derivados de la titularidad única (no venían en el archivo)" });
  } else {
    return { ok: false, reason: "porcentajes de titularidad incompletos para la titularidad informada" };
  }

  // Importes: si no vienen, 0 marcado como «no informado»; si vienen ilegibles, se rechaza el registro.
  const money: Record<string, number> = {};
  for (const [field, keys] of OPTIONAL_MONEY_FIELDS) {
    const p = pick(row, ...keys);
    if (!p) {
      money[field as string] = 0;
      warnings.push({ index, key: String(field), reason: "campo no informado en el archivo (se importa a 0, sin inventar importes)" });
    } else {
      const n = parseFlexibleNumber(p.value);
      if (n === null) return { ok: false, reason: `«${p.key}» no es un importe válido (${String(p.value)})` };
      money[field as string] = n;
    }
  }

  const regPick = pick(row, "registrationDate", "Fecha Registro", "fechaRegistro");
  let registrationDate = "";
  if (regPick) {
    const d = normalizeDateValue(regPick.value);
    if (d === null) return { ok: false, reason: "fecha de registro no válida" };
    registrationDate = d;
  } else {
    warnings.push({ index, key: "registrationDate", reason: "sin fecha de registro (no se inventan fechas)" });
  }

  const idPick = pick(row, "id", "ID Inmueble");
  const tenantNamePick = pick(row, "tenantName", "Inquilino");
  const tenantDniPick = pick(row, "tenantDni", "DNI Inquilino");
  const refPick = pick(row, "cadastralReference", "Referencia Catastral", "refCatastral", "Ref Catastral");

  const property: Property = {
    // Clave técnica local solo si el archivo no trae identificador.
    id: idPick ? String(idPick.value) : `prop_imp_${Date.now()}_${index}`,
    address,
    cadastralReference: refPick ? String(refPick.value) : "",
    owner,
    ownershipPercentageUser1: pct1,
    ownershipPercentageUser2: pct2,
    tenantName: tenantNamePick ? String(tenantNamePick.value) : "",
    tenantDni: tenantDniPick ? String(tenantDniPick.value) : "",
    monthlyRent: money.monthlyRent as number,
    purchasePrice: money.purchasePrice as number,
    landValuePercent: money.landValuePercent as number,
    amortizationAmount: money.amortizationAmount as number,
    expensesCommunity: money.expensesCommunity as number,
    expensesIBI: money.expensesIBI as number,
    expensesInsurance: money.expensesInsurance as number,
    expensesRepairs: money.expensesRepairs as number,
    registrationDate,
  };

  // Conservar campos compatibles adicionales de la exportación (hipoteca, contrato,
  // historial, datos anuales y documentos) sin transformarlos.
  for (const [field, keys] of PROPERTY_EXTRA_NUMBER_FIELDS) {
    const p = pick(row, ...keys);
    if (!p) continue;
    const n = parseFlexibleNumber(p.value);
    if (n === null) {
      warnings.push({ index, key: String(field), reason: `valor no numérico «${String(p.value)}»; campo omitido` });
      continue;
    }
    (property as any)[field] = n;
  }
  for (const [field, keys] of PROPERTY_EXTRA_RAW_FIELDS) {
    const p = pick(row, ...keys);
    if (!p) continue;
    (property as any)[field] = p.value;
  }

  return { ok: true, property, warnings };
}

function mapPropertyRows(rows: any[]): PropertyImportResult {
  const properties: Property[] = [];
  const rejected: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  rows.forEach((row, index) => {
    if (!isObj(row)) {
      rejected.push({ index, key: `registro ${index + 1}`, reason: "el registro no es un objeto reconocible" });
      return;
    }
    const res = mapPropertyRow(row, index);
    if ("reason" in res) {
      rejected.push({ index, key: `registro ${index + 1}`, reason: res.reason });
    } else {
      properties.push(res.property);
      warnings.push(...res.warnings);
    }
  });
  return {
    properties,
    rejected,
    warnings,
    structure: EMPTY_STRUCTURE,
    error: null,
  };
}

const PROPERTY_LIST_ERROR =
  "No se ha encontrado un listado de inmuebles en el archivo. Asegúrate de que el archivo exportado contenga los datos de los inmuebles.";

export function parsePropertiesFromText(text: string): PropertyImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { properties: [], rejected: [], warnings: [], structure: EMPTY_STRUCTURE, error: "El archivo no es JSON válido. Comprueba que sea una exportación correcta." };
  }
  const structure = detectImportStructure(parsed);
  if (structure.kind === "expense-list") {
    return {
      properties: [], rejected: [], warnings: [], structure,
      error: "El archivo contiene una lista de gastos/ingresos, no de inmuebles. Impórtalo desde el módulo de Gastos e Ingresos.",
    };
  }
  if (structure.kind !== "property-list" && structure.kind !== "portfolio-backup") {
    return { properties: [], rejected: [], warnings: [], structure, error: PROPERTY_LIST_ERROR };
  }
  const result = mapPropertyRows(structure.propertyRows);
  result.structure = structure;
  if (result.properties.length === 0 && result.rejected.length === 0) {
    result.error = PROPERTY_LIST_ERROR;
  }
  return result;
}

export function parsePropertiesFromRows(rows: any[]): PropertyImportResult {
  const result = mapPropertyRows(rows);
  result.structure = { kind: "property-list", label: "Hoja de cálculo", propertyRows: rows, expenseRows: [] };
  return result;
}

// ---------------------------------------------------------------------------
// Mapeo de gastos e ingresos
// ---------------------------------------------------------------------------

export interface ExpenseImportResult {
  expenses: PropertyExpense[];
  rejected: ImportIssue[];
  warnings: ImportIssue[];
  structure: DetectedStructure;
  error: string | null;
}

const EXPENSE_CATEGORIES: Array<[PropertyExpense["category"], string[]]> = [
  ["repairs", ["repairs", "reparaciones y conservación", "reparaciones y conservacion", "reparaciones"]],
  ["ibi", ["ibi", "impuestos y tasas (ibi)", "impuestos y tasas", "impuestos"]],
  ["insurance", ["insurance", "primas de seguros", "seguros", "seguro"]],
  ["community", ["community", "gastos de comunidad", "comunidad"]],
  ["maintenance", ["maintenance", "mantenimiento / suministros", "mantenimiento", "suministros"]],
  ["amortization", ["amortization", "amortización inmueble (3% s/v.c.)", "amortización inmueble", "amortizacion inmueble", "amortización", "amortizacion"]],
  ["rent", ["rent", "ingresos por alquiler", "alquiler", "renta"]],
  ["other", ["other", "otros gastos deducibles", "otros"]],
];

function normalizeCategory(value: unknown): PropertyExpense["category"] | null {
  const s = String(value ?? "").trim().toLowerCase();
  for (const [code, aliases] of EXPENSE_CATEGORIES) {
    if (aliases.includes(s)) return code;
  }
  return null;
}

type ExpenseRowMap =
  | { ok: true; expense: PropertyExpense; warnings: ImportIssue[] }
  | { ok: false; reason: string };

function mapExpenseRow(row: Record<string, any>, index: number): ExpenseRowMap {
  const warnings: ImportIssue[] = [];

  const amountPick = pick(row, "amount", "Importe (€)", "Importe", "Importe_EUR", "importe");
  if (!amountPick) return { ok: false, reason: "importe no informado (no se inventan importes)" };
  const amount = parseFlexibleNumber(amountPick.value);
  if (amount === null) return { ok: false, reason: `importe «${String(amountPick.value)}» no válido` };

  const datePick = pick(row, "date", "Fecha", "fecha");
  if (!datePick) return { ok: false, reason: "fecha no informada (no se inventan fechas)" };
  const date = normalizeDateValue(datePick.value);
  if (date === null) return { ok: false, reason: "fecha no válida" };

  const catPick = pick(row, "category", "Categoría Fiscal", "Categoría", "Categoria", "categoria");
  const typePick = pick(row, "type", "Tipo Registro", "Tipo", "type_op", "tipo");

  let category: PropertyExpense["category"];
  if (catPick) {
    const normalized = normalizeCategory(catPick.value);
    if (normalized) {
      category = normalized;
    } else {
      // Se conserva la categoría original aunque no sea de las habituales, sin inventar otra.
      category = String(catPick.value).trim() as PropertyExpense["category"];
      warnings.push({ index, key: "category", reason: `categoría «${String(catPick.value)}» conservada sin normalizar` });
    }
  } else {
    // Sin categoría: la única derivación segura es la que implica el tipo de operación.
    const typeStr = typePick ? String(typePick.value).trim().toLowerCase() : "";
    category = typeStr.includes("ingreso") ? "rent" : "other";
    warnings.push({ index, key: "category", reason: "categoría no informada; clasificada por el tipo de operación" });
  }

  let type: "gasto" | "ingreso";
  if (typePick) {
    const t = String(typePick.value).trim().toLowerCase();
    if (t.includes("ingreso")) type = "ingreso";
    else if (t.includes("gasto")) type = "gasto";
    else return { ok: false, reason: `tipo de operación «${String(typePick.value)}» no reconocido (gasto o ingreso)` };
  } else {
    type = category === "rent" ? "ingreso" : "gasto";
    warnings.push({ index, key: "type", reason: "tipo derivado de la categoría (no venía en el archivo)" });
  }

  const idPick = pick(row, "id", "ID Transacción", "ID Transaccion");
  // Relación con el inmueble: solo se conserva si viene en el archivo. Nunca se inventa.
  const propPick = pick(row, "propertyId", "property_id", "ID Inmueble", "idInmueble");
  let propertyId = "";
  if (propPick) {
    propertyId = String(propPick.value);
  } else {
    warnings.push({ index, key: "propertyId", reason: "operación sin inmueble asociado en el archivo; no se inventa la relación (revisa la asignación)" });
  }

  const descPick = pick(row, "description", "Descripción / Concepto", "Descripción", "Descripcion", "descripcion", "Concepto", "concepto");
  const receiptUrlPick = pick(row, "receiptUrl", "receipt_url");
  const receiptPathPick = pick(row, "receiptPath", "receipt_path");
  const receiptNamePick = pick(row, "receiptName", "Nombre Comprobante", "Nombre Archivo Adjunto", "receipt_name");
  const receiptTypePick = pick(row, "receiptType", "receipt_type");

  const expense: PropertyExpense = {
    id: idPick ? String(idPick.value) : `exp_imp_${Date.now()}_${index}`,
    propertyId,
    category,
    type,
    amount,
    date,
  };
  if (descPick) expense.description = String(descPick.value);
  if (receiptUrlPick) expense.receiptUrl = String(receiptUrlPick.value);
  if (receiptPathPick) expense.receiptPath = String(receiptPathPick.value);
  if (receiptNamePick) expense.receiptName = String(receiptNamePick.value);
  if (receiptTypePick) expense.receiptType = String(receiptTypePick.value);

  return { ok: true, expense, warnings };
}

function mapExpenseRows(rows: any[]): ExpenseImportResult {
  const expenses: PropertyExpense[] = [];
  const rejected: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  rows.forEach((row, index) => {
    if (!isObj(row)) {
      rejected.push({ index, key: `registro ${index + 1}`, reason: "el registro no es un objeto reconocible" });
      return;
    }
    const res = mapExpenseRow(row, index);
    if ("reason" in res) {
      rejected.push({ index, key: `registro ${index + 1}`, reason: res.reason });
    } else {
      expenses.push(res.expense);
      warnings.push(...res.warnings);
    }
  });
  return {
    expenses,
    rejected,
    warnings,
    structure: EMPTY_STRUCTURE,
    error: null,
  };
}

const EXPENSE_LIST_ERROR =
  "No se ha encontrado un listado de gastos/ingresos en el archivo. Asegúrate de que el archivo exportado contenga operaciones contables.";

export function parseExpensesFromText(text: string): ExpenseImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { expenses: [], rejected: [], warnings: [], structure: EMPTY_STRUCTURE, error: "El archivo no es JSON válido. Comprueba que sea una exportación correcta." };
  }
  const structure = detectImportStructure(parsed);
  if (structure.kind === "property-list") {
    return {
      expenses: [], rejected: [], warnings: [], structure,
      error: "El archivo contiene una lista de inmuebles, no de gastos/ingresos. Impórtalo desde el módulo de Inmuebles.",
    };
  }
  if (structure.kind !== "expense-list" && structure.kind !== "portfolio-backup") {
    return { expenses: [], rejected: [], warnings: [], structure, error: EXPENSE_LIST_ERROR };
  }
  const result = mapExpenseRows(structure.expenseRows);
  result.structure = structure;
  if (result.expenses.length === 0 && result.rejected.length === 0) {
    result.error = structure.kind === "portfolio-backup"
      ? "La copia de seguridad integral no contiene gastos/ingresos que importar."
      : EXPENSE_LIST_ERROR;
  }
  return result;
}

export function parseExpensesFromRows(rows: any[]): ExpenseImportResult {
  const result = mapExpenseRows(rows);
  result.structure = { kind: "expense-list", label: "Hoja de cálculo", propertyRows: [], expenseRows: rows };
  return result;
}
