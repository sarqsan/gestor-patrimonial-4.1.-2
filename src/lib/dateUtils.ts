/**
 * Utilidades puras para el tratamiento robusto de fechas contables y fiscales.
 * 
 * Reglas de negocio:
 * 1. Soporta formato canónico ISO: YYYY-MM-DD.
 * 2. Soporta formatos españoles/europeos: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, D/M/YYYY.
 * 3. Soporta números de serie de hojas de cálculo (Excel/LibreOffice).
 * 4. Jamás interpreta el día (DD) como si fuera el año.
 * 5. Conserva el mínimo legal de 6 años (Art. 30 C.Comercio) de forma estrictamente
 *    no destructiva: jamás purga datos automáticamente.
 */

/**
 * Extrae el año (4 dígitos) de cualquier fecha válida.
 * Devuelve un número entero entre 1900 y 2100, o `null` si no se puede determinar.
 */
export function extractYearFromDate(dateStr: unknown): number | null {
  if (typeof dateStr === "number" && Number.isFinite(dateStr)) {
    // Si ya es un año directo (ej. 2026)
    if (dateStr >= 1900 && dateStr <= 2100) return Math.floor(dateStr);
    // Número serial de Excel (días desde 1899-12-30)
    if (dateStr > 20000 && dateStr < 80000) {
      const ms = Math.round((dateStr - 25569) * 86400 * 1000);
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return d.getUTCFullYear();
    }
  }

  if (typeof dateStr !== "string") return null;
  const s = dateStr.trim();
  if (!s) return null;

  // 1. ISO inicial: YYYY-MM-DD o YYYY/MM/DD o YYYY.MM.DD
  const isoMatch = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (isoMatch) {
    const yr = parseInt(isoMatch[1], 10);
    if (yr >= 1900 && yr <= 2100) return yr;
  }

  // 2. Español/Europeo: DD/MM/YYYY o DD-MM-YYYY o DD.MM.YYYY
  const euMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (euMatch) {
    const yr = parseInt(euMatch[3], 10);
    if (yr >= 1900 && yr <= 2100) return yr;
  }

  // 3. Cadena que contiene un año de 4 dígitos delimitado
  const anyFourDigit = s.match(/(?:^|[^0-9])(19\d\d|20\d\d)(?:[^0-9]|$)/);
  if (anyFourDigit) {
    const yr = parseInt(anyFourDigit[1], 10);
    if (yr >= 1900 && yr <= 2100) return yr;
  }

  // 4. Fallback con Date.parse estándar
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    const yr = parsed.getFullYear();
    if (yr >= 1900 && yr <= 2100) return yr;
  }

  return null;
}

/**
 * Normaliza cualquier formato de fecha a la representación ISO estándar YYYY-MM-DD.
 * Si no es válida o no reconocible, devuelve el valor en cadena recortado o null.
 */
export function normalizeDateToIso(dateStr: unknown): string | null {
  if (typeof dateStr === "number" && Number.isFinite(dateStr) && dateStr > 20000 && dateStr < 80000) {
    const ms = Math.round((dateStr - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }

  if (typeof dateStr !== "string") return null;
  const s = dateStr.trim();
  if (!s) return null;

  // Si ya es estrictamente YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Español/Europeo: DD/MM/YYYY o DD-MM-YYYY o DD.MM.YYYY
  const euMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (euMatch) {
    const day = euMatch[1].padStart(2, "0");
    const month = euMatch[2].padStart(2, "0");
    const year = euMatch[3];
    return `${year}-${month}-${day}`;
  }

  // YYYY/MM/DD o YYYY.MM.DD
  const isoSlashMatch = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoSlashMatch) {
    const year = isoSlashMatch[1];
    const month = isoSlashMatch[2].padStart(2, "0");
    const day = isoSlashMatch[3].padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  // Timestamp ISO: YYYY-MM-DDTHH:mm:...
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    return s.slice(0, 10);
  }

  return s;
}

/**
 * Comprueba si una fecha es anterior a N años respecto a un año de referencia.
 * Nunca borra nada: es una función pura para clasificación o advertencias visuales.
 */
export function isDateOlderThanYears(dateStr: unknown, years = 6, referenceYear = new Date().getFullYear()): boolean {
  const yr = extractYearFromDate(dateStr);
  if (yr === null) return false;
  return (referenceYear - yr) > years;
}
