export interface UserProfile {
  name: string;
  dni: string;
  brutoTrabajo: number;
  netoTrabajo: number;
  address?: string;
}

export interface PartnerProfile {
  name: string;
  dni: string;
  brutoTrabajo: number;
  netoTrabajo: number;
  hasPartner: boolean;
  address?: string;
}

export interface PropertyContract {
  startDate: string;
  endDate?: string;
  monthlyRent: number;
  pdfName?: string;
  pdfSize?: string;
}

export interface TenantContractRecord {
  id: string;
  tenantName: string;
  tenantDni: string;
  startDate: string; // YYYY-MM-DD
  endDate?: string;  // YYYY-MM-DD
  monthlyRent: number;
  pdfName?: string;
  pdfSize?: string;
  notes?: string;
}

export interface PropertyYearlyFinancials {
  currentValue?: number; // valor actual
  purchasePrice?: number; // valor de compra
  purchaseExpenses?: number; // total gastos operación compra
  mortgageDebt?: number; // capital pendiente de hipoteca
  monthlyMortgagePayment?: number; // cuota hipotecaria mensual
  isManual?: boolean; // indica si la cifra fue introducida/modificada manualmente
}

export interface PropertyDocument {
  id: string;
  name: string;
  size: string;
  type: string;
  category: 'ibi' | 'seguros' | 'comunidad' | 'reparaciones' | 'muebles_electrodomesticos' | 'otros';
  year: number;
  uploadDate: string;
  fileData?: string; // Base64 data URL
}

export interface Property {
  id: string;
  address: string;
  cadastralReference: string;
  owner: 'user1' | 'user2' | 'both';
  ownershipPercentageUser1: number;
  ownershipPercentageUser2: number;
  tenantName: string;
  tenantDni: string;
  monthlyRent: number;
  purchasePrice: number;
  currentValue?: number; // valor actual de mercado general
  mortgageDebt?: number; // capital pendiente de hipoteca general
  monthlyMortgagePayment?: number; // cuota hipotecaria mensual general
  mortgageInterestRate?: number; // tipo de interés nominal anual (%) general
  mortgageStartDate?: string; // fecha de referencia / inicio hipoteca (YYYY-MM-DD)
  mortgageTermYears?: number; // plazo total de hipoteca en años
  landValuePercent: number; // e.g. 30 for 30% land, 70% construction
  amortizationAmount: number; // standard 3% of construction value (purchasePrice * (100 - landValuePercent) / 100 * 0.03)
  expensesCommunity: number; // annual
  expensesIBI: number; // annual
  expensesInsurance: number; // annual
  expensesRepairs: number; // annual
  registrationDate: string;
  contract?: PropertyContract;
  tenantHistory?: TenantContractRecord[];
  yearlyFinancials?: Record<number, PropertyYearlyFinancials>;
  documents?: PropertyDocument[];
}

export interface RentPayment {
  id: string;
  propertyId: string;
  month: string; // e.g. "Enero"
  year: number;
  amount: number;
  status: 'paid' | 'pending' | 'late';
  datePaid?: string;
}

export interface SyncEvent {
  id: string;
  timestamp: string;
  sourceModule: string;
  targetModule: string;
  action: string;
  details: string;
}

export interface PropertyExpense {
  id: string;
  propertyId: string;
  category: 'repairs' | 'ibi' | 'insurance' | 'community' | 'maintenance' | 'amortization' | 'other' | 'rent';
  type?: 'gasto' | 'ingreso';
  amount: number;
  date: string; // YYYY-MM-DD
  description?: string;
  receiptUrl?: string;
  receiptName?: string;
  receiptType?: string;
}

export interface AppState {
  user1: UserProfile;
  user2: PartnerProfile;
  properties: Property[];
  payments: RentPayment[];
  expenses?: PropertyExpense[];
  contracts?: any[];
  syncEvents: SyncEvent[];
  syncEnabled: boolean;
  isOnboarded: boolean;
  isAuthenticated?: boolean;
  currentUser?: string;
  registeredUsers?: Record<string, string>;
  currentYear?: number;
  yearlyProfiles?: Record<number, { user1: UserProfile; user2: PartnerProfile }>;
  theme?: string;
}

export interface ThemeColors {
  primaryText: string;
  primaryBg: string;
  primaryBgLight: string;
  primaryBorder: string;
  primaryBorderHover: string;
  gradientFromTo: string;
  gradientTo: string;
  gradientFromToLight: string;
  accentText: string;
  ring: string;
  iconBg: string;
  iconText: string;
  badgeBg: string;
  badgeText: string;
}

export function getThemeColors(themeName?: string): ThemeColors {
  switch (themeName) {
    case "cosmic-teal":
      return {
        primaryText: "text-cyan-400",
        primaryBg: "bg-cyan-600",
        primaryBgLight: "bg-cyan-600/20",
        primaryBorder: "border-cyan-500/20",
        primaryBorderHover: "hover:border-cyan-500/40",
        gradientFromTo: "from-cyan-600 to-teal-600",
        gradientTo: "to-cyan-600",
        gradientFromToLight: "from-cyan-950/20 via-slate-900/40 to-slate-900/60",
        accentText: "text-cyan-300",
        ring: "focus:ring-cyan-500",
        iconBg: "bg-cyan-600/20",
        iconText: "text-cyan-400",
        badgeBg: "bg-cyan-500/10",
        badgeText: "text-cyan-400",
      };
    case "warm-amber":
      return {
        primaryText: "text-amber-400",
        primaryBg: "bg-amber-600",
        primaryBgLight: "bg-amber-600/20",
        primaryBorder: "border-amber-500/20",
        primaryBorderHover: "hover:border-amber-500/40",
        gradientFromTo: "from-amber-600 to-orange-600",
        gradientTo: "to-amber-600",
        gradientFromToLight: "from-amber-950/20 via-slate-900/40 to-slate-900/60",
        accentText: "text-amber-300",
        ring: "focus:ring-amber-500",
        iconBg: "bg-amber-600/20",
        iconText: "text-amber-400",
        badgeBg: "bg-amber-500/10",
        badgeText: "text-amber-400",
      };
    case "emerald-forest":
      return {
        primaryText: "text-emerald-400",
        primaryBg: "bg-emerald-600",
        primaryBgLight: "bg-emerald-600/20",
        primaryBorder: "border-emerald-500/20",
        primaryBorderHover: "hover:border-emerald-500/40",
        gradientFromTo: "from-emerald-600 to-teal-600",
        gradientTo: "to-emerald-600",
        gradientFromToLight: "from-emerald-950/20 via-slate-900/40 to-slate-900/60",
        accentText: "text-emerald-300",
        ring: "focus:ring-emerald-500",
        iconBg: "bg-emerald-600/20",
        iconText: "text-emerald-400",
        badgeBg: "bg-emerald-500/10",
        badgeText: "text-emerald-400",
      };
    case "slate-indigo":
    default:
      return {
        primaryText: "text-indigo-400",
        primaryBg: "bg-indigo-600",
        primaryBgLight: "bg-indigo-600/20",
        primaryBorder: "border-indigo-500/20",
        primaryBorderHover: "hover:border-indigo-500/40",
        gradientFromTo: "from-indigo-600 to-violet-600",
        gradientTo: "to-indigo-600",
        gradientFromToLight: "from-indigo-950/20 via-slate-900/40 to-slate-900/60",
        accentText: "text-indigo-300",
        ring: "focus:ring-indigo-500",
        iconBg: "bg-indigo-600/20",
        iconText: "text-indigo-400",
        badgeBg: "bg-indigo-500/10",
        badgeText: "text-indigo-400",
      };
    case "light-clear":
      return {
        primaryText: "text-indigo-600",
        primaryBg: "bg-indigo-600",
        primaryBgLight: "bg-indigo-50",
        primaryBorder: "border-slate-200",
        primaryBorderHover: "hover:border-slate-300",
        gradientFromTo: "from-indigo-600 to-violet-600",
        gradientTo: "to-indigo-600",
        gradientFromToLight: "from-slate-50 via-white to-slate-50",
        accentText: "text-indigo-700",
        ring: "focus:ring-indigo-500",
        iconBg: "bg-indigo-50",
        iconText: "text-indigo-600",
        badgeBg: "bg-indigo-50",
        badgeText: "text-indigo-600",
      };
    case "light-mint":
      return {
        primaryText: "text-emerald-600",
        primaryBg: "bg-emerald-600",
        primaryBgLight: "bg-emerald-50",
        primaryBorder: "border-slate-200",
        primaryBorderHover: "hover:border-slate-300",
        gradientFromTo: "from-emerald-600 to-teal-600",
        gradientTo: "to-emerald-600",
        gradientFromToLight: "from-slate-50 via-white to-slate-50",
        accentText: "text-emerald-700",
        ring: "focus:ring-emerald-500",
        iconBg: "bg-emerald-50",
        iconText: "text-emerald-600",
        badgeBg: "bg-emerald-50",
        badgeText: "text-emerald-600",
      };
    case "light-amber":
      return {
        primaryText: "text-amber-700",
        primaryBg: "bg-amber-600",
        primaryBgLight: "bg-amber-50",
        primaryBorder: "border-slate-200",
        primaryBorderHover: "hover:border-slate-300",
        gradientFromTo: "from-amber-600 to-orange-600",
        gradientTo: "to-amber-600",
        gradientFromToLight: "from-slate-50 via-white to-slate-50",
        accentText: "text-amber-800",
        ring: "focus:ring-amber-500",
        iconBg: "bg-amber-50",
        iconText: "text-amber-700",
        badgeBg: "bg-amber-50",
        badgeText: "text-amber-700",
      };
    case "light-royal":
      return {
        primaryText: "text-blue-600",
        primaryBg: "bg-blue-600",
        primaryBgLight: "bg-blue-50",
        primaryBorder: "border-slate-200",
        primaryBorderHover: "hover:border-slate-300",
        gradientFromTo: "from-blue-600 to-indigo-600",
        gradientTo: "to-blue-600",
        gradientFromToLight: "from-slate-50 via-white to-slate-50",
        accentText: "text-blue-700",
        ring: "focus:ring-blue-500",
        iconBg: "bg-blue-50",
        iconText: "text-blue-600",
        badgeBg: "bg-blue-50",
        badgeText: "text-blue-600",
      };
  }
}

export function getPropertyTenantsForYear(property: Property, year: number): TenantContractRecord[] {
  let records: TenantContractRecord[] = property.tenantHistory && property.tenantHistory.length > 0
    ? [...property.tenantHistory]
    : [];

  if (records.length === 0 && property.tenantName) {
    records.push({
      id: `initial_${property.id}`,
      tenantName: property.tenantName,
      tenantDni: property.tenantDni || "",
      startDate: property.contract?.startDate || `${year - 2}-01-01`,
      endDate: property.contract?.endDate,
      monthlyRent: property.contract?.monthlyRent || property.monthlyRent || 0,
      pdfName: property.contract?.pdfName,
      pdfSize: property.contract?.pdfSize
    });
  }

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  return records.filter(rec => {
    const start = rec.startDate || "2000-01-01";
    const end = rec.endDate;
    const startsBeforeOrInYear = start <= yearEnd;
    const endsAfterOrInYear = !end || end >= yearStart;
    return startsBeforeOrInYear && endsAfterOrInYear;
  });
}

export function getTenantActiveMonthsForYear(tenantRec: TenantContractRecord, year: number): number[] {
  const activeMonths: number[] = [];
  const start = tenantRec.startDate || `${year}-01-01`;
  const end = tenantRec.endDate;

  for (let m = 0; m < 12; m++) {
    const monthStr = String(m + 1).padStart(2, '0');
    const monthStart = `${year}-${monthStr}-01`;
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    const monthEnd = `${year}-${monthStr}-${String(daysInMonth).padStart(2, '0')}`;

    if (start <= monthEnd && (!end || end >= monthStart)) {
      activeMonths.push(m);
    }
  }

  return activeMonths;
}

export interface EffectiveFinancials {
  currentValue: number;
  purchasePrice: number;
  purchaseExpenses: number;
  mortgageDebt: number;
  monthlyMortgagePayment: number;
  isManual?: boolean;
  isMortgageCalculated?: boolean; // true si la hipoteca se ha proyectado dinámicamente por amortización
}

export function calculateAmortizedMortgageDebt(
  initialDebt: number,
  monthlyPayment: number,
  annualInterestRate: number,
  monthsElapsed: number
): number {
  if (initialDebt <= 0 || monthsElapsed <= 0) return Math.max(0, initialDebt);
  if (annualInterestRate <= 0 || monthlyPayment <= 0) return Math.max(0, initialDebt);

  const monthlyRate = annualInterestRate / 100 / 12;
  let currentDebt = initialDebt;

  for (let m = 0; m < monthsElapsed; m++) {
    if (currentDebt <= 0) break;
    const interestPayment = currentDebt * monthlyRate;
    const principalPayment = monthlyPayment - interestPayment;
    if (principalPayment <= 0) break;
    currentDebt = Math.max(0, currentDebt - principalPayment);
  }

  return Math.round(currentDebt);
}

export function getEffectivePropertyFinancials(
  prop: Property,
  targetYear: number
): EffectiveFinancials {
  const purchasePrice = prop.purchasePrice || 0;
  const defaultPurchaseExpenses = Math.round(purchasePrice * 0.10);

  // Comprueba si un valor en un año parece una estimación automática de revalorización teórica
  const isAutoEstimatedVal = (yr: number, val: number | undefined) => {
    if (val === undefined || val === 0) return true;
    const diff = Math.max(0, yr - 2025);
    const estVal = Math.round(purchasePrice * Math.pow(1.035, diff));
    return Math.abs(val - estVal) <= 1 || val === purchasePrice;
  };

  const isExplicitManualRecord = (fin: PropertyYearlyFinancials | undefined, yr: number): boolean => {
    if (!fin) return false;
    if (fin.isManual === true) return true;
    if ((fin.mortgageDebt ?? 0) > 0 || (fin.monthlyMortgagePayment ?? 0) > 0) return true;
    if (fin.currentValue !== undefined && fin.currentValue > 0 && !isAutoEstimatedVal(yr, fin.currentValue)) return true;
    return false;
  };

  // 1. Determinar currentValue efectivo
  let effectiveCurrentValue = prop.currentValue ?? purchasePrice;
  const targetYearFin = prop.yearlyFinancials?.[targetYear];

  if (targetYearFin && isExplicitManualRecord(targetYearFin, targetYear) && targetYearFin.currentValue) {
    effectiveCurrentValue = targetYearFin.currentValue;
  } else if (prop.yearlyFinancials) {
    const years = Object.keys(prop.yearlyFinancials).map(Number).sort((a, b) => b - a);
    for (const yr of years) {
      const fin = prop.yearlyFinancials[yr];
      if (isExplicitManualRecord(fin, yr) && fin.currentValue && !isAutoEstimatedVal(yr, fin.currentValue)) {
        effectiveCurrentValue = fin.currentValue;
        break;
      }
    }
  }

  // 2. Determinar hipoteca y estado de cálculo:
  // A) ¿El targetYear tiene un registro de hipoteca introducido explícitamente por el usuario?
  if (targetYearFin && isExplicitManualRecord(targetYearFin, targetYear) && (targetYearFin.mortgageDebt ?? 0) > 0) {
    return {
      currentValue: effectiveCurrentValue,
      purchasePrice: targetYearFin.purchasePrice ?? purchasePrice,
      purchaseExpenses: targetYearFin.purchaseExpenses ?? defaultPurchaseExpenses,
      mortgageDebt: targetYearFin.mortgageDebt!,
      monthlyMortgagePayment: targetYearFin.monthlyMortgagePayment ?? prop.monthlyMortgagePayment ?? 0,
      isManual: true,
      isMortgageCalculated: false,
    };
  }

  // B) Buscar el año manual de referencia más reciente (<= targetYear) con deuda de hipoteca
  let refYear = 2025;
  let refDebt = prop.mortgageDebt ?? 0;
  let refMonthlyPayment = prop.monthlyMortgagePayment ?? 0;
  let foundManualRef = false;

  if (prop.yearlyFinancials) {
    const sortedYears = Object.keys(prop.yearlyFinancials)
      .map(Number)
      .filter(y => y <= targetYear)
      .sort((a, b) => b - a);

    for (const yr of sortedYears) {
      const fin = prop.yearlyFinancials[yr];
      if (isExplicitManualRecord(fin, yr) && (fin.mortgageDebt ?? 0) > 0) {
        refYear = yr;
        refDebt = fin.mortgageDebt!;
        refMonthlyPayment = fin.monthlyMortgagePayment ?? prop.monthlyMortgagePayment ?? 0;
        foundManualRef = true;
        break;
      }
    }
  }

  if (!foundManualRef && (prop.mortgageDebt ?? 0) > 0) {
    refYear = 2025;
    refDebt = prop.mortgageDebt!;
    refMonthlyPayment = prop.monthlyMortgagePayment ?? 0;
  }

  const interestRate = prop.mortgageInterestRate ?? 0;

  // C) Si targetYear > refYear Y tenemos interés > 0 Y deuda de ref > 0 Y cuota > 0:
  // Proyectar en memoria por amortización francesa
  if (targetYear > refYear && interestRate > 0 && refDebt > 0 && refMonthlyPayment > 0) {
    const yearsDiff = targetYear - refYear;
    const monthsElapsed = yearsDiff * 12;
    const calculatedDebt = calculateAmortizedMortgageDebt(refDebt, refMonthlyPayment, interestRate, monthsElapsed);

    return {
      currentValue: effectiveCurrentValue,
      purchasePrice: targetYearFin?.purchasePrice ?? prop.purchasePrice ?? purchasePrice,
      purchaseExpenses: targetYearFin?.purchaseExpenses ?? defaultPurchaseExpenses,
      mortgageDebt: calculatedDebt,
      monthlyMortgagePayment: refMonthlyPayment,
      isManual: false,
      isMortgageCalculated: true,
    };
  }

  // D) Respaldo estático: devolver el valor de referencia sin proyectar
  return {
    currentValue: effectiveCurrentValue,
    purchasePrice: targetYearFin?.purchasePrice ?? prop.purchasePrice ?? purchasePrice,
    purchaseExpenses: targetYearFin?.purchaseExpenses ?? defaultPurchaseExpenses,
    mortgageDebt: refDebt,
    monthlyMortgagePayment: refMonthlyPayment,
    isManual: foundManualRef,
    isMortgageCalculated: false,
  };
}
