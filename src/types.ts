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

export interface PropertyYearlyFinancials {
  currentValue?: number; // valor actual
  purchasePrice?: number; // valor de compra
  purchaseExpenses?: number; // total gastos operación compra
  mortgageDebt?: number; // capital pendiente de hipoteca
  monthlyMortgagePayment?: number; // cuota hipotecaria mensual
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
  landValuePercent: number; // e.g. 30 for 30% land, 70% construction
  amortizationAmount: number; // standard 3% of construction value (purchasePrice * (100 - landValuePercent) / 100 * 0.03)
  expensesCommunity: number; // annual
  expensesIBI: number; // annual
  expensesInsurance: number; // annual
  expensesRepairs: number; // annual
  registrationDate: string;
  contract?: PropertyContract;
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
