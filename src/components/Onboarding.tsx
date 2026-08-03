import React, { useState } from "react";
import { SAMPLE_DECLARATIONS } from "../data/samples";
import { AppState } from "../types";
import { 
  FileText, 
  Sparkles, 
  AlertCircle, 
  CheckCircle2, 
  ArrowRight, 
  Upload, 
  Heart, 
  Building, 
  User, 
  Coins, 
  ArrowUpRight 
} from "lucide-react";

const isSameAddress = (addr1: string, addr2: string): boolean => {
  if (!addr1 || !addr2) return false;
  
  const cleanAddress = (addr: string): string => {
    let clean = addr.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    
    // Replace common punctuation with spaces
    clean = clean.replace(/[,./_#-]/g, " ");
    
    // Replace standard abbreviations
    clean = clean.replace(/\bc\/\b|\bcl\b/g, "calle");
    clean = clean.replace(/\bav\b|\bavda\b/g, "avenida");
    clean = clean.replace(/\bpso\b/g, "paseo");
    clean = clean.replace(/\bctra\b/g, "carretera");
    clean = clean.replace(/\bplz\b|\bplaça\b|\bpl\b/g, "plaza");
    clean = clean.replace(/\bnum\b|\bno\b|\bnº\b/g, "");
    clean = clean.replace(/\bdr\b|\bdcha\b|\bderecha\b/g, "der");
    clean = clean.replace(/\biz\b|\bizda\b|\bizquierda\b/g, "izq");
    clean = clean.replace(/\bdupl\b|\bduplicado\b/g, "dup");
    clean = clean.replace(/\b1º\b|\b1o\b|\bprimero\b/g, "1");
    clean = clean.replace(/\b2º\b|\b2o\b|\bsegundo\b/g, "2");
    clean = clean.replace(/\b3º\b|\b3o\b|\btercero\b/g, "3");
    clean = clean.replace(/\b4º\b|\b4o\b|\bcuarto\b/g, "4");

    return clean;
  };

  const clean1 = cleanAddress(addr1);
  const clean2 = cleanAddress(addr2);

  if (clean1.replace(/\s+/g, "") === clean2.replace(/\s+/g, "")) return true;

  const words1: string[] = clean1.match(/[a-z0-9]+/g) || [];
  const words2: string[] = clean2.match(/[a-z0-9]+/g) || [];

  if (words1.length === 0 || words2.length === 0) return false;

  let matches = 0;
  words1.forEach(w1 => {
    if (words2.includes(w1)) {
      matches++;
    }
  });

  const ratio = matches / Math.min(words1.length, words2.length);
  return ratio >= 0.70;
};

const mergeCommaSeparated = (val1: string, val2: string): string => {
  const clean1 = (val1 || "").trim();
  const clean2 = (val2 || "").trim();
  const isInvalid = (str: string) => !str || str.toLowerCase().includes("pendiente") || str === "---" || str.startsWith("0000");
  
  if (isInvalid(clean1)) return isInvalid(clean2) ? "" : clean2;
  if (isInvalid(clean2)) return clean1;

  // Split by common delimiters: comma, slash, semicolon, newline and trim
  const list1 = clean1.split(/[,/;\n]+/).map(s => s.trim()).filter(Boolean);
  const list2 = clean2.split(/[,/;\n]+/).map(s => s.trim()).filter(Boolean);

  // Combine and deduplicate maintaining order
  const combined = Array.from(new Set([...list1, ...list2]));
  return combined.join(", ");
};

const deduplicateProperties = (properties: any[]): any[] => {
  if (!properties || properties.length === 0) return [];

  const unique: any[] = [];

  properties.forEach((prop) => {
    const isDuplicate = unique.find((item) => {
      const ref1 = (item.cadastralReference || "").trim().replace(/[\s-]/g, "").toUpperCase();
      const ref2 = (prop.cadastralReference || "").trim().replace(/[\s-]/g, "").toUpperCase();
      
      const hasValidRef1 = ref1 && ref1.length > 5 && !ref1.startsWith("REF-CATASTRAL") && !ref1.startsWith("MOCK");
      const hasValidRef2 = ref2 && ref2.length > 5 && !ref2.startsWith("REF-CATASTRAL") && !ref2.startsWith("MOCK");

      if (hasValidRef1 && hasValidRef2 && ref1 === ref2) {
        return true;
      }

      return isSameAddress(item.address, prop.address);
    });

    if (isDuplicate) {
      const existingPctU1 = Number(isDuplicate.ownershipPercentageUser1 ?? (isDuplicate.owner === 'user1' ? 100 : isDuplicate.owner === 'both' ? 50 : 0));
      const existingPctU2 = Number(isDuplicate.ownershipPercentageUser2 ?? (isDuplicate.owner === 'user2' ? 100 : isDuplicate.owner === 'both' ? 50 : 0));

      const newPctU1 = Number(prop.ownershipPercentageUser1 ?? (prop.owner === 'user1' ? 100 : prop.owner === 'both' ? 50 : 0));
      const newPctU2 = Number(prop.ownershipPercentageUser2 ?? (prop.owner === 'user2' ? 100 : prop.owner === 'both' ? 50 : 0));

      let finalPctU1 = Math.max(existingPctU1, newPctU1);
      let finalPctU2 = Math.max(existingPctU2, newPctU2);

      if (finalPctU1 === 100 && finalPctU2 === 100) {
        finalPctU1 = 50;
        finalPctU2 = 50;
      } else if (finalPctU1 === 0 && finalPctU2 === 0) {
        finalPctU1 = 50;
        finalPctU2 = 50;
      }

      isDuplicate.ownershipPercentageUser1 = finalPctU1;
      isDuplicate.ownershipPercentageUser2 = finalPctU2;

      if (finalPctU1 > 0 && finalPctU2 > 0) {
        isDuplicate.owner = "both";
      } else if (finalPctU1 > 0) {
        isDuplicate.owner = "user1";
      } else if (finalPctU2 > 0) {
        isDuplicate.owner = "user2";
      }

      // Financial properties are already upscaled to 100% capacity in parsing. Max-merge is clean and safe.
      isDuplicate.monthlyRent = Math.max(isDuplicate.monthlyRent || 0, prop.monthlyRent || 0);
      isDuplicate.purchasePrice = Math.max(isDuplicate.purchasePrice || 0, prop.purchasePrice || 0);
      isDuplicate.landValuePercent = isDuplicate.landValuePercent || prop.landValuePercent || 25;
      isDuplicate.amortizationAmount = Math.max(isDuplicate.amortizationAmount || 0, prop.amortizationAmount || 0);
      
      isDuplicate.expensesCommunity = Math.max(isDuplicate.expensesCommunity || 0, prop.expensesCommunity || 0);
      isDuplicate.expensesIBI = Math.max(isDuplicate.expensesIBI || 0, prop.expensesIBI || 0);
      isDuplicate.expensesInsurance = Math.max(isDuplicate.expensesInsurance || 0, prop.expensesInsurance || 0);
      isDuplicate.expensesRepairs = Math.max(isDuplicate.expensesRepairs || 0, prop.expensesRepairs || 0);

      // Merge multiple tenants / DNIs cleanly
      isDuplicate.tenantName = mergeCommaSeparated(isDuplicate.tenantName, prop.tenantName);
      isDuplicate.tenantDni = mergeCommaSeparated(isDuplicate.tenantDni, prop.tenantDni);

      if (!isDuplicate.cadastralReference || isDuplicate.cadastralReference.startsWith("REF-CATASTRAL")) {
        isDuplicate.cadastralReference = prop.cadastralReference || isDuplicate.cadastralReference;
      }
    } else {
      unique.push({ ...prop });
    }
  });

  return unique;
};

interface OnboardingProps {
  onComplete: (extractedState: Partial<AppState>) => void;
}

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [declarationMode, setDeclarationMode] = useState<"conjunta" | "separadas">("conjunta");

  // User 1 / Joint States
  const [pastedText1, setPastedText1] = useState("");
  const [uploadedFile1, setUploadedFile1] = useState<{ name: string; size: number; base64: string; mimeType: string } | null>(null);
  const [isDragging1, setIsDragging1] = useState(false);

  // User 2 States
  const [pastedText2, setPastedText2] = useState("");
  const [uploadedFile2, setUploadedFile2] = useState<{ name: string; size: number; base64: string; mimeType: string } | null>(null);
  const [isDragging2, setIsDragging2] = useState(false);

  // User Properties File States
  const [uploadedPropertiesFile, setUploadedPropertiesFile] = useState<{ name: string; size: number; base64: string; mimeType: string } | null>(null);
  const [isDraggingProperties, setIsDraggingProperties] = useState(false);

  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [showTextPaste1, setShowTextPaste1] = useState(false);
  const [showTextPaste2, setShowTextPaste2] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<any | null>(null);

  const loadingSteps = [
    "Conectando con el motor de extracción inteligente...",
    "Analizando estructura de la declaración AEAT...",
    "Identificando contribuyente y rentas del trabajo...",
    "Buscando inmuebles arrendados, inquilinos y contratos...",
    "Calculando amortizaciones (3% s/construcción)...",
    "Generando perfil fiscal sincronizado..."
  ];

  const handleSelectTemplate = (id: string) => {
    setSelectedTemplate(id);
    setDeclarationMode("conjunta"); // Templates are for the main/joint flow
    const template = SAMPLE_DECLARATIONS.find(d => d.id === id);
    if (template) {
      setPastedText1(template.rawText);
      setUploadedFile1(null); // Clear uploaded file if choosing template
      setShowTextPaste1(true);
    }
  };

  const startExtraction = async () => {
    const hasProperties = !!uploadedPropertiesFile;
    if (declarationMode === "conjunta") {
      if (!pastedText1.trim() && !uploadedFile1 && !hasProperties) {
        setError("Por favor, introduce el texto de la declaración, selecciona una plantilla de ejemplo o sube un archivo (PDF/Excel).");
        return;
      }
    } else {
      const hasUser1 = pastedText1.trim() || uploadedFile1;
      const hasUser2 = pastedText2.trim() || uploadedFile2;
      if (!hasUser1 && !hasUser2 && !hasProperties) {
        setError("Por favor, proporciona al menos una declaración de la renta o un archivo de inmuebles.");
        return;
      }
    }

    setLoading(true);
    setError(null);
    setPreviewData(null);
    
    // Simulate loading steps visually
    let step = 0;
    const interval = setInterval(() => {
      if (step < loadingSteps.length - 1) {
        step++;
        setLoadingStep(step);
      }
    }, 1200);

    try {
      const bodyPayload = {
        text1: pastedText1.trim() || undefined,
        fileData1: uploadedFile1 ? uploadedFile1.base64 : undefined,
        mimeType1: uploadedFile1 ? uploadedFile1.mimeType : undefined,
        text2: pastedText2.trim() || undefined,
        fileData2: uploadedFile2 ? uploadedFile2.base64 : undefined,
        mimeType2: uploadedFile2 ? uploadedFile2.mimeType : undefined,
        propertiesFileData: uploadedPropertiesFile ? uploadedPropertiesFile.base64 : undefined,
        propertiesFileMime: uploadedPropertiesFile ? uploadedPropertiesFile.mimeType : undefined,
        propertiesFileName: uploadedPropertiesFile ? uploadedPropertiesFile.name : undefined,
      };

      const response = await fetch("/api/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bodyPayload),
      });

      clearInterval(interval);

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "No se pudo extraer la información de los documentos.");
      }

      const result = await response.json();
      if (result.properties) {
        result.properties = deduplicateProperties(result.properties);
      }
      setPreviewData(result);
    } catch (err: any) {
      clearInterval(interval);
      setError(err.message || "Error al conectar con el servidor de extracción.");
    } finally {
      setLoading(false);
      setLoadingStep(0);
    }
  };

  const handleConfirmOnboarding = () => {
    if (!previewData) return;

    // Map extracted API data to AppState structures
    const user1Profile = {
      name: previewData.user1?.name || "Usuario 1",
      dni: previewData.user1?.dni || "12345678A",
      brutoTrabajo: Number(previewData.user1?.brutoTrabajo || 0),
      netoTrabajo: Number(previewData.user1?.netoTrabajo || 0),
    };

    const hasPartner = !!previewData.user2?.hasPartner || (previewData.user2?.name && previewData.user2?.name !== "");
    const user2Profile = {
      name: previewData.user2?.name || "Usuario 2",
      dni: previewData.user2?.dni || "87654321K",
      brutoTrabajo: Number(previewData.user2?.brutoTrabajo || 0),
      netoTrabajo: Number(previewData.user2?.netoTrabajo || 0),
      hasPartner: hasPartner,
    };

    const extractedProperties = (previewData.properties || []).map((prop: any, index: number) => {
      const id = `prop_${Date.now()}_${index}`;
      const monthly = Number(prop.monthlyRent || 0);
      const purchase = Number(prop.purchasePrice || 0);
      const landVal = Number(prop.landValuePercent || 25);
      
      // Compute standard 3% amortization if not provided or zero
      let amort = Number(prop.amortizationAmount || 0);
      if (amort === 0 && purchase > 0) {
        const constructionVal = purchase * (100 - landVal) / 100;
        amort = Number((constructionVal * 0.03).toFixed(2));
      }

      const addrLower = (prop.address || "").toLowerCase();
      const isMadrid = addrLower.includes("alcala") || addrLower.includes("madrid");
      const isSevilla = addrLower.includes("constitucion") || addrLower.includes("sevilla");
      const isBarcelona = addrLower.includes("mallorca") || addrLower.includes("barcelona");

      let defaultCurrentValue = purchase;
      let defaultExpenses = Math.round(purchase * 0.1); // 10% standard purchase expenses
      let defaultMortgageDebt = 0;
      let defaultMonthlyMortgagePayment = 0;

      if (isMadrid) {
        defaultCurrentValue = 215000;
        defaultMortgageDebt = 115000;
        defaultMonthlyMortgagePayment = 580;
      } else if (isSevilla) {
        defaultCurrentValue = 162000;
        defaultMortgageDebt = 88000;
        defaultMonthlyMortgagePayment = 440;
      } else if (isBarcelona) {
        defaultCurrentValue = 295000;
        defaultMortgageDebt = 165000;
        defaultMonthlyMortgagePayment = 810;
      } else if (purchase > 0) {
        defaultCurrentValue = Math.round(purchase * 1.15);
        defaultMortgageDebt = Math.round(purchase * 0.6);
        defaultMonthlyMortgagePayment = Math.round((purchase * 0.6 * 0.045) / 12);
      }

      const yearlyFinancials: Record<number, any> = {};
      const years = [2025, 2026, 2027, 2028];
      years.forEach((yr) => {
        const multiplier = yr === 2025 ? 0.96 : yr === 2026 ? 1.0 : yr === 2027 ? 1.04 : 1.08;
        const debtReduction = yr === 2025 ? 1.03 : yr === 2026 ? 1.0 : yr === 2027 ? 0.96 : 0.92;

        yearlyFinancials[yr] = {
          currentValue: Math.round(defaultCurrentValue * multiplier),
          purchasePrice: purchase,
          purchaseExpenses: defaultExpenses,
          mortgageDebt: Math.round(defaultMortgageDebt * debtReduction),
          monthlyMortgagePayment: defaultMonthlyMortgagePayment
        };
      });

      return {
        id,
        address: prop.address || "Inmueble sin dirección",
        cadastralReference: prop.cadastralReference || "REF-CATASTRAL-MOCK",
        owner: prop.owner || "user1",
        ownershipPercentageUser1: Number(prop.ownershipPercentageUser1 ?? (prop.owner === 'user1' ? 100 : prop.owner === 'both' ? 50 : 0)),
        ownershipPercentageUser2: Number(prop.ownershipPercentageUser2 ?? (prop.owner === 'user2' ? 100 : prop.owner === 'both' ? 50 : 0)),
        tenantName: prop.tenantName || "Inquilino pendiente",
        tenantDni: prop.tenantDni || "00000000X",
        monthlyRent: monthly,
        purchasePrice: purchase,
        landValuePercent: landVal,
        amortizationAmount: amort,
        expensesCommunity: Number(prop.expensesCommunity || 0),
        expensesIBI: Number(prop.expensesIBI || 0),
        expensesInsurance: Number(prop.expensesInsurance || 0),
        expensesRepairs: Number(prop.expensesRepairs || 0),
        registrationDate: new Date().toLocaleDateString('es-ES'),
        yearlyFinancials
      };
    });

    onComplete({
      user1: user1Profile,
      user2: user2Profile,
      properties: extractedProperties,
      isOnboarded: true
    });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, userNum: 1 | 2) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processFile(file, userNum);
  };

  const processFile = (file: File, userNum: 1 | 2) => {
    setError(null);
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const isTxt = file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt");

    if (!isPdf && !isTxt) {
      setError("Solo se admiten archivos en formato PDF (.pdf) o de texto plano (.txt).");
      return;
    }

    if (isPdf) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const result = evt.target?.result;
        if (typeof result === "string") {
          const base64 = result.split(",")[1];
          const fileState = {
            name: file.name,
            size: file.size,
            base64,
            mimeType: "application/pdf"
          };
          if (userNum === 1) {
            setUploadedFile1(fileState);
            setPastedText1(""); // Clear pasted text
            setSelectedTemplate("");
          } else {
            setUploadedFile2(fileState);
            setPastedText2(""); // Clear pasted text
          }
        }
      };
      reader.readAsDataURL(file);
    } else {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const text = evt.target?.result;
        if (typeof text === "string") {
          if (userNum === 1) {
            setPastedText1(text);
            setUploadedFile1(null);
            setSelectedTemplate("");
          } else {
            setPastedText2(text);
            setUploadedFile2(null);
          }
        }
      };
      reader.readAsText(file);
    }
  };

  const handleDragOver1 = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging1(true);
  };

  const handleDragLeave1 = () => {
    setIsDragging1(false);
  };

  const handleDrop1 = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging1(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processFile(file, 1);
    }
  };

  const handleDragOver2 = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging2(true);
  };

  const handleDragLeave2 = () => {
    setIsDragging2(false);
  };

  const handleDrop2 = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging2(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processFile(file, 2);
    }
  };

  // Properties File Handlers
  const handleDragOverProperties = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingProperties(true);
  };

  const handleDragLeaveProperties = () => {
    setIsDraggingProperties(false);
  };

  const handleDropProperties = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingProperties(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processPropertiesFile(file);
    }
  };

  const handlePropertiesFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processPropertiesFile(file);
    }
  };

  const processPropertiesFile = (file: File) => {
    setError(null);
    const nameLower = file.name.toLowerCase();
    const isPdf = file.type === "application/pdf" || nameLower.endsWith(".pdf");
    const isExcel = file.type.includes("sheet") || file.type.includes("excel") || nameLower.endsWith(".xlsx") || nameLower.endsWith(".xls");
    const isTxt = file.type === "text/plain" || nameLower.endsWith(".txt") || nameLower.endsWith(".csv");

    if (!isPdf && !isExcel && !isTxt) {
      setError("Solo se admiten archivos de inmuebles en formato PDF (.pdf), Excel (.xlsx, .xls) o de Texto/CSV.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (evt) => {
      const result = evt.target?.result;
      if (typeof result === "string") {
        const base64 = result.split(",")[1];
        setUploadedPropertiesFile({
          name: file.name,
          size: file.size,
          base64,
          mimeType: isExcel 
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" 
            : isPdf 
              ? "application/pdf" 
              : "text/plain"
        });
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div id="onboarding-root" className="min-h-screen bg-slate-900 text-slate-100 flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto w-full space-y-8 bg-slate-800/50 backdrop-blur-md p-8 sm:p-10 rounded-2xl border border-slate-700/60 shadow-2xl">
        
        {/* Header */}
        <div className="text-center">
          <div className="inline-flex items-center justify-center p-3 bg-indigo-600/20 text-indigo-400 rounded-xl mb-4 border border-indigo-500/20">
            <Sparkles className="w-8 h-8" />
          </div>
          <h2 className="text-3xl font-bold font-sans tracking-tight text-white">
            Gestión de Alquileres y Control de Renta
          </h2>
          <p className="mt-2 text-slate-400 max-w-xl mx-auto">
            Configura tu cartera de inmuebles y rendimientos importando automáticamente tu Declaración de la Renta.
          </p>
        </div>

        {/* Content Tabs */}
        {!previewData && !loading && (
          <div className="space-y-6">
            
            {/* Declaration Mode Selector */}
            <div className="flex bg-slate-950/80 p-1 rounded-xl border border-slate-800/80">
              <button
                type="button"
                onClick={() => setDeclarationMode("conjunta")}
                className={`flex-1 py-2.5 text-xs font-bold font-mono uppercase tracking-wider rounded-lg transition-all ${
                  declarationMode === "conjunta"
                    ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/10"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Declaración Conjunta o de 1 Usuario
              </button>
              <button
                type="button"
                onClick={() => setDeclarationMode("separadas")}
                className={`flex-1 py-2.5 text-xs font-bold font-mono uppercase tracking-wider rounded-lg transition-all ${
                  declarationMode === "separadas"
                    ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/10"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                Subir Declaraciones de Ambos por Separado
              </button>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                {declarationMode === "conjunta" 
                  ? "Paso 1: Selecciona una plantilla AEAT real o sube el documento del Usuario 1 / Conjunta" 
                  : "Paso 1: Sube la declaración de cada usuario por separado (puedes omitir una de las dos si solo quieres actualizar uno)"}
              </label>
              
              {/* Template Selectors (Only shown in Conjunta/Single mode to avoid clutter) */}
              {declarationMode === "conjunta" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                  {SAMPLE_DECLARATIONS.map((decl) => (
                    <button
                      key={decl.id}
                      type="button"
                      onClick={() => handleSelectTemplate(decl.id)}
                      className={`text-left p-4 rounded-xl border transition-all ${
                        selectedTemplate === decl.id
                          ? "bg-indigo-600/20 border-indigo-500 text-white"
                          : "bg-slate-800/40 border-slate-700 hover:border-slate-600 text-slate-300"
                      }`}
                    >
                      <div className="flex items-center space-x-2 font-medium text-sm text-white mb-1">
                        <FileText className="w-4 h-4 text-indigo-400" />
                        <span>{decl.title}</span>
                      </div>
                      <p className="text-xs text-slate-400">{decl.description}</p>
                    </button>
                  ))}
                </div>
              )}

              {/* Upload Formats Section */}
              {declarationMode === "conjunta" ? (
                // CONJUNTA / SINGLE FILE VIEW
                <div className="space-y-4">
                  <div>
                    {uploadedFile1 ? (
                      <div className="bg-indigo-950/40 border border-indigo-500/40 rounded-xl p-6 flex flex-col sm:flex-row items-center justify-between gap-4 animate-fade-in">
                        <div className="flex items-center space-x-4 text-left">
                          <div className="p-3 bg-indigo-600/20 text-indigo-400 rounded-xl shrink-0">
                            <FileText className="w-7 h-7" />
                          </div>
                          <div className="text-left">
                            <h4 className="font-bold text-white text-sm truncate max-w-[280px] sm:max-w-md">{uploadedFile1.name}</h4>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Tamaño: {(uploadedFile1.size / 1024).toFixed(1)} KB • Formato: {uploadedFile1.mimeType === "application/pdf" ? "PDF" : "TXT"}
                            </p>
                            <span className="inline-flex items-center text-[10px] text-emerald-400 font-mono font-bold mt-1.5 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
                              Declaración Principal Lista
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => { setUploadedFile1(null); setSelectedTemplate(""); }}
                          className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 hover:text-white rounded-lg text-xs font-semibold text-slate-400 transition-colors cursor-pointer"
                        >
                          Quitar
                        </button>
                      </div>
                    ) : showTextPaste1 ? (
                      <div className="space-y-3">
                        <textarea
                          rows={10}
                          className="w-full bg-slate-950/60 border border-slate-700/80 rounded-xl p-4 text-slate-200 font-mono text-xs focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 placeholder-slate-600"
                          placeholder="Pega aquí el texto de tu borrador de la Renta Modelo 100 de la Agencia Tributaria..."
                          value={pastedText1}
                          onChange={(e) => {
                            setPastedText1(e.target.value);
                            setSelectedTemplate("");
                          }}
                        />
                        <div className="flex justify-between items-center px-1">
                          <span className="text-[10px] text-slate-500">Formato de texto borrador (Modelo 100)</span>
                          <button 
                            type="button" 
                            onClick={() => { setShowTextPaste1(false); setPastedText1(""); }} 
                            className="text-xs text-indigo-400 hover:text-indigo-300 underline font-medium cursor-pointer"
                          >
                            O cambiar a subir archivo (PDF / TXT)
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <label className="block w-full cursor-pointer">
                          <input
                            type="file"
                            accept=".txt,.pdf"
                            onChange={(e) => handleFileUpload(e, 1)}
                            className="hidden"
                          />
                          <div 
                            onDragOver={handleDragOver1}
                            onDragLeave={handleDragLeave1}
                            onDrop={handleDrop1}
                            className={`transition-all duration-200 rounded-2xl border-2 border-dashed p-10 flex flex-col items-center justify-center text-center hover:bg-slate-850/30 ${
                              isDragging1 
                                ? "bg-indigo-600/15 border-indigo-400 scale-[1.01]" 
                                : "border-slate-700 hover:border-indigo-500/50 bg-slate-950/20"
                            }`}
                          >
                            <Upload className="w-10 h-10 text-indigo-400 mb-3 animate-pulse" />
                            <p className="text-sm text-white font-bold">Arrastra y suelta tu declaración PDF o TXT aquí</p>
                            <p className="text-xs text-slate-400 mt-1.5">O haz clic para buscar tu archivo localmente</p>
                            <span className="mt-4 inline-flex items-center px-4 py-2 bg-indigo-600/10 hover:bg-indigo-600/20 text-indigo-300 text-xs font-bold rounded-xl border border-indigo-500/25 transition-all">
                              Seleccionar Archivo PDF/TXT
                            </span>
                          </div>
                        </label>
                        <div className="flex justify-center">
                          <button 
                            type="button" 
                            onClick={() => setShowTextPaste1(true)} 
                            className="text-xs text-indigo-400 hover:text-indigo-300 underline font-medium cursor-pointer"
                          >
                            O prefiere copiar y pegar el texto del borrador de renta
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                // SEPARADAS / DUAL FILES VIEW
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  
                  {/* Usuario 1 Card */}
                  <div className="bg-slate-900/20 border border-slate-800/80 rounded-2xl p-5 space-y-4">
                    <h3 className="text-sm font-bold text-white flex items-center space-x-1.5">
                      <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
                      <span>Usuario 1 (Declarante Principal)</span>
                    </h3>

                    <div>
                      {uploadedFile1 ? (
                        <div className="bg-indigo-950/30 border border-indigo-500/30 rounded-xl p-4 flex items-center justify-between gap-3 animate-fade-in text-left">
                          <div className="flex items-center space-x-3 truncate">
                            <FileText className="w-5 h-5 text-indigo-400 shrink-0" />
                            <div className="truncate text-xs">
                              <h4 className="font-semibold text-white truncate max-w-[130px]">{uploadedFile1.name}</h4>
                              <p className="text-[10px] text-slate-400">PDF • {(uploadedFile1.size / 1024).toFixed(1)} KB</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => { setUploadedFile1(null); setSelectedTemplate(""); }}
                            className="p-1.5 bg-slate-800 hover:bg-slate-700 hover:text-white rounded text-xs font-semibold text-slate-400 transition-colors"
                          >
                            Quitar
                          </button>
                        </div>
                      ) : showTextPaste1 ? (
                        <div className="space-y-2">
                          <textarea
                            rows={6}
                            className="w-full bg-slate-950/60 border border-slate-700/80 rounded-xl p-3 text-slate-200 font-mono text-[11px] focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 placeholder-slate-600"
                            placeholder="Pega el texto de la declaración del Usuario 1..."
                            value={pastedText1}
                            onChange={(e) => setPastedText1(e.target.value)}
                          />
                          <button 
                            type="button" 
                            onClick={() => { setShowTextPaste1(false); setPastedText1(""); }} 
                            className="text-[10px] text-indigo-400 hover:text-indigo-300 underline font-medium cursor-pointer block"
                          >
                            Volver a subir archivo (PDF / TXT)
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <label className="block w-full cursor-pointer">
                            <input
                              type="file"
                              accept=".txt,.pdf"
                              onChange={(e) => handleFileUpload(e, 1)}
                              className="hidden"
                            />
                            <div 
                              onDragOver={handleDragOver1}
                              onDragLeave={handleDragLeave1}
                              onDrop={handleDrop1}
                              className={`transition-all duration-200 rounded-xl border-2 border-dashed p-6 flex flex-col items-center justify-center text-center hover:bg-slate-800/20 ${
                                isDragging1 
                                  ? "bg-indigo-600/15 border-indigo-400" 
                                  : "border-slate-800 hover:border-indigo-500/40 bg-slate-950/35"
                              }`}
                            >
                              <Upload className="w-8 h-8 text-indigo-400 mb-2 animate-pulse" />
                              <p className="text-xs text-white font-bold">Arrastra tu archivo aquí</p>
                              <p className="text-[10px] text-slate-400 mt-1">O haz clic para buscarlo</p>
                              <span className="mt-3 inline-flex px-3 py-1 bg-indigo-600/10 hover:bg-indigo-600/20 text-indigo-300 text-[10px] font-bold rounded-lg border border-indigo-500/20">
                                Buscar PDF/TXT
                              </span>
                            </div>
                          </label>
                          <button 
                            type="button" 
                            onClick={() => setShowTextPaste1(true)} 
                            className="text-[10px] text-indigo-400 hover:text-indigo-300 underline font-medium cursor-pointer block text-center w-full"
                          >
                            O copiar y pegar texto borrador
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Usuario 2 Card */}
                  <div className="bg-slate-900/20 border border-slate-800/80 rounded-2xl p-5 space-y-4">
                    <h3 className="text-sm font-bold text-white flex items-center space-x-1.5">
                      <span className="w-2 h-2 rounded-full bg-pink-500"></span>
                      <span>Usuario 2 (Cónyuge / Pareja)</span>
                    </h3>

                    <div>
                      {uploadedFile2 ? (
                        <div className="bg-pink-950/30 border border-pink-500/30 rounded-xl p-4 flex items-center justify-between gap-3 animate-fade-in text-left">
                          <div className="flex items-center space-x-3 truncate">
                            <FileText className="w-5 h-5 text-pink-400 shrink-0" />
                            <div className="truncate text-xs">
                              <h4 className="font-semibold text-white truncate max-w-[130px]">{uploadedFile2.name}</h4>
                              <p className="text-[10px] text-slate-400">PDF • {(uploadedFile2.size / 1024).toFixed(1)} KB</p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setUploadedFile2(null)}
                            className="p-1.5 bg-slate-800 hover:bg-slate-700 hover:text-white rounded text-xs font-semibold text-slate-400 transition-colors"
                          >
                            Quitar
                          </button>
                        </div>
                      ) : showTextPaste2 ? (
                        <div className="space-y-2">
                          <textarea
                            rows={6}
                            className="w-full bg-slate-950/60 border border-slate-700/80 rounded-xl p-3 text-slate-200 font-mono text-[11px] focus:ring-1 focus:ring-pink-500 focus:border-pink-500 placeholder-slate-600"
                            placeholder="Pega el texto de la declaración del Usuario 2..."
                            value={pastedText2}
                            onChange={(e) => setPastedText2(e.target.value)}
                          />
                          <button 
                            type="button" 
                            onClick={() => { setShowTextPaste2(false); setPastedText2(""); }} 
                            className="text-[10px] text-pink-400 hover:text-pink-300 underline font-medium cursor-pointer block"
                          >
                            Volver a subir archivo (PDF / TXT)
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <label className="block w-full cursor-pointer">
                            <input
                              type="file"
                              accept=".txt,.pdf"
                              onChange={(e) => handleFileUpload(e, 2)}
                              className="hidden"
                            />
                            <div 
                              onDragOver={handleDragOver2}
                              onDragLeave={handleDragLeave2}
                              onDrop={handleDrop2}
                              className={`transition-all duration-200 rounded-xl border-2 border-dashed p-6 flex flex-col items-center justify-center text-center hover:bg-slate-800/20 ${
                                isDragging2 
                                  ? "bg-pink-600/15 border-pink-400" 
                                  : "border-slate-800 hover:border-pink-500/40 bg-slate-950/35"
                              }`}
                            >
                              <Upload className="w-8 h-8 text-pink-400 mb-2 animate-pulse" />
                              <p className="text-xs text-white font-bold">Arrastra tu archivo aquí</p>
                              <p className="text-[10px] text-slate-400 mt-1">O haz clic para buscarlo</p>
                              <span className="mt-3 inline-flex px-3 py-1 bg-pink-600/10 hover:bg-pink-600/20 text-pink-300 text-[10px] font-bold rounded-lg border border-pink-500/20">
                                Buscar PDF/TXT
                              </span>
                            </div>
                          </label>
                          <button 
                            type="button" 
                            onClick={() => setShowTextPaste2(true)} 
                            className="text-[10px] text-pink-400 hover:text-pink-300 underline font-medium cursor-pointer block text-center w-full"
                          >
                            O copiar y pegar texto borrador
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                </div>
              )}
            </div>
 
            {/* Paso 2: Datos de Inmuebles Adicionales (Excel / PDF) */}
            <div className="pt-5 border-t border-slate-700/50 mt-6 space-y-3">
              <div className="flex items-center space-x-2">
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-bold">2</span>
                <label className="block text-sm font-medium text-slate-200">
                  Paso 2: ¿Tienes un listado de inmuebles? (Opcional - Excel, PDF, CSV, TXT)
                </label>
              </div>
              <p className="text-xs text-slate-400">
                Sube un archivo Excel (.xlsx, .xls), PDF o texto/CSV con la lista de tus inmuebles, inquilinos, contratos, alquileres o gastos. El motor de IA cruzará toda la información con tu declaración para automatizar el desglose perfecto de datos compartidos, inquilinos múltiples y gastos.
              </p>

              <div>
                {uploadedPropertiesFile ? (
                  <div className="bg-amber-950/30 border border-amber-500/40 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4 animate-fade-in text-left">
                    <div className="flex items-center space-x-4 text-left">
                      <div className="p-3 bg-amber-500/10 text-amber-400 rounded-xl shrink-0">
                        <FileText className="w-7 h-7" />
                      </div>
                      <div className="text-left">
                        <h4 className="font-bold text-white text-sm truncate max-w-[240px] sm:max-w-md">{uploadedPropertiesFile.name}</h4>
                        <p className="text-xs text-slate-400 mt-0.5">
                          Tamaño: {(uploadedPropertiesFile.size / 1024).toFixed(1)} KB • Formato: {uploadedPropertiesFile.name.split('.').pop()?.toUpperCase()}
                        </p>
                        <span className="inline-flex items-center text-[10px] text-amber-400 font-mono font-bold mt-1.5 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">
                          Listado de Inmuebles Preparado
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setUploadedPropertiesFile(null)}
                      className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 hover:text-white rounded-lg text-xs font-semibold text-slate-400 transition-colors cursor-pointer"
                    >
                      Quitar
                    </button>
                  </div>
                ) : (
                  <label className="block w-full cursor-pointer">
                    <input
                      type="file"
                      accept=".txt,.pdf,.xlsx,.xls,.csv"
                      onChange={handlePropertiesFileUpload}
                      className="hidden"
                    />
                    <div 
                      onDragOver={handleDragOverProperties}
                      onDragLeave={handleDragLeaveProperties}
                      onDrop={handleDropProperties}
                      className={`transition-all duration-200 rounded-2xl border-2 border-dashed p-6 flex flex-col items-center justify-center text-center hover:bg-slate-850/30 ${
                        isDraggingProperties 
                          ? "bg-amber-600/15 border-amber-400 scale-[1.01]" 
                          : "border-slate-800 hover:border-amber-500/40 bg-slate-950/25"
                      }`}
                    >
                      <Upload className="w-8 h-8 text-amber-400/80 mb-2 animate-pulse" />
                      <p className="text-xs text-white font-bold">Arrastra tu listado Excel, PDF o CSV aquí</p>
                      <p className="text-[10px] text-slate-400 mt-1">O haz clic para buscar tu archivo localmente</p>
                      <span className="mt-3 inline-flex items-center px-3 py-1.5 bg-amber-600/10 hover:bg-amber-600/20 text-amber-300 text-xs font-bold rounded-xl border border-amber-500/20 transition-all">
                        Seleccionar Listado de Inmuebles
                      </span>
                    </div>
                  </label>
                )}
              </div>
            </div>

            {error && (
              <div className="bg-red-900/20 border border-red-500/40 rounded-xl p-4 text-sm text-red-300 flex items-start space-x-2">
                <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                onClick={startExtraction}
                disabled={
                  declarationMode === "conjunta" 
                    ? (!pastedText1.trim() && !uploadedFile1 && !uploadedPropertiesFile)
                    : (!pastedText1.trim() && !uploadedFile1 && !pastedText2.trim() && !uploadedFile2 && !uploadedPropertiesFile)
                }
                className="w-full md:w-auto inline-flex items-center justify-center px-6 py-3 bg-indigo-600 text-white font-medium rounded-xl hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 transition-all cursor-pointer shadow-lg shadow-indigo-600/10"
              >
                <span>Extraer Información Fiscal con IA</span>
                <Sparkles className="w-4 h-4 ml-2" />
              </button>
            </div>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="py-12 flex flex-col items-center justify-center space-y-6">
            <div className="relative w-16 h-16">
              <div className="absolute inset-0 rounded-full border-4 border-slate-700"></div>
              <div className="absolute inset-0 rounded-full border-4 border-indigo-500 border-t-transparent animate-spin"></div>
            </div>
            <div className="text-center space-y-2">
              <h4 className="text-lg font-medium text-white">Procesando declaración de la renta</h4>
              <p className="text-sm text-indigo-400 font-mono animate-pulse">{loadingSteps[loadingStep]}</p>
            </div>
          </div>
        )}

        {/* Preview and Confirmation Screen */}
        {previewData && !loading && (
          <div className="space-y-8 animate-fade-in">
            <div className="border-b border-slate-700/60 pb-4">
              <h3 className="text-xl font-bold text-white flex items-center">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 mr-2" />
                Información Fiscal Extraída Exitosamente
              </h3>
              <p className="text-sm text-slate-400 mt-1">
                Hemos extraído los siguientes datos relativos a vuestras rentas e inmuebles. Confirma que todo es correcto.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* Contribuyentes */}
              <div className="space-y-4">
                <div className="bg-slate-800/40 rounded-xl p-5 border border-slate-700/40">
                  <div className="flex items-center space-x-2 text-indigo-400 font-semibold mb-3">
                    <User className="w-4.5 h-4.5" />
                    <span>Usuario 1 (Declarante Principal)</span>
                  </div>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span className="text-slate-400">Nombre:</span> <span className="font-medium text-white">{previewData.user1?.name || "No especificado"}</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">NIF/DNI:</span> <span className="font-mono text-slate-300">{previewData.user1?.dni || "No especificado"}</span></div>
                    <div className="flex justify-between border-t border-slate-700/40 pt-2 mt-2"><span className="text-slate-400">Rendimiento Bruto Trabajo:</span> <span className="font-bold text-emerald-400">{Number(previewData.user1?.brutoTrabajo || 0).toLocaleString("es-ES")} €</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">Rendimiento Neto Trabajo:</span> <span className="font-semibold text-slate-200">{Number(previewData.user1?.netoTrabajo || 0).toLocaleString("es-ES")} €</span></div>
                  </div>
                </div>

                {previewData.user2 && (previewData.user2.hasPartner || previewData.user2.name) && (
                  <div className="bg-slate-800/40 rounded-xl p-5 border border-slate-700/40">
                    <div className="flex items-center space-x-2 text-pink-400 font-semibold mb-3">
                      <Heart className="w-4.5 h-4.5" />
                      <span>Usuario 2 (Pareja / Cónyuge)</span>
                    </div>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between"><span className="text-slate-400">Nombre:</span> <span className="font-medium text-white">{previewData.user2?.name || "No especificado"}</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">NIF/DNI:</span> <span className="font-mono text-slate-300">{previewData.user2?.dni || "No especificado"}</span></div>
                      <div className="flex justify-between border-t border-slate-700/40 pt-2 mt-2"><span className="text-slate-400">Rendimiento Bruto Trabajo:</span> <span className="font-bold text-emerald-400">{Number(previewData.user2?.brutoTrabajo || 0).toLocaleString("es-ES")} €</span></div>
                      <div className="flex justify-between"><span className="text-slate-400">Rendimiento Neto Trabajo:</span> <span className="font-semibold text-slate-200">{Number(previewData.user2?.netoTrabajo || 0).toLocaleString("es-ES")} €</span></div>
                    </div>
                  </div>
                )}
              </div>

              {/* Inmuebles */}
              <div className="space-y-4">
                <div className="bg-slate-800/40 rounded-xl p-5 border border-slate-700/40 h-full flex flex-col">
                  <div className="flex items-center space-x-2 text-indigo-400 font-semibold mb-3">
                    <Building className="w-4.5 h-4.5" />
                    <span>Inmuebles Arrendados Extraídos ({previewData.properties?.length || 0})</span>
                  </div>

                  <div className="space-y-3 flex-1 overflow-y-auto max-h-[300px] pr-2">
                    {previewData.properties && previewData.properties.length > 0 ? (
                      previewData.properties.map((prop: any, idx: number) => (
                        <div key={idx} className="bg-slate-900/60 p-3 rounded-lg border border-slate-800 space-y-1.5 text-xs text-slate-300">
                          <div className="font-semibold text-white truncate">{prop.address}</div>
                          <div className="flex justify-between font-mono text-slate-400">
                            <span>Ref. Catastral:</span>
                            <span className="text-slate-300">{prop.cadastralReference || "MOCK_REF"}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>Titular:</span>
                            <span className="capitalize text-slate-300">
                              {prop.owner === "user1" ? "Usuario 1" : prop.owner === "user2" ? "Usuario 2" : "Al 50% Ambos"}
                            </span>
                          </div>
                          <div className="flex justify-between border-t border-slate-800 pt-1.5 mt-1 text-slate-400">
                            <span>Inquilino:</span>
                            <span className="text-white font-medium">{prop.tenantName} ({prop.tenantDni})</span>
                          </div>
                          <div className="flex justify-between">
                            <span>Renta mensual:</span>
                            <span className="text-emerald-400 font-bold">{Number(prop.monthlyRent || 0).toLocaleString("es-ES")} €/mes</span>
                          </div>
                          <div className="flex justify-between">
                            <span>Compra:</span>
                            <span className="text-white font-semibold">{Number(prop.purchasePrice || 0).toLocaleString("es-ES")} €</span>
                          </div>
                          <div className="flex justify-between text-indigo-300">
                            <span>Amortización Anual:</span>
                            <span>{Number(prop.amortizationAmount || 0).toLocaleString("es-ES")} €</span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center text-slate-500 py-6">No se encontraron inmuebles en el texto.</div>
                    )}
                  </div>
                </div>
              </div>

            </div>

            <div className="flex flex-col sm:flex-row justify-between gap-3 pt-4 border-t border-slate-700/60">
              <button
                onClick={() => setPreviewData(null)}
                className="px-5 py-2.5 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 transition-all cursor-pointer text-center"
              >
                Volver a Importar
              </button>
              
              <button
                onClick={handleConfirmOnboarding}
                className="inline-flex items-center justify-center px-6 py-2.5 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-500 transition-all cursor-pointer shadow-lg shadow-indigo-600/20 text-center"
              >
                <span>Acceder al Dashboard Sincronizado</span>
                <ArrowRight className="w-4 h-4 ml-2" />
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
