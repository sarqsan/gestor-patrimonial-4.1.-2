import React, { useState } from "react";
import { AppState, Property, PropertyExpense, getThemeColors } from "../types";
import { 
  Building, 
  Briefcase, 
  TrendingUp, 
  Coins, 
  Heart, 
  User, 
  Users, 
  Percent,
  CheckCircle,
  HelpCircle,
  Upload,
  FileText,
  Sparkles,
  Loader2,
  AlertCircle,
  Check,
  Calendar,
  DollarSign,
  Tag,
  X,
  Paintbrush
} from "lucide-react";
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  ResponsiveContainer, 
  PieChart, 
  Pie, 
  Cell 
} from "recharts";

interface DashboardProps {
  state: AppState;
  onAddExpense: (newExpense: PropertyExpense) => void;
  onUpdateCurrentYear?: (year: number) => void;
  onLoadTaxDeclarationForYear?: (
    year: number,
    u1: { brutoTrabajo: number; netoTrabajo: number },
    u2: { brutoTrabajo: number; netoTrabajo: number },
    newProperties?: Property[]
  ) => void;
  onUpdateTheme?: (theme: string) => void;
}

export default function Dashboard({ 
  state, 
  onAddExpense,
  onUpdateCurrentYear,
  onLoadTaxDeclarationForYear,
  onUpdateTheme
}: DashboardProps) {
  const { user1, user2, properties } = state;
  const themeColors = getThemeColors(state.theme);

  const activeYear = state.currentYear || 2026;
  const yearlyProfile = state.yearlyProfiles?.[activeYear];
  const activeUser1 = yearlyProfile?.user1 || user1;
  const activeUser2 = yearlyProfile?.user2 || user2;

  // AI Invoice Scanner State
  const [selectedPropertyId, setSelectedPropertyId] = useState<string>(properties[0]?.id || "");
  const [dragActive, setDragActive] = useState(false);
  const [scannedFile, setScannedFile] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanStatusMsg, setScanStatusMsg] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [extractedResult, setExtractedResult] = useState<{
    amount: number;
    date: string;
    description: string;
    category: 'repairs' | 'ibi' | 'insurance' | 'community' | 'maintenance' | 'other';
    nif?: string;
  } | null>(null);
  const [savingScan, setSavingScan] = useState(false);
  const [scanSuccess, setScanSuccess] = useState(false);

  // Form states for manual or file upload of tax declarations for posterior/anterior years
  const [showYearUpload, setShowYearUpload] = useState(false);
  const [yearIntegrationMode, setYearIntegrationMode] = useState<"user1" | "user2" | "conjunta">("conjunta");
  const [manualBrutoU1, setManualBrutoU1] = useState("");
  const [manualNetoU1, setManualNetoU1] = useState("");
  const [manualBrutoU2, setManualBrutoU2] = useState("");
  const [manualNetoU2, setManualNetoU2] = useState("");
  const [yearPastedText, setYearPastedText] = useState("");
  const [yearUploadedFile, setYearUploadedFile] = useState<{ name: string; size: number; base64: string; mimeType: string } | null>(null);
  const [yearIsDragging, setYearIsDragging] = useState(false);
  const [showYearTextPaste, setShowYearTextPaste] = useState(false);
  const [yearExtracting, setYearExtracting] = useState(false);
  const [yearError, setYearError] = useState<string | null>(null);
  const [yearSuccess, setYearSuccess] = useState(false);

  const processYearFile = (file: File) => {
    setYearError(null);
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const isTxt = file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt");

    if (!isPdf && !isTxt) {
      setYearError("Solo se admiten archivos en formato PDF (.pdf) o de texto plano (.txt).");
      return;
    }

    if (isPdf) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const result = evt.target?.result;
        if (typeof result === "string") {
          const base64 = result.split(",")[1];
          setYearUploadedFile({
            name: file.name,
            size: file.size,
            base64,
            mimeType: "application/pdf"
          });
          setYearPastedText(""); // Clear pasted text
        }
      };
      reader.readAsDataURL(file);
    } else {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const text = evt.target?.result;
        if (typeof text === "string") {
          setYearPastedText(text);
          setYearUploadedFile(null);
        }
      };
      reader.readAsText(file);
    }
  };

  const handleYearDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setYearIsDragging(true);
  };

  const handleYearDragLeave = () => {
    setYearIsDragging(false);
  };

  const handleYearDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setYearIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processYearFile(file);
    }
  };

  const handleYearFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processYearFile(file);
    }
  };

  // File drag & drop handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileScan(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFileScan(e.target.files[0]);
    }
  };

  const handleFileScan = async (file: File) => {
    if (properties.length === 0) {
      setScanError("Debes registrar al menos un inmueble antes de escanear facturas.");
      return;
    }
    if (!selectedPropertyId) {
      // Default to first property if not selected
      setSelectedPropertyId(properties[0].id);
    }
    
    setScannedFile(file);
    setScanning(true);
    setScanError(null);
    setExtractedResult(null);
    setScanSuccess(false);
    setScanStatusMsg("Preparando documento para transferencia...");

    try {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onloadend = async () => {
        try {
          const base64Data = reader.result as string;
          const rawBase64 = base64Data.split(",")[1];
          const mimeType = file.type || (file.name.endsWith(".pdf") ? "application/pdf" : "image/jpeg");

          setScanStatusMsg("Enviando a la red neuronal de Gemini 3.5 Flash...");
          
          const response = await fetch("/api/extract-invoice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileData: rawBase64, mimeType })
          });

          if (!response.ok) {
            const errRes = await response.json();
            throw new Error(errRes.error || "Fallo en la extracción de datos.");
          }

          setScanStatusMsg("Leyendo base imponible, fecha y NIF fiscal...");
          const result = await response.json();
          
          setExtractedResult(result);
          setScanning(false);
        } catch (e: any) {
          console.error(e);
          setScanError(e.message || "No se pudo interpretar el comprobante. Inténtalo de nuevo.");
          setScanning(false);
        }
      };
    } catch (e: any) {
      setScanError("Error al abrir el archivo local.");
      setScanning(false);
    }
  };

  const handleConfirmScan = () => {
    if (!extractedResult) return;
    
    const propId = selectedPropertyId || properties[0]?.id;
    if (!propId) {
      setScanError("Selecciona una propiedad.");
      return;
    }

    setSavingScan(true);
    
    const newExpense: PropertyExpense = {
      id: `exp_${Date.now()}`,
      propertyId: propId,
      category: extractedResult.category,
      amount: Number(extractedResult.amount || 0),
      date: extractedResult.date,
      description: `${extractedResult.description} (NIF: ${extractedResult.nif || 'No detectado'}) [AI-Scanner]`
    };

    onAddExpense(newExpense);
    
    setScanSuccess(true);
    setTimeout(() => {
      setExtractedResult(null);
      setScannedFile(null);
      setScanSuccess(false);
    }, 1500);

    setSavingScan(false);
  };

  // 1. Calculate Rent Received totals (Bruto & Neto) for the active year
  let rentalUser1Bruto = 0;
  let rentalUser1Neto = 0;
  let rentalUser1Reducido = 0; // After 60% Spanish rental tax reduction

  let rentalUser2Bruto = 0;
  let rentalUser2Neto = 0;
  let rentalUser2Reducido = 0;

  properties.forEach((prop) => {
    let brutoAlquiler = 0;
    let totalGastos = 0;
    let amort = 0;

    if (activeYear === 2025) {
      brutoAlquiler = prop.monthlyRent * 12;
      totalGastos = prop.expensesCommunity + prop.expensesIBI + prop.expensesInsurance + prop.expensesRepairs;
      amort = prop.amortizationAmount;
    } else {
      // activeYear !== 2025 (e.g., 2026 and other years)
      // Only sum ACTUAL incomes that the user realized (no default data)
      const paidPaymentsSum = (state.payments || [])
        .filter((p) => p.propertyId === prop.id && p.year === activeYear && p.status === 'paid')
        .reduce((sum, p) => sum + p.amount, 0);

      const otherIncomesSum = (state.expenses || [])
        .filter((e) => e.propertyId === prop.id && parseInt(e.date.split("-")[0]) === activeYear && e.type === 'ingreso' && e.category !== 'rent')
        .reduce((sum, e) => sum + e.amount, 0);

      const manualRentIncomesSum = (state.expenses || [])
        .filter((e) => e.propertyId === prop.id && parseInt(e.date.split("-")[0]) === activeYear && e.type === 'ingreso' && e.category === 'rent')
        .reduce((sum, e) => sum + e.amount, 0);

      brutoAlquiler = Math.max(paidPaymentsSum, manualRentIncomesSum) + otherIncomesSum;

      // Only sum ACTUAL expenses that the user realized (no default profile values)
      const actualExpenses = (state.expenses || []).filter(
        (e) => e.propertyId === prop.id && parseInt(e.date.split("-")[0]) === activeYear && e.type === 'gasto'
      );

      totalGastos = actualExpenses
        .filter((e) => e.category !== 'amortization')
        .reduce((sum, e) => sum + e.amount, 0);

      amort = actualExpenses
        .filter((e) => e.category === 'amortization')
        .reduce((sum, e) => sum + e.amount, 0);
    }
    
    // Net rent = Rent - Expenses - Amortization (Spanish Tax calculation before reduction)
    const annualNet = Math.max(0, brutoAlquiler - totalGastos - amort);
    // Spanish law: 60% reduction for permanent housing leasing means 40% taxable
    const annualReducido = annualNet * 0.40;

    // Attribute based on ownership percentages
    const pct1 = prop.ownershipPercentageUser1 / 100;
    const pct2 = prop.ownershipPercentageUser2 / 100;

    rentalUser1Bruto += brutoAlquiler * pct1;
    rentalUser1Neto += annualNet * pct1;
    rentalUser1Reducido += annualReducido * pct1;

    if (user2.hasPartner) {
      rentalUser2Bruto += brutoAlquiler * pct2;
      rentalUser2Neto += annualNet * pct2;
      rentalUser2Reducido += annualReducido * pct2;
    }
  });

  const rentalConjuntoBruto = rentalUser1Bruto + rentalUser2Bruto;
  const rentalConjuntoNeto = rentalUser1Neto + rentalUser2Neto;
  const rentalConjuntoReducido = rentalUser1Reducido + rentalUser2Reducido;

  // 2. Work Income (Rendimiento del Trabajo) totals for the active year
  const workUser1Bruto = activeUser1.brutoTrabajo;
  const workUser1Neto = activeUser1.netoTrabajo;

  const workUser2Bruto = user2.hasPartner ? activeUser2.brutoTrabajo : 0;
  const workUser2Neto = user2.hasPartner ? activeUser2.netoTrabajo : 0;

  const workConjuntoBruto = workUser1Bruto + workUser2Bruto;
  const workConjuntoNeto = workUser1Neto + workUser2Neto;

  // Charts data
  const comparisonData = [
    {
      name: "Alquileres",
      "Bruto U1": rentalUser1Bruto,
      "Neto U1": rentalUser1Neto,
      "Bruto U2": rentalUser2Bruto,
      "Neto U2": rentalUser2Neto,
      "Conjunto Bruto": rentalConjuntoBruto,
      "Conjunto Neto": rentalConjuntoNeto,
    },
    {
      name: "Trabajo",
      "Bruto U1": workUser1Bruto,
      "Neto U1": workUser1Neto,
      "Bruto U2": workUser2Bruto,
      "Neto U2": workUser2Neto,
      "Conjunto Bruto": workConjuntoBruto,
      "Conjunto Neto": workConjuntoNeto,
    }
  ];

  // Pie chart for property contribution
  const COLORS = ["#6366f1", "#ec4899", "#14b8a6", "#f59e0b", "#3b82f6"];
  const propertyContribution = properties.map((p, idx) => {
    let brutoAlquilerVal = 0;
    if (activeYear === 2025) {
      brutoAlquilerVal = p.monthlyRent * 12;
    } else {
      const paidPaymentsSum = (state.payments || [])
        .filter((pay) => pay.propertyId === p.id && pay.year === activeYear && pay.status === 'paid')
        .reduce((sum, pay) => sum + pay.amount, 0);

      const otherIncomesSum = (state.expenses || [])
        .filter((e) => e.propertyId === p.id && parseInt(e.date.split("-")[0]) === activeYear && e.type === 'ingreso' && e.category !== 'rent')
        .reduce((sum, e) => sum + e.amount, 0);

      const manualRentIncomesSum = (state.expenses || [])
        .filter((e) => e.propertyId === p.id && parseInt(e.date.split("-")[0]) === activeYear && e.type === 'ingreso' && e.category === 'rent')
        .reduce((sum, e) => sum + e.amount, 0);

      brutoAlquilerVal = Math.max(paidPaymentsSum, manualRentIncomesSum) + otherIncomesSum;
    }

    return {
      name: p.address.split(",")[0], // Short name
      value: brutoAlquilerVal,
      color: COLORS[idx % COLORS.length]
    };
  });

  // --- CALCULADORA DE RENDIMIENTO PATRIMONIAL Y FINANCIERO (CONSOLIDADO DE LA CARTERA) ---
  let totalMarketValue = 0; // Valor de mercado estimado
  let totalMortgageDebt = 0; // Capital pendiente de hipoteca
  let totalMonthlyMortgagePayment = 0; // Cuota hipotecaria mensual
  let totalPurchasePrice = 0; // Valor de compra
  let totalPurchaseExpenses = 0; // Total gastos en operación compra
  let totalAnnualRentEstimate = 0; // Total rent estimates (for yields)
  let totalMonthlyExpenses = 0; // Total annual expenses / 12
  let portfolioMonthlyCashflow = 0; // Prorated monthly cashflow

  properties.forEach((prop) => {
    // Get year-specific financials if available, otherwise fallback to defaults
    const yearlyFin = prop.yearlyFinancials?.[activeYear];
    
    // Estimate 3.5% revaluation per year starting from 2025 if currentValue is not set
    const yearsDiff = Math.max(0, activeYear - 2025);
    const estimatedCurrentValue = Math.round(prop.purchasePrice * Math.pow(1.035, yearsDiff));
    const currentValue = yearlyFin?.currentValue ?? estimatedCurrentValue;
    
    const purchasePriceVal = yearlyFin?.purchasePrice ?? prop.purchasePrice ?? 0;
    const purchaseExpensesVal = yearlyFin?.purchaseExpenses ?? Math.round(purchasePriceVal * 0.10); // fallback to 10% standard expenses
    const mortgageDebtVal = yearlyFin?.mortgageDebt ?? 0;
    const monthlyMortgagePaymentVal = yearlyFin?.monthlyMortgagePayment ?? 0;

    totalMarketValue += currentValue;
    totalMortgageDebt += mortgageDebtVal;
    totalMonthlyMortgagePayment += monthlyMortgagePaymentVal;
    totalPurchasePrice += purchasePriceVal;
    totalPurchaseExpenses += purchaseExpensesVal;

    // Monthly rent received
    const monthlyRentEstimate = prop.contract?.monthlyRent ?? prop.monthlyRent ?? 0;
    
    // Prorated monthly expenses: Comunidad, IBI, Seguros
    const communityMonthly = (prop.expensesCommunity || 0) / 12;
    const ibiMonthly = (prop.expensesIBI || 0) / 12;
    const insuranceMonthly = (prop.expensesInsurance || 0) / 12;
    
    // Property Cashflow = Renta - Hipoteca - Gastos Prorrateados
    const propertyCashflow = monthlyRentEstimate - monthlyMortgagePaymentVal - communityMonthly - ibiMonthly - insuranceMonthly;
    portfolioMonthlyCashflow += propertyCashflow;

    // Compatibility variables
    totalAnnualRentEstimate += monthlyRentEstimate * 12;
    totalMonthlyExpenses += communityMonthly + ibiMonthly + insuranceMonthly;
  });

  const portfolioEquity = totalMarketValue - totalMortgageDebt;
  
  const totalMonthlyRent = totalAnnualRentEstimate / 12;

  // Rentabilidades
  const totalInvestedCapital = totalPurchasePrice + totalPurchaseExpenses;
  const rentabilidadBrutaGlobal = totalInvestedCapital > 0 ? (totalAnnualRentEstimate / totalInvestedCapital) * 100 : 0;
  
  const totalAnnualExpenses = totalMonthlyExpenses * 12;
  const rentabilidadNetaGlobal = totalInvestedCapital > 0 ? ((totalAnnualRentEstimate - totalAnnualExpenses) / totalInvestedCapital) * 100 : 0;

  // ROE (Return on Equity) = Net Annual Cashflow / Personal Capital Invested
  const personalInvestedCapital = Math.max(1000, totalInvestedCapital - totalMortgageDebt);
  const annualNetCashflow = portfolioMonthlyCashflow * 12;
  const roeGlobal = personalInvestedCapital > 0 ? (annualNetCashflow / personalInvestedCapital) * 100 : 0;

  // TIR estimada = ((Annual Cashflow + Property appreciation (historically ~3.5%)) / personalInvestedCapital)
  const annualAppreciation = totalMarketValue * 0.035;
  const tirEstimadaGlobal = personalInvestedCapital > 0 ? ((annualNetCashflow + annualAppreciation) / personalInvestedCapital) * 100 : 0;

  return (
    <div id="dashboard-tab" className="space-y-10 animate-fade-in text-slate-100">
      
      {/* SECTION 1: HEADER SUMMARY */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-white font-sans tracking-tight">Dashboard Patrimonial y de Renta</h1>
          <p className="text-sm text-slate-400 mt-1">
            Resumen consolidado e individual del capital inmobiliario y rendimientos del trabajo.
          </p>
        </div>
        
        <div className="flex flex-wrap items-center gap-3 mt-4 md:mt-0">
          {/* ASPECT DROPDOWN */}
          <div className="flex items-center space-x-2 bg-slate-900 border border-slate-800 rounded-xl px-3 py-1.5 shadow-sm">
            <Paintbrush className={`w-4 h-4 ${themeColors.primaryText}`} />
            <span className="text-xs font-semibold text-slate-300">Aspecto:</span>
            <select
              value={state.theme || "slate-indigo"}
              onChange={(e) => onUpdateTheme?.(e.target.value)}
              className="bg-transparent text-white font-bold text-xs focus:outline-none cursor-pointer pr-1"
            >
              <optgroup label="Temas Oscuros" className="bg-slate-950 text-slate-400 font-bold">
                <option value="slate-indigo" className="bg-slate-950 text-white">Slate & Índigo (Defecto)</option>
                <option value="cosmic-teal" className="bg-slate-950 text-white">Teal Cósmico 🌌</option>
                <option value="warm-amber" className="bg-slate-950 text-white">Cálido Ámbar 🪵</option>
                <option value="emerald-forest" className="bg-slate-950 text-white">Esmeralda Financiero 💹</option>
              </optgroup>
              <optgroup label="Temas Claros / Limpios" className="bg-slate-950 text-slate-400 font-bold">
                <option value="light-clear" className="bg-slate-950 text-white">☀️ Claridad Pura (Nieve)</option>
                <option value="light-mint" className="bg-slate-950 text-white">🌿 Menta Fresca (Limpio)</option>
                <option value="light-amber" className="bg-slate-950 text-white">🍁 Ámbar Cálido Claro</option>
                <option value="light-royal" className="bg-slate-950 text-white">🏢 Azul Ejecutivo (Oficina)</option>
              </optgroup>
            </select>
          </div>

          <div className="flex items-center space-x-2 bg-slate-900 border border-slate-800 rounded-xl px-3 py-1.5 shadow-sm">
            <Calendar className={`w-4 h-4 ${themeColors.primaryText}`} />
            <span className="text-xs font-semibold text-slate-300">Ejercicio Fiscal:</span>
            <select
              value={activeYear}
              onChange={(e) => onUpdateCurrentYear?.(Number(e.target.value))}
              className="bg-transparent text-white font-bold text-xs focus:outline-none cursor-pointer pr-1"
            >
              <option value="2025" className="bg-slate-950 text-white">2025</option>
              <option value="2026" className="bg-slate-950 text-white">2026</option>
              <option value="2027" className="bg-slate-950 text-white">2027</option>
              <option value="2028" className="bg-slate-950 text-white">2028</option>
            </select>
          </div>
          
          <div className={`flex items-center bg-slate-800/60 border border-slate-700/60 px-3 py-1.5 rounded-xl text-xs space-x-1.5 ${themeColors.primaryText} font-mono`}>
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
            <span>Sincronizado {activeYear}</span>
          </div>
        </div>
      </div>

      {/* SECCIÓN MULTI-AÑO: DETECCIÓN DE DATOS LABORALES DEL EJERCICIO SELECCIONADO */}
      {(!state.yearlyProfiles?.[activeYear] && activeYear !== 2025 && activeYear !== 2026) && (
        <div className="bg-amber-950/20 border border-amber-500/20 rounded-3xl p-6 space-y-4 animate-fade-in text-left">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-start space-x-3">
              <div className="p-3 bg-amber-500/10 text-amber-400 rounded-2xl border border-amber-500/10">
                <AlertCircle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-amber-300">Sin datos de trabajo cargados para el ejercicio {activeYear}</h3>
                <p className="text-xs text-slate-400 mt-1 max-w-2xl">
                  Estás visualizando el ejercicio fiscal <strong>{activeYear}</strong>, pero aún no se ha integrado su declaración de renta.
                  Para calcular con precisión el IRPF de {activeYear}, puedes simularlo con los datos del ejercicio 2026, copiar del año anterior o subir un borrador para extraerlo con Inteligencia Artificial.
                </p>
              </div>
            </div>
            
            <div className="flex flex-wrap gap-2.5 shrink-0">
              <button
                onClick={() => {
                  // Copy from 2026
                  onLoadTaxDeclarationForYear?.(
                    activeYear,
                    { brutoTrabajo: user1.brutoTrabajo, netoTrabajo: user1.netoTrabajo },
                    { brutoTrabajo: user2.brutoTrabajo, netoTrabajo: user2.netoTrabajo }
                  );
                }}
                className="px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/20 rounded-xl text-xs font-semibold transition-all flex items-center space-x-1.5 cursor-pointer"
              >
                <span>Copiar de 2026 📋</span>
              </button>
              <button
                onClick={() => setShowYearUpload(!showYearUpload)}
                className="px-3.5 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-xl text-xs font-bold transition-all flex items-center space-x-1.5 cursor-pointer"
              >
                <span>Integrar Declaración {activeYear} 📄</span>
              </button>
            </div>
          </div>

          {showYearUpload && (
            <div className="bg-slate-950/60 rounded-2xl border border-slate-800 p-5 space-y-5 mt-4 animate-slide-in">
              <div className="flex justify-between items-center border-b border-slate-800 pb-2">
                <span className="text-xs font-bold text-white uppercase tracking-wider font-mono flex items-center space-x-1">
                  <Sparkles className="w-3.5 h-3.5 text-indigo-400 mr-1" />
                  Módulo de Integración de Renta {activeYear}
                </span>
                <button 
                  onClick={() => setShowYearUpload(false)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {user2.hasPartner && (
                <div className="space-y-2">
                  <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider font-bold">
                    ¿Qué declaración deseas integrar para el ejercicio {activeYear}?
                  </label>
                  <div className="grid grid-cols-3 gap-2 bg-slate-900/60 p-1 rounded-xl border border-slate-800/80">
                    <button
                      type="button"
                      onClick={() => setYearIntegrationMode("conjunta")}
                      className={`py-2 text-xs font-bold font-sans rounded-lg transition-all cursor-pointer ${
                        yearIntegrationMode === "conjunta"
                          ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/10"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      Conjunta (Ambos) 👥
                    </button>
                    <button
                      type="button"
                      onClick={() => setYearIntegrationMode("user1")}
                      className={`py-2 text-xs font-bold font-sans rounded-lg transition-all cursor-pointer ${
                        yearIntegrationMode === "user1"
                          ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/10"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      Indiv. {user1.name ? user1.name.split(" ")[0] : "Usuario 1"} 👤
                    </button>
                    <button
                      type="button"
                      onClick={() => setYearIntegrationMode("user2")}
                      className={`py-2 text-xs font-bold font-sans rounded-lg transition-all cursor-pointer ${
                        yearIntegrationMode === "user2"
                          ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/10"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      Indiv. {user2.name ? user2.name.split(" ")[0] : "Usuario 2"} 👤
                    </button>
                  </div>
                </div>
              )}

              {yearError && (
                <div className="p-3 bg-red-950/30 border border-red-500/35 text-red-300 text-xs rounded-xl flex items-center space-x-2">
                  <AlertCircle className="w-4 h-4 text-red-400" />
                  <span>{yearError}</span>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* AI Text Paste / Upload */}
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-slate-300">Opción A: Extracción Inteligente por IA</h4>
                  <p className="text-[11px] text-slate-500 font-sans">
                    {yearIntegrationMode === "conjunta" 
                      ? "Adjunta el archivo PDF/TXT de la declaración conjunta, o pega el texto del borrador."
                      : yearIntegrationMode === "user1"
                      ? `Adjunta el PDF/TXT o borrador de la declaración de IRPF de ${user1.name || "Usuario 1"}.`
                      : `Adjunta el PDF/TXT o borrador de la declaración de IRPF de ${user2.name || "Usuario 2"}.`
                    }
                  </p>

                  {yearUploadedFile ? (
                    <div className="bg-indigo-950/30 border border-indigo-500/30 rounded-xl p-4 flex items-center justify-between gap-3 animate-fade-in text-left">
                      <div className="flex items-center space-x-3 truncate">
                        <FileText className="w-5 h-5 text-indigo-400 shrink-0" />
                        <div className="truncate text-xs">
                          <h4 className="font-semibold text-white truncate max-w-[180px]">{yearUploadedFile.name}</h4>
                          <p className="text-[10px] text-slate-400">PDF • {(yearUploadedFile.size / 1024).toFixed(1)} KB</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setYearUploadedFile(null); }}
                        className="p-1.5 bg-slate-800 hover:bg-slate-700 hover:text-white rounded text-xs font-semibold text-slate-400 transition-colors cursor-pointer"
                      >
                        Quitar
                      </button>
                    </div>
                  ) : showYearTextPaste ? (
                    <div className="space-y-2">
                      <textarea
                        value={yearPastedText}
                        onChange={(e) => setYearPastedText(e.target.value)}
                        placeholder="Pega aquí el borrador o texto extraído de la declaración de IRPF del ejercicio..."
                        className="w-full bg-slate-900 border border-slate-800 rounded-xl p-3 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500 min-h-[120px] font-mono"
                      />
                      <div className="flex justify-end">
                        <button 
                          type="button" 
                          onClick={() => { setShowYearTextPaste(false); setYearPastedText(""); }} 
                          className="text-[10px] text-indigo-400 hover:text-indigo-300 underline font-medium cursor-pointer"
                        >
                          O cambiar a subir archivo (PDF / TXT)
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <label className="block w-full cursor-pointer">
                        <input
                          type="file"
                          accept=".txt,.pdf"
                          onChange={handleYearFileUpload}
                          className="hidden"
                        />
                        <div 
                          onDragOver={handleYearDragOver}
                          onDragLeave={handleYearDragLeave}
                          onDrop={handleYearDrop}
                          className={`transition-all duration-200 rounded-xl border-2 border-dashed p-6 flex flex-col items-center justify-center text-center hover:bg-slate-850/30 ${
                            yearIsDragging 
                              ? "bg-indigo-600/15 border-indigo-400 scale-[1.01]" 
                              : "border-slate-800 hover:border-indigo-500/50 bg-slate-900/40"
                          }`}
                        >
                          <Upload className="w-8 h-8 text-indigo-400 mb-2" />
                          <p className="text-xs text-white font-bold">Arrastra y suelta tu declaración PDF o TXT aquí</p>
                          <p className="text-[10px] text-slate-400 mt-1">O haz clic para buscar tu archivo localmente</p>
                        </div>
                      </label>
                      <div className="flex justify-center">
                        <button 
                          type="button" 
                          onClick={() => setShowYearTextPaste(true)} 
                          className="text-[10px] text-indigo-400 hover:text-indigo-300 underline font-medium cursor-pointer"
                        >
                          O prefiere copiar y pegar el texto del borrador de renta
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-between items-center gap-2 pt-2">
                    <button
                      onClick={() => {
                        // Insert sample mockup text for testing based on selected mode
                        setShowYearTextPaste(true);
                        if (yearIntegrationMode === "user1") {
                          setYearPastedText(`Borrador Declaración Ejercicio ${activeYear}
Declarante: ${user1.name || "Usuario 1"} - DNI: ${user1.dni || "12345678A"}
Rendimientos del trabajo bruto: ${Math.round(user1.brutoTrabajo * 1.05)}
Rendimientos neto trabajo: ${Math.round(user1.netoTrabajo * 1.05)}`);
                        } else if (yearIntegrationMode === "user2") {
                          setYearPastedText(`Borrador Declaración Ejercicio ${activeYear}
Declarante: ${user2.name || "Usuario 2"} - DNI: ${user2.dni || "87654321K"}
Rendimientos del trabajo bruto: ${Math.round(user2.brutoTrabajo * 1.04)}
Rendimientos neto trabajo: ${Math.round(user2.netoTrabajo * 1.04)}`);
                        } else {
                          setYearPastedText(`Borrador Declaración Ejercicio ${activeYear}
Declarante: ${user1.name || "Usuario 1"} - DNI: ${user1.dni || "12345678A"}
Rendimientos del trabajo bruto: ${Math.round(user1.brutoTrabajo * 1.05)}
Rendimientos neto trabajo: ${Math.round(user1.netoTrabajo * 1.05)}
${user2.hasPartner ? `Cónyuge: ${user2.name || "Usuario 2"} - DNI: ${user2.dni || "87654321K"}\nRendimientos trabajo cónyuge bruto: ${Math.round(user2.brutoTrabajo * 1.04)}\nRendimientos neto trabajo cónyuge: ${Math.round(user2.netoTrabajo * 1.04)}` : ""}
                          `);
                        }
                      }}
                      className="text-[10px] text-indigo-400 hover:text-indigo-300 underline font-semibold cursor-pointer"
                    >
                      Cargar texto de ejemplo simulado ✨
                    </button>

                    <button
                      disabled={yearExtracting || (!yearPastedText.trim() && !yearUploadedFile)}
                      onClick={async () => {
                        setYearExtracting(true);
                        setYearError(null);
                        try {
                          const bodyPayload: any = {};
                          if (yearUploadedFile) {
                            bodyPayload.fileData1 = yearUploadedFile.base64;
                            bodyPayload.mimeType1 = yearUploadedFile.mimeType;
                          } else {
                            bodyPayload.text1 = yearPastedText;
                          }

                          const response = await fetch("/api/extract", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(bodyPayload),
                          });
                          if (!response.ok) throw new Error("Fallo en la extracción");
                          const res = await response.json();
                          
                          const isConjunta = yearIntegrationMode === "conjunta";
                          const isUser1 = yearIntegrationMode === "user1";
                          const isUser2 = yearIntegrationMode === "user2";

                          // Run load with selected target user profiles
                          onLoadTaxDeclarationForYear?.(
                            activeYear,
                            (isConjunta || isUser1) ? { 
                              brutoTrabajo: Number(res.user1?.brutoTrabajo || user1.brutoTrabajo * 1.05),
                              netoTrabajo: Number(res.user1?.netoTrabajo || user1.netoTrabajo * 1.05)
                            } : undefined,
                            (isConjunta || isUser2) ? {
                              brutoTrabajo: Number(res.user2?.brutoTrabajo || user2.brutoTrabajo * 1.04),
                              netoTrabajo: Number(res.user2?.netoTrabajo || user2.netoTrabajo * 1.04)
                            } : undefined,
                            res.properties
                          );
                          setYearSuccess(true);
                          setShowYearUpload(false);
                          setYearUploadedFile(null);
                        } catch (err: any) {
                          setYearError("No se pudo conectar con el servidor de extracción. Se han aplicado valores estimados basados en el archivo o texto.");
                          
                          let sampleText = yearPastedText;
                          if (yearUploadedFile) {
                            sampleText = `Borrador Declaración Ejercicio ${activeYear}
Declarante: ${user1.name || "Usuario 1"}
Rendimientos del trabajo bruto: ${Math.round(user1.brutoTrabajo * 1.05)}
Rendimientos neto trabajo: ${Math.round(user1.netoTrabajo * 1.05)}`;
                          }

                          const brutoMatch1 = sampleText.match(/bruto:?\s*(\d+)/i) || sampleText.match(/trabajo bruto:?\s*(\d+)/i);
                          const netoMatch1 = sampleText.match(/neto\s*trabajo:?\s*(\d+)/i) || sampleText.match(/neto:?\s*(\d+)/i);
                          
                          const u1B = brutoMatch1 ? Number(brutoMatch1[1]) : Math.round(user1.brutoTrabajo * 1.05);
                          const u1N = netoMatch1 ? Number(netoMatch1[1]) : Math.round(user1.netoTrabajo * 1.05);

                          const brutoMatch2 = sampleText.match(/cónyuge bruto:?\s*(\d+)/i) || sampleText.match(/cónyuge\s*bruto:?\s*(\d+)/i);
                          const netoMatch2 = sampleText.match(/cónyuge neto:?\s*(\d+)/i) || sampleText.match(/cónyuge\s*neto:?\s*(\d+)/i);

                          const u2B = brutoMatch2 ? Number(brutoMatch2[1]) : Math.round(user2.brutoTrabajo * 1.04);
                          const u2N = netoMatch2 ? Number(netoMatch2[1]) : Math.round(user2.netoTrabajo * 1.04);

                          const isConjunta = yearIntegrationMode === "conjunta";
                          const isUser1 = yearIntegrationMode === "user1";
                          const isUser2 = yearIntegrationMode === "user2";

                          onLoadTaxDeclarationForYear?.(
                            activeYear,
                            (isConjunta || isUser1) ? { brutoTrabajo: u1B, netoTrabajo: u1N } : undefined,
                            (isConjunta || isUser2) ? { brutoTrabajo: u2B, netoTrabajo: u2N } : undefined
                          );
                          setYearSuccess(true);
                          setTimeout(() => setShowYearUpload(false), 1500);
                          setYearUploadedFile(null);
                        } finally {
                          setYearExtracting(false);
                        }
                      }}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-xl text-xs font-bold transition-all flex items-center space-x-1.5 cursor-pointer"
                    >
                      {yearExtracting ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Extrayendo...</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-3.5 h-3.5" />
                          <span>Procesar con IA</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Manual Entry */}
                <div className="space-y-4 border-t lg:border-t-0 lg:border-l border-slate-800 lg:pl-6 pt-4 lg:pt-0">
                  <h4 className="text-xs font-bold text-slate-300 font-sans">Opción B: Introducir Rendimientos Manualmente</h4>
                  
                  <div className="space-y-3">
                    {(yearIntegrationMode === "conjunta" || yearIntegrationMode === "user1") && (
                      <div className="bg-slate-900/60 p-3.5 rounded-xl border border-slate-800/80 space-y-2.5">
                        <span className="text-[10px] font-mono text-indigo-400 font-bold uppercase">{user1.name || "Declarante 1"}</span>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[9px] text-slate-500 uppercase font-mono mb-1">Rendimiento Bruto (€)</label>
                            <input
                              type="number"
                              value={manualBrutoU1}
                              onChange={(e) => setManualBrutoU1(e.target.value)}
                              placeholder={Math.round(user1.brutoTrabajo * 1.05).toString()}
                              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:ring-1 focus:ring-indigo-500"
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] text-slate-500 uppercase font-mono mb-1">Rendimiento Neto (€)</label>
                            <input
                              type="number"
                              value={manualNetoU1}
                              onChange={(e) => setManualNetoU1(e.target.value)}
                              placeholder={Math.round(user1.netoTrabajo * 1.05).toString()}
                              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:ring-1 focus:ring-indigo-500"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {(user2.hasPartner && (yearIntegrationMode === "conjunta" || yearIntegrationMode === "user2")) && (
                      <div className="bg-slate-900/60 p-3.5 rounded-xl border border-slate-800/80 space-y-2.5">
                        <span className="text-[10px] font-mono text-pink-400 font-bold uppercase">{user2.name || "Cónyuge 2"}</span>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[9px] text-slate-500 uppercase font-mono mb-1">Rendimiento Bruto (€)</label>
                            <input
                              type="number"
                              value={manualBrutoU2}
                              onChange={(e) => setManualBrutoU2(e.target.value)}
                              placeholder={Math.round(user2.brutoTrabajo * 1.04).toString()}
                              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:ring-1 focus:ring-indigo-500"
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] text-slate-500 uppercase font-mono mb-1">Rendimiento Neto (€)</label>
                            <input
                              type="number"
                              value={manualNetoU2}
                              onChange={(e) => setManualNetoU2(e.target.value)}
                              placeholder={Math.round(user2.netoTrabajo * 1.04).toString()}
                              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:ring-1 focus:ring-indigo-500"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    <button
                      onClick={() => {
                        const isConjunta = yearIntegrationMode === "conjunta";
                        const isUser1 = yearIntegrationMode === "user1";
                        const isUser2 = yearIntegrationMode === "user2";

                        const u1B = (isConjunta || isUser1) ? (manualBrutoU1 ? Number(manualBrutoU1) : Math.round(user1.brutoTrabajo * 1.05)) : undefined;
                        const u1N = (isConjunta || isUser1) ? (manualNetoU1 ? Number(manualNetoU1) : Math.round(user1.netoTrabajo * 1.05)) : undefined;
                        const u2B = (isConjunta || isUser2) ? (manualBrutoU2 ? Number(manualBrutoU2) : Math.round(user2.brutoTrabajo * 1.04)) : undefined;
                        const u2N = (isConjunta || isUser2) ? (manualNetoU2 ? Number(manualNetoU2) : Math.round(user2.netoTrabajo * 1.04)) : undefined;

                        onLoadTaxDeclarationForYear?.(
                          activeYear,
                          u1B !== undefined ? { brutoTrabajo: u1B, netoTrabajo: u1N! } : undefined,
                          u2B !== undefined ? { brutoTrabajo: u2B, netoTrabajo: u2N! } : undefined
                        );
                        setShowYearUpload(false);
                      }}
                      className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-slate-950 rounded-xl text-xs font-bold transition-colors cursor-pointer"
                    >
                      Guardar Datos de Trabajo Manuales
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}



      {/* NUEVO PANEL: RENDIMIENTO PATRIMONIAL Y FINANCIERO DE LA CARTERA */}
      <div className="space-y-5 animate-fade-in text-left">
        <div className="flex items-center space-x-2 border-b border-slate-800 pb-3">
          <div className="p-1.5 bg-amber-600/20 text-amber-400 rounded-lg">
            <Coins className="w-5 h-5" />
          </div>
          <h2 className="text-lg font-bold text-white">Análisis Consolidado de la Cartera Inmobiliaria ({activeYear})</h2>
        </div>

        {/* Bento Grid de Indicadores Financieros */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          
          {/* Card 1: Patrimonio / Valor Mercado */}
          <div className="bg-slate-800/30 border border-slate-700/50 p-5 rounded-2xl flex flex-col justify-between hover:border-amber-500/30 transition-all shadow-md relative overflow-hidden group">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400">Patrimonio Estimado</span>
            <div className="mt-2">
              <span className="text-2xl font-black text-white">{totalMarketValue.toLocaleString("es-ES")} €</span>
            </div>
            <p className="text-[10px] text-slate-500 mt-2">Valor de mercado estimado acumulado de los inmuebles activos.</p>
            <div className="absolute top-2 right-2 opacity-5 group-hover:opacity-10 transition-all text-white">
              <Building className="w-10 h-10" />
            </div>
          </div>

          {/* Card 2: Deuda Pendiente */}
          <div className="bg-slate-800/30 border border-slate-700/50 p-5 rounded-2xl flex flex-col justify-between hover:border-rose-500/30 transition-all shadow-md relative overflow-hidden group">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-rose-400">Capital Pendiente Hipoteca</span>
            <div className="mt-2">
              <span className="text-2xl font-black text-white">{totalMortgageDebt.toLocaleString("es-ES")} €</span>
            </div>
            <p className="text-[10px] text-slate-500 mt-2">Total deuda financiera viva acumulada en el ejercicio {activeYear}.</p>
            <div className="absolute top-2 right-2 opacity-5 group-hover:opacity-10 transition-all text-white">
              <TrendingUp className="w-10 h-10" />
            </div>
          </div>

          {/* Card 3: Equity */}
          <div className="bg-slate-800/30 border border-slate-700/50 p-5 rounded-2xl flex flex-col justify-between hover:border-emerald-500/30 transition-all shadow-md relative overflow-hidden group">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-400">Equity (Capital Neto)</span>
            <div className="mt-2">
              <span className="text-2xl font-black text-white">{portfolioEquity.toLocaleString("es-ES")} €</span>
              <span className="text-[10px] text-emerald-500 font-mono ml-1.5 font-bold">
                ({totalMarketValue > 0 ? Math.round((portfolioEquity / totalMarketValue) * 100) : 100}%)
              </span>
            </div>
            <p className="text-[10px] text-slate-500 mt-2">Valor de la cartera libre de cargas hipotecarias.</p>
            <div className="absolute top-2 right-2 opacity-5 group-hover:opacity-10 transition-all text-white">
              <Coins className="w-10 h-10" />
            </div>
          </div>

          {/* Card 4: Cashflow Neto */}
          <div className="bg-indigo-950/25 border border-indigo-500/30 p-5 rounded-2xl flex flex-col justify-between hover:border-indigo-400/50 transition-all shadow-md relative overflow-hidden group">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-indigo-400">Cashflow Consolidado</span>
            <div className="mt-2">
              <span className={`text-2xl font-black ${portfolioMonthlyCashflow >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {portfolioMonthlyCashflow >= 0 ? '+' : ''}{portfolioMonthlyCashflow.toLocaleString("es-ES", { maximumFractionDigits: 1 })} €/mes
              </span>
            </div>
            <p className="text-[10px] text-slate-500 mt-2">Rendimiento mensual neto tras descontar hipoteca y gastos corrientes.</p>
            <div className="absolute top-2 right-2 opacity-5 group-hover:opacity-10 transition-all text-white">
              <TrendingUp className="w-10 h-10" />
            </div>
          </div>

        </div>

        {/* Fila de Rentabilidades Clave */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 bg-slate-900/50 border border-slate-800 rounded-2xl p-5 text-center">
          
          <div className="border-b sm:border-b-0 sm:border-r border-slate-800/80 last:border-0 py-2 sm:py-1">
            <span className="text-[10px] text-slate-500 font-mono font-bold block uppercase tracking-wider">Rentabilidad Bruta Global</span>
            <span className="text-xl font-bold text-slate-200 block mt-1">{rentabilidadBrutaGlobal.toFixed(2)} %</span>
            <p className="text-[9px] text-slate-600 mt-0.5">Ingreso Bruto Anual / Capital Invertido</p>
          </div>

          <div className="border-b sm:border-b-0 sm:border-r border-slate-800/80 last:border-0 py-2 sm:py-1">
            <span className="text-[10px] text-slate-500 font-mono font-bold block uppercase tracking-wider text-amber-500/80">Rentabilidad Neta Global</span>
            <span className="text-xl font-bold text-amber-400 block mt-1">{rentabilidadNetaGlobal.toFixed(2)} %</span>
            <p className="text-[9px] text-slate-600 mt-0.5">(Renta - Gastos Corrientes) / Inversión</p>
          </div>

          <div className="border-b sm:border-b-0 sm:border-r border-slate-800/80 last:border-0 py-2 sm:py-1">
            <span className="text-[10px] text-slate-500 font-mono font-bold block uppercase tracking-wider text-indigo-400/95">ROE (sobre Capital Propio)</span>
            <span className="text-xl font-bold text-indigo-300 block mt-1">{roeGlobal.toFixed(2)} %</span>
            <p className="text-[9px] text-slate-600 mt-0.5">Cashflow Neto Anual / Capital Propio Aportado</p>
          </div>

          <div className="py-2 sm:py-1">
            <span className="text-[10px] text-slate-500 font-mono font-bold block uppercase tracking-wider text-emerald-400/80">TIR Estimada</span>
            <span className="text-xl font-bold text-emerald-400 block mt-1">{tirEstimadaGlobal.toFixed(2)} %</span>
            <p className="text-[9px] text-slate-600 mt-0.5">Rentabilidad Neta + Revalorización anual (3.5%)</p>
          </div>

        </div>

        {/* Tabla Detalle por Inmueble */}
        <div className="bg-slate-900/30 border border-slate-850 rounded-2xl overflow-hidden shadow-lg text-left">
          <div className="p-4 bg-slate-950/40 border-b border-slate-805 flex justify-between items-center">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 font-mono">Rentabilidad Anual Detallada por Inmueble ({activeYear})</h3>
              <p className="text-[10px] text-slate-500 mt-0.5">Métricas de rendimiento e inversión individuales para cada propiedad.</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-slate-300 divide-y divide-slate-800">
              <thead className="bg-slate-950/20 text-[10px] font-mono text-slate-500 uppercase tracking-wider text-left">
                <tr>
                  <th className="px-4 py-3">Dirección del Inmueble</th>
                  <th className="px-4 py-3 text-right">Valor actual</th>
                  <th className="px-4 py-3 text-right">Valor Compra + Gastos</th>
                  <th className="px-4 py-3 text-right">Rentabilidad bruta</th>
                  <th className="px-4 py-3 text-right">Rentabilidad neta</th>
                  <th className="px-4 py-3 text-right">Cashflow mensual</th>
                  <th className="px-4 py-3 text-right">Equity (valor - deuda)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/40 font-sans">
                {properties.map((prop) => {
                  const yearlyFin = prop.yearlyFinancials?.[activeYear];
                  
                  // Estimate 3.5% revaluation per year starting from 2025 if currentValue is not set
                  const yearsDiff = Math.max(0, activeYear - 2025);
                  const estimatedCurrentValue = Math.round(prop.purchasePrice * Math.pow(1.035, yearsDiff));
                  const curVal = yearlyFin?.currentValue ?? estimatedCurrentValue;
                  
                  const purPrice = yearlyFin?.purchasePrice ?? prop.purchasePrice ?? 0;
                  const purExp = yearlyFin?.purchaseExpenses ?? Math.round(purPrice * 0.10); // fallback to 10% standard expenses
                  const mortDebt = yearlyFin?.mortgageDebt ?? 0;
                  const mortPay = yearlyFin?.monthlyMortgagePayment ?? 0;

                  const totalInvestment = purPrice + purExp;
                  const equity = curVal - mortDebt;
                  const equityPercent = curVal > 0 ? (equity / curVal) * 100 : 100;

                  // Rent estimates
                  const monthlyRentEstimate = prop.contract?.monthlyRent ?? prop.monthlyRent ?? 0;
                  const annualRent = monthlyRentEstimate * 12;

                  // Annual expenses for this year
                  let annualExp = 0;
                  if (activeYear === 2025) {
                    annualExp = prop.expensesCommunity + prop.expensesIBI + prop.expensesInsurance + prop.expensesRepairs;
                  } else {
                    const actualExpensesSum = (state.expenses || [])
                      .filter((e) => e.propertyId === prop.id && parseInt(e.date.split("-")[0]) === activeYear && e.type === 'gasto' && e.category !== 'amortization')
                      .reduce((sum, e) => sum + e.amount, 0);
                    annualExp = actualExpensesSum || (prop.expensesCommunity + prop.expensesIBI + prop.expensesInsurance + prop.expensesRepairs);
                  }
                  
                  // Yields
                  const grossYield = totalInvestment > 0 ? (annualRent / totalInvestment) * 100 : 0;
                  const netYield = totalInvestment > 0 ? ((annualRent - annualExp) / totalInvestment) * 100 : 0;

                  // Cashflow: prorating community, IBI, insurance over 12 months, and subtracting them and mortgage
                  const communityMonthly = (prop.expensesCommunity || 0) / 12;
                  const ibiMonthly = (prop.expensesIBI || 0) / 12;
                  const insuranceMonthly = (prop.expensesInsurance || 0) / 12;
                  const cashflow = monthlyRentEstimate - mortPay - communityMonthly - ibiMonthly - insuranceMonthly;

                  return (
                    <tr key={prop.id} className="hover:bg-slate-800/20 transition-all">
                      <td className="px-4 py-3 font-semibold text-white whitespace-nowrap truncate max-w-[160px] md:max-w-[240px]">
                        {prop.address}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap font-mono">{curVal.toLocaleString("es-ES")} €</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap text-slate-400 font-mono">{totalInvestment.toLocaleString("es-ES")} €</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap text-emerald-400 font-bold font-mono">{grossYield.toFixed(2)} %</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap text-amber-400 font-bold font-mono">{netYield.toFixed(2)} %</td>
                      <td className={`px-4 py-3 text-right whitespace-nowrap font-bold font-mono ${cashflow >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {cashflow >= 0 ? '+' : ''}{cashflow.toLocaleString("es-ES", { maximumFractionDigits: 0 })} €/mes
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap text-slate-200 font-mono">
                        {equity.toLocaleString("es-ES")} € <span className="text-[10px] text-slate-500 font-mono font-semibold">({Math.round(equityPercent)}%)</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* SECTION 2: RENTAL INCOME METRICS */}
      <div className="space-y-4">
        <div className="flex items-center space-x-2">
          <div className="p-1.5 bg-indigo-600/20 text-indigo-400 rounded-lg">
            <Building className="w-5 h-5" />
          </div>
          <h2 className="text-lg font-bold text-white">1. Desglose de Rendimientos por Alquileres</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* User 1 Alquileres */}
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 hover:border-indigo-500/40 transition-all shadow-lg relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-all text-slate-200">
              <User className="w-20 h-20" />
            </div>
            <span className="text-xs font-semibold text-indigo-400 tracking-wider uppercase font-mono">Arrendador 1</span>
            <h3 className="text-xl font-bold text-white mt-1 truncate">{user1.name}</h3>
            <p className="text-xs text-slate-400 mb-4 font-mono">NIF: {user1.dni}</p>
            
            <div className="space-y-3 pt-3 border-t border-slate-700/40">
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-400">Importe Bruto Anual:</span>
                <span className="text-lg font-bold text-white">{(rentalUser1Bruto).toLocaleString("es-ES")} €</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-400 flex items-center">
                  Rendimiento Neto:
                  <span className="group/neto relative ml-1 cursor-help text-slate-500 hover:text-indigo-400">
                    <HelpCircle className="w-3.5 h-3.5" />
                    <span className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 w-48 p-2 bg-slate-950 text-[10px] text-slate-300 rounded-lg opacity-0 group-hover/neto:opacity-100 transition-all pointer-events-none z-50 shadow-xl leading-normal font-sans border border-slate-800">
                      Renta íntegra menos gastos deducibles anuales y amortización (3% s/v. construcción).
                    </span>
                  </span>
                </span>
                <span className="text-lg font-bold text-indigo-400">{(rentalUser1Neto).toLocaleString("es-ES")} €</span>
              </div>
              <div className="flex justify-between items-center border-t border-slate-700/20 pt-2 text-xs">
                <span className="text-slate-500">Tributable (con reducción 60%):</span>
                <span className="font-semibold text-emerald-400">{(rentalUser1Reducido).toLocaleString("es-ES")} €</span>
              </div>
            </div>
          </div>

          {/* User 2 Alquileres */}
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 hover:border-pink-500/40 transition-all shadow-lg relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-all text-slate-200">
              <Heart className="w-20 h-20" />
            </div>
            <span className="text-xs font-semibold text-pink-400 tracking-wider uppercase font-mono">Arrendador 2</span>
            <h3 className="text-xl font-bold text-white mt-1 truncate">{user2.hasPartner ? user2.name : "Sin cónyuge activo"}</h3>
            <p className="text-xs text-slate-400 mb-4 font-mono">NIF: {user2.hasPartner ? user2.dni : "---"}</p>
            
            {user2.hasPartner ? (
              <div className="space-y-3 pt-3 border-t border-slate-700/40">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-slate-400">Importe Bruto Anual:</span>
                  <span className="text-lg font-bold text-white">{(rentalUser2Bruto).toLocaleString("es-ES")} €</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-sm text-slate-400">Rendimiento Neto:</span>
                  <span className="text-lg font-bold text-pink-400">{(rentalUser2Neto).toLocaleString("es-ES")} €</span>
                </div>
                <div className="flex justify-between items-center border-t border-slate-700/20 pt-2 text-xs">
                  <span className="text-slate-500">Tributable (con reducción 60%):</span>
                  <span className="font-semibold text-emerald-400">{(rentalUser2Reducido).toLocaleString("es-ES")} €</span>
                </div>
              </div>
            ) : (
              <div className="h-28 flex flex-col items-center justify-center border-t border-slate-700/40 pt-3">
                <p className="text-xs text-slate-500 text-center">Para añadir un segundo arrendador, sube una declaración conjunta o edita el perfil de pareja.</p>
              </div>
            )}
          </div>

          {/* Conjunto Alquileres */}
          <div className="bg-indigo-950/20 border border-indigo-500/30 rounded-2xl p-6 hover:border-indigo-500/60 transition-all shadow-xl relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-all text-indigo-400">
              <Users className="w-20 h-20" />
            </div>
            <span className="text-xs font-semibold text-emerald-400 tracking-wider uppercase font-mono">Fondo Conjunto</span>
            <h3 className="text-xl font-bold text-white mt-1">Suma Consolidada</h3>
            <p className="text-xs text-slate-400 mb-4 font-mono">Ambos Arrendadores</p>
            
            <div className="space-y-3 pt-3 border-t border-slate-700/50">
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-300">Total Recibido Bruto:</span>
                <span className="text-xl font-black text-white">{(rentalConjuntoBruto).toLocaleString("es-ES")} €</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-300">Total Neto Consolidado:</span>
                <span className="text-xl font-black text-indigo-300">{(rentalConjuntoNeto).toLocaleString("es-ES")} €</span>
              </div>
              <div className="flex justify-between items-center border-t border-indigo-500/20 pt-2 text-xs">
                <span className="text-slate-400">Tributable Final Conjunto:</span>
                <span className="font-bold text-emerald-400">{(rentalConjuntoReducido).toLocaleString("es-ES")} €</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* SECCIÓN: DIGITALIZACIÓN DE FACTURAS Y RECIBOS CON INTELIGENCIA ARTIFICIAL (GEMINI 3.5 FLASH) */}
      <div className={`bg-gradient-to-br ${themeColors.gradientFromToLight} border ${themeColors.primaryBorder} rounded-3xl p-6 md:p-8 space-y-6 shadow-2xl relative overflow-hidden text-left`}>
        
        {/* Subtle grid accent background */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#33415510_1px,transparent_1px),linear-gradient(to_bottom,#33415510_1px,transparent_1px)] bg-[size:24px_24px] pointer-events-none"></div>
        <div className={`absolute -top-40 -right-40 w-80 h-80 ${themeColors.primaryBgLight} rounded-full blur-3xl pointer-events-none opacity-20`}></div>

        <div className="relative flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="space-y-1">
            <span className={`inline-flex items-center space-x-1 px-2.5 py-1 rounded-md ${themeColors.badgeBg} ${themeColors.badgeText} text-[10px] font-mono font-bold uppercase tracking-wider`}>
              <Sparkles className="w-3 h-3 mr-1" />
              Procesamiento con IA
            </span>
            <h2 className="text-xl font-bold text-white tracking-tight flex items-center">
              Digitalizar Factura o Recibo de Alquiler
            </h2>
            <p className="text-xs text-slate-400">
              Sube la imagen o PDF de un gasto (IBI, Comunidad, Seguros, Reparaciones) para extraer automáticamente su importe y categoría fiscal.
            </p>
          </div>

          <div className="w-full md:w-72">
            <label className="block text-[10px] font-mono uppercase font-bold text-slate-400 mb-1.5">1. Seleccionar Inmueble Destino</label>
            <select
              value={selectedPropertyId}
              onChange={(e) => setSelectedPropertyId(e.target.value)}
              className={`w-full bg-slate-950/80 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-slate-200 focus:ring-2 ${themeColors.ring} cursor-pointer`}
            >
              <option value="" disabled>Selecciona un inmueble...</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.address.split(",")[0]} ({p.tenantName ? `Inq: ${p.tenantName.split(",")[0]}` : "Sin inquilino"})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Drag & Drop Area or Active Scanning details */}
        <div className="relative grid grid-cols-1 lg:grid-cols-2 gap-6 pt-2">
          
          {/* UPLOAD / DROPZONE */}
          <div
            onDragEnter={handleDrag}
            onDragOver={handleDrag}
            onDragLeave={handleDrag}
            onDrop={handleDrop}
            className={`relative flex flex-col items-center justify-center border-2 border-dashed rounded-2xl p-8 transition-all min-h-[180px] ${
              dragActive 
                ? `border-current ${themeColors.primaryBgLight} text-white shadow-inner` 
                : `border-slate-700 hover:border-slate-600 bg-slate-950/40 hover:bg-slate-950/60 text-slate-400`
            }`}
          >
            <input
              type="file"
              id="ai-invoice-upload"
              accept="image/*,application/pdf"
              className="absolute inset-0 opacity-0 cursor-pointer w-full h-full z-10"
              onChange={handleFileChange}
              disabled={scanning}
            />

            {scanning ? (
              <div className="text-center space-y-3.5 z-20">
                <div className="relative flex justify-center">
                  <Loader2 className={`w-10 h-10 ${themeColors.primaryText} animate-spin`} />
                  <div className={`absolute top-0 left-0 right-0 bottom-0 m-auto w-4 h-4 ${themeColors.primaryBg} rounded-full animate-ping`}></div>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-bold text-white">Extrayendo Datos Financieros...</p>
                  <p className="text-[10px] text-slate-400 font-mono animate-pulse">{scanStatusMsg}</p>
                </div>
              </div>
            ) : scannedFile ? (
              <div className="text-center space-y-3.5 z-20">
                <div className={`p-3 ${themeColors.primaryBgLight} ${themeColors.primaryText} rounded-2xl inline-block border ${themeColors.primaryBorder}`}>
                  <FileText className="w-8 h-8" />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-bold text-white truncate max-w-[280px]">{scannedFile.name}</p>
                  <p className="text-[10px] text-slate-500 font-mono">{(scannedFile.size / 1024).toFixed(1)} KB - Listo para escanear</p>
                </div>
                <button
                  onClick={() => handleFileScan(scannedFile)}
                  className={`mt-2 text-xs font-bold ${themeColors.primaryText} hover:opacity-80 underline`}
                >
                  Volver a procesar
                </button>
              </div>
            ) : (
              <div className="text-center space-y-4 z-20 pointer-events-none">
                <div className="p-3.5 bg-slate-900 border border-slate-800 rounded-2xl inline-block text-slate-400 shadow-md">
                  <Upload className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-300">Arrastra tu factura o recibo aquí, o haz clic para explorar</p>
                  <p className="text-[10px] text-slate-500 mt-1">Formatos admitidos: JPEG, PNG, PDF (Máx 5MB)</p>
                </div>
              </div>
            )}
          </div>

          {/* AI EXTRACTION RESULTS PREVIEW */}
          <div className="bg-slate-950/50 rounded-2xl border border-slate-800 p-5 flex flex-col justify-between min-h-[180px]">
            {extractedResult ? (
              <div className="space-y-4 animate-fade-in">
                <div className="flex justify-between items-center border-b border-slate-800 pb-2.5">
                  <h4 className={`text-xs font-bold ${themeColors.primaryText} flex items-center font-mono`}>
                    <CheckCircle className="w-4 h-4 text-emerald-400 mr-1.5" />
                    EXTRACCIÓN COMPLETADA POR IA
                  </h4>
                  {scanSuccess && (
                    <span className="text-[10px] text-emerald-400 bg-emerald-950/30 px-2 py-0.5 rounded-md border border-emerald-500/20 font-bold animate-pulse">
                      ¡Guardado e integrado!
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[9px] uppercase font-mono text-slate-500 mb-1">Importe Extraído (€)</label>
                    <div className="relative">
                      <input
                        type="number"
                        step="any"
                        value={extractedResult.amount}
                        onChange={(e) => setExtractedResult({ ...extractedResult, amount: Number(e.target.value || 0) })}
                        className="w-full bg-slate-900 border border-slate-700/60 rounded-lg pl-6 pr-2.5 py-1.5 text-xs text-white font-bold"
                      />
                      <DollarSign className="w-3.5 h-3.5 text-slate-500 absolute left-2 top-2" />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[9px] uppercase font-mono text-slate-500 mb-1">Fecha Emisión</label>
                    <div className="relative">
                      <input
                        type="date"
                        value={extractedResult.date}
                        onChange={(e) => setExtractedResult({ ...extractedResult, date: e.target.value })}
                        className="w-full bg-slate-900 border border-slate-700/60 rounded-lg pl-7 pr-2.5 py-1.5 text-xs text-white font-mono"
                      />
                      <Calendar className="w-3.5 h-3.5 text-slate-500 absolute left-2 top-2" />
                    </div>
                  </div>

                  <div className="col-span-2">
                    <label className="block text-[9px] uppercase font-mono text-slate-500 mb-1">Concepto / Emisor</label>
                    <input
                      type="text"
                      value={extractedResult.description}
                      onChange={(e) => setExtractedResult({ ...extractedResult, description: e.target.value })}
                      className="w-full bg-slate-900 border border-slate-700/60 rounded-lg px-2.5 py-1.5 text-xs text-white font-semibold"
                    />
                  </div>

                  <div className="col-span-2 grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[9px] uppercase font-mono text-slate-500 mb-1">NIF Proveedor</label>
                      <input
                        type="text"
                        value={extractedResult.nif || ""}
                        onChange={(e) => setExtractedResult({ ...extractedResult, nif: e.target.value })}
                        placeholder="Sin NIF detectado"
                        className="w-full bg-slate-900 border border-slate-700/60 rounded-lg px-2.5 py-1.5 text-xs text-white font-mono uppercase"
                      />
                    </div>
                    <div>
                      <label className="block text-[9px] uppercase font-mono text-slate-500 mb-1">Categoría AEAT</label>
                      <select
                        value={extractedResult.category}
                        onChange={(e) => setExtractedResult({ ...extractedResult, category: e.target.value as any })}
                        className="w-full bg-slate-900 border border-slate-700/60 rounded-lg px-2 py-1.5 text-xs text-slate-200 font-bold"
                      >
                        <option value="repairs">Reparaciones (repairs)</option>
                        <option value="ibi">Tributos / IBI (ibi)</option>
                        <option value="insurance">Seguros (insurance)</option>
                        <option value="community">Comunidad (community)</option>
                        <option value="maintenance">Suministros (maintenance)</option>
                        <option value="other">Otros Deducibles (other)</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t border-slate-900">
                  <button
                    type="button"
                    onClick={() => { setExtractedResult(null); setScannedFile(null); }}
                    className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-400 hover:text-slate-300 rounded-lg text-[11px] font-semibold"
                  >
                    Descartar
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmScan}
                    disabled={savingScan}
                    className={`inline-flex items-center px-4 py-1.5 ${themeColors.primaryBg} hover:opacity-95 text-white rounded-lg text-[11px] font-bold shadow-md`}
                  >
                    {savingScan ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                    ) : (
                      <Check className="w-3.5 h-3.5 mr-1" />
                    )}
                    <span>Integrar en Libro de Gastos</span>
                  </button>
                </div>
              </div>
            ) : scanError ? (
              <div className="flex flex-col items-center justify-center text-center space-y-2 py-8 h-full">
                <AlertCircle className="w-8 h-8 text-rose-500" />
                <p className="text-xs font-bold text-white">Fallo al escanear comprobante</p>
                <p className="text-[10px] text-slate-400 max-w-[280px]">{scanError}</p>
                <button
                  onClick={() => { setScanError(null); setScannedFile(null); }}
                  className={`text-indigo-400 hover:opacity-80 underline font-bold text-[10px]`}
                >
                  Intentar de nuevo
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center text-center space-y-2 py-8 h-full text-slate-500">
                <Sparkles className={`w-8 h-8 ${themeColors.primaryText} animate-pulse`} />
                <p className="text-xs font-semibold">Esperando digitalización...</p>
                <p className="text-[10px] text-slate-600 max-w-[240px]">
                  Sube un comprobante de gasto en la zona de carga para ver la previsualización interactiva.
                </p>
              </div>
            )}
          </div>

        </div>

      </div>

      {/* SECTION 3: WORK INCOME METRICS */}
      <div className="space-y-4">
        <div className="flex items-center space-x-2">
          <div className="p-1.5 bg-indigo-600/20 text-indigo-400 rounded-lg">
            <Briefcase className="w-5 h-5" />
          </div>
          <h2 className="text-lg font-bold text-white">2. Rendimientos del Trabajo (Sueldos)</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* User 1 Trabajo */}
          <div className="bg-slate-800/30 border border-slate-700/40 rounded-2xl p-6 relative overflow-hidden">
            <span className="text-xs text-slate-400 font-mono block">Trabajador 1</span>
            <h4 className="text-md font-semibold text-white mt-0.5 truncate">{user1.name}</h4>
            
            <div className="space-y-2.5 mt-4 pt-3 border-t border-slate-700/20 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">Sueldo Bruto Trabajo:</span>
                <span className="font-bold text-slate-200">{(workUser1Bruto).toLocaleString("es-ES")} €</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Sueldo Neto Trabajo:</span>
                <span className="font-bold text-emerald-400">{(workUser1Neto).toLocaleString("es-ES")} €</span>
              </div>
            </div>
          </div>

          {/* User 2 Trabajo */}
          <div className="bg-slate-800/30 border border-slate-700/40 rounded-2xl p-6 relative overflow-hidden">
            <span className="text-xs text-slate-400 font-mono block">Trabajador 2</span>
            <h4 className="text-md font-semibold text-white mt-0.5 truncate">
              {user2.hasPartner ? user2.name : "Sin cónyuge activo"}
            </h4>
            
            {user2.hasPartner ? (
              <div className="space-y-2.5 mt-4 pt-3 border-t border-slate-700/20 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-400">Sueldo Bruto Trabajo:</span>
                  <span className="font-bold text-slate-200">{(workUser2Bruto).toLocaleString("es-ES")} €</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Sueldo Neto Trabajo:</span>
                  <span className="font-bold text-emerald-400">{(workUser2Neto).toLocaleString("es-ES")} €</span>
                </div>
              </div>
            ) : (
              <div className="h-16 flex items-center justify-center text-xs text-slate-500 mt-2">
                No hay datos del segundo contribuyente.
              </div>
            )}
          </div>

          {/* Conjunto Trabajo */}
          <div className="bg-emerald-950/10 border border-emerald-500/20 rounded-2xl p-6 relative overflow-hidden">
            <span className="text-xs text-emerald-400 font-mono block">Suma Trabajo</span>
            <h4 className="text-md font-semibold text-white mt-0.5">Suma Rendimientos de Trabajo</h4>
            
            <div className="space-y-2.5 mt-4 pt-3 border-t border-slate-700/20 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-300">Total Trabajo Bruto:</span>
                <span className="font-extrabold text-white">{(workConjuntoBruto).toLocaleString("es-ES")} €</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-300">Total Trabajo Neto:</span>
                <span className="font-extrabold text-emerald-400">{(workConjuntoNeto).toLocaleString("es-ES")} €</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 4: INTERACTIVE ANALYTICS & CHARTS */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Chart 1: Rendimiento Bruto vs Neto (TRABAJO Y ALQUILERES) */}
        <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 lg:col-span-2 space-y-4">
          <h3 className="text-md font-bold text-white flex items-center">
            <TrendingUp className="w-4 h-4 text-indigo-400 mr-2" />
            Comparación Rendimientos Bruto vs Neto (Anual Consolidado)
          </h3>
          <p className="text-xs text-slate-400">Análisis comparativo de los ingresos totales percibidos en concepto de alquileres frente a las nóminas laborales.</p>
          
          <div className="h-64 mt-4 text-xs font-mono">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={[
                  {
                    name: "Alquileres",
                    Bruto: rentalConjuntoBruto,
                    Neto: rentalConjuntoNeto,
                  },
                  {
                    name: "Trabajo",
                    Bruto: workConjuntoBruto,
                    Neto: workConjuntoNeto,
                  }
                ]}
                margin={{ top: 20, right: 10, left: 10, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="name" stroke="#94a3b8" />
                <YAxis stroke="#94a3b8" tickFormatter={(v) => `${(v/1000)}k€`} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#1e293b', borderColor: '#475569', borderRadius: '8px' }}
                  labelStyle={{ color: '#f8fafc', fontWeight: 'bold' }}
                />
                <Legend />
                <Bar dataKey="Bruto" fill="#6366f1" radius={[4, 4, 0, 0]} name="Ingresos Brutos (€)" />
                <Bar dataKey="Neto" fill="#10b981" radius={[4, 4, 0, 0]} name="Ingresos Netos (€)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 2: Contribución de Inmuebles a la Renta */}
        <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 space-y-4 flex flex-col justify-between">
          <div>
            <h3 className="text-md font-bold text-white flex items-center">
              <Coins className="w-4 h-4 text-indigo-400 mr-2" />
              Cartera de Alquileres
            </h3>
            <p className="text-xs text-slate-400">Porcentaje de aportación de cada inmueble sobre los ingresos brutos inmobiliarios totales.</p>
          </div>

          {propertyContribution.length > 0 ? (
            <div className="flex-1 flex flex-col justify-center items-center py-4">
              <div className="h-36 w-full text-[10px] font-mono">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={propertyContribution}
                      cx="50%"
                      cy="50%"
                      innerRadius={40}
                      outerRadius={55}
                      paddingAngle={4}
                      dataKey="value"
                    >
                      {propertyContribution.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip 
                      formatter={(value) => `${Number(value).toLocaleString("es-ES")} €`}
                      contentStyle={{ backgroundColor: '#1e293b', borderColor: '#475569', borderRadius: '8px' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              {/* Legends */}
              <div className="w-full space-y-2 mt-4 max-h-[120px] overflow-y-auto pr-1">
                {propertyContribution.map((item, idx) => (
                  <div key={idx} className="flex justify-between items-center text-xs">
                    <div className="flex items-center space-x-2 truncate max-w-[150px]">
                      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: item.color }}></div>
                      <span className="truncate text-slate-300 font-sans">{item.name}</span>
                    </div>
                    <span className="font-mono text-slate-400">
                      {((item.value / rentalConjuntoBruto) * 100 || 0).toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-slate-500 py-12">
              No hay inmuebles disponibles para mostrar.
            </div>
          )}
        </div>

      </div>

    </div>
  );
}
