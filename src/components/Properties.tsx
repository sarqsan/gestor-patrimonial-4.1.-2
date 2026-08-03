import React, { useState, useEffect } from "react";
import { Property, PropertyExpense } from "../types";
import * as XLSX from "xlsx";
import { 
  Building, 
  User, 
  Coins, 
  MapPin, 
  CreditCard, 
  Trash2, 
  Plus, 
  Edit3, 
  X, 
  Check, 
  Calculator,
  RefreshCw,
  Info,
  AlertCircle,
  FileText,
  Upload,
  Download,
  FileSpreadsheet,
  FileCode,
  Calendar,
  Sparkles,
  Loader2,
  CheckCircle
} from "lucide-react";

interface PropertiesProps {
  properties: Property[];
  onAddProperty: (newProperty: Property) => void;
  onEditProperty: (updatedProperty: Property) => void;
  onDeleteProperty: (id: string) => void;
  onDeleteExpense: (id: string) => void;
  onImportProperties?: (newProperties: Property[], mode: 'merge' | 'replace') => void;
  user1Name: string;
  user2Name: string;
  hasPartner: boolean;
  expenses?: PropertyExpense[];
  currentYear?: number;
}

export default function Properties({ 
  properties, 
  onAddProperty, 
  onEditProperty, 
  onDeleteProperty,
  onDeleteExpense,
  onImportProperties,
  user1Name,
  user2Name,
  hasPartner,
  expenses = [],
  currentYear = 2026
}: PropertiesProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [openFiscalPropertyId, setOpenFiscalPropertyId] = useState<string | null>(null);
  const [fiscalFilterYear, setFiscalFilterYear] = useState<number>(currentYear);
  const [deleteExpenseConfirmId, setDeleteExpenseConfirmId] = useState<string | null>(null);

  // New states for real estate performance metrics and document manager
  const [openFinancialsPropertyId, setOpenFinancialsPropertyId] = useState<string | null>(null);
  const [openDocsPropertyId, setOpenDocsPropertyId] = useState<string | null>(null);

  // Import / Export states
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importPreviewData, setImportPreviewData] = useState<Property[] | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccessMsg, setImportSuccessMsg] = useState<string | null>(null);
  const [financialYear, setFinancialYear] = useState<number>(currentYear);
  const [docYear, setDocYear] = useState<number>(currentYear);

  const [finCurrentValue, setFinCurrentValue] = useState("");
  const [finPurchasePrice, setFinPurchasePrice] = useState("");
  const [finPurchaseExpenses, setFinPurchaseExpenses] = useState("");
  const [finMortgageDebt, setFinMortgageDebt] = useState("");
  const [finMonthlyMortgagePayment, setFinMonthlyMortgagePayment] = useState("");

  const [docCategory, setDocCategory] = useState<'ibi' | 'seguros' | 'comunidad' | 'reparaciones' | 'muebles_electrodomesticos' | 'otros'>('ibi');
  const [uploadedFileBase64, setUploadedFileBase64] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [uploadedFileSize, setUploadedFileSize] = useState("");
  const [uploadedFileType, setUploadedFileType] = useState("");
  const [docUploadSuccess, setDocUploadSuccess] = useState(false);
  const [docIsUploading, setDocIsUploading] = useState(false);

  useEffect(() => {
    setFiscalFilterYear(currentYear);
    setFinancialYear(currentYear);
    setDocYear(currentYear);
  }, [currentYear]);

  // Sync financial form fields when selecting a property or changing years
  useEffect(() => {
    if (openFinancialsPropertyId) {
      const prop = properties.find(p => p.id === openFinancialsPropertyId);
      if (prop) {
        const yearly = prop.yearlyFinancials?.[financialYear];
        setFinCurrentValue(yearly?.currentValue?.toString() ?? prop.purchasePrice?.toString() ?? "0");
        setFinPurchasePrice(yearly?.purchasePrice?.toString() ?? prop.purchasePrice?.toString() ?? "0");
        setFinPurchaseExpenses(yearly?.purchaseExpenses?.toString() ?? "0");
        setFinMortgageDebt(yearly?.mortgageDebt?.toString() ?? "0");
        setFinMonthlyMortgagePayment(yearly?.monthlyMortgagePayment?.toString() ?? "0");
      }
    }
  }, [openFinancialsPropertyId, financialYear, properties]);

  const handleSaveFinancials = (prop: Property) => {
    const updatedYearly = {
      ...(prop.yearlyFinancials || {})
    };
    updatedYearly[financialYear] = {
      currentValue: Number(finCurrentValue.toString().replace(",", ".") || 0),
      purchasePrice: Number(finPurchasePrice.toString().replace(",", ".") || 0),
      purchaseExpenses: Number(finPurchaseExpenses.toString().replace(",", ".") || 0),
      mortgageDebt: Number(finMortgageDebt.toString().replace(",", ".") || 0),
      monthlyMortgagePayment: Number(finMonthlyMortgagePayment.toString().replace(",", ".") || 0),
    };

    const updatedProp: Property = {
      ...prop,
      purchasePrice: Number(finPurchasePrice.toString().replace(",", ".") || prop.purchasePrice || 0),
      yearlyFinancials: updatedYearly
    };
    
    onEditProperty(updatedProp);
  };

  const handleUploadDocLocal = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setDocIsUploading(true);
    setDocUploadSuccess(false);

    const reader = new FileReader();
    reader.onload = (evt) => {
      const result = evt.target?.result;
      if (typeof result === "string") {
        setUploadedFileBase64(result);
        setUploadedFileName(file.name);
        const sizeInMB = (file.size / (1024 * 1024)).toFixed(2);
        setUploadedFileSize(`${sizeInMB} MB`);
        setUploadedFileType(file.type || "application/pdf");
        
        setDocIsUploading(false);
        setDocUploadSuccess(true);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSaveDocument = (prop: Property) => {
    if (!uploadedFileBase64) return;

    const newDoc = {
      id: `doc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: uploadedFileName,
      size: uploadedFileSize,
      type: uploadedFileType,
      category: docCategory,
      year: docYear,
      uploadDate: new Date().toLocaleDateString('es-ES'),
      fileData: uploadedFileBase64
    };

    const updatedProp: Property = {
      ...prop,
      documents: [...(prop.documents || []), newDoc]
    };

    onEditProperty(updatedProp);
    
    // Clear state
    setUploadedFileBase64(null);
    setUploadedFileName("");
    setUploadedFileSize("");
    setUploadedFileType("");
    setDocUploadSuccess(false);
  };

  const handleDeleteDocument = (prop: Property, docId: string) => {
    const updatedProp: Property = {
      ...prop,
      documents: (prop.documents || []).filter(d => d.id !== docId)
    };
    onEditProperty(updatedProp);
  };

  const [openContractPropertyId, setOpenContractPropertyId] = useState<string | null>(null);

  // Card-level Contract Form State
  const [cardStartDate, setCardStartDate] = useState("");
  const [cardEndDate, setCardEndDate] = useState("");
  const [cardMonthlyRent, setCardMonthlyRent] = useState("");
  const [cardPdfName, setCardPdfName] = useState("");
  const [cardPdfSize, setCardPdfSize] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);

  const handleToggleContractPanel = (prop: Property) => {
    if (openContractPropertyId === prop.id) {
      setOpenContractPropertyId(null);
    } else {
      setOpenContractPropertyId(prop.id);
      setOpenFiscalPropertyId(null);
      // Initialize states
      setCardStartDate(prop.contract?.startDate || "");
      setCardEndDate(prop.contract?.endDate || "");
      setCardMonthlyRent(prop.contract?.monthlyRent?.toString() || prop.monthlyRent?.toString() || "0");
      setCardPdfName(prop.contract?.pdfName || "");
      setCardPdfSize(prop.contract?.pdfSize || "");
      setUploadSuccess(!!prop.contract?.pdfName);
      setIsUploading(false);
    }
  };

  const handleSaveCardContract = (prop: Property) => {
    const updatedProp: Property = {
      ...prop,
      contract: {
        startDate: cardStartDate || new Date().toISOString().split('T')[0],
        endDate: cardEndDate || undefined,
        monthlyRent: Number(cardMonthlyRent.toString().replace(",", ".") || prop.monthlyRent || 0),
        pdfName: cardPdfName || undefined,
        pdfSize: cardPdfSize || undefined
      }
    };
    onEditProperty(updatedProp);
  };

  const handleDeleteCardContract = (prop: Property) => {
    const updatedProp: Property = {
      ...prop,
      contract: undefined
    };
    onEditProperty(updatedProp);
    setCardStartDate("");
    setCardEndDate("");
    setCardMonthlyRent(prop.monthlyRent.toString());
    setCardPdfName("");
    setCardPdfSize("");
    setUploadSuccess(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, prop: Property) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadSuccess(false);

    setTimeout(() => {
      setIsUploading(false);
      setUploadSuccess(true);
      setCardPdfName(file.name);
      
      const sizeInMB = (file.size / (1024 * 1024)).toFixed(2);
      setCardPdfSize(`${sizeInMB} MB`);

      if (!cardStartDate) {
        setCardStartDate("2026-01-01");
      }
      if (!cardMonthlyRent || cardMonthlyRent === "0") {
        setCardMonthlyRent(prop.monthlyRent.toString() || "1200");
      }
      if (!cardEndDate) {
        setCardEndDate("2027-01-01");
      }
    }, 1500);
  };

  // Form State
  const [address, setAddress] = useState("");
  const [cadastralReference, setCadastralReference] = useState("");
  const [owner, setOwner] = useState<'user1' | 'user2' | 'both'>('user1');
  const [pctU1, setPctU1] = useState("100");
  const [pctU2, setPctU2] = useState("0");
  const [tenantName, setTenantName] = useState("");
  const [tenantDni, setTenantDni] = useState("");
  const [monthlyRent, setMonthlyRent] = useState("0");
  const [purchasePrice, setPurchasePrice] = useState("0");
  const [landValuePercent, setLandValuePercent] = useState("25");
  const [expensesCommunity, setExpensesCommunity] = useState("0");
  const [expensesIBI, setExpensesIBI] = useState("0");
  const [expensesInsurance, setExpensesInsurance] = useState("0");
  const [expensesRepairs, setExpensesRepairs] = useState("0");

  const [contractStartDate, setContractStartDate] = useState("");
  const [contractEndDate, setContractEndDate] = useState("");
  const [contractMonthlyRent, setContractMonthlyRent] = useState("");
  const [contractPdfName, setContractPdfName] = useState("");
  const [contractPdfSize, setContractPdfSize] = useState("");

  const resetForm = () => {
    setAddress("");
    setCadastralReference("");
    setOwner('user1');
    setPctU1("100");
    setPctU2("0");
    setTenantName("");
    setTenantDni("");
    setMonthlyRent("0");
    setPurchasePrice("0");
    setLandValuePercent("25");
    setExpensesCommunity("0");
    setExpensesIBI("0");
    setExpensesInsurance("0");
    setExpensesRepairs("0");
    setContractStartDate("");
    setContractEndDate("");
    setContractMonthlyRent("");
    setContractPdfName("");
    setContractPdfSize("");
  };

  const handleStartEdit = (prop: Property) => {
    setEditingId(prop.id);
    setAddress(prop.address);
    setCadastralReference(prop.cadastralReference);
    setOwner(prop.owner);
    setPctU1(prop.ownershipPercentageUser1.toString());
    setPctU2(prop.ownershipPercentageUser2.toString());
    setTenantName(prop.tenantName);
    setTenantDni(prop.tenantDni);
    setMonthlyRent(prop.monthlyRent.toString());
    setPurchasePrice(prop.purchasePrice.toString());
    setLandValuePercent(prop.landValuePercent.toString());
    setExpensesCommunity(prop.expensesCommunity.toString());
    setExpensesIBI(prop.expensesIBI.toString());
    setExpensesInsurance(prop.expensesInsurance.toString());
    setExpensesRepairs(prop.expensesRepairs.toString());
    setContractStartDate(prop.contract?.startDate || "");
    setContractEndDate(prop.contract?.endDate || "");
    setContractMonthlyRent(prop.contract?.monthlyRent?.toString() || "");
    setContractPdfName(prop.contract?.pdfName || "");
    setContractPdfSize(prop.contract?.pdfSize || "");
  };

  const handleOwnerChange = (val: 'user1' | 'user2' | 'both') => {
    setOwner(val);
    if (val === 'user1') {
      setPctU1("100");
      setPctU2("0");
    } else if (val === 'user2') {
      setPctU1("0");
      setPctU2("100");
    } else {
      setPctU1("50");
      setPctU2("50");
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!address.trim()) return;

    // Calculate Amortization amount based on Spanish law: 3% on construction value (acquisition cost minus land value)
    const safePrice = Number(purchasePrice.toString().replace(",", ".") || 0);
    const safeLand = Number(landValuePercent.toString().replace(",", ".") || 0);
    const constructionValue = safePrice * (100 - safeLand) / 100;
    const computedAmortization = Number((constructionValue * 0.03).toFixed(2));

    const hasContractData = contractStartDate || contractEndDate || contractMonthlyRent || contractPdfName;
    let finalContract = undefined;
    if (hasContractData) {
      finalContract = {
        startDate: contractStartDate || new Date().toISOString().split("T")[0],
        endDate: contractEndDate || undefined,
        monthlyRent: Number(contractMonthlyRent.toString().replace(",", ".") || monthlyRent.toString().replace(",", ".") || 0),
        pdfName: contractPdfName || undefined,
        pdfSize: contractPdfSize || undefined,
      };
    }
    const existingProp = editingId ? properties.find(p => p.id === editingId) : undefined;
    if (existingProp?.contract && !hasContractData) {
      finalContract = existingProp.contract;
    }

    let defaultYearlyFinancials = undefined;
    if (!editingId) {
      // For a new property, generate standard 2025-2028 financials
      const defaultExpenses = Math.round(safePrice * 0.1); // 10% standard purchase expenses
      const defaultMortgageDebt = 0; // Default to no mortgage, can be set in financials
      const defaultMonthlyMortgagePayment = 0;
      
      const years = [2025, 2026, 2027, 2028];
      const yearlyRecord: Record<number, any> = {};
      years.forEach((yr) => {
        const yearsDiff = Math.max(0, yr - 2025);
        const estimatedCurrentValue = Math.round(safePrice * Math.pow(1.035, yearsDiff));
        yearlyRecord[yr] = {
          currentValue: estimatedCurrentValue,
          purchasePrice: safePrice,
          purchaseExpenses: defaultExpenses,
          mortgageDebt: defaultMortgageDebt,
          monthlyMortgagePayment: defaultMonthlyMortgagePayment
        };
      });
      defaultYearlyFinancials = yearlyRecord;
    }

    const propData: Property = {
      id: editingId || `prop_${Date.now()}`,
      address,
      cadastralReference,
      owner,
      ownershipPercentageUser1: Number(pctU1.toString().replace(",", ".") || 0),
      ownershipPercentageUser2: hasPartner ? Number(pctU2.toString().replace(",", ".") || 0) : 0,
      tenantName,
      tenantDni,
      monthlyRent: Number(monthlyRent.toString().replace(",", ".") || 0),
      purchasePrice: Number(purchasePrice.toString().replace(",", ".") || 0),
      landValuePercent: Number(landValuePercent.toString().replace(",", ".") || 0),
      amortizationAmount: computedAmortization,
      expensesCommunity: Number(expensesCommunity.toString().replace(",", ".") || 0),
      expensesIBI: Number(expensesIBI.toString().replace(",", ".") || 0),
      expensesInsurance: Number(expensesInsurance.toString().replace(",", ".") || 0),
      expensesRepairs: Number(expensesRepairs.toString().replace(",", ".") || 0),
      registrationDate: existingProp?.registrationDate || new Date().toLocaleDateString('es-ES'),
      contract: finalContract,
      yearlyFinancials: existingProp?.yearlyFinancials || defaultYearlyFinancials,
      documents: existingProp?.documents
    };

    if (editingId) {
      onEditProperty(propData);
      setEditingId(null);
    } else {
      onAddProperty(propData);
      setIsAdding(false);
    }
    resetForm();
  };

  // Property Export handlers
  const handleExportJSON = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(properties, null, 2));
    const dlAnchor = document.createElement("a");
    dlAnchor.setAttribute("href", dataStr);
    dlAnchor.setAttribute("download", `inmuebles_rentasync_${new Date().toISOString().split("T")[0]}.json`);
    document.body.appendChild(dlAnchor);
    dlAnchor.click();
    dlAnchor.remove();
    setIsExportOpen(false);
  };

  const handleExportExcel = () => {
    const rows = properties.map((p) => ({
      "ID Inmueble": p.id,
      "Dirección Completa": p.address,
      "Referencia Catastral": p.cadastralReference || "",
      "Titularidad": p.owner,
      "% Propietario 1": p.ownershipPercentageUser1,
      "% Propietario 2": p.ownershipPercentageUser2,
      "Inquilino": p.tenantName || "",
      "DNI Inquilino": p.tenantDni || "",
      "Renta Mensual (€)": p.monthlyRent || 0,
      "Precio Adquisición (€)": p.purchasePrice || 0,
      "% Suelo Catastral": p.landValuePercent || 0,
      "Amortización Anual (€)": p.amortizationAmount || 0,
      "Gastos Comunidad (€)": p.expensesCommunity || 0,
      "Gastos IBI (€)": p.expensesIBI || 0,
      "Gastos Seguro (€)": p.expensesInsurance || 0,
      "Gastos Reparaciones (€)": p.expensesRepairs || 0,
      "Fecha Registro": p.registrationDate || ""
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Inmuebles");
    XLSX.writeFile(workbook, `inmuebles_${new Date().toISOString().split("T")[0]}.xlsx`);
    setIsExportOpen(false);
  };

  // Property Import handler
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
            if (Array.isArray(parsed.properties)) {
              rawArray = parsed.properties;
            } else if (Array.isArray(parsed.inmuebles)) {
              rawArray = parsed.inmuebles;
            } else if (Array.isArray(parsed.data?.properties)) {
              rawArray = parsed.data.properties;
            } else if (Array.isArray(parsed.portfolio?.properties)) {
              rawArray = parsed.portfolio.properties;
            } else if (Array.isArray(parsed.state?.properties)) {
              rawArray = parsed.state.properties;
            } else if (Array.isArray(parsed.data)) {
              rawArray = parsed.data;
            } else if (Array.isArray(parsed.items)) {
              rawArray = parsed.items;
            } else if (parsed.address || parsed["Dirección Completa"] || parsed["Dirección"] || parsed["Direccion"]) {
              rawArray = [parsed];
            } else {
              const candidateKey = Object.keys(parsed).find(k => 
                Array.isArray(parsed[k]) && parsed[k].length > 0 && 
                (parsed[k][0]?.address || parsed[k][0]?.["Dirección Completa"] || parsed[k][0]?.cadastralReference || parsed[k][0]?.monthlyRent)
              );
              if (candidateKey) {
                rawArray = parsed[candidateKey];
              }
            }
          }

          if (rawArray && Array.isArray(rawArray)) {
            const validProps: Property[] = rawArray.map((item: any, idx: number) => ({
              id: item.id || `prop_imp_${Date.now()}_${idx}`,
              address: String(item.address || item.Dirección || item["Dirección Completa"] || item.Direccion || "Sin Dirección"),
              cadastralReference: String(item.cadastralReference || item["Referencia Catastral"] || item.refCatastral || ""),
              owner: (item.owner === "user2" || item.owner === "joint") ? item.owner : "user1",
              ownershipPercentageUser1: Number(item.ownershipPercentageUser1 ?? item["% Propietario 1"] ?? 100),
              ownershipPercentageUser2: Number(item.ownershipPercentageUser2 ?? item["% Propietario 2"] ?? 0),
              tenantName: String(item.tenantName || item["Inquilino"] || ""),
              tenantDni: String(item.tenantDni || item["DNI Inquilino"] || ""),
              monthlyRent: Number(item.monthlyRent ?? item["Renta Mensual (€)"] ?? item["Renta Mensual"] ?? 0),
              purchasePrice: Number(item.purchasePrice ?? item["Precio Adquisición (€)"] ?? item["Precio Adquisicion"] ?? 0),
              landValuePercent: Number(item.landValuePercent ?? item["% Suelo Catastral"] ?? 25),
              amortizationAmount: Number(item.amortizationAmount ?? item["Amortización Anual (€)"] ?? 0),
              expensesCommunity: Number(item.expensesCommunity ?? item["Gastos Comunidad (€)"] ?? 0),
              expensesIBI: Number(item.expensesIBI ?? item["Gastos IBI (€)"] ?? 0),
              expensesInsurance: Number(item.expensesInsurance ?? item["Gastos Seguro (€)"] ?? 0),
              expensesRepairs: Number(item.expensesRepairs ?? item["Gastos Reparaciones (€)"] ?? 0),
              registrationDate: String(item.registrationDate || item["Fecha Registro"] || new Date().toLocaleDateString('es-ES')),
              contract: item.contract,
              yearlyFinancials: item.yearlyFinancials,
              documents: item.documents
            })).filter(p => p.address && p.address !== "Sin Dirección");

            if (validProps.length === 0) {
              setImportError("No se han encontrado inmuebles con datos válidos en el archivo JSON.");
              setImportPreviewData(null);
            } else {
              setImportPreviewData(validProps);
            }
          } else {
            setImportError("No se ha encontrado un listado de inmuebles en el archivo JSON. Asegúrate de que el archivo exportado contenga los datos de los inmuebles.");
            setImportPreviewData(null);
          }
        } catch (err) {
          setImportError("Error al leer el archivo JSON de inmuebles. Comprueba que el formato sea correcto.");
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

          const validProps: Property[] = rows.map((item: any, idx: number) => {
            const addr = item["Dirección Completa"] || item["Dirección"] || item["address"] || item["Direccion"] || "Sin Dirección";
            const ref = item["Referencia Catastral"] || item["cadastralReference"] || item["Ref Catastral"] || "";
            const ownerVal = item["Titularidad"] || item["Titular"] || item["owner"] || "user1";
            const rent = item["Renta Mensual (€)"] || item["Renta Mensual"] || item["monthlyRent"] || 0;
            const price = item["Precio Adquisición (€)"] || item["purchasePrice"] || 0;
            const land = item["% Suelo Catastral"] || item["landValuePercent"] || 25;
            const amort = item["Amortización Anual (€)"] || item["amortizationAmount"] || (price * (100 - land) / 100 * 0.03);

            return {
              id: item["ID Inmueble"] || item["id"] || `prop_imp_${Date.now()}_${idx}`,
              address: String(addr),
              cadastralReference: String(ref),
              owner: ownerVal as any,
              ownershipPercentageUser1: Number(item["% Propietario 1"] ?? item["ownershipPercentageUser1"] ?? 100),
              ownershipPercentageUser2: Number(item["% Propietario 2"] ?? item["ownershipPercentageUser2"] ?? 0),
              tenantName: String(item["Inquilino"] || item["tenantName"] || ""),
              tenantDni: String(item["DNI Inquilino"] || item["tenantDni"] || ""),
              monthlyRent: Number(rent) || 0,
              purchasePrice: Number(price) || 0,
              landValuePercent: Number(land) || 25,
              amortizationAmount: Number(amort) || 0,
              expensesCommunity: Number(item["Gastos Comunidad (€)"] || item["expensesCommunity"] || 0),
              expensesIBI: Number(item["Gastos IBI (€)"] || item["expensesIBI"] || 0),
              expensesInsurance: Number(item["Gastos Seguro (€)"] || item["expensesInsurance"] || 0),
              expensesRepairs: Number(item["Gastos Reparaciones (€)"] || item["expensesRepairs"] || 0),
              registrationDate: String(item["Fecha Registro"] || item["registrationDate"] || new Date().toLocaleDateString('es-ES'))
            };
          }).filter(p => p.address && p.address !== "Sin Dirección");

          if (validProps.length === 0) {
            setImportError("No se han encontrado filas con direcciones válidas en la hoja de cálculo.");
            setImportPreviewData(null);
          } else {
            setImportPreviewData(validProps);
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
    if (onImportProperties) {
      onImportProperties(importPreviewData, importMode);
      setImportSuccessMsg(`Se han importado con éxito ${importPreviewData.length} inmuebles.`);
      setTimeout(() => {
        setIsImportOpen(false);
        setImportPreviewData(null);
        setImportSuccessMsg(null);
      }, 1200);
    } else {
      importPreviewData.forEach(p => onAddProperty(p));
      setIsImportOpen(false);
      setImportPreviewData(null);
    }
  };

  return (
    <div id="properties-tab" className="space-y-8 animate-fade-in text-slate-100">
      
      {/* HEADER SECTION */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Mis Inmuebles Arrendados</h1>
          <p className="text-sm text-slate-400 mt-1">
            Gestiona tu cartera inmobiliaria, inquilinos, contratos e importes deducibles para el cálculo fiscal.
          </p>
        </div>
        {!isAdding && !editingId && (
          <div className="mt-4 sm:mt-0 flex flex-wrap items-center gap-2">
            {/* EXPORT BUTTON & DROPDOWN */}
            <div className="relative">
              <button
                onClick={() => setIsExportOpen(!isExportOpen)}
                className="inline-flex items-center px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-semibold rounded-xl transition-all cursor-pointer text-xs"
                title="Exportar inmuebles"
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
              className="inline-flex items-center px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-semibold rounded-xl transition-all cursor-pointer text-xs"
              title="Importar inmuebles"
            >
              <Upload className="w-4 h-4 mr-1.5 text-amber-400" />
              <span>Importar</span>
            </button>

            {/* ADD PROPERTY BUTTON */}
            <button
              onClick={() => { resetForm(); setIsAdding(true); }}
              className="inline-flex items-center px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl transition-all cursor-pointer text-xs shadow-md shadow-indigo-600/10"
            >
              <Plus className="w-4 h-4 mr-1.5" />
              <span>Añadir Inmueble</span>
            </button>
          </div>
        )}
      </div>

      {/* FORM: ADD OR EDIT */}
      {(isAdding || editingId) && (
        <form onSubmit={handleSubmit} className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 sm:p-8 space-y-6 animate-slide-in">
          <div className="flex justify-between items-center border-b border-slate-700/60 pb-4">
            <h3 className="text-lg font-bold text-white flex items-center">
              <Building className="w-5 h-5 text-indigo-400 mr-2" />
              {editingId ? "Editar Detalles del Inmueble" : "Añadir Nuevo Inmueble de Alquiler"}
            </h3>
            <button
              type="button"
              onClick={() => { setIsAdding(false); setEditingId(null); resetForm(); }}
              className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-700/40"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            
            {/* COLUMN 1: BASICS */}
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Dirección Completa</label>
                <input
                  type="text"
                  required
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full bg-slate-900/60 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  placeholder="Calle de Alcalá 140, 3ºB, Madrid"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Referencia Catastral (20 caracteres)</label>
                <input
                  type="text"
                  value={cadastralReference}
                  onChange={(e) => setCadastralReference(e.target.value)}
                  className="w-full bg-slate-900/60 border border-slate-700 rounded-xl px-4 py-2.5 text-sm font-mono text-slate-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 uppercase"
                  placeholder="9872301VK4797S0003TR"
                  maxLength={20}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Titularidad Catastral</label>
                  <select
                    value={owner}
                    onChange={(e) => handleOwnerChange(e.target.value as any)}
                    className="w-full bg-slate-900/60 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  >
                    <option value="user1">Propietario 1 ({user1Name})</option>
                    {hasPartner && <option value="user2">Propietario 2 ({user2Name})</option>}
                    {hasPartner && <option value="both">Coparticipado (Ambos)</option>}
                  </select>
                </div>

                {owner === 'both' && (
                  <div className="flex space-x-2">
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-500 uppercase mb-1.5">% {user1Name.split(" ")[0]}</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={pctU1}
                        onChange={(e) => {
                          const valStr = e.target.value;
                          if (valStr === "" || /^[0-9]*[.,]?[0-9]*$/.test(valStr)) {
                            const valNum = Math.min(100, Math.max(0, Number(valStr.replace(",", ".") || 0)));
                            setPctU1(valStr);
                            setPctU2((100 - valNum).toString());
                          }
                        }}
                        className="w-full bg-slate-900/60 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 font-bold focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-500 uppercase mb-1.5">% {user2Name.split(" ")[0]}</label>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={pctU2}
                        onChange={(e) => {
                          const valStr = e.target.value;
                          if (valStr === "" || /^[0-9]*[.,]?[0-9]*$/.test(valStr)) {
                            const valNum = Math.min(100, Math.max(0, Number(valStr.replace(",", ".") || 0)));
                            setPctU2(valStr);
                            setPctU1((100 - valNum).toString());
                          }
                        }}
                        className="w-full bg-slate-900/60 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-100 font-bold focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="bg-slate-900/30 p-4 rounded-xl border border-slate-700/40 space-y-3">
                <h4 className="text-xs font-bold text-slate-300 flex items-center">
                  <User className="w-3.5 h-3.5 text-indigo-400 mr-1.5" />
                  Información de Contrato e Inquilino
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Nombre Completo de Inquilinos</label>
                    <input
                      type="text"
                      value={tenantName}
                      onChange={(e) => setTenantName(e.target.value)}
                      className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100"
                      placeholder="Juan Pérez García, María López Fernández"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">NIF / DNI de Inquilinos</label>
                    <input
                      type="text"
                      value={tenantDni}
                      onChange={(e) => setTenantDni(e.target.value)}
                      className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 font-mono"
                      placeholder="12345678Z, 87654321X"
                    />
                  </div>
                </div>
                <p className="text-[9px] text-slate-500 italic">
                  * Si hay varios inquilinos, sepáralos por comas (ej: Juan Pérez, María López).
                </p>
                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">Renta Mensual (€/mes)</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={monthlyRent}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "" || /^[0-9]*[.,]?[0-9]*$/.test(val)) {
                        setMonthlyRent(val);
                      }
                    }}
                    className="w-1/2 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 font-semibold focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                {/* Apartado para Contratos */}
                <div className="border-t border-slate-700/60 pt-3.5 mt-2 space-y-3">
                  <span className="text-[10px] font-mono font-bold text-indigo-400 uppercase tracking-wider block">
                    Vigencia y Documentación de Contrato
                  </span>
                  
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Fecha de Inicio</label>
                      <input
                        type="date"
                        value={contractStartDate}
                        onChange={(e) => setContractStartDate(e.target.value)}
                        className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Fecha de Fin (si procede)</label>
                      <input
                        type="date"
                        value={contractEndDate}
                        onChange={(e) => setContractEndDate(e.target.value)}
                        className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Renta en Contrato (€/mes, opcional)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder={monthlyRent || "0"}
                      value={contractMonthlyRent}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "" || /^[0-9]*[.,]?[0-9]*$/.test(val)) {
                          setContractMonthlyRent(val);
                        }
                      }}
                      className="w-1/2 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 font-semibold focus:ring-1 focus:ring-indigo-500 focus:outline-none"
                    />
                  </div>

                  {/* Subida de Contrato PDF en Formulario */}
                  <div className="space-y-1.5">
                    <label className="block text-[10px] text-slate-400">Adjuntar Documento PDF de Contrato</label>
                    <div className="relative border border-dashed border-slate-700 hover:border-slate-500 rounded-xl p-4 transition-all bg-slate-900/40 text-center">
                      <input
                        type="file"
                        accept=".pdf"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            setContractPdfName(file.name);
                            const sizeInMB = (file.size / (1024 * 1024)).toFixed(2);
                            setContractPdfSize(`${sizeInMB} MB`);
                            if (!contractStartDate) {
                              setContractStartDate(new Date().toISOString().split('T')[0]);
                            }
                            if (!contractMonthlyRent) {
                              setContractMonthlyRent(monthlyRent || "1200");
                            }
                          }
                        }}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      />
                      
                      {contractPdfName ? (
                        <div className="flex items-center justify-between text-xs bg-slate-950/40 p-2.5 rounded-lg border border-slate-800">
                          <div className="flex items-center space-x-2">
                            <FileText className="w-5 h-5 text-emerald-400" />
                            <div className="text-left">
                              <p className="font-semibold text-slate-200 truncate max-w-[150px]">{contractPdfName}</p>
                              <p className="text-[10px] text-slate-500">{contractPdfSize || "Fichero PDF"}</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setContractPdfName("");
                              setContractPdfSize("");
                            }}
                            className="text-red-400 hover:text-red-300 font-semibold text-[10px] uppercase tracking-wider"
                          >
                            Eliminar
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <Upload className="w-5 h-5 text-slate-500 mx-auto" />
                          <p className="text-[11px] text-slate-400 font-medium">Selecciona o arrastra el PDF del contrato</p>
                          <p className="text-[9px] text-slate-500">Admite archivos .pdf de hasta 10 MB</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* COLUMN 2: FINANCIAL DETAILS & TAX DEDUCTIONS */}
            <div className="space-y-4">
              <div className="bg-slate-900/40 p-4 rounded-xl border border-slate-700/60 space-y-4">
                <h4 className="text-xs font-bold text-slate-300 flex items-center">
                  <Calculator className="w-3.5 h-3.5 text-indigo-400 mr-1.5" />
                  Base de Compra y Amortización Fiscal
                </h4>
                <p className="text-[10px] text-slate-400 leading-normal">
                  Según la normativa española de IRPF, es deducible como gasto el 3% del coste de adquisición correspondiente a la construcción (excluyendo el valor de suelo).
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Precio Compra / Adquisición (€)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={purchasePrice}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "" || /^[0-9]*[.,]?[0-9]*$/.test(val)) {
                          setPurchasePrice(val);
                        }
                      }}
                      className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 font-bold focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Porcentaje Suelo Catastral (%)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={landValuePercent}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "" || /^[0-9]*[.,]?[0-9]*$/.test(val)) {
                          setLandValuePercent(val);
                        }
                      }}
                      className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 font-semibold focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>

                <div className="flex justify-between items-center text-xs bg-slate-950/40 p-3 rounded-lg border border-slate-800 text-indigo-300">
                  <span>Amortización Anual Deducible Estimada:</span>
                  <span className="font-bold text-white">
                    {((Number(purchasePrice.toString().replace(",", ".") || 0) * (100 - Number(landValuePercent.toString().replace(",", ".") || 0)) / 100) * 0.03).toLocaleString("es-ES")} €
                  </span>
                </div>
              </div>

              <div className="bg-slate-900/30 p-4 rounded-xl border border-slate-700/40 space-y-3">
                <h4 className="text-xs font-bold text-slate-300 flex items-center">
                  <Coins className="w-3.5 h-3.5 text-indigo-400 mr-1.5" />
                  Gastos Anuales Estimados (Deducibles de Renta)
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Gastos de Comunidad (€/año)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={expensesCommunity}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "" || /^[0-9]*[.,]?[0-9]*$/.test(val)) {
                          setExpensesCommunity(val);
                        }
                      }}
                      className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Importe IBI (€/año)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={expensesIBI}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "" || /^[0-9]*[.,]?[0-9]*$/.test(val)) {
                          setExpensesIBI(val);
                        }
                      }}
                      className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Seguro de Hogar / Impago (€/año)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={expensesInsurance}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "" || /^[0-9]*[.,]?[0-9]*$/.test(val)) {
                          setExpensesInsurance(val);
                        }
                      }}
                      className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Reparaciones y Conservación (€/año)</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={expensesRepairs}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "" || /^[0-9]*[.,]?[0-9]*$/.test(val)) {
                          setExpensesRepairs(val);
                        }
                      }}
                      className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              </div>
            </div>

          </div>

          {/* ACTIONS */}
          <div className="flex justify-end space-x-3 pt-4 border-t border-slate-700/60">
            <button
              type="button"
              onClick={() => { setIsAdding(false); setEditingId(null); resetForm(); }}
              className="px-5 py-2 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-700/40 text-sm transition-all cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="inline-flex items-center px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl text-sm transition-all cursor-pointer shadow-lg shadow-indigo-600/10"
            >
              <Check className="w-4 h-4 mr-1.5" />
              <span>{editingId ? "Sincronizar Cambios" : "Guardar e Integrar"}</span>
            </button>
          </div>
        </form>
      )}

      {/* PROPERTY LIST CARDS */}
      {!isAdding && !editingId && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {properties.length > 0 ? (
            properties.map((prop) => {
              const isFiscalOpen = openFiscalPropertyId === prop.id;
              
              // Calculate values specifically for the selected year
              const propertyExpensesForYear = expenses.filter(
                (e) => e.propertyId === prop.id && parseInt(e.date.split("-")[0] || "0") === fiscalFilterYear
              );

              const dynamicRepairs = propertyExpensesForYear.filter(e => e.category === 'repairs').reduce((sum, e) => sum + e.amount, 0);
              const dynamicIBI = propertyExpensesForYear.filter(e => e.category === 'ibi').reduce((sum, e) => sum + e.amount, 0);
              const dynamicInsurance = propertyExpensesForYear.filter(e => e.category === 'insurance').reduce((sum, e) => sum + e.amount, 0);
              const dynamicCommunity = propertyExpensesForYear.filter(e => e.category === 'community').reduce((sum, e) => sum + e.amount, 0);
              const dynamicMaintenance = propertyExpensesForYear.filter(e => e.category === 'maintenance').reduce((sum, e) => sum + e.amount, 0);
              const dynamicAmortization = propertyExpensesForYear.filter(e => e.category === 'amortization').reduce((sum, e) => sum + e.amount, 0);
              const dynamicOther = propertyExpensesForYear.filter(e => e.category === 'other').reduce((sum, e) => sum + e.amount, 0);

              const is2025 = fiscalFilterYear === 2025;
              const totalRepairs = is2025 ? prop.expensesRepairs : dynamicRepairs;
              const totalIBI = is2025 ? prop.expensesIBI : dynamicIBI;
              const totalInsurance = is2025 ? prop.expensesInsurance : dynamicInsurance;
              const totalCommunity = is2025 ? prop.expensesCommunity : dynamicCommunity;
              const totalAmortization = is2025 ? prop.amortizationAmount : dynamicAmortization;
              const totalMaintenance = dynamicMaintenance;
              const totalOther = dynamicOther;

              const grandTotalExpenses = totalRepairs + totalIBI + totalInsurance + totalCommunity + totalAmortization + totalMaintenance + totalOther;

              const isFinancialsOpen = openFinancialsPropertyId === prop.id;
              const isDocsOpen = openDocsPropertyId === prop.id;
              const isExpanded = isFiscalOpen || openContractPropertyId === prop.id || isFinancialsOpen || isDocsOpen;

              return (
                <div 
                  key={prop.id} 
                  className={`bg-slate-800/40 border border-slate-700/50 hover:border-slate-600 rounded-2xl p-6 transition-all shadow-lg flex flex-col justify-between space-y-6 relative group ${
                    isExpanded ? "md:col-span-2 border-indigo-500/50 shadow-indigo-950/20" : ""
                  }`}
                >
                  
                  {/* Upper Card Block */}
                  <div className="space-y-4">
                    <div className="flex justify-between items-start">
                      <div className="flex items-start space-x-3 min-w-0">
                        <div className="p-2.5 bg-indigo-600/10 text-indigo-400 rounded-xl border border-indigo-500/10 shrink-0">
                          <Building className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-md font-bold text-white leading-tight pr-8 truncate" title={prop.address}>{prop.address}</h4>
                          <div className="flex items-center space-x-2 mt-1 text-xs text-slate-400 font-mono">
                            <MapPin className="w-3 h-3 text-slate-500" />
                            <span className="truncate">Ref: {prop.cadastralReference || "No asignada"}</span>
                          </div>
                        </div>
                      </div>

                      <button
                        onClick={() => onDeleteProperty(prop.id)}
                        className="text-slate-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-slate-700/30 transition-all shrink-0 cursor-pointer"
                        title="Eliminar Inmueble"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Badges / Titularidades */}
                    <div className="flex flex-wrap gap-2 text-[10px] font-mono font-semibold">
                      <span className="px-2.5 py-1 bg-slate-900 border border-slate-800 rounded-lg text-indigo-400">
                        Propietario: {prop.owner === 'user1' ? user1Name.split(" ")[0] : prop.owner === 'user2' ? user2Name.split(" ")[0] : "Ambos"}
                      </span>
                      {prop.owner === 'both' && (
                        <span className="px-2.5 py-1 bg-indigo-950/40 border border-indigo-500/20 rounded-lg text-white">
                          {user1Name.split(" ")[0]}: {prop.ownershipPercentageUser1}% | {user2Name.split(" ")[0]}: {prop.ownershipPercentageUser2}%
                        </span>
                      )}
                      {prop.contract ? (
                        <span className="px-2.5 py-1 bg-emerald-950/40 border border-emerald-500/20 rounded-lg text-emerald-400 flex items-center">
                          <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse mr-1.5"></span>
                          <span>Contrato Activo</span>
                        </span>
                      ) : (
                        <span className="px-2.5 py-1 bg-amber-950/20 border border-amber-500/20 rounded-lg text-amber-500">
                          Sin Contrato
                        </span>
                      )}
                    </div>

                    {/* Financial Metrics Split */}
                    <div className="grid grid-cols-2 gap-4 bg-slate-900/30 p-4 rounded-xl border border-slate-700/20 text-xs">
                      <div className="space-y-1">
                        <span className="text-slate-500 font-mono uppercase block text-[9px]">Renta Mensual</span>
                        <span className="text-lg font-black text-white">{prop.monthlyRent.toLocaleString("es-ES")} €</span>
                      </div>
                      <div className="space-y-1">
                        <span className="text-slate-500 font-mono uppercase block text-[9px]">Amortización Anual</span>
                        <span className="text-lg font-bold text-indigo-300">{prop.amortizationAmount.toLocaleString("es-ES")} €</span>
                      </div>
                    </div>

                    {/* Inquilinos info */}
                    {(() => {
                      const tenants = prop.tenantName ? prop.tenantName.split(",").map(t => t.trim()).filter(Boolean) : [];
                      const dnis = prop.tenantDni ? prop.tenantDni.split(",").map(d => d.trim()).filter(Boolean) : [];
                      return (
                        <div className="bg-slate-950/30 p-3.5 rounded-xl border border-slate-800 space-y-2">
                          <span className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-wider block">
                            Arrendatarios / Inquilinos ({tenants.length || 0})
                          </span>
                          {tenants.length > 0 ? (
                            <div className="space-y-1.5 max-h-[120px] overflow-y-auto">
                              {tenants.map((t, idx) => (
                                <div key={idx} className="flex justify-between items-center text-xs bg-slate-900/40 p-2 rounded-lg border border-slate-800/40">
                                  <div className="flex items-center space-x-1.5 min-w-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"></span>
                                    <span className="text-slate-200 font-medium truncate" title={t}>{t}</span>
                                  </div>
                                  <span className="text-[10px] text-slate-400 font-mono shrink-0 bg-slate-800/80 px-1.5 py-0.5 rounded border border-slate-700/30 ml-2">
                                    {dnis[idx] || "---"}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-slate-500 italic">No se especifican inquilinos</p>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Lower Card Block: Expenses Overview & Action Buttons */}
                  <div className="space-y-4 pt-4 border-t border-slate-700/40">
                    <div className="flex justify-between items-center text-xs text-slate-400">
                      <span>Deducciones e Impuestos ({fiscalFilterYear}):</span>
                      <span className="font-semibold text-indigo-300">
                        {grandTotalExpenses.toLocaleString("es-ES")} € desgravables
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => handleStartEdit(prop)}
                        className="inline-flex items-center justify-center py-2 px-3 bg-slate-900 hover:bg-slate-700 border border-slate-700 hover:border-slate-600 text-slate-300 font-semibold rounded-xl text-xs transition-all cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5 mr-1" />
                        Editar Ficha
                      </button>

                      <button
                        onClick={() => {
                          setOpenFinancialsPropertyId(isFinancialsOpen ? null : prop.id);
                          setOpenDocsPropertyId(null);
                          setOpenFiscalPropertyId(null);
                          setOpenContractPropertyId(null);
                        }}
                        className={`inline-flex items-center justify-center py-2 px-3 border rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                          isFinancialsOpen
                            ? "bg-amber-600 hover:bg-amber-500 border-amber-500 text-slate-950 font-bold"
                            : "bg-amber-950/20 hover:bg-amber-950/40 border-amber-500/20 text-amber-400"
                        }`}
                      >
                        <Coins className="w-3.5 h-3.5 mr-1" />
                        Finanzas/Hipoteca 💰
                      </button>

                      <button
                        onClick={() => {
                          setOpenDocsPropertyId(isDocsOpen ? null : prop.id);
                          setOpenFinancialsPropertyId(null);
                          setOpenFiscalPropertyId(null);
                          setOpenContractPropertyId(null);
                        }}
                        className={`inline-flex items-center justify-center py-2 px-3 border rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                          isDocsOpen
                            ? "bg-blue-600 hover:bg-blue-500 border-blue-500 text-white font-bold"
                            : "bg-blue-950/20 hover:bg-blue-950/40 border-blue-500/20 text-blue-400"
                        }`}
                      >
                        <Upload className="w-3.5 h-3.5 mr-1" />
                        Recibos/Docs 📁
                      </button>

                      <button
                        onClick={() => {
                          handleToggleContractPanel(prop);
                          setOpenFinancialsPropertyId(null);
                          setOpenDocsPropertyId(null);
                          setOpenFiscalPropertyId(null);
                        }}
                        className={`inline-flex items-center justify-center py-2 px-3 border rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                          openContractPropertyId === prop.id
                            ? "bg-emerald-600 hover:bg-emerald-500 border-emerald-500 text-slate-950 font-bold"
                            : "bg-emerald-950/20 hover:bg-emerald-950/40 border-emerald-500/20 text-emerald-400"
                        }`}
                      >
                        <FileText className="w-3.5 h-3.5 mr-1" />
                        Contrato 📄
                      </button>
                      
                      <button
                        onClick={() => {
                          setOpenFiscalPropertyId(isFiscalOpen ? null : prop.id);
                          setOpenContractPropertyId(null);
                          setOpenFinancialsPropertyId(null);
                          setOpenDocsPropertyId(null);
                        }}
                        className={`col-span-2 inline-flex items-center justify-center py-2 px-3 border rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                          isFiscalOpen 
                            ? "bg-indigo-600 hover:bg-indigo-500 border-indigo-500 text-white" 
                            : "bg-indigo-950/20 hover:bg-indigo-950/40 border-indigo-500/20 text-indigo-400"
                        }`}
                      >
                        <Calculator className="w-3.5 h-3.5 mr-1" />
                        Opción Fiscal 📊
                      </button>
                    </div>
                  </div>

                  {/* BLOC FINANCIERO E HIPOTECARIO EXPANDIDO */}
                  {isFinancialsOpen && (
                    <div className="w-full bg-slate-900/80 border border-amber-500/20 rounded-2xl p-5 mt-4 space-y-4 animate-slide-in text-left">
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-slate-800 pb-3 gap-2">
                        <div className="flex items-center space-x-2">
                          <Coins className="w-5 h-5 text-amber-400" />
                          <div>
                            <h5 className="text-sm font-bold text-white">Análisis Financiero, Tasación e Hipoteca ({financialYear})</h5>
                            <p className="text-[10px] text-slate-400">Control de plusvalías latentes, endeudamiento y rentabilidad anual de este inmueble.</p>
                          </div>
                        </div>
                        <div className="flex items-center space-x-2 shrink-0">
                          <span className="text-[11px] text-slate-400">Cambiar Año:</span>
                          <select
                            value={financialYear}
                            onChange={(e) => setFinancialYear(Number(e.target.value))}
                            className="bg-slate-950 border border-slate-800 text-xs text-white font-bold px-2 py-1.5 rounded-lg focus:outline-none focus:ring-1 focus:ring-amber-500"
                          >
                            <option value="2025">2025</option>
                            <option value="2026">2026</option>
                            <option value="2027">2027</option>
                            <option value="2028">2028</option>
                          </select>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                        {/* Formulario Izquierda */}
                        <div className="space-y-3.5">
                          <div>
                            <label className="block text-[10px] text-slate-400 uppercase font-mono mb-1">Valor de Mercado Actual Estimado (€)</label>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={finCurrentValue}
                              onChange={(e) => setFinCurrentValue(e.target.value)}
                              placeholder={(prop.purchasePrice || 0).toString()}
                              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:ring-1 focus:ring-amber-500 font-bold"
                            />
                            <p className="text-[9px] text-slate-500 mt-0.5">El valor estimado si lo vendieses hoy. Afecta al Equity y al ROE.</p>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-[10px] text-slate-400 uppercase font-mono mb-1">Precio de Compra (€)</label>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={finPurchasePrice}
                                onChange={(e) => setFinPurchasePrice(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:ring-1 focus:ring-amber-500 font-semibold"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-400 uppercase font-mono mb-1">Gastos de Compra (€)</label>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={finPurchaseExpenses}
                                onChange={(e) => setFinPurchaseExpenses(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:ring-1 focus:ring-amber-500 font-semibold"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-[10px] text-slate-400 uppercase font-mono mb-1">Capital Hipoteca Pendiente (€)</label>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={finMortgageDebt}
                                onChange={(e) => setFinMortgageDebt(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:ring-1 focus:ring-amber-500 font-semibold"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] text-slate-400 uppercase font-mono mb-1">Cuota Mensual Hipoteca (€)</label>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={finMonthlyMortgagePayment}
                                onChange={(e) => setFinMonthlyMortgagePayment(e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:ring-1 focus:ring-amber-500 font-semibold"
                              />
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              handleSaveFinancials(prop);
                              alert(`Datos financieros del año ${financialYear} guardados y actualizados exitosamente.`);
                            }}
                            className="w-full py-2 bg-amber-600 hover:bg-amber-500 text-slate-950 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1 cursor-pointer"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>Guardar Finanzas de {financialYear} 💰</span>
                          </button>
                        </div>

                        {/* Métricas e Indicadores de Rendimiento Derecha */}
                        <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/80 space-y-3 flex flex-col justify-between">
                          <h6 className="text-[11px] font-bold text-amber-300 font-mono uppercase tracking-wider">Métricas Clave de Inversión ({financialYear})</h6>
                          
                          {(() => {
                            const curVal = Number(finCurrentValue.replace(",", ".") || 0) || prop.purchasePrice || 0;
                            const purPrice = Number(finPurchasePrice.replace(",", ".") || 0) || prop.purchasePrice || 0;
                            const purExp = Number(finPurchaseExpenses.replace(",", ".") || 0);
                            const mortDebt = Number(finMortgageDebt.replace(",", ".") || 0);
                            const mortPay = Number(finMonthlyMortgagePayment.replace(",", ".") || 0);

                            const totalInvestment = purPrice + purExp;
                            const equity = curVal - mortDebt;
                            const equityPercent = curVal > 0 ? (equity / curVal) * 100 : 0;

                            // Rent estimates
                            const monthlyRentEstimate = prop.contract?.monthlyRent ?? prop.monthlyRent ?? 0;
                            const annualRent = monthlyRentEstimate * 12;

                            // Annual expenses for this year
                            const annualExp = grandTotalExpenses;
                            
                            // Gross & Net Yields
                            const grossYield = totalInvestment > 0 ? (annualRent / totalInvestment) * 100 : 0;
                            const netYield = totalInvestment > 0 ? ((annualRent - annualExp) / totalInvestment) * 100 : 0;

                            // Cashflow: prorating community, IBI, insurance over 12 months, and subtracting them and mortgage
                            const communityMonthly = (totalCommunity || 0) / 12;
                            const ibiMonthly = (totalIBI || 0) / 12;
                            const insuranceMonthly = (totalInsurance || 0) / 12;
                            const cashflow = monthlyRentEstimate - mortPay - communityMonthly - ibiMonthly - insuranceMonthly;

                            // ROE & TIR
                            const capInvertido = Math.max(1000, totalInvestment - mortDebt);
                            const annualCashflow = cashflow * 12;
                            const roe = capInvertido > 0 ? (annualCashflow / capInvertido) * 100 : 0;
                            const tir = capInvertido > 0 ? ((annualCashflow + (curVal * 0.035)) / capInvertido) * 100 : 0;

                            return (
                              <div className="space-y-2.5 text-xs text-slate-300">
                                <div className="flex justify-between items-center border-b border-slate-900 pb-1.5">
                                  <span>Equity de la propiedad:</span>
                                  <span className="font-bold text-white">
                                    {equity.toLocaleString("es-ES")} € <span className="text-[10px] text-slate-500 font-mono">({Math.round(equityPercent)}%)</span>
                                  </span>
                                </div>
                                <div className="flex justify-between items-center border-b border-slate-900 pb-1.5">
                                  <span>Cashflow Neto Mensual:</span>
                                  <span className={`font-black ${cashflow >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {cashflow >= 0 ? '+' : ''}{cashflow.toLocaleString("es-ES", { maximumFractionDigits: 2 })} €/mes
                                  </span>
                                </div>
                                <div className="flex justify-between items-center border-b border-slate-900 pb-1.5">
                                  <span>Rentabilidad Bruta:</span>
                                  <span className="font-bold text-white">{grossYield.toFixed(2)} %</span>
                                </div>
                                <div className="flex justify-between items-center border-b border-slate-900 pb-1.5">
                                  <span>Rentabilidad Neta:</span>
                                  <span className="font-bold text-amber-400">{netYield.toFixed(2)} %</span>
                                </div>
                                <div className="flex justify-between items-center border-b border-slate-900 pb-1.5">
                                  <span>ROE (s/ capital propio):</span>
                                  <span className="font-semibold text-indigo-300">{roe.toFixed(2)} %</span>
                                </div>
                                <div className="flex justify-between items-center border-b border-slate-900 pb-1.5">
                                  <span className="flex items-center">
                                    TIR Anual Estimada:
                                    <span className="group/tir relative ml-1 cursor-help text-slate-500 hover:text-indigo-400">
                                      <Info className="w-3 h-3" />
                                      <span className="absolute bottom-full right-0 mb-1 w-44 p-1.5 bg-slate-950 text-[9px] text-slate-400 rounded-lg opacity-0 group-hover/tir:opacity-100 transition-all pointer-events-none shadow-xl border border-slate-800 leading-tight">
                                        Calculada con cashflow neto más una apreciación histórica anual estimada del 3,5%.
                                      </span>
                                    </span>
                                  </span>
                                  <span className="font-bold text-emerald-400">{tir.toFixed(2)} %</span>
                                </div>
                                <div className="bg-slate-900/60 p-2 rounded-lg text-[10px] text-slate-400 border border-slate-900">
                                  <span className="font-bold text-slate-300 block mb-1">Gasto total en este ejercicio ({financialYear}):</span>
                                  {grandTotalExpenses > 0 ? (
                                    <span>
                                      Un total de <strong className="text-white">{grandTotalExpenses.toLocaleString("es-ES")} €</strong> imputados: Comunidad ({totalCommunity}€), IBI ({totalIBI}€), Seguros ({totalInsurance}€), Reparaciones ({totalRepairs}€), Amortización ({totalAmortization}€).
                                    </span>
                                  ) : (
                                    <span>Sin gastos declarados en el libro para el año {financialYear}.</span>
                                  )}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* BLOC RECIBOS Y DOCUMENTOS EXPANDIDO */}
                  {isDocsOpen && (
                    <div className="w-full bg-slate-900/80 border border-blue-500/20 rounded-2xl p-5 mt-4 space-y-4 animate-slide-in text-left">
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-slate-800 pb-3 gap-2">
                        <div className="flex items-center space-x-2">
                          <Upload className="w-5 h-5 text-blue-400" />
                          <div>
                            <h5 className="text-sm font-bold text-white">Archivo Digital de Recibos y Comprobantes ({docYear})</h5>
                            <p className="text-[10px] text-slate-400">Guarda tus justificantes fiscales (IBI, seguro, comunidad) listos para requerimientos de la AEAT.</p>
                          </div>
                        </div>
                        <div className="flex items-center space-x-2 shrink-0">
                          <span className="text-[11px] text-slate-400">Asignar Año:</span>
                          <select
                            value={docYear}
                            onChange={(e) => setDocYear(Number(e.target.value))}
                            className="bg-slate-950 border border-slate-800 text-xs text-white font-bold px-2 py-1.5 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                          >
                            <option value="2025">2025</option>
                            <option value="2026">2026</option>
                            <option value="2027">2027</option>
                            <option value="2028">2028</option>
                          </select>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                        {/* Subir Documento */}
                        <div className="space-y-4">
                          <div className="space-y-2">
                            <label className="block text-xs font-semibold text-slate-300">1. Seleccionar Categoría del Recibo/Documento</label>
                            <select
                              value={docCategory}
                              onChange={(e) => setDocCategory(e.target.value as any)}
                              className="w-full bg-slate-950 border border-slate-800 text-xs text-white rounded-lg p-2 focus:ring-1 focus:ring-blue-500 font-bold"
                            >
                              <option value="ibi">Impuesto de Bienes Inmuebles (IBI) 🏦</option>
                              <option value="seguros">Seguro del Hogar / Impago de Alquiler 🛡️</option>
                              <option value="comunidad">Gastos de Comunidad de Propietarios 👥</option>
                              <option value="reparaciones">Facturas de Reparaciones / Reformas 🔧</option>
                              <option value="muebles_electrodomesticos">Facturas de Muebles o Electrodomésticos 📺</option>
                              <option value="otros">Otros Justificantes / Gastos Administrativos 📝</option>
                            </select>
                          </div>

                          <div className="space-y-2">
                            <label className="block text-xs font-semibold text-slate-300">2. Cargar Recibo (Formatos PDF, JPG, PNG)</label>
                            <div className="relative border border-dashed border-slate-800 hover:border-blue-500/50 rounded-xl p-6 transition-all bg-slate-950/40 text-center">
                              <input
                                type="file"
                                accept=".pdf,image/jpeg,image/png"
                                onChange={handleUploadDocLocal}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                              />
                              {docIsUploading ? (
                                <div className="space-y-2">
                                  <Loader2 className="w-6 h-6 text-blue-400 animate-spin mx-auto" />
                                  <p className="text-[11px] text-slate-300">Cargando archivo local...</p>
                                </div>
                              ) : uploadedFileBase64 ? (
                                <div className="space-y-1.5">
                                  <div className="flex items-center justify-center space-x-1 text-emerald-400">
                                    <CheckCircle className="w-4 h-4" />
                                    <span className="text-[11px] font-bold">¡Archivo adjuntado con éxito!</span>
                                  </div>
                                  <p className="text-xs font-semibold text-slate-200 truncate max-w-[240px] mx-auto">{uploadedFileName}</p>
                                  <p className="text-[10px] text-slate-500 font-mono">{uploadedFileSize}</p>
                                </div>
                              ) : (
                                <div className="space-y-1">
                                  <Upload className="w-6 h-6 text-slate-600 mx-auto" />
                                  <p className="text-xs text-slate-300 font-medium">Examinar o soltar archivo</p>
                                  <p className="text-[9px] text-slate-500">PDF, JPG o PNG hasta 10MB</p>
                                </div>
                              )}
                            </div>
                          </div>

                          <button
                            type="button"
                            disabled={!uploadedFileBase64}
                            onClick={() => {
                              handleSaveDocument(prop);
                              alert("Recibo almacenado con éxito en tu repositorio local seguro.");
                            }}
                            className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5 cursor-pointer"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>Integrar Documento en {docYear} 📂</span>
                          </button>
                        </div>

                        {/* Listado de Documentos del Año */}
                        <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/80 space-y-3.5 flex flex-col justify-between">
                          <div>
                            <h6 className="text-[11px] font-bold text-blue-300 font-mono uppercase tracking-wider mb-2.5">Repositorio de Archivos ({docYear})</h6>
                            
                            {(() => {
                              const docsForYear = (prop.documents || []).filter(d => d.year === docYear);
                              if (docsForYear.length === 0) {
                                return (
                                  <div className="py-12 text-center text-slate-600 text-xs">
                                    No hay recibos digitalizados para el año {docYear} en este inmueble.
                                  </div>
                                );
                              }
                              return (
                                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                                  {docsForYear.map((doc) => {
                                    const catLabels: Record<string, string> = {
                                      ibi: 'IBI 🏦',
                                      seguros: 'Seguro 🛡️',
                                      comunidad: 'Comun. 👥',
                                      reparaciones: 'Repar. 🔧',
                                      muebles_electrodomesticos: 'Equipam. 📺',
                                      otros: 'Otros 📝'
                                    };
                                    return (
                                      <div key={doc.id} className="flex justify-between items-center bg-slate-900 border border-slate-800 p-2.5 rounded-xl text-xs">
                                        <div className="min-w-0 pr-2">
                                          <div className="flex items-center space-x-1.5">
                                            <span className="text-[9px] px-1.5 py-0.5 bg-blue-500/10 text-blue-400 border border-blue-500/10 rounded-md font-mono font-bold uppercase whitespace-nowrap">
                                              {catLabels[doc.category] || doc.category}
                                            </span>
                                            <p className="font-semibold text-slate-200 truncate" title={doc.name}>
                                              {doc.name}
                                            </p>
                                          </div>
                                          <p className="text-[10px] text-slate-500 mt-0.5">{doc.size} • Subido el {doc.uploadDate}</p>
                                        </div>
                                        
                                        <div className="flex items-center space-x-1.5 shrink-0">
                                          <a
                                            href={doc.fileData}
                                            download={doc.name}
                                            className="px-2 py-1 bg-slate-950 hover:bg-slate-800 border border-slate-800 text-[10px] text-blue-400 hover:text-blue-300 font-bold rounded-lg cursor-pointer"
                                          >
                                            Descargar / Imprimir
                                          </a>
                                          
                                          {deleteExpenseConfirmId === doc.id ? (
                                            <div className="flex items-center space-x-1 bg-rose-950/20 border border-rose-500/20 p-0.5 rounded-lg">
                                              <button
                                                onClick={() => {
                                                  handleDeleteDocument(prop, doc.id);
                                                  setDeleteExpenseConfirmId(null);
                                                }}
                                                className="px-1 py-0.5 text-[8px] bg-rose-600 hover:bg-rose-500 text-white font-bold rounded"
                                              >
                                                Sí
                                              </button>
                                              <button
                                                onClick={() => setDeleteExpenseConfirmId(null)}
                                                className="px-1 py-0.5 text-[8px] bg-slate-800 text-slate-300 rounded"
                                              >
                                                No
                                              </button>
                                            </div>
                                          ) : (
                                            <button
                                              onClick={() => setDeleteExpenseConfirmId(doc.id)}
                                              className="p-1 text-slate-500 hover:text-rose-400 cursor-pointer"
                                              title="Eliminar documento"
                                            >
                                              <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })()}
                          </div>
                          
                          <div className="text-[10px] text-slate-500 bg-slate-900/40 p-2 rounded-lg border border-slate-900 leading-normal">
                            💡 <strong>Prueba de Auditoría AEAT:</strong> Estos recibos coinciden con las deducciones cargadas en la opción fiscal y el libro de gastos. Puedes descargarlos de forma masiva ante cualquier requerimiento de inspección fiscal.
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* BLOC FISCAL EXPANDIDO ALINEADO CON EL MODELO 100 */}
                  {isFiscalOpen && (
                    <div className="w-full bg-slate-900/80 border border-indigo-500/20 rounded-2xl p-5 mt-4 space-y-4 animate-slide-in text-left">
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-slate-800 pb-3 gap-2">
                        <div className="flex items-center space-x-2">
                          <Calculator className="w-5 h-5 text-indigo-400" />
                          <div>
                            <h5 className="text-sm font-bold text-white">Declaración Fiscal de Gastos (IRPF {fiscalFilterYear})</h5>
                            <p className="text-[10px] text-slate-400">Todos los gastos categorizados e imputables para desgravar en tu renta.</p>
                          </div>
                        </div>
                        <div className="flex items-center space-x-2 shrink-0">
                          <span className="text-[11px] text-slate-400">Filtrar Año:</span>
                          <select
                            value={fiscalFilterYear}
                            onChange={(e) => setFiscalFilterYear(Number(e.target.value))}
                            className="bg-slate-950 border border-slate-800 text-xs text-white font-bold px-2 py-1.5 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          >
                            <option value="2025">2025</option>
                            <option value="2026">2026</option>
                            <option value="2027">2027</option>
                            <option value="2028">2028</option>
                          </select>
                        </div>
                      </div>

                      {/* Summary metrics of the year */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 py-1.5">
                        <div className="bg-slate-950/50 p-3 rounded-xl border border-slate-800/60 text-xs">
                          <span className="text-slate-500 block text-[9px] uppercase font-mono">Gastos Comunidad</span>
                          <span className="text-sm font-bold text-white">{totalCommunity.toLocaleString("es-ES")} €</span>
                        </div>
                        <div className="bg-slate-950/50 p-3 rounded-xl border border-slate-800/60 text-xs">
                          <span className="text-slate-500 block text-[9px] uppercase font-mono">Impuestos/IBI</span>
                          <span className="text-sm font-bold text-white">{totalIBI.toLocaleString("es-ES")} €</span>
                        </div>
                        <div className="bg-slate-950/50 p-3 rounded-xl border border-slate-800/60 text-xs">
                          <span className="text-slate-500 block text-[9px] uppercase font-mono">Reparaciones/Conserv.</span>
                          <span className="text-sm font-bold text-white">{totalRepairs.toLocaleString("es-ES")} €</span>
                        </div>
                        <div className="bg-slate-950/50 p-3 rounded-xl border border-slate-800/60 text-xs">
                          <span className="text-indigo-400 block text-[9px] uppercase font-mono">Total Deductible</span>
                          <span className="text-sm font-bold text-emerald-400">{grandTotalExpenses.toLocaleString("es-ES")} €</span>
                        </div>
                      </div>

                      {/* Categorized detailed AEAT lines */}
                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse text-xs min-w-[500px]">
                          <thead>
                            <tr className="border-b border-slate-800 text-slate-500 font-mono text-[9px] uppercase">
                              <th className="py-2.5 px-3">Categoría Fiscal / Concepto AEAT</th>
                              <th className="py-2.5 px-3 text-right">Ficha (Estimación)</th>
                              <th className="py-2.5 px-3 text-right">Cargados (IA/Diario)</th>
                              <th className="py-2.5 px-3 text-right text-white font-semibold">Total Imputable</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/60 text-slate-300 font-sans">
                            
                            {/* Repairs */}
                            <tr className="hover:bg-slate-800/20">
                              <td className="py-2.5 px-3">
                                <span className="block font-medium text-slate-200">Conservación y reparación</span>
                                <span className="text-[10px] text-slate-500">Pintura, averías de termos, fontanería, mantenimiento estético</span>
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono">{(is2025 ? prop.expensesRepairs : 0).toLocaleString("es-ES")} €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-slate-400">{dynamicRepairs.toLocaleString("es-ES")} €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-indigo-400 font-bold">{totalRepairs.toLocaleString("es-ES")} €</td>
                            </tr>

                            {/* Taxes */}
                            <tr className="hover:bg-slate-800/20">
                              <td className="py-2.5 px-3">
                                <span className="block font-medium text-slate-200">Tributos, recargos y tasas</span>
                                <span className="text-[10px] text-slate-500">IBI anual, tasas de basuras, vados municipales</span>
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono">{(is2025 ? prop.expensesIBI : 0).toLocaleString("es-ES")} €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-slate-400">{dynamicIBI.toLocaleString("es-ES")} €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-indigo-400 font-bold">{totalIBI.toLocaleString("es-ES")} €</td>
                            </tr>

                            {/* Insurance */}
                            <tr className="hover:bg-slate-800/20">
                              <td className="py-2.5 px-3">
                                <span className="block font-medium text-slate-200">Primas de contratos de seguro</span>
                                <span className="text-[10px] text-slate-500">Seguro multirriesgo del hogar, seguros de impago de alquiler</span>
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono">{(is2025 ? prop.expensesInsurance : 0).toLocaleString("es-ES")} €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-slate-400">{dynamicInsurance.toLocaleString("es-ES")} €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-indigo-400 font-bold">{totalInsurance.toLocaleString("es-ES")} €</td>
                            </tr>

                            {/* Community */}
                            <tr className="hover:bg-slate-800/20">
                              <td className="py-2.5 px-3">
                                <span className="block font-medium text-slate-200">Gastos de comunidad y administración</span>
                                <span className="text-[10px] text-slate-500">Cuotas ordinarias, derramas comunitarias, honorarios administración</span>
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono">{(is2025 ? prop.expensesCommunity : 0).toLocaleString("es-ES")} €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-slate-400">{dynamicCommunity.toLocaleString("es-ES")} €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-indigo-400 font-bold">{totalCommunity.toLocaleString("es-ES")} €</td>
                            </tr>

                            {/* Amortization */}
                            <tr className="hover:bg-slate-800/20">
                              <td className="py-2.5 px-3">
                                <span className="block font-medium text-slate-200">Amortización de bienes inmuebles (3% s/construcción)</span>
                                <span className="text-[10px] text-slate-500">3% anual deducible sobre el valor de la construcción</span>
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono">{(is2025 ? prop.amortizationAmount : 0).toLocaleString("es-ES")} €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-slate-400">{dynamicAmortization.toLocaleString("es-ES")} €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-indigo-400 font-bold">{totalAmortization.toLocaleString("es-ES")} €</td>
                            </tr>

                            {/* Supplies */}
                            <tr className="hover:bg-slate-800/20">
                              <td className="py-2.5 px-3">
                                <span className="block font-medium text-slate-200">Suministros y mantenimiento</span>
                                <span className="text-[10px] text-slate-500">Luz, agua, gas pagados directamente por el propietario</span>
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono">0 €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-slate-400">{dynamicMaintenance.toLocaleString("es-ES")} €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-indigo-400 font-bold">{dynamicMaintenance.toLocaleString("es-ES")} €</td>
                            </tr>

                            {/* Other */}
                            <tr className="hover:bg-slate-800/20">
                              <td className="py-2.5 px-3">
                                <span className="block font-medium text-slate-200">Otros gastos deducibles</span>
                                <span className="text-[10px] text-slate-500">Comisiones de agencia, defensa jurídica, gastos de formalización</span>
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono">0 €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-slate-400">{dynamicOther.toLocaleString("es-ES")} €</td>
                              <td className="py-2.5 px-3 text-right font-mono text-indigo-400 font-bold">{dynamicOther.toLocaleString("es-ES")} €</td>
                            </tr>

                          </tbody>
                        </table>
                      </div>

                      {/* Dynamic expenses list specifically parsed or scanned for this year */}
                      <div className="bg-slate-950/40 border border-slate-800 rounded-xl p-3.5 space-y-2">
                        <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider block">
                          Justificantes y Facturas Individuales de {fiscalFilterYear} ({propertyExpensesForYear.filter(e => e.category !== 'rent').length})
                        </span>
                        {propertyExpensesForYear.filter(e => e.category !== 'rent').length > 0 ? (
                          <div className="space-y-1.5 max-h-[150px] overflow-y-auto">
                            {propertyExpensesForYear.filter(e => e.category !== 'rent').map((exp) => (
                              <div key={exp.id} className="flex justify-between items-center text-[11px] bg-slate-900/60 p-2 rounded-lg border border-slate-800/50">
                                <div className="space-y-0.5">
                                  <span className="text-slate-200 font-medium">{exp.description || "Gasto sin concepto"}</span>
                                  <div className="flex items-center space-x-2 text-[10px] text-slate-500">
                                    <span className="font-mono bg-slate-800/50 px-1 py-0.2 rounded text-[9px] uppercase text-indigo-400 font-bold">
                                      {exp.category}
                                    </span>
                                    <span>•</span>
                                    <span>{new Date(exp.date).toLocaleDateString("es-ES")}</span>
                                  </div>
                                </div>
                                <div className="flex items-center space-x-2">
                                  {deleteExpenseConfirmId === exp.id ? (
                                    <div className="flex items-center gap-1.5 animate-fade-in bg-slate-800 p-1.5 rounded-lg border border-red-500/30">
                                      <span className="text-[10px] text-red-400 font-bold px-1 font-sans">¿Eliminar?</span>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          onDeleteExpense(exp.id);
                                          setDeleteExpenseConfirmId(null);
                                        }}
                                        className="px-2 py-0.5 bg-red-600 hover:bg-red-500 text-white font-bold text-[10px] rounded transition-colors cursor-pointer"
                                      >
                                        Sí
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setDeleteExpenseConfirmId(null)}
                                        className="px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-[10px] rounded transition-colors cursor-pointer"
                                      >
                                        No
                                      </button>
                                    </div>
                                  ) : (
                                    <>
                                      <span className="font-mono text-xs font-bold text-slate-100">-{exp.amount.toLocaleString("es-ES")} €</span>
                                      <button
                                        type="button"
                                        onClick={() => setDeleteExpenseConfirmId(exp.id)}
                                        className="p-1 text-slate-500 hover:text-red-400 hover:bg-red-950/20 rounded-lg transition-colors cursor-pointer"
                                        title="Eliminar Registro"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-slate-500 italic">No se han registrado facturas ni recibos específicos por diario para este ejercicio. Se imputarán las estimaciones de la ficha.</p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* BLOC CONTRATO EXPANDIDO */}
                  {openContractPropertyId === prop.id && (
                    <div className="w-full bg-slate-900/80 border border-emerald-500/20 rounded-2xl p-5 mt-4 space-y-5 animate-slide-in text-left">
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-slate-800 pb-3 gap-2">
                        <div className="flex items-center space-x-2">
                          <FileText className="w-5 h-5 text-emerald-400" />
                          <div>
                            <h5 className="text-sm font-bold text-white">Contrato de Arrendamiento</h5>
                            <p className="text-[10px] text-slate-400">Detalles de vigencia, cuantía de renta y documento digitalizado del contrato.</p>
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* Lado izquierdo: Información actual del contrato y subida */}
                        <div className="space-y-4">
                          <h6 className="text-xs font-bold text-slate-300 uppercase tracking-wider font-mono">Ficha del Contrato</h6>
                          
                          {prop.contract ? (
                            <div className="bg-slate-950/50 rounded-xl border border-slate-800 p-4 space-y-3.5">
                              <div className="grid grid-cols-2 gap-3 text-xs">
                                <div>
                                  <span className="text-slate-500 block text-[9px] uppercase font-mono">Fecha de Inicio</span>
                                  <span className="font-semibold text-slate-200">
                                    {prop.contract.startDate ? prop.contract.startDate.split("-").reverse().join("/") : "No especificada"}
                                  </span>
                                </div>
                                <div>
                                  <span className="text-slate-500 block text-[9px] uppercase font-mono">Fecha de Fin</span>
                                  <span className="font-semibold text-slate-200">
                                    {prop.contract.endDate ? prop.contract.endDate.split("-").reverse().join("/") : "Indefinido / Prorrogable"}
                                  </span>
                                </div>
                              </div>

                              <div>
                                <span className="text-slate-500 block text-[9px] uppercase font-mono">Cuantía de Alquiler</span>
                                <span className="text-lg font-black text-emerald-400">
                                  {prop.contract.monthlyRent ? prop.contract.monthlyRent.toLocaleString("es-ES") : prop.monthlyRent.toLocaleString("es-ES")} €/mes
                                </span>
                              </div>

                              {prop.contract.pdfName ? (
                                <div className="bg-slate-900 border border-emerald-500/10 rounded-lg p-3 flex items-center justify-between">
                                  <div className="flex items-center space-x-2 min-w-0">
                                    <FileText className="w-5 h-5 text-emerald-400 shrink-0" />
                                    <div className="min-w-0">
                                      <p className="text-xs font-bold text-slate-200 truncate pr-2" title={prop.contract.pdfName}>
                                        {prop.contract.pdfName}
                                      </p>
                                      <p className="text-[10px] text-slate-500 font-mono">{prop.contract.pdfSize || "1.2 MB"}</p>
                                    </div>
                                  </div>
                                  <div className="flex space-x-2 shrink-0">
                                    <a
                                      href="#"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        alert(`Descargando ${prop.contract?.pdfName}... (Simulado)`);
                                      }}
                                      className="text-[10px] bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 px-2 py-1 rounded font-bold transition-all cursor-pointer"
                                    >
                                      Descargar
                                    </a>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteCardContract(prop)}
                                      className="text-[10px] bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 px-2 py-1 rounded font-bold transition-all cursor-pointer"
                                    >
                                      Eliminar
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="p-3 bg-amber-950/20 border border-amber-500/10 rounded-lg text-amber-400 text-xs flex items-start space-x-2">
                                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                                  <span>Contrato completado a mano sin documento PDF adjunto. Puedes subir el PDF de respaldo a la derecha.</span>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="p-5 bg-slate-950/40 border border-dashed border-slate-800 rounded-xl text-center text-slate-500 text-xs space-y-2">
                              <FileText className="w-8 h-8 text-slate-600 mx-auto" />
                              <p className="font-medium">No hay ningún contrato activo registrado para este inmueble.</p>
                              <p className="text-[10px] text-slate-500 max-w-xs mx-auto">Sube el PDF a la derecha o rellena la vigencia para vincular el contrato a este inmueble.</p>
                            </div>
                          )}
                        </div>

                        {/* Lado derecho: Formulario de Modificación / Subida */}
                        <div className="space-y-4 border-t lg:border-t-0 lg:border-l border-slate-800 lg:pl-6 pt-4 lg:pt-0">
                          <h6 className="text-xs font-bold text-slate-300 uppercase tracking-wider font-mono">Modificar / Digitalizar Contrato</h6>
                          
                          <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-[10px] text-slate-400 mb-1 font-mono uppercase">Fecha de Inicio</label>
                                <input
                                  type="date"
                                  value={cardStartDate}
                                  onChange={(e) => setCardStartDate(e.target.value)}
                                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:ring-1 focus:ring-emerald-500"
                                />
                              </div>
                              <div>
                                <label className="block text-[10px] text-slate-400 mb-1 font-mono uppercase">Fecha de Fin</label>
                                <input
                                  type="date"
                                  value={cardEndDate}
                                  onChange={(e) => setCardEndDate(e.target.value)}
                                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:ring-1 focus:ring-emerald-500"
                                />
                              </div>
                            </div>

                            <div>
                              <label className="block text-[10px] text-slate-400 mb-1 font-mono uppercase">Cuantía Alquiler Mensual (€/mes)</label>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={cardMonthlyRent}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  if (val === "" || /^[0-9]*[.,]?[0-9]*$/.test(val)) {
                                    setCardMonthlyRent(val);
                                  }
                                }}
                                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white focus:ring-1 focus:ring-emerald-500 font-bold"
                              />
                            </div>

                            {/* Drag & Drop simulated uploader */}
                            <div className="space-y-2">
                              <label className="block text-[10px] text-slate-400 font-mono uppercase">Digitalizar / Adjuntar PDF</label>
                              <div className="relative border border-dashed border-slate-800 hover:border-emerald-500/50 rounded-xl p-4 transition-all bg-slate-950/40 text-center">
                                <input
                                  type="file"
                                  accept=".pdf"
                                  onChange={(e) => handleFileChange(e, prop)}
                                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                />
                                {isUploading ? (
                                  <div className="space-y-2">
                                    <Loader2 className="w-5 h-5 text-emerald-400 animate-spin mx-auto" />
                                    <p className="text-[10px] text-slate-300 font-medium">Extrayendo cláusulas con IA de Gemini...</p>
                                  </div>
                                ) : cardPdfName ? (
                                  <div className="space-y-1">
                                    <div className="flex items-center justify-center space-x-1 text-emerald-400">
                                      <CheckCircle className="w-4 h-4" />
                                      <span className="text-[10px] font-bold">¡Extraído Correctamente por IA!</span>
                                    </div>
                                    <p className="text-xs font-semibold text-slate-200 truncate max-w-[200px] mx-auto">{cardPdfName}</p>
                                    <p className="text-[9px] text-slate-500 font-mono">{cardPdfSize || "Fichero PDF"}</p>
                                  </div>
                                ) : (
                                  <div className="space-y-1">
                                    <Upload className="w-5 h-5 text-slate-600 mx-auto" />
                                    <p className="text-[10px] text-slate-400 font-medium">Subir Contrato PDF</p>
                                    <p className="text-[8px] text-slate-500">Arrastra o haz clic para subir</p>
                                  </div>
                                )}
                              </div>
                            </div>

                            <button
                              onClick={() => {
                                handleSaveCardContract(prop);
                                alert("Contrato guardado y sincronizado exitosamente en el sistema fiscal.");
                              }}
                              className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-slate-950 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5 cursor-pointer mt-2"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>Guardar Contrato</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                </div>
              );
            })
          ) : (
            <div className="col-span-2 bg-slate-800/10 border border-dashed border-slate-700 rounded-2xl py-16 flex flex-col items-center justify-center text-slate-500 space-y-3">
              <Building className="w-12 h-12 text-slate-600" />
              <p className="text-sm font-medium">No hay ningún inmueble registrado en la cartera.</p>
              <button
                onClick={() => setIsAdding(true)}
                className="text-indigo-400 hover:text-indigo-300 font-bold text-xs underline"
              >
                Añadir tu primer inmueble ahora
              </button>
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
                  <h3 className="font-bold text-white text-base">Importar Inmuebles</h3>
                  <p className="text-xs text-slate-400">Sube un archivo JSON o Excel (.xlsx) de inmuebles</p>
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
                  id="properties-import-file"
                  accept=".json,.xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleProcessImportFile(file);
                  }}
                />
                <label
                  htmlFor="properties-import-file"
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
                    <span className="text-indigo-200 font-medium">Inmuebles detectados en el archivo:</span>
                    <span className="bg-indigo-500/20 text-indigo-300 font-bold px-2.5 py-1 rounded-full border border-indigo-500/30">
                      {importPreviewData.length} inmuebles
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
                        <div className="text-[10px] opacity-75 font-normal mt-0.5">Mantiene los inmuebles actuales</div>
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
                        <div className="text-[10px] opacity-75 font-normal mt-0.5">Sustituye la cartera actual</div>
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

    </div>
  );
}
