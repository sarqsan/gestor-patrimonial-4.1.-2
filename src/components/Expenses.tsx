import React, { useState, useEffect } from "react";
import { Property, PropertyExpense } from "../types";
import * as XLSX from "xlsx";
import { 
  Building, 
  Plus, 
  Trash2, 
  Receipt, 
  TrendingDown, 
  TrendingUp,
  Calendar, 
  Filter, 
  FileText, 
  Sparkles,
  DollarSign,
  Tag,
  Hammer,
  HelpCircle,
  FileCheck2,
  Lock,
  Percent,
  Check,
  Coins,
  ArrowUpRight,
  ArrowDownLeft,
  PieChart as ChartIcon,
  BookOpen,
  Download,
  Upload,
  FileSpreadsheet,
  FileCode,
  X,
  AlertCircle,
  Paperclip,
  Eye,
  ExternalLink,
  Image as ImageIcon
} from "lucide-react";

interface ExpensesProps {
  properties: Property[];
  expenses: PropertyExpense[];
  onAddExpense: (newExpense: PropertyExpense) => void;
  onDeleteExpense: (id: string) => void;
  onImportExpenses?: (newExpenses: PropertyExpense[], mode: 'merge' | 'replace') => void;
  user1Name: string;
  currentYear?: number;
}

export default function Expenses({
  properties,
  expenses = [],
  onAddExpense,
  onDeleteExpense,
  onImportExpenses,
  user1Name,
  currentYear = 2026
}: ExpensesProps) {
  const [activeSubTab, setActiveSubTab] = useState<"ledger" | "amortization" | "analysis">("ledger");
  const [isAdding, setIsAdding] = useState(false);
  const [filterProperty, setFilterProperty] = useState<string>("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [filterType, setFilterType] = useState<"all" | "gasto" | "ingreso">("all");
  const [filterYear, setFilterYear] = useState<string>("all");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Import / Export states
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importPreviewData, setImportPreviewData] = useState<PropertyExpense[] | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccessMsg, setImportSuccessMsg] = useState<string | null>(null);

  // Form states
  const [propertyId, setPropertyId] = useState("");
  const [opType, setOpType] = useState<"gasto" | "ingreso">("gasto");
  const [category, setCategory] = useState<PropertyExpense["category"]>("repairs");
  const [amount, setAmount] = useState<string>("");
  const [date, setDate] = useState<string>(new Date().toISOString().split("T")[0]);
  const [description, setDescription] = useState("");
  const [receiptUrl, setReceiptUrl] = useState<string | undefined>(undefined);
  const [receiptName, setReceiptName] = useState<string | undefined>(undefined);
  const [receiptType, setReceiptType] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [amortNotification, setAmortNotification] = useState<{ text: string; isError: boolean } | null>(null);

  // Receipt Viewer Modal state
  const [selectedReceiptExpense, setSelectedReceiptExpense] = useState<PropertyExpense | null>(null);

  // File Upload Handler for Form
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      setError("El archivo seleccionado supera el límite de 10MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      setReceiptUrl(result);
      setReceiptName(file.name);
      setReceiptType(file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg"));
      setError(null);
    };
    reader.onerror = () => {
      setError("Error al leer el archivo seleccionado.");
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveReceipt = () => {
    setReceiptUrl(undefined);
    setReceiptName(undefined);
    setReceiptType(undefined);
  };

  // Direct File Attach Handler from Table
  const handleDirectAttachReceipt = (expenseId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      alert("El archivo seleccionado supera el límite de 10MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      const fType = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg");
      const updatedExpenses = expenses.map(item => {
        if (item.id === expenseId) {
          return {
            ...item,
            receiptUrl: result,
            receiptName: file.name,
            receiptType: fType
          };
        }
        return item;
      });

      if (onImportExpenses) {
        onImportExpenses(updatedExpenses, 'replace');
      } else {
        const target = updatedExpenses.find(x => x.id === expenseId);
        if (target) onAddExpense(target);
      }
    };
    reader.readAsDataURL(file);
  };

  // Export handlers
  const handleExportJSON = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(expenses, null, 2));
    const dlAnchor = document.createElement("a");
    dlAnchor.setAttribute("href", dataStr);
    dlAnchor.setAttribute("download", `gastos_e_ingresos_rentasync_${new Date().toISOString().split("T")[0]}.json`);
    document.body.appendChild(dlAnchor);
    dlAnchor.click();
    dlAnchor.remove();
    setIsExportOpen(false);
  };

  const handleExportExcel = () => {
    const propMap = new Map(properties.map((p) => [p.id, p.address]));
    const rows = expenses.map((e) => ({
      "ID Transacción": e.id,
      "ID Inmueble": e.propertyId,
      "Inmueble / Dirección": propMap.get(e.propertyId) || e.propertyId,
      "Tipo Registro": e.type || (e.category === "rent" ? "ingreso" : "gasto"),
      "Categoría Fiscal": e.category,
      "Importe (€)": e.amount,
      "Fecha": e.date,
      "Descripción / Concepto": e.description || ""
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Gastos e Ingresos");
    XLSX.writeFile(workbook, `gastos_e_ingresos_${new Date().toISOString().split("T")[0]}.xlsx`);
    setIsExportOpen(false);
  };

  // Import handler
  const handleProcessImportFile = (file: File) => {
    setImportError(null);
    setImportSuccessMsg(null);
    const isJson = file.name.toLowerCase().endsWith(".json");
    const reader = new FileReader();

    if (isJson) {
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target?.result as string);
          
          let rawArray: any[] | null = null;
          if (Array.isArray(parsed)) {
            rawArray = parsed;
          } else if (parsed && typeof parsed === "object") {
            if (Array.isArray(parsed.expenses)) {
              rawArray = parsed.expenses;
            } else if (Array.isArray(parsed.gastos)) {
              rawArray = parsed.gastos;
            } else if (Array.isArray(parsed.ingresos)) {
              rawArray = parsed.ingresos;
            } else if (Array.isArray(parsed.transacciones)) {
              rawArray = parsed.transacciones;
            } else if (Array.isArray(parsed.data?.expenses)) {
              rawArray = parsed.data.expenses;
            } else if (Array.isArray(parsed.portfolio?.expenses)) {
              rawArray = parsed.portfolio.expenses;
            } else if (Array.isArray(parsed.state?.expenses)) {
              rawArray = parsed.state.expenses;
            } else if (Array.isArray(parsed.data)) {
              rawArray = parsed.data;
            } else if (Array.isArray(parsed.items)) {
              rawArray = parsed.items;
            } else if (parsed.amount || parsed.Importe || parsed.category) {
              rawArray = [parsed];
            } else {
              const candidateKey = Object.keys(parsed).find(k => 
                Array.isArray(parsed[k]) && parsed[k].length > 0 && 
                (parsed[k][0]?.amount !== undefined || parsed[k][0]?.Importe !== undefined || parsed[k][0]?.category)
              );
              if (candidateKey) {
                rawArray = parsed[candidateKey];
              }
            }
          }

          if (rawArray && Array.isArray(rawArray)) {
            const validExpenses: PropertyExpense[] = rawArray.map((item: any, idx: number) => {
              const rawCat = item.category || (item.type === "ingreso" || item.Tipo === "ingreso" ? "rent" : "other");
              const rawTypeStr = String(item.type || item.type_op || item.Tipo || (rawCat === "rent" ? "ingreso" : "gasto")).toLowerCase();
              const finalType: "gasto" | "ingreso" = (rawTypeStr === "ingreso" || rawCat === "rent") ? "ingreso" : "gasto";

              return {
                id: String(item.id || `exp_imp_${Date.now()}_${idx}`),
                propertyId: String(item.propertyId || item.property_id || properties[0]?.id || "prop_1"),
                category: rawCat as any,
                type: finalType,
                amount: Number(item.amount || item.Importe || 0),
                date: String(item.date || item.Fecha || new Date().toISOString().split("T")[0]),
                description: item.description || item.descripcion || item.Descripcion || undefined
              };
            }).filter(item => item.amount > 0);

            if (validExpenses.length === 0) {
              setImportError("No se han encontrado registros válidos de gastos o ingresos en el archivo.");
              setImportPreviewData(null);
            } else {
              setImportPreviewData(validExpenses);
            }
          } else {
            setImportError("No se ha encontrado un listado de gastos/ingresos en el archivo JSON. Asegúrate de que el archivo exportado contenga operaciones contables.");
            setImportPreviewData(null);
          }
        } catch (err) {
          setImportError("Error al leer el archivo JSON. Asegúrate de que tenga un formato correcto.");
          setImportPreviewData(null);
        }
      };
      reader.readAsText(file);
    } else {
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: "array" });
          const sheetName = workbook.SheetNames[0];
          const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

          const validExpenses: PropertyExpense[] = rows.map((item: any, idx: number) => {
            const rawAmount = item["Importe (€)"] || item["Importe"] || item["amount"] || item["Importe_EUR"] || 0;
            const rawDate = item["Fecha"] || item["date"] || new Date().toISOString().split("T")[0];
            const rawCat = item["Categoría Fiscal"] || item["category"] || item["Categoría"] || "other";
            const rawTypeStr = String(item["Tipo Registro"] || item["type"] || item["Tipo"] || (rawCat === "rent" ? "ingreso" : "gasto")).toLowerCase();
            const finalType: "gasto" | "ingreso" = (rawTypeStr === "ingreso" || rawCat === "rent") ? "ingreso" : "gasto";
            const rawPropId = item["ID Inmueble"] || item["propertyId"] || properties[0]?.id || "prop_1";

            return {
              id: String(item["ID Transacción"] || item["id"] || `exp_imp_${Date.now()}_${idx}`),
              propertyId: String(rawPropId),
              category: rawCat as any,
              type: finalType,
              amount: Number(rawAmount) || 0,
              date: String(rawDate),
              description: item["Descripción / Concepto"] || item["description"] || item["Descripción"] || undefined
            };
          }).filter(item => item.amount > 0);

          if (validExpenses.length === 0) {
            setImportError("No se han encontrado filas con importes válidos en la hoja de cálculo.");
            setImportPreviewData(null);
          } else {
            setImportPreviewData(validExpenses);
          }
        } catch (err) {
          setImportError("Error al procesar la hoja de cálculo. Comprueba que sea un archivo Excel (.xlsx, .xls) o CSV válido.");
          setImportPreviewData(null);
        }
      };
      reader.readAsArrayBuffer(file);
    }
  };

  const handleConfirmImport = () => {
    if (!importPreviewData || importPreviewData.length === 0) return;
    if (onImportExpenses) {
      onImportExpenses(importPreviewData, importMode);
      setImportSuccessMsg(`Se han importado con éxito ${importPreviewData.length} registros contables.`);
      setTimeout(() => {
        setIsImportOpen(false);
        setImportPreviewData(null);
        setImportSuccessMsg(null);
      }, 1200);
    } else {
      // Fallback: add items one by one
      importPreviewData.forEach(exp => onAddExpense(exp));
      setIsImportOpen(false);
      setImportPreviewData(null);
    }
  };

  const resetForm = () => {
    setPropertyId(properties[0]?.id || "");
    setOpType("gasto");
    setCategory("repairs");
    setAmount("");
    setDate(new Date().toISOString().split("T")[0]);
    setDescription("");
    setReceiptUrl(undefined);
    setReceiptName(undefined);
    setReceiptType(undefined);
    setError(null);
  };

  const handleStartAdd = () => {
    if (properties.length === 0) {
      setError("Debes registrar al menos un inmueble antes de registrar transacciones.");
    }
    resetForm();
    setIsAdding(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!propertyId) {
      setError("Por favor, selecciona una propiedad.");
      return;
    }
    const parsedAmount = parseFloat(amount.replace(",", "."));
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setError("Por favor, introduce un importe válido y mayor que cero.");
      return;
    }
    if (!date) {
      setError("Por favor, selecciona una fecha válida.");
      return;
    }

    const finalCategory = opType === "ingreso" ? "rent" : category;

    const newExpense: PropertyExpense = {
      id: `exp_${Date.now()}`,
      propertyId,
      category: finalCategory,
      type: opType,
      amount: parsedAmount,
      date,
      description: description.trim() || undefined,
      receiptUrl,
      receiptName,
      receiptType
    };

    onAddExpense(newExpense);
    setIsAdding(false);
    resetForm();
  };

  // Get localized categories
  const categories: Record<PropertyExpense["category"], { label: string; color: string; icon: any; isDeductible: boolean }> = {
    repairs: { label: "Reparaciones y Conservación", color: "from-red-500 to-rose-600", icon: Hammer, isDeductible: true },
    ibi: { label: "Impuestos y Tasas (IBI)", color: "from-amber-500 to-yellow-600", icon: FileText, isDeductible: true },
    insurance: { label: "Primas de Seguros", color: "from-teal-500 to-emerald-600", icon: FileCheck2, isDeductible: true },
    community: { label: "Gastos de Comunidad", color: "from-blue-500 to-cyan-600", icon: Building, isDeductible: true },
    maintenance: { label: "Mantenimiento / Suministros", color: "from-purple-500 to-violet-600", icon: Receipt, isDeductible: true },
    amortization: { label: "Amortización Inmueble (3% s/v.c.)", color: "from-indigo-500 to-indigo-600", icon: Percent, isDeductible: true },
    rent: { label: "Ingresos por Alquiler", color: "from-emerald-500 to-teal-600", icon: Coins, isDeductible: false },
    other: { label: "Otros Gastos Deducibles", color: "from-slate-500 to-slate-600", icon: HelpCircle, isDeductible: true }
  };

  // Helper to trigger rapid Spanish Amortization integration for a property
  const handleTriggerAmortization = (prop: Property) => {
    // Check if we already have an amortization for this year
    const hasAmort = expenses.some(e => e.propertyId === prop.id && e.category === 'amortization' && e.date.startsWith("2026"));
    if (hasAmort) {
      setAmortNotification({
        text: `Ya se ha registrado la amortización correspondiente a 2026 para el inmueble: ${prop.address.split(",")[0]}`,
        isError: true
      });
      setTimeout(() => setAmortNotification(null), 5000);
      return;
    }

    const newExpense: PropertyExpense = {
      id: `exp_amort_${prop.id}_${Date.now()}`,
      propertyId: prop.id,
      category: 'amortization',
      type: 'gasto',
      amount: prop.amortizationAmount,
      date: '2026-12-31',
      description: `Amortización deducible 3% s/v. construcción (${(100 - prop.landValuePercent)}% de compra)`
    };

    onAddExpense(newExpense);
    setAmortNotification({
      text: `Amortización de ${prop.amortizationAmount.toLocaleString("es-ES")} € registrada para el inmueble de forma exitosa.`,
      isError: false
    });
    setTimeout(() => setAmortNotification(null), 5000);
  };

  // Maximum 5 years in dropdown selector as per AEAT / Commercial Code view
  const availableYears = Array.from({ length: 5 }, (_, i) => currentYear - i);

  // Automatic 6-year retention purge policy (Art. 30 C.Comercio)
  // Records older than 6 years (e.g., in 2033, 2026 records are 7 years old and purged) are automatically deleted
  const [purgedCount, setPurgedCount] = useState<number>(0);

  useEffect(() => {
    const expiredList = expenses.filter(exp => {
      const expYear = parseInt(exp.date.split('-')[0], 10);
      return !isNaN(expYear) && (currentYear - expYear) > 6;
    });

    if (expiredList.length > 0) {
      const validExpenses = expenses.filter(exp => {
        const expYear = parseInt(exp.date.split('-')[0], 10);
        return isNaN(expYear) || (currentYear - expYear) <= 6;
      });

      setPurgedCount(prev => prev + expiredList.length);
      if (onImportExpenses) {
        onImportExpenses(validExpenses, 'replace');
      } else {
        expiredList.forEach(exp => onDeleteExpense(exp.id));
      }
    }
  }, [expenses, currentYear]);

  // Filtered list
  const filteredExpenses = expenses.filter(exp => {
    const matchProp = filterProperty === "all" || exp.propertyId === filterProperty;
    const matchCat = filterCategory === "all" || exp.category === filterCategory;
    
    // Check type (incomes vs expenses)
    const isIncome = exp.category === 'rent' || exp.type === 'ingreso';
    const currentType = isIncome ? 'ingreso' : 'gasto';
    const matchType = filterType === "all" || currentType === filterType;

    // Check year filter
    const matchYear = filterYear === "all" || exp.date.startsWith(filterYear);

    return matchProp && matchCat && matchType && matchYear;
  });

  // Financial summary
  const totalIncomes = expenses
    .filter(e => e.category === 'rent' || e.type === 'ingreso')
    .reduce((sum, e) => sum + e.amount, 0);

  const totalDeductibleExpenses = expenses
    .filter(e => e.category !== 'rent' && e.type !== 'ingreso')
    .reduce((sum, e) => sum + e.amount, 0);

  const netYield = totalIncomes - totalDeductibleExpenses;

  // Category totals for expenses only
  const expenseTotals = expenses
    .filter(e => e.category !== 'rent' && e.type !== 'ingreso')
    .reduce((acc, curr) => {
      acc[curr.category] = (acc[curr.category] || 0) + curr.amount;
      return acc;
    }, {} as Record<string, number>);

  return (
    <div id="expenses-tab" className="space-y-8 animate-fade-in text-slate-100">
      
      {/* HEADER SECTION */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Gestión de Gastos e Ingresos de Alquiler</h1>
          <p className="text-sm text-slate-400 mt-1">
            Libro contable y registro unificado de cobros ordinarios y gastos fiscales deducibles para el cálculo automático del Modelo 100 de IRPF.
          </p>
        </div>
        {!isAdding && (
          <div className="mt-4 sm:mt-0 flex flex-wrap items-center gap-2">
            {/* EXPORT BUTTON & DROPDOWN */}
            <div className="relative">
              <button
                onClick={() => setIsExportOpen(!isExportOpen)}
                className="inline-flex items-center px-3.5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-semibold rounded-xl transition-all cursor-pointer text-xs"
                title="Exportar gastos e ingresos"
              >
                <Download className="w-4 h-4 mr-1.5 text-indigo-400" />
                <span>Exportar</span>
              </button>

              {isExportOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setIsExportOpen(false)}></div>
                  <div className="absolute right-0 mt-2 w-56 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl py-2 z-40 text-xs">
                    <button
                      onClick={handleExportJSON}
                      className="w-full text-left px-4 py-2.5 hover:bg-slate-800 text-slate-200 flex items-center gap-2.5"
                    >
                      <FileCode className="w-4 h-4 text-emerald-400" />
                      <div>
                        <div className="font-semibold">Exportar JSON</div>
                        <div className="text-[10px] text-slate-400">Para pasar a otro perfil en la App</div>
                      </div>
                    </button>
                    <button
                      onClick={handleExportExcel}
                      className="w-full text-left px-4 py-2.5 hover:bg-slate-800 text-slate-200 flex items-center gap-2.5"
                    >
                      <FileSpreadsheet className="w-4 h-4 text-indigo-400" />
                      <div>
                        <div className="font-semibold">Exportar Excel (.xlsx)</div>
                        <div className="text-[10px] text-slate-400">Para abrir en Excel o Google Sheets</div>
                      </div>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* IMPORT BUTTON */}
            <button
              onClick={() => {
                setIsImportOpen(true);
                setImportPreviewData(null);
                setImportError(null);
                setImportSuccessMsg(null);
              }}
              className="inline-flex items-center px-3.5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-semibold rounded-xl transition-all cursor-pointer text-xs"
              title="Importar gastos e ingresos"
            >
              <Upload className="w-4 h-4 mr-1.5 text-amber-400" />
              <span>Importar</span>
            </button>

            {/* ADD TRANSACTION BUTTON */}
            <button
              onClick={handleStartAdd}
              className="inline-flex items-center px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl transition-all cursor-pointer text-xs shadow-lg shadow-indigo-600/15 hover:-translate-y-0.5"
            >
              <Plus className="w-4 h-4 mr-1.5" />
              <span>Registrar Transacción</span>
            </button>
          </div>
        )}
      </div>

      {/* SUB-TAB NAVIGATION */}
      {!isAdding && (
        <div className="flex border-b border-slate-800/80 gap-6">
          <button
            onClick={() => setActiveSubTab("ledger")}
            className={`pb-3 text-sm font-semibold relative transition-colors flex items-center gap-1.5 cursor-pointer ${
              activeSubTab === "ledger" ? "text-indigo-400 font-bold" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <BookOpen className="w-4 h-4" />
            <span>Libro Diario Contable</span>
            {activeSubTab === "ledger" && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500 rounded-full animate-fade-in"></div>
            )}
          </button>
          
          <button
            onClick={() => setActiveSubTab("amortization")}
            className={`pb-3 text-sm font-semibold relative transition-colors flex items-center gap-1.5 cursor-pointer ${
              activeSubTab === "amortization" ? "text-indigo-400 font-bold" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Percent className="w-4 h-4" />
            <span>Deducción de Amortización (3%)</span>
            {activeSubTab === "amortization" && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500 rounded-full animate-fade-in"></div>
            )}
          </button>

          <button
            onClick={() => setActiveSubTab("analysis")}
            className={`pb-3 text-sm font-semibold relative transition-colors flex items-center gap-1.5 cursor-pointer ${
              activeSubTab === "analysis" ? "text-indigo-400 font-bold" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <ChartIcon className="w-4 h-4" />
            <span>Distribución de Gastos</span>
            {activeSubTab === "analysis" && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500 rounded-full animate-fade-in"></div>
            )}
          </button>
        </div>
      )}

      {/* FINANCIAL OVERVIEW GRID */}
      {!isAdding && activeSubTab === "ledger" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          
          {/* TOTAL INCOMES CARD */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-6 relative overflow-hidden shadow-lg hover:border-emerald-500/25 transition-colors">
            <div className="absolute right-3 top-3 p-1.5 bg-emerald-500/10 text-emerald-400 rounded-xl">
              <ArrowUpRight className="w-5 h-5" />
            </div>
            <span className="text-[10px] uppercase font-mono font-bold text-slate-400 tracking-wider">Total Ingresos Registrados</span>
            <h2 className="text-3xl font-black text-emerald-400 mt-2 tracking-tight">
              {totalIncomes.toLocaleString("es-ES")} €
            </h2>
            <p className="text-xs text-slate-500 mt-2">Suma acumulada de cobros mensuales de renta.</p>
          </div>

          {/* TOTAL DEDUCTIBLE EXPENSES CARD */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-6 relative overflow-hidden shadow-lg hover:border-rose-500/25 transition-colors">
            <div className="absolute right-3 top-3 p-1.5 bg-rose-500/10 text-rose-400 rounded-xl">
              <ArrowDownLeft className="w-5 h-5" />
            </div>
            <span className="text-[10px] uppercase font-mono font-bold text-slate-400 tracking-wider">Total Gastos Deducibles</span>
            <h2 className="text-3xl font-black text-rose-400 mt-2 tracking-tight">
              {totalDeductibleExpenses.toLocaleString("es-ES")} €
            </h2>
            <p className="text-xs text-slate-500 mt-2">Gastos soportados deducibles del rendimiento bruto.</p>
          </div>

          {/* NET YIELD CARD */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-6 relative overflow-hidden shadow-lg hover:border-indigo-500/25 transition-colors">
            <div className="absolute right-3 top-3 p-1.5 bg-indigo-500/10 text-indigo-400 rounded-xl">
              <Coins className="w-5 h-5" />
            </div>
            <span className="text-[10px] uppercase font-mono font-bold text-slate-400 tracking-wider">Rendimiento Contable Neto</span>
            <h2 className={`text-3xl font-black mt-2 tracking-tight ${netYield >= 0 ? "text-indigo-400" : "text-red-400"}`}>
              {netYield.toLocaleString("es-ES")} €
            </h2>
            <p className="text-xs text-slate-500 mt-2">Base imponible previa a reducciones por vivienda habitual.</p>
          </div>

        </div>
      )}

      {/* FORM: ADD TRANSACTION */}
      {isAdding && (
        <form onSubmit={handleSubmit} className="bg-slate-900/40 border border-slate-700/50 rounded-2xl p-6 shadow-2xl animate-slide-in text-left">
          <h3 className="text-md font-bold text-white flex items-center mb-6">
            <Receipt className="w-5 h-5 text-indigo-400 mr-2" />
            <span>Registrar Nueva Operación Contable</span>
          </h3>

          {error && (
            <div className="bg-red-950/30 border border-red-500/20 text-red-300 text-xs p-3 rounded-xl mb-5 flex items-center space-x-2">
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full shrink-0"></span>
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            
            {/* Associated Property */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Inmueble Asociado *</label>
              <select
                required
                value={propertyId}
                onChange={(e) => setPropertyId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-4 py-3 text-xs text-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer"
              >
                <option value="" disabled>Selecciona una propiedad...</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.address} ({p.tenantName || "Sin inquilino"})
                  </option>
                ))}
              </select>
            </div>

            {/* Type of Operation */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Tipo de Registro Contable *</label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setOpType("gasto")}
                  className={`py-2.5 rounded-xl border font-bold text-xs transition-all flex items-center justify-center space-x-1.5 cursor-pointer ${
                    opType === "gasto"
                      ? "bg-rose-950/30 border-rose-500 text-rose-300 shadow-md shadow-rose-950/20"
                      : "bg-slate-950 border-slate-850 text-slate-400 hover:text-slate-300"
                  }`}
                >
                  <ArrowDownLeft className="w-3.5 h-3.5" />
                  <span>Gasto Deducible</span>
                </button>
                <button
                  type="button"
                  onClick={() => setOpType("ingreso")}
                  className={`py-2.5 rounded-xl border font-bold text-xs transition-all flex items-center justify-center space-x-1.5 cursor-pointer ${
                    opType === "ingreso"
                      ? "bg-emerald-950/30 border-emerald-500 text-emerald-300 shadow-md shadow-emerald-950/20"
                      : "bg-slate-950 border-slate-850 text-slate-400 hover:text-slate-300"
                  }`}
                >
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  <span>Ingreso Renta</span>
                </button>
              </div>
            </div>

            {/* Category selection - only visible for expenses */}
            {opType === "gasto" ? (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Categoría Fiscal AEAT *</label>
                <select
                  required
                  value={category}
                  onChange={(e) => setCategory(e.target.value as any)}
                  className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-4 py-3 text-xs text-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer"
                >
                  {Object.entries(categories)
                    .filter(([key]) => key !== "rent") // Rent is restricted to income
                    .map(([key, value]) => (
                      <option key={key} value={key}>{value.label}</option>
                    ))}
                </select>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Categoría Fiscal AEAT *</label>
                <div className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs text-slate-400 font-bold select-none flex items-center gap-1.5">
                  <Coins className="w-4 h-4 text-emerald-400" />
                  <span>Ingresos por Alquiler (Rendimiento Íntegro)</span>
                </div>
              </div>
            )}

            {/* Amount */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Importe / Monto (€) *</label>
              <input
                required
                type="text"
                inputMode="decimal"
                placeholder="0,00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-4 py-3 text-xs text-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 font-mono"
              />
            </div>

            {/* Date */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Fecha de Registro *</label>
              <input
                required
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-4 py-3 text-xs text-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>

            {/* Concept Description */}
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Descripción / Proveedor o Concepto</label>
              <input
                type="text"
                placeholder={opType === "gasto" ? "Ej. Factura fontanero termo, Seguro Mapfre, IBI 1º Semestre, etc." : "Ej. Cobro mensualidad inquilino"}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-4 py-3 text-xs text-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>

            {/* Document / Receipt / Invoice Attachment */}
            <div className="md:col-span-2 bg-slate-950/60 border border-slate-800 rounded-xl p-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-2">
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                  <Paperclip className="w-4 h-4 text-indigo-400" />
                  <span>Comprobante / Factura / Justificante (AEAT)</span>
                  <span className="text-[10px] text-slate-500 font-normal lowercase">(opcional)</span>
                </label>
                <span className="text-[10px] text-slate-500 font-mono">Formatos: JPG, PNG, WEBP, PDF (Máx 10MB)</span>
              </div>

              {!receiptUrl ? (
                <div className="relative border-2 border-dashed border-slate-700/80 hover:border-indigo-500/60 rounded-xl p-5 text-center transition-colors bg-slate-900/30">
                  <input
                    type="file"
                    accept="image/*,.pdf,application/pdf"
                    onChange={handleFileChange}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                  />
                  <div className="flex flex-col items-center justify-center space-y-2 pointer-events-none">
                    <div className="p-3 bg-indigo-500/10 text-indigo-400 rounded-full border border-indigo-500/20">
                      <Upload className="w-5 h-5" />
                    </div>
                    <p className="text-xs font-medium text-slate-300">
                      Haz clic o arrastra un archivo aquí para adjuntar la factura o recibo
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Guardaremos la imagen/documento para tus declaraciones de IRPF y revisiones de Hacienda
                    </p>
                  </div>
                </div>
              ) : (
                <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 flex items-center justify-between gap-3">
                  <div className="flex items-center space-x-3 overflow-hidden min-w-0">
                    {receiptType?.startsWith("image/") || receiptUrl.startsWith("data:image/") ? (
                      <div className="w-12 h-12 rounded-lg bg-slate-800 border border-slate-700 overflow-hidden shrink-0 flex items-center justify-center relative">
                        <img src={receiptUrl} alt="Vista previa" className="w-full h-full object-cover" />
                      </div>
                    ) : (
                      <div className="w-12 h-12 rounded-lg bg-indigo-950/50 border border-indigo-500/30 text-indigo-400 flex items-center justify-center shrink-0">
                        <FileText className="w-6 h-6" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-white truncate">{receiptName || "Comprobante_adjunto"}</p>
                      <p className="text-[10px] font-mono text-emerald-400 flex items-center gap-1 mt-0.5">
                        <Check className="w-3 h-3" /> Archivo preparado para guardar
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedReceiptExpense({
                          id: 'draft',
                          propertyId: propertyId || 'draft',
                          category: opType === 'ingreso' ? 'rent' : category,
                          type: opType,
                          amount: parseFloat(amount) || 0,
                          date: date || new Date().toISOString().split('T')[0],
                          description: description || 'Vista previa del comprobante',
                          receiptUrl,
                          receiptName,
                          receiptType
                        });
                      }}
                      className="p-1.5 text-slate-300 hover:text-indigo-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors text-xs font-medium flex items-center gap-1 cursor-pointer"
                      title="Ver vista previa"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Ver</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleRemoveReceipt}
                      className="p-1.5 text-slate-400 hover:text-red-400 bg-slate-800 hover:bg-red-950/30 rounded-lg transition-colors cursor-pointer"
                      title="Eliminar archivo"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>

          </div>

          <div className="mt-8 flex justify-end space-x-3 border-t border-slate-800 pt-5">
            <button
              type="button"
              onClick={() => setIsAdding(false)}
              className="px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-xl text-xs transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl text-xs transition-all cursor-pointer shadow-lg shadow-indigo-600/15"
            >
              Guardar Operación
            </button>
          </div>
        </form>
      )}

      {/* VIEW 1: LEDGER */}
      {!isAdding && activeSubTab === "ledger" && (
        <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 shadow-lg">
          
          {/* Filters Row */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6 pb-4 border-b border-slate-800">
            <h3 className="text-md font-bold text-white flex items-center">
              <Filter className="w-5 h-5 text-indigo-400 mr-2" />
              Libro Diario Unificado
            </h3>

            <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
              {/* Filter: Property */}
              <div>
                <select
                  value={filterProperty}
                  onChange={(e) => setFilterProperty(e.target.value)}
                  className="bg-slate-900 border border-slate-700/80 rounded-xl px-3 py-2 text-[11px] text-slate-300 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer"
                >
                  <option value="all">Todos los Inmuebles</option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>{p.address.split(",")[0]}</option>
                  ))}
                </select>
              </div>

              {/* Filter: Operation Type */}
              <div>
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value as any)}
                  className="bg-slate-900 border border-slate-700/80 rounded-xl px-3 py-2 text-[11px] text-slate-300 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer"
                >
                  <option value="all">Todo Tipo</option>
                  <option value="ingreso">Solo Ingresos (+)</option>
                  <option value="gasto">Solo Gastos (-)</option>
                </select>
              </div>

              {/* Filter: Category */}
              <div>
                <select
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value)}
                  className="bg-slate-900 border border-slate-700/80 rounded-xl px-3 py-2 text-[11px] text-slate-300 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer"
                >
                  <option value="all">Todas las Categorías</option>
                  {Object.entries(categories).map(([key, value]) => (
                    <option key={key} value={key}>{value.label}</option>
                  ))}
                </select>
              </div>

              {/* Filter: Year (Max 5 ejercicios) */}
              <div>
                <select
                  value={filterYear}
                  onChange={(e) => setFilterYear(e.target.value)}
                  className="bg-slate-900 border border-indigo-500/40 rounded-xl px-3 py-2 text-[11px] font-bold text-indigo-300 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer"
                >
                  <option value="all">Año: Todos (Máx 5 Ejercicios)</option>
                  {availableYears.map((yr) => (
                    <option key={yr} value={yr.toString()}>
                      Año: {yr}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Retention & Auto-Purge Banner (Art. 30 C.Comercio - 6 años) */}
          <div className="mb-4 bg-slate-900/60 border border-slate-800 rounded-xl px-3.5 py-2 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center space-x-2 text-slate-400">
              <Calendar className="w-4 h-4 text-indigo-400 shrink-0" />
              <span>
                <strong className="text-slate-200 font-semibold">Regla de Conservación AEAT / Mercantil (6 años):</strong> Los registros con más de 6 años se purgan automáticamente (ej. en {currentYear + 7} se eliminan los de {currentYear + 1}).
              </span>
            </div>
            {purgedCount > 0 && (
              <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded-md font-mono text-[10px] font-bold">
                {purgedCount} registros antiguos purgados
              </span>
            )}
          </div>

          {/* List Table */}
          {filteredExpenses.length === 0 ? (
            <div className="text-center py-12 bg-slate-950/20 rounded-xl border border-dashed border-slate-800/80">
              <Receipt className="w-12 h-12 text-slate-600 mx-auto mb-3" />
              <p className="text-sm text-slate-400 font-medium">No se han registrado transacciones con estos filtros.</p>
              <p className="text-xs text-slate-500 mt-1">Registra cobros de alquileres y facturas para poblar el libro diario.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-sans">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 font-mono text-[9px] uppercase tracking-wider">
                    <th className="py-3 px-3">Fecha</th>
                    <th className="py-3 px-3">Inmueble</th>
                    <th className="py-3 px-3">Clasificación AEAT</th>
                    <th className="py-3 px-3">Descripción / Concepto</th>
                    <th className="py-3 px-3 text-center">Comprobante AEAT</th>
                    <th className="py-3 px-3 text-right">Dirección</th>
                    <th className="py-3 px-3 text-right">Importe</th>
                    <th className="py-3 px-3 text-center">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50 font-medium">
                  {filteredExpenses
                    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                    .map((exp) => {
                      const prop = properties.find(p => p.id === exp.propertyId);
                      const catInfo = categories[exp.category];
                      const Icon = catInfo?.icon || HelpCircle;
                      const isIncome = exp.category === 'rent' || exp.type === 'ingreso';

                      return (
                        <tr key={exp.id} className="hover:bg-slate-800/20 transition-colors">
                          <td className="py-3.5 px-3 font-mono text-slate-400 whitespace-nowrap">
                            {new Date(exp.date).toLocaleDateString("es-ES")}
                          </td>
                          <td className="py-3.5 px-3 text-slate-300 truncate max-w-[160px]">
                            {prop ? prop.address.split(",")[0] : "Desconocido"}
                          </td>
                          <td className="py-3.5 px-3 whitespace-nowrap">
                            <span className={`inline-flex items-center space-x-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold text-white bg-gradient-to-r ${catInfo?.color || "from-slate-500 to-slate-600"}`}>
                              <Icon className="w-2.5 h-2.5" />
                              <span>{catInfo?.label || exp.category}</span>
                            </span>
                          </td>
                          <td className="py-3.5 px-3 text-slate-400 italic font-normal max-w-xs truncate">
                            {exp.description || "-"}
                          </td>
                          <td className="py-3.5 px-3 text-center">
                            {exp.receiptUrl ? (
                              <button
                                type="button"
                                onClick={() => setSelectedReceiptExpense(exp)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 font-bold text-[10px] transition-all cursor-pointer shadow-sm hover:scale-105"
                                title="Consultar o descargar justificante / factura"
                              >
                                <Eye className="w-3 h-3 shrink-0" />
                                <span>Ver Factura</span>
                              </button>
                            ) : (
                              <label
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-700/60 font-medium text-[10px] transition-colors cursor-pointer"
                                title="Adjuntar factura o recibo a esta operación"
                              >
                                <Paperclip className="w-3 h-3 text-slate-500" />
                                <span>Adjuntar</span>
                                <input
                                  type="file"
                                  accept="image/*,.pdf,application/pdf"
                                  className="hidden"
                                  onChange={(e) => handleDirectAttachReceipt(exp.id, e)}
                                />
                              </label>
                            )}
                          </td>
                          <td className="py-3.5 px-3 text-right whitespace-nowrap font-mono">
                            {isIncome ? (
                              <span className="text-emerald-400 text-[10px] bg-emerald-950/40 px-2 py-0.5 rounded-md border border-emerald-500/10 font-bold">
                                INGRESO (+)
                              </span>
                            ) : (
                              <span className="text-rose-400 text-[10px] bg-rose-950/40 px-2 py-0.5 rounded-md border border-rose-500/10 font-bold">
                                GASTO (-)
                              </span>
                            )}
                          </td>
                          <td className={`py-3.5 px-3 text-right font-bold font-mono ${isIncome ? "text-emerald-400" : "text-rose-400"}`}>
                            {isIncome ? "+" : "-"}{exp.amount.toLocaleString("es-ES")} €
                          </td>
                          <td className="py-3.5 px-3 text-center min-w-[100px]">
                            {deleteConfirmId === exp.id ? (
                              <div className="flex items-center justify-center gap-1.5 animate-fade-in bg-slate-900 p-1 rounded-lg border border-red-500/30">
                                <button
                                  type="button"
                                  onClick={() => {
                                    onDeleteExpense(exp.id);
                                    setDeleteConfirmId(null);
                                  }}
                                  className="px-2 py-1 bg-red-600 hover:bg-red-500 text-white font-bold text-[10px] rounded transition-colors cursor-pointer"
                                >
                                  Sí
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeleteConfirmId(null)}
                                  className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 text-[10px] rounded transition-colors cursor-pointer"
                                >
                                  No
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setDeleteConfirmId(exp.id)}
                                className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-950/20 rounded-lg transition-colors cursor-pointer"
                                title="Eliminar Registro"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* VIEW 2: AMORTIZATION TOOL */}
      {!isAdding && activeSubTab === "amortization" && (
        <div className="space-y-6">
          <div className="bg-gradient-to-br from-indigo-950/10 to-slate-900 border border-indigo-500/10 rounded-2xl p-6 text-left">
            <h3 className="text-lg font-bold text-white flex items-center mb-2.5">
              <Sparkles className="w-5 h-5 text-indigo-400 mr-2" />
              La Regla de la Amortización Fiscal (3%) en España
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              La Agencia Tributaria permite deducir anualmente el **3% del mayor de los siguientes valores**: el coste de adquisición (sin incluir el suelo) o el valor catastral de la construcción. Esto representa el gasto deducible fiscal más importante, ya que reduce el neto tributable sin implicar un desembolso real de caja.
            </p>
            <div className="bg-slate-950/40 border border-slate-800 rounded-xl p-4 text-[11px] text-slate-300 font-mono space-y-1">
              <span className="text-indigo-400 font-bold block mb-1">Fórmula Legal Aplicada:</span>
              <span>Amortización Anual = Precio Compra × % Construcción (por defecto {(100 - (properties[0]?.landValuePercent || 30))}% construito) × 3%</span>
            </div>
          </div>

          {amortNotification && (
            <div className={`p-4 rounded-xl border text-xs flex items-center space-x-2 ${
              amortNotification.isError 
                ? "bg-red-950/30 border-red-500/20 text-red-300" 
                : "bg-emerald-950/30 border-emerald-500/20 text-emerald-300"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${amortNotification.isError ? "bg-red-500" : "bg-emerald-500"}`}></span>
              <span>{amortNotification.text}</span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {properties.map((prop) => {
              const hasAmort = expenses.some(e => e.propertyId === prop.id && e.category === 'amortization' && e.date.startsWith("2026"));
              return (
                <div key={prop.id} className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between hover:border-slate-700 transition-colors">
                  <div className="space-y-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <h4 className="font-bold text-white text-sm">{prop.address.split(",")[0]}</h4>
                        <p className="text-[10px] text-slate-500 font-mono">ID: {prop.id}</p>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border font-bold ${
                        hasAmort 
                          ? "bg-emerald-950/30 text-emerald-400 border-emerald-500/20" 
                          : "bg-amber-950/30 text-amber-400 border-amber-500/20"
                      }`}>
                        {hasAmort ? "✓ Amortización 2026 Integrada" : "⚠ Amortización Pendiente"}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-2.5 border-t border-slate-800 text-xs">
                      <div>
                        <span className="text-slate-500 block text-[10px] uppercase font-mono">Precio Adquisición</span>
                        <span className="font-bold text-slate-300">{prop.purchasePrice.toLocaleString("es-ES")} €</span>
                      </div>
                      <div>
                        <span className="text-slate-500 block text-[10px] uppercase font-mono">Porcentaje Suelo / Vuelo</span>
                        <span className="font-bold text-slate-300">{prop.landValuePercent}% Suelo / {100 - prop.landValuePercent}% Vuelo</span>
                      </div>
                      <div className="col-span-2 bg-slate-950/40 p-2.5 rounded-xl border border-slate-850 mt-1">
                        <span className="text-slate-500 block text-[9px] uppercase font-mono">Amortización Anual Calculada</span>
                        <span className="text-sm font-extrabold text-indigo-400">{prop.amortizationAmount.toLocaleString("es-ES")} € / año</span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-slate-800 mt-4 flex justify-end">
                    {hasAmort ? (
                      <button
                        disabled
                        className="w-full py-2 bg-slate-800/50 text-slate-500 rounded-xl font-bold text-xs flex items-center justify-center space-x-1.5 border border-slate-850"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Ya Incorporado en Libro Contable</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => handleTriggerAmortization(prop)}
                        className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-bold text-xs flex items-center justify-center space-x-1.5 transition-colors cursor-pointer shadow-md shadow-indigo-600/10"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Contabilizar Amortización Anual</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* VIEW 3: ANALYSIS / DISTRIBUTION */}
      {!isAdding && activeSubTab === "analysis" && (
        <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 shadow-lg text-left">
          <h3 className="text-md font-bold text-white flex items-center mb-6">
            <ChartIcon className="w-5 h-5 text-indigo-400 mr-2" />
            Análisis de Distribución de Gastos
          </h3>

          {totalDeductibleExpenses === 0 ? (
            <div className="text-center py-12 bg-slate-950/20 rounded-xl border border-dashed border-slate-800/80">
              <Receipt className="w-12 h-12 text-slate-600 mx-auto mb-3" />
              <p className="text-sm text-slate-400 font-medium">No hay gastos para graficar.</p>
              <p className="text-xs text-slate-500 mt-1">Registra gastos para analizar las deducciones anuales.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
              {/* Progress meters list */}
              <div className="space-y-4">
                <span className="text-[10px] font-mono uppercase font-bold text-slate-400 tracking-wider">Desglose de Costes Soportados</span>
                <div className="space-y-3.5">
                  {Object.entries(categories)
                    .filter(([key]) => key !== "rent")
                    .map(([key, value]) => {
                      const amount = expenseTotals[key] || 0;
                      const percentage = totalDeductibleExpenses > 0 ? (amount / totalDeductibleExpenses) * 100 : 0;
                      const Icon = value.icon;
                      
                      return (
                        <div key={key} className="space-y-1">
                          <div className="flex justify-between text-xs font-semibold">
                            <span className="flex items-center text-slate-300">
                              <span className={`w-2.5 h-2.5 rounded-full bg-gradient-to-r ${value.color} mr-2`}></span>
                              {value.label}
                            </span>
                            <span className="text-slate-400 font-mono">
                              {amount.toLocaleString("es-ES")} € ({percentage.toFixed(1)}%)
                            </span>
                          </div>
                          <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden">
                            <div className="bg-indigo-500 h-2 rounded-full" style={{ width: `${percentage}%` }}></div>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* Graphical Box Accent */}
              <div className="bg-slate-950/60 rounded-3xl p-6 border border-slate-800 flex flex-col justify-center items-center text-center space-y-4 min-h-[220px]">
                <div className="p-4 bg-indigo-500/10 text-indigo-400 rounded-full border border-indigo-500/20">
                  <Sparkles className="w-8 h-8 animate-pulse" />
                </div>
                <div className="space-y-1">
                  <h4 className="text-sm font-bold text-white">Cumplimiento Fiscal y Eficiencia</h4>
                  <p className="text-xs text-slate-400 max-w-sm leading-relaxed">
                    Tus gastos deducibles registrados representan el <span className="font-bold text-indigo-400">{((totalDeductibleExpenses / (totalIncomes || 1)) * 100).toFixed(1)}%</span> del total de tus ingresos íntegros. Esto optimiza el pago de impuestos reduciendo la base imponible neta antes de aplicar la reducción general por alquiler habitual.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* IMPORT MODAL */}
      {isImportOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-scale-up">
            <div className="p-5 border-b border-slate-800 flex justify-between items-center bg-slate-800/40">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-amber-500/10 text-amber-400 rounded-xl border border-amber-500/20">
                  <Upload className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base">Importar Gastos e Ingresos</h3>
                  <p className="text-xs text-slate-400">Sube un archivo JSON o Excel (.xlsx) exportado de otro perfil</p>
                </div>
              </div>
              <button
                onClick={() => setIsImportOpen(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              {/* FILE UPLOADER */}
              <div className="border-2 border-dashed border-slate-700 hover:border-amber-500/50 rounded-2xl p-6 text-center transition-colors bg-slate-950/40">
                <input
                  type="file"
                  id="expenses-import-file"
                  accept=".json,.xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleProcessImportFile(file);
                  }}
                />
                <label
                  htmlFor="expenses-import-file"
                  className="cursor-pointer flex flex-col items-center gap-2"
                >
                  <div className="p-3 bg-slate-800 rounded-xl text-amber-400">
                    <FileSpreadsheet className="w-8 h-8" />
                  </div>
                  <div>
                    <span className="font-semibold text-white text-sm hover:underline">Haz clic para seleccionar archivo</span>
                    <p className="text-xs text-slate-400 mt-1">Soporta archivos JSON, Excel (.xlsx, .xls) y CSV</p>
                  </div>
                </label>
              </div>

              {/* ERROR MESSAGE */}
              {importError && (
                <div className="p-3 bg-red-950/40 border border-red-500/30 text-red-300 rounded-xl text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                  <span>{importError}</span>
                </div>
              )}

              {/* SUCCESS MESSAGE */}
              {importSuccessMsg && (
                <div className="p-3 bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 rounded-xl text-xs flex items-center gap-2">
                  <Check className="w-4 h-4 shrink-0 text-emerald-400" />
                  <span>{importSuccessMsg}</span>
                </div>
              )}

              {/* PREVIEW & MODE CHOICE */}
              {importPreviewData && importPreviewData.length > 0 && (
                <div className="space-y-4 pt-2">
                  <div className="p-3.5 bg-indigo-950/40 border border-indigo-500/30 rounded-xl flex justify-between items-center text-xs">
                    <span className="text-indigo-200 font-medium">Registros detectados en el archivo:</span>
                    <span className="bg-indigo-500/20 text-indigo-300 font-bold px-2.5 py-1 rounded-full border border-indigo-500/30">
                      {importPreviewData.length} elementos
                    </span>
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-300 block">Modo de Importación:</label>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setImportMode('merge')}
                        className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                          importMode === 'merge'
                            ? 'bg-amber-500/10 border-amber-500/50 text-amber-300 font-bold'
                            : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:bg-slate-800'
                        }`}
                      >
                        <div className="text-xs">➕ Fusionar (Añadir)</div>
                        <div className="text-[10px] opacity-75 font-normal mt-0.5">Mantiene los registros actuales</div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setImportMode('replace')}
                        className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                          importMode === 'replace'
                            ? 'bg-red-500/10 border-red-500/50 text-red-300 font-bold'
                            : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:bg-slate-800'
                        }`}
                      >
                        <div className="text-xs">🔄 Reemplazar todo</div>
                        <div className="text-[10px] opacity-75 font-normal mt-0.5">Sustituye los datos del perfil</div>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 border-t border-slate-800 bg-slate-800/40 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setIsImportOpen(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-xl text-xs transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleConfirmImport}
                disabled={!importPreviewData || importPreviewData.length === 0}
                className="px-5 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold rounded-xl text-xs transition-all shadow-lg shadow-amber-500/20"
              >
                Confirmar Importación ({importPreviewData?.length || 0})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RECEIPT VIEWER & DOWNLOAD MODAL */}
      {selectedReceiptExpense && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden text-left">
            
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/80">
              <div className="flex items-center space-x-2.5">
                <div className="p-2 bg-indigo-500/10 text-indigo-400 rounded-xl border border-indigo-500/20">
                  <Receipt className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-white">Comprobante Fiscal / Factura (AEAT)</h3>
                  <p className="text-[11px] text-slate-400">
                    {selectedReceiptExpense.receiptName || "Justificante_Transaccion"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedReceiptExpense(null)}
                className="p-1.5 text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Transaction Metadata Bar */}
            <div className="bg-slate-950/70 border-b border-slate-800 px-6 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-sans">
              <div>
                <span className="text-[10px] text-slate-500 font-mono uppercase block">Inmueble</span>
                <span className="font-semibold text-slate-200 truncate block">
                  {properties.find(p => p.id === selectedReceiptExpense.propertyId)?.address.split(",")[0] || "Inmueble"}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-slate-500 font-mono uppercase block">Fecha</span>
                <span className="font-semibold text-slate-200 font-mono block">
                  {new Date(selectedReceiptExpense.date).toLocaleDateString("es-ES")}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-slate-500 font-mono uppercase block">Categoría</span>
                <span className="font-semibold text-indigo-300 block truncate">
                  {categories[selectedReceiptExpense.category]?.label || selectedReceiptExpense.category}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-slate-500 font-mono uppercase block">Importe</span>
                <span className={`font-bold font-mono text-sm block ${
                  (selectedReceiptExpense.category === 'rent' || selectedReceiptExpense.type === 'ingreso')
                    ? 'text-emerald-400'
                    : 'text-rose-400'
                }`}>
                  {selectedReceiptExpense.amount.toLocaleString("es-ES")} €
                </span>
              </div>
            </div>

            {/* Document / Image Preview Body */}
            <div className="p-6 overflow-y-auto flex-1 bg-slate-950/40 flex items-center justify-center min-h-[300px]">
              {selectedReceiptExpense.receiptUrl ? (
                selectedReceiptExpense.receiptType?.startsWith("image/") || selectedReceiptExpense.receiptUrl.startsWith("data:image/") ? (
                  <div className="flex flex-col items-center max-w-full space-y-2">
                    <img
                      src={selectedReceiptExpense.receiptUrl}
                      alt={selectedReceiptExpense.receiptName || "Comprobante de factura"}
                      className="max-h-[55vh] max-w-full object-contain rounded-xl border border-slate-700 shadow-2xl bg-black/40"
                    />
                  </div>
                ) : selectedReceiptExpense.receiptType === "application/pdf" || selectedReceiptExpense.receiptUrl.startsWith("data:application/pdf") ? (
                  <div className="w-full h-[55vh] rounded-xl overflow-hidden border border-slate-700 bg-slate-900">
                    <iframe
                      src={selectedReceiptExpense.receiptUrl}
                      title="Vista previa PDF"
                      className="w-full h-full border-0"
                    />
                  </div>
                ) : (
                  <div className="text-center py-12 space-y-4">
                    <FileText className="w-16 h-16 text-indigo-400 mx-auto" />
                    <p className="text-xs text-slate-300">Vista previa no disponible directamente para este formato.</p>
                  </div>
                )
              ) : (
                <div className="text-center py-12 text-slate-500 text-xs">
                  Sin comprobante adjunto.
                </div>
              )}
            </div>

            {/* Footer Actions */}
            <div className="p-4 border-t border-slate-800 bg-slate-900 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center space-x-2">
                {selectedReceiptExpense.id !== 'draft' && (
                  <label
                    className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-xl text-xs transition-colors cursor-pointer flex items-center gap-1.5"
                    title="Sustituir por un nuevo archivo"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Cambiar Archivo</span>
                    <input
                      type="file"
                      accept="image/*,.pdf,application/pdf"
                      className="hidden"
                      onChange={(e) => {
                        handleDirectAttachReceipt(selectedReceiptExpense.id, e);
                        setSelectedReceiptExpense(null);
                      }}
                    />
                  </label>
                )}
              </div>

              <div className="flex items-center space-x-3">
                <button
                  type="button"
                  onClick={() => setSelectedReceiptExpense(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-xl text-xs transition-colors cursor-pointer"
                >
                  Cerrar
                </button>

                {selectedReceiptExpense.receiptUrl && (
                  <a
                    href={selectedReceiptExpense.receiptUrl}
                    download={
                      selectedReceiptExpense.receiptName ||
                      `factura_${selectedReceiptExpense.date}_${selectedReceiptExpense.amount}eur.${
                        selectedReceiptExpense.receiptType?.includes('pdf') ? 'pdf' : 'png'
                      }`
                    }
                    className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs transition-all cursor-pointer flex items-center gap-2 shadow-lg shadow-indigo-600/20"
                  >
                    <Download className="w-4 h-4" />
                    <span>Descargar para AEAT / Hacienda</span>
                  </a>
                )}
              </div>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
