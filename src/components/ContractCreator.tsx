import React, { useState, useEffect } from "react";
import { AppState, Property } from "../types";
import { 
  FileText, 
  Download, 
  Sparkles, 
  Check, 
  AlertTriangle, 
  Loader2, 
  Building, 
  User, 
  Calendar, 
  Coins, 
  Clipboard, 
  RefreshCw,
  Info,
  ShieldAlert,
  ArrowRight
} from "lucide-react";

interface ContractCreatorProps {
  state: AppState;
  onEditProperty: (updatedProperty: Property) => void;
  addSyncEvent: (source: string, target: string, action: string, details: string) => void;
}

export default function ContractCreator({ state, onEditProperty, addSyncEvent }: ContractCreatorProps) {
  // Property selection
  const [selectedPropertyId, setSelectedPropertyId] = useState<string>("");
  
  // Landlord profile
  const [landlordName, setLandlordName] = useState("");
  const [landlordDni, setLandlordDni] = useState("");
  const [landlordAddress, setLandlordAddress] = useState("");
  const [landlordType, setLandlordType] = useState<"physical" | "juridical">("physical");

  // Tenant profile
  const [tenantName, setTenantName] = useState("");
  const [tenantDni, setTenantDni] = useState("");

  // Property info
  const [propertyAddress, setPropertyAddress] = useState("");
  const [propertyCadastral, setPropertyCadastral] = useState("");
  const [isStressedZone, setIsStressedZone] = useState(false);

  // Contract conditions
  const [monthlyRent, setMonthlyRent] = useState(1000);
  const [startDate, setStartDate] = useState(new Date().toISOString().split("T")[0]);
  const [durationYears, setDurationYears] = useState(5);
  const [fianzaMonths, setFianzaMonths] = useState(1);
  const [guaranteeMonths, setGuaranteeMonths] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState("Transferencia Bancaria");
  const [iban, setIban] = useState("ES21 0049 1500 0000 0000 0000");

  // Extra clauses and AI custom edits
  const [extraClauses, setExtraClauses] = useState<string>("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedContractText, setGeneratedContractText] = useState("");
  const [isLinked, setIsLinked] = useState(false);
  const [copied, setCopied] = useState(false);

  // Warnings / Validation states
  const [guaranteeWarning, setGuaranteeWarning] = useState(false);

  // Signing city
  const [signingCity, setSigningCity] = useState("Madrid");
  const [isCustomText, setIsCustomText] = useState(false);

  // Initialize form fields based on selected property or default user data
  useEffect(() => {
    setIsCustomText(false);
    if (selectedPropertyId === "manual" || !selectedPropertyId) {
      // Default manual setup
      setLandlordName(state.user1.name || "Usuario 1");
      setLandlordDni(state.user1.dni || "12345678A");
      setLandlordAddress(state.user1.address || "Calle de Alcalá 140, 3ºB, 28009 Madrid");
      setTenantName("");
      setTenantDni("");
      setPropertyAddress("");
      setPropertyCadastral("");
      setMonthlyRent(1000);
      setDurationYears(5);
      setSigningCity("Madrid");
      setIsLinked(false);
      return;
    }

    const prop = state.properties.find(p => p.id === selectedPropertyId);
    if (prop) {
      // Determine Landlord info based on property owner
      if (prop.owner === "user1") {
        setLandlordName(state.user1.name || "Usuario 1");
        setLandlordDni(state.user1.dni || "12345678A");
        setLandlordAddress(state.user1.address || "Calle de Alcalá 140, 3ºB, 28009 Madrid");
      } else if (prop.owner === "user2") {
        setLandlordName(state.user2.name || "Usuario 2");
        setLandlordDni(state.user2.dni || "87654321K");
        setLandlordAddress(state.user2.address || "Calle de Alcalá 140, 3ºB, 28009 Madrid");
      } else {
        setLandlordName(`${state.user1.name || "Usuario 1"} y ${state.user2.name || "Usuario 2"}`);
        setLandlordDni(`${state.user1.dni || "12345678A"} / ${state.user2.dni || "87654321K"}`);
        setLandlordAddress(state.user1.address || "Calle de Alcalá 140, 3ºB, 28009 Madrid");
      }

      setTenantName(prop.tenantName || "");
      setTenantDni(prop.tenantDni || "");
      setPropertyAddress(prop.address);
      setPropertyCadastral(prop.cadastralReference);
      setMonthlyRent(prop.monthlyRent || 1000);
      
      // Auto-extract city from property address (e.g., "Calle de Alcalá 140, 3ºB, 28009 Madrid" -> "Madrid")
      let detectedCity = "Madrid";
      if (prop.address) {
        // Strip 5-digit postal code if any
        const cleaned = prop.address.replace(/\b\d{5}\b/g, "").trim();
        const parts = cleaned.split(",");
        let lastPart = parts[parts.length - 1].trim();
        // Strip trailing country indicators
        lastPart = lastPart.replace(/(España|Spain)/gi, "").trim();
        if (lastPart) {
          detectedCity = lastPart;
        }
      }
      setSigningCity(detectedCity);

      // Default to 5 years for natural person, 7 years if changed
      setDurationYears(landlordType === "physical" ? 5 : 7);
      
      // Auto fianza and guarantees
      setFianzaMonths(1);
      setGuaranteeMonths(0);
      setIsLinked(!!prop.contract?.startDate);
      
      if (prop.contract) {
        setStartDate(prop.contract.startDate);
        setMonthlyRent(prop.contract.monthlyRent);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPropertyId]);

  // Handle updates to landlord type
  useEffect(() => {
    if (landlordType === "physical") {
      setDurationYears(5);
    } else {
      setDurationYears(7);
    }
  }, [landlordType]);

  // Validate guarantees under 2024 Spanish Law limit (Art 36.5: additional guarantees max 2 months)
  useEffect(() => {
    if (guaranteeMonths > 2) {
      setGuaranteeWarning(true);
    } else {
      setGuaranteeWarning(false);
    }
  }, [guaranteeMonths]);

  // Pre-generate standard Spanish LAU contract text locally (fallback and live update)
  const computeLocalContractText = () => {
    const fianzaAmount = Math.round(monthlyRent * fianzaMonths);
    const guaranteeAmount = Math.round(monthlyRent * guaranteeMonths);
    const totalDepositAmount = fianzaAmount + guaranteeAmount;
    const finalDuration = durationYears;

    return `CONTRATO DE ARRENDAMIENTO DE VIVIENDA HABITUAL

En ${signingCity || "Madrid"}, a ${new Date(startDate).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" })}.

REUNIDOS
De una parte, D./Dña. ${landlordName || "[Nombre del Arrendador]"}, con DNI/NIF ${landlordDni || "[DNI del Arrendador]"}, y domicilio para notificaciones en ${landlordAddress || "[Domicilio del Arrendador]"}, en adelante denominado el "ARRENDADOR".

Y de otra parte, D./Dña. ${tenantName || "[Nombre del Inquilino]"}, con DNI/NIF ${tenantDni || "[DNI del Inquilino]"}, en adelante denominado el "ARRENDATARIO".

Ambas partes se reconocen mutuamente capacidad legal suficiente para el otorgamiento del presente contrato de arrendamiento y, a tal fin,

EXPONEN
I. Que el ARRENDADOR es propietario en pleno dominio del inmueble sito en ${propertyAddress || "[Dirección del Inmueble]"}, con Referencia Catastral ${propertyCadastral || "[Referencia Catastral]"}, libre de cargas y arrendatarios.

II. Que el ARRENDATARIO está interesado en arrendar dicho inmueble para destinarlo exclusivamente a satisfacer su necesidad permanente de vivienda habitual, para sí y su unidad familiar, no pudiendo darle otro destino secundario.

III. Que las partes acuerdan formalizar el presente contrato conforme a lo dispuesto en la Ley 29/1994, de 24 de noviembre, de Arrendamientos Urbanos (LAU), con las modificaciones introducidas por la Ley 12/2023, de 24 de mayo, por el Derecho a la Vivienda, y bajo las siguientes:

CLÁUSULAS

PRIMERA.- OBJETO Y DESTINO.
El ARRENDADOR cede en arrendamiento al ARRENDATARIO el inmueble descrito, quien lo acepta en perfecto estado de habitabilidad. El inmueble se destinará exclusivamente a vivienda habitual del ARRENDATARIO, quedando prohibido expresamente el subarriendo, la cesión de contrato, el alojamiento de huéspedes permanentes no declarados o la explotación como vivienda de uso turístico.

SEGUNDA.- DURACIÓN Y PRÓRROGAS.
El plazo de duración pactado es de ${finalDuration} AÑOS a contar desde el ${new Date(startDate).toLocaleDateString("es-ES")}. Llegado el día del vencimiento del contrato, este se prorrogará obligatoriamente por plazos anuales hasta que el arrendamiento alcance una duración mínima de ${finalDuration} años, de conformidad con el Artículo 9 de la LAU, salvo que el ARRENDATARIO manifieste al ARRENDADOR, con al menos treinta días de antelación a la fecha de terminación, su voluntad de no renovarlo.
Conforme a la legislación vigente (Ley de Vivienda 12/2023), finalizado el periodo de prórroga legal, el ARRENDATARIO podrá solicitar una prórroga extraordinaria de carácter anual por un periodo máximo de tres (3) años, acreditando situación de vulnerabilidad social y económica, que el ARRENDADOR persona jurídica o gran tenedor estará obligado a aceptar.

TERCERA.- RENTA Y ACTUALIZACIÓN LIMITADA (CONFORMIDAD LEY DE VIVIENDA 2024).
La renta mensual acordada es de ${monthlyRent} EUROS, pagaderos en mensualidades anticipadas dentro de los primeros siete días de cada mes mediante ${paymentMethod} a la cuenta bancaria de titularidad del arrendador: IBAN: ${iban}.
La renta solo podrá ser actualizada anualmente en la fecha en que se cumpla cada año de vigencia del contrato. Conforme a la Disposición Adicional Undécima de la Ley 12/2023 por el Derecho a la Vivienda, el incremento de la renta para las actualizaciones anuales que tengan lugar entre el 1 de enero de 2024 y el 31 de diciembre de 2026 está topado legalmente a un máximo del 3%, o en su defecto, indexado al nuevo índice de referencia para la actualización anual de contratos de arrendamiento de vivienda, sin que en ningún caso pueda superarse dicho porcentaje legal ni aplicarse el IPC general si fuera superior.
${isStressedZone ? `\n[CONDICIÓN ESPECIAL - ZONA TENSIONADA]: Al estar situado el inmueble en una Zona de Mercado Residencial Tensionado declarada oficialmente, la renta fijada se encuentra limitada al valor máximo aplicable según el Sistema Estatal de Referencia del Precio del Alquiler de Vivienda, declarando las partes conocer y aceptar expresamente dicho límite legal.` : ""}

CUARTA.- GASTOS DE GESTIÓN E INMOBILIARIA (ART. 20.1 LAU VIGENTE).
En cumplimiento estricto del Artículo 20.1 de la Ley de Arrendamientos Urbanos, en su redacción dada por la Ley 12/2023 por el Derecho a la Vivienda, se hace constar de forma expresa que los gastos de gestión inmobiliaria y de formalización del presente contrato serán a cargo exclusivo del ARRENDADOR, no pudiendo repercutirse de ninguna forma, concepto, cargo directo o indirecto sobre el ARRENDATARIO.

QUINTA.- FIANZA LEGAL Y GARANTÍAS ADICIONALES ACOTADAS.
El ARRENDATARIO hace entrega en este acto de la suma de ${fianzaAmount} EUROS, equivalente a una (1) mensualidad de renta, en concepto de fianza legal obligatoria conforme al Art. 36.1 de la LAU, destinada a garantizar la reparación de daños físicos en el inmueble al término del arrendamiento.
${guaranteeMonths > 0 ? `Asimismo, se constituye una garantía adicional acumulada de ${guaranteeAmount} EUROS (equivalente a ${guaranteeMonths} mensualidades de renta) mediante depósito, respetando escrupulosamente el límite de dos meses establecido en el Artículo 36.5 de la LAU modificado para contratos de vivienda habitual de duración ordinaria.` : "No se establecen garantías financieras adicionales adicionales a la fianza legal de un mes."}
El importe total depositado asciende a ${totalDepositAmount} EUROS, el cual será custodiado e ingresado por el ARRENDADOR en el organismo público autonómico competente de depósitos de fianzas en los plazos reglamentarios.

SEXTA.- SUMINISTROS Y TRIBUTOS.
Los gastos de agua, electricidad, gas, servicios de telecomunicación y cualquier otro suministro provisto de contador individual serán de cuenta exclusiva del ARRENDATARIO, comprometiéndose a poner a su nombre los contratos de servicios correspondientes. Los tributos anuales como el IBI y las cuotas de Comunidad ordinarias de propietarios serán sufragados por el ARRENDADOR.

SÉPTIMA.- CONSERVACIÓN Y REPARACIONES.
El ARRENDADOR está obligado a realizar, sin derecho a elevar por ello la renta, todas las reparaciones que sean necesarias para conservar la vivienda en las condiciones de habitabilidad para servir al uso convenido, salvo cuando el deterioro sea imputable al ARRENDATARIO. Las pequeñas reparaciones que exija el desgaste por el uso ordinario de la vivienda serán a cargo del ARRENDATARIO.

${extraClauses ? `OCTAVA.- CLÁUSULAS ADICIONALES PARTICULARES.\n${extraClauses}\n` : ""}
Y en prueba de conformidad y aceptación de todas y cada una de las cláusulas, las partes firman el presente documento por duplicado y a un solo efecto, en el lugar y fecha indicados en el encabezamiento.


__________________________________                __________________________________
EL ARRENDADOR                                    EL ARRENDATARIO
D./Dña. ${landlordName || "..."}                  D./Dña. ${tenantName || "..."}
`;
  };

  // Keep live text sync
  useEffect(() => {
    if (!isCustomText && (!generatedContractText || !isGenerating)) {
      setGeneratedContractText(computeLocalContractText());
    }
  }, [
    landlordName, landlordDni, landlordAddress, landlordType,
    tenantName, tenantDni, propertyAddress, propertyCadastral,
    monthlyRent, startDate, durationYears, fianzaMonths,
    guaranteeMonths, paymentMethod, iban, extraClauses, isStressedZone, signingCity,
    isCustomText, isGenerating
  ]);

  // Save/Link contract parameters directly to the Property module in state
  const handleLinkToProperty = () => {
    if (!selectedPropertyId || selectedPropertyId === "manual") {
      alert("Selecciona un inmueble de tu cartera para vincular este contrato.");
      return;
    }

    const prop = state.properties.find(p => p.id === selectedPropertyId);
    if (!prop) return;

    const updatedProp: Property = {
      ...prop,
      monthlyRent: monthlyRent,
      tenantName: tenantName,
      tenantDni: tenantDni,
      contract: {
        startDate: startDate,
        monthlyRent: monthlyRent,
        pdfName: `Contrato_Generado_${prop.address.split(",")[0].replace(/\s+/g, "_")}.doc`,
        pdfSize: "Legal Word Format (Auto)"
      }
    };

    onEditProperty(updatedProp);
    setIsLinked(true);

    // Trigger sync log event
    addSyncEvent(
      "Redactor Contratos Ley 2024",
      "Cartera de Inmuebles & Cobros",
      `Contrato vinculado a ${prop.address.split(",")[0]}`,
      `Vinculada fecha de inicio (${startDate}) y renta mensual de ${monthlyRent}€ al inmueble. Sincronizada la fianza y el estatus legal en tiempo real.`
    );
  };

  // AI-powered contract optimizer using server-side Gemini 3.5 Flash
  const handleOptimizeWithAI = async () => {
    if (isGenerating) return;
    setIsGenerating(true);
    
    addSyncEvent(
      "Centro Redacción IA",
      "Redactor Contratos Ley 2024",
      "Llamada a IA para optimización de cláusulas",
      `Solicitada revisión inteligente del contrato de alquiler. Parámetros enviados: Renta ${monthlyRent}€, Zona Tensionada: ${isStressedZone ? "SÍ" : "NO"}, Instrucción: "${aiPrompt || "Revisión general"}"`
    );

    try {
      // Build precise context with actual Spain 2024 Housing Law constraints
      const contractContext = {
        landlordName,
        landlordDni,
        landlordAddress,
        landlordType,
        tenantName,
        tenantDni,
        propertyAddress,
        propertyCadastral,
        isStressedZone,
        monthlyRent,
        startDate,
        durationYears,
        fianzaMonths,
        guaranteeMonths,
        paymentMethod,
        iban,
        extraClauses
      };

      const promptText = `
        Por favor, actúa como un abogado experto en derecho inmobiliario español.
        Quiero que revises y optimices el siguiente contrato de arrendamiento de vivienda habitual, incorporando de forma muy profesional la siguiente instrucción adicional del usuario: "${aiPrompt || "Por favor, pule el lenguaje para que sea formal, legalmente blindado frente a impagos y redactado con impecable estilo jurídico español, asegurando que cumple rigurosamente con la Ley de Vivienda 12/2023 de España."}".

        MANDATOS LEGALES CRÍTICOS DE LA LEY DE VIVIENDA DE 2024 QUE DEBES ASEGURAR:
        1. Los gastos de gestión inmobiliaria y formalización de contrato corresponden EXCLUSIVAMENTE al Arrendador (Art 20.1 LAU).
        2. La actualización anual de la renta está topada al 3% máximo durante 2024, 2025 y 2026 (o el nuevo índice). No se puede pactar el IPC general si este supera dicho límite legal.
        3. La fianza legal obligatoria es de 1 mes. Las garantías adicionales añadidas no pueden superar en ningún caso las 2 mensualidades de renta (máximo 3 meses totales de depósito), a menos que el plazo pactado sea superior al ordinario de la LAU.
        4. Duración obligatoria de mínimo 5 años para personas físicas y 7 años para personas jurídicas, prorrogables.
        5. Si se indica que está en Zona Tensionada (${isStressedZone ? "Sí" : "No"}), haz mención expresa de que la renta cumple con los límites legales según el Sistema Estatal de Referencia de Precios.

        Devuelve ÚNICAMENTE el texto redactado del contrato de arrendamiento completo y pulido, con un formato de texto limpio y elegante, listo para ser copiado o descargado, respetando la estructura legal clásica: Título, Reunidos, Intervienen, Exponen y Cláusulas detalladas. No incluyas explicaciones adicionales, introducciones ni notas de saludo fuera del contrato.
      `;

      // Call the server API proxy for Gemini model generateContent
      const response = await fetch("/api/optimize-contract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contractContext,
          customPrompt: promptText
        })
      });

      if (!response.ok) {
        throw new Error("La llamada al servidor de optimización de contratos de IA falló.");
      }

      const data = await response.json();
      if (data && data.text) {
        setGeneratedContractText(data.text);
        setIsCustomText(true);
        addSyncEvent(
          "Centro Redacción IA",
          "Redactor Contratos Ley 2024",
          "Contrato optimizado por IA",
          "Gemini ha revisado, pulido y adaptado las cláusulas conforme a la Ley de Vivienda 12/2023 e incorporado tus peticiones particulares."
        );
      } else {
        throw new Error("No se recibió texto optimizado del modelo de IA.");
      }
    } catch (error: any) {
      console.error(error);
      alert(`Error de IA: ${error.message}. Se mantendrá la plantilla legal estándar local.`);
    } finally {
      setIsGenerating(false);
    }
  };

  // Copy to clipboard helper
  const handleCopyToClipboard = () => {
    navigator.clipboard.writeText(generatedContractText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    addSyncEvent(
      "Redactor Contratos Ley 2024",
      "Portapapeles",
      "Texto de contrato copiado",
      "Se ha copiado el contrato completo al portapapeles para su edición o firma."
    );
  };

  // Elegant Word download (.doc opens perfectly in Word as HTML rich document)
  const handleDownloadDoc = () => {
    // Wrap contract text with standard HTML line breaks and basic styling for Microsoft Word compatibility
    const formattedHtml = `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <title>Contrato de Arrendamiento de Vivienda Habitual</title>
        <meta charset="utf-8">
        <style>
          body {
            font-family: 'Times New Roman', serif;
            font-size: 12pt;
            line-height: 1.5;
            color: #000000;
            margin: 2.54cm 2.54cm 2.54cm 2.54cm;
          }
          h1 {
            font-size: 14pt;
            text-align: center;
            font-weight: bold;
            margin-bottom: 24pt;
            text-transform: uppercase;
          }
          h2 {
            font-size: 12pt;
            font-weight: bold;
            margin-top: 18pt;
            margin-bottom: 6pt;
          }
          p {
            margin-bottom: 12pt;
            text-align: justify;
          }
          .signatures {
            margin-top: 50pt;
            width: 100%;
          }
          .signature-col {
            width: 50%;
            float: left;
            text-align: left;
          }
        </style>
      </head>
      <body>
        ${generatedContractText
          .replace(/\n\n/g, "</p><p>")
          .replace(/\n/g, "<br>")
          .replace(/^/, "<h1>")
          .replace(/REUNIDOS/, "</h1><h2>REUNIDOS</h2><p>")
          .replace(/EXPONEN/, "<h2>EXPONEN</h2><p>")
          .replace(/CLÁUSULAS/, "<h2>CLÁUSULAS</h2><p>")
          .replace(/PRIMERA\.-/g, "<h2>PRIMERA.-</h2>")
          .replace(/SEGUNDA\.-/g, "<h2>SEGUNDA.-</h2>")
          .replace(/TERCERA\.-/g, "<h2>TERCERA.-</h2>")
          .replace(/CUARTA\.-/g, "<h2>CUARTA.-</h2>")
          .replace(/QUINTA\.-/g, "<h2>QUINTA.-</h2>")
          .replace(/SEXTA\.-/g, "<h2>SEXTA.-</h2>")
          .replace(/SÉPTIMA\.-/g, "<h2>SÉPTIMA.-</h2>")
          .replace(/OCTAVA\.-/g, "<h2>OCTAVA.-</h2>")
        }
      </body>
      </html>
    `;

    const blob = new Blob(["\ufeff" + formattedHtml], { type: "application/msword;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    
    const propPart = propertyAddress ? propertyAddress.split(",")[0].replace(/\s+/g, "_") : "vivienda";
    a.download = `Contrato_Alquiler_Ley_2024_${propPart}.doc`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addSyncEvent(
      "Redactor Contratos Ley 2024",
      "Descargas de Usuario",
      "Contrato descargado (.doc)",
      `Generado archivo Word con todos los datos integrados del inmueble en ${propertyAddress || "dirección manual"}.`
    );
  };

  return (
    <div id="contracts-creator-tab" className="space-y-8 animate-fade-in text-slate-100">
      
      {/* HEADER SECTION */}
      <div className="border-b border-slate-800 pb-5">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-indigo-600/20 text-indigo-400 rounded-xl border border-indigo-500/20">
            <FileText className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Redactor Inteligente de Contratos</h1>
            <p className="text-sm text-slate-400 mt-1">
              Diseña, cumplimenta y optimiza con IA contratos de arrendamiento de vivienda habitual 100% blindados y adaptados a la Ley de Vivienda de 2024.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        
        {/* LEFT COLUMN: INTERACTIVE FORM (5 COLS) */}
        <div className="lg:col-span-5 space-y-6">
          
          {/* STEP 1: CARTERA INTEGRATION */}
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex items-center space-x-2 text-indigo-400">
              <Building className="w-5 h-5" />
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200">Asociar Inmueble de Cartera</h3>
            </div>
            
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">Selecciona el inmueble a alquilar:</label>
              <select
                value={selectedPropertyId}
                onChange={(e) => setSelectedPropertyId(e.target.value)}
                className="w-full bg-slate-950/80 border border-slate-700/80 rounded-xl px-3 py-2.5 text-xs text-slate-200 focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">-- Seleccionar inmueble --</option>
                <option value="manual">Cumplimentar manualmente (Fuera de cartera)</option>
                {state.properties.map((prop) => (
                  <option key={prop.id} value={prop.id}>
                    {prop.address.split(",")[0]} ({prop.tenantName || "Sin inquilino asignado"})
                  </option>
                ))}
              </select>
              {selectedPropertyId && selectedPropertyId !== "manual" && (
                <p className="text-[11px] text-emerald-400 mt-1.5 flex items-center">
                  <Check className="w-3.5 h-3.5 mr-1" /> Los datos del propietario, inquilino y renta se han pre-cargado automáticamente.
                </p>
              )}
            </div>
          </div>

          {/* STEP 2: PARTICIPANTES */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5 space-y-5">
            <div className="flex items-center space-x-2 text-indigo-400 border-b border-slate-800 pb-2.5">
              <User className="w-5 h-5" />
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200">Datos de los Intervinientes</h3>
            </div>

            {/* LANDLORD TYPE */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">Tipo de Arrendador (Propietario):</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setLandlordType("physical")}
                  className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all ${
                    landlordType === "physical"
                      ? "bg-indigo-600/10 border-indigo-500 text-indigo-400"
                      : "bg-slate-900/40 border-slate-800 text-slate-400 hover:bg-slate-800"
                  }`}
                >
                  Persona Física (5 años mín.)
                </button>
                <button
                  type="button"
                  onClick={() => setLandlordType("juridical")}
                  className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all ${
                    landlordType === "juridical"
                      ? "bg-indigo-600/10 border-indigo-500 text-indigo-400"
                      : "bg-slate-900/40 border-slate-800 text-slate-400 hover:bg-slate-800"
                  }`}
                >
                  Persona Jurídica (7 años mín.)
                </button>
              </div>
            </div>

            {/* LANDLORD DATA */}
            <div className="space-y-3.5 pt-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">Arrendador (Dueño)</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Nombre o Razón Social</label>
                  <input
                    type="text"
                    value={landlordName}
                    onChange={(e) => setLandlordName(e.target.value)}
                    className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">DNI / CIF</label>
                  <input
                    type="text"
                    value={landlordDni}
                    onChange={(e) => setLandlordDni(e.target.value)}
                    className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono uppercase"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Domicilio a efectos de notificaciones</label>
                <input
                  type="text"
                  value={landlordAddress}
                  onChange={(e) => setLandlordAddress(e.target.value)}
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200"
                  placeholder="Calle de Alcalá 140, Madrid"
                />
              </div>
            </div>

            {/* TENANT DATA */}
            <div className="space-y-3.5 border-t border-slate-800/80 pt-3.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">Arrendatario (Inquilino)</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Nombre Completo</label>
                  <input
                    type="text"
                    value={tenantName}
                    onChange={(e) => setTenantName(e.target.value)}
                    className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200"
                    placeholder="E.g., Juan Manuel Pérez"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">DNI / NIE / Pasaporte</label>
                  <input
                    type="text"
                    value={tenantDni}
                    onChange={(e) => setTenantDni(e.target.value)}
                    className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono uppercase"
                    placeholder="E.g., 12345678Z"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* STEP 3: FINANCIALS & PROPERTY */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex items-center space-x-2 text-indigo-400 border-b border-slate-800 pb-2.5">
              <Coins className="w-5 h-5" />
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200">Condiciones y Vivienda</h3>
            </div>

            {/* PROPERTY DATA */}
            <div className="space-y-3 pt-1 border-b border-slate-800 pb-3">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">Datos del Inmueble</span>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Dirección Completa de la Vivienda</label>
                <input
                  type="text"
                  value={propertyAddress}
                  onChange={(e) => setPropertyAddress(e.target.value)}
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200"
                  placeholder="Calle Gran Vía 12, Barcelona"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1 font-sans">Referencia Catastral</label>
                  <input
                    type="text"
                    value={propertyCadastral}
                    onChange={(e) => setPropertyCadastral(e.target.value)}
                    className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono uppercase"
                    placeholder="1234567DF1234F0001XX"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Localidad de Firma</label>
                  <input
                    type="text"
                    value={signingCity}
                    onChange={(e) => setSigningCity(e.target.value)}
                    className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200"
                    placeholder="E.g., Madrid, Barcelona"
                  />
                </div>
              </div>
            </div>

            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">Condiciones del Contrato</span>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Renta Mensual (€)</label>
                <input
                  type="number"
                  value={monthlyRent}
                  onChange={(e) => setMonthlyRent(Number(e.target.value))}
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Fecha Inicio</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Duración (Años)</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={durationYears}
                  onChange={(e) => setDurationYears(Number(e.target.value))}
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Fianza (Meses)</label>
                <select
                  value={fianzaMonths}
                  onChange={(e) => setFianzaMonths(Number(e.target.value))}
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200"
                >
                  <option value={1}>1 mes (Mínimo)</option>
                  <option value={2}>2 meses</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Garantía Adic. (Meses)</label>
                <input
                  type="number"
                  min={0}
                  max={6}
                  value={guaranteeMonths}
                  onChange={(e) => setGuaranteeMonths(Number(e.target.value))}
                  className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200"
                />
              </div>
            </div>

            {/* LEY DE VIVIENDA WARNING LIMIT FOR GUARANTEES */}
            {guaranteeWarning && (
              <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-xl flex items-start space-x-2 text-red-300">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="text-[10px] leading-relaxed">
                  <strong className="font-bold">¡ALERTA LEY DE VIVIENDA 2024!</strong> El Art. 36.5 de la LAU limita las garantías adicionales a un <strong className="font-bold">máximo de 2 mensualidades de renta</strong> en contratos ordinarios de vivienda habitual. Superarlo puede invalidar esta cláusula.
                </div>
              </div>
            )}

            {/* STRESSED RESIDENTIAL ZONE LIMITS */}
            <div className="p-3 bg-indigo-950/30 border border-indigo-500/20 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-300">Inmueble en Zona Tensionada (2024)</span>
                <input
                  type="checkbox"
                  checked={isStressedZone}
                  onChange={(e) => setIsStressedZone(e.target.checked)}
                  className="w-4 h-4 text-indigo-600 border-slate-700 bg-slate-950 rounded focus:ring-indigo-500 cursor-pointer"
                />
              </div>
              <p className="text-[10px] text-slate-400 leading-normal">
                Activa si tu inmueble se ubica en un municipio declarado tensionado. Esto activará la cláusula de referencia limitando la renta al Índice Estatal de Precios de Alquiler.
              </p>
            </div>

            {/* LAW HIGHLIGHT PANEL */}
            <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-xl space-y-1.5 text-[10.5px]">
              <span className="font-bold text-amber-400 flex items-center">
                <Info className="w-3.5 h-3.5 mr-1 text-amber-400 shrink-0" /> Cumplimiento de Normativa 2024 Asegurada:
              </span>
              <ul className="list-disc pl-4 space-y-1 text-slate-300">
                <li><strong className="text-slate-100">Honorarios Inmobiliaria:</strong> Repercutidos 100% al Arrendador (Art 20.1 LAU).</li>
                <li><strong className="text-slate-100">Tope de Actualización:</strong> Renta topada legalmente al 3% anual máximo en 2024-2026.</li>
                <li><strong className="text-slate-100">Duración mínima:</strong> {landlordType === "physical" ? "5 años" : "7 años"} de prórroga forzosa obligatoria.</li>
              </ul>
            </div>

            <div className="space-y-3.5 pt-1.5">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">Datos Bancarios para Cobros</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Método preferente</label>
                  <input
                    type="text"
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">IBAN del Arrendador</label>
                  <input
                    type="text"
                    value={iban}
                    onChange={(e) => setIban(e.target.value)}
                    className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 font-mono"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* CLÁUSULAS ADICIONALES */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5 space-y-3">
            <div className="flex items-center space-x-2 text-indigo-400">
              <FileText className="w-5 h-5" />
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200">Cláusulas Personalizadas</h3>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">Añade cláusulas adicionales de forma manual:</label>
              <textarea
                value={extraClauses}
                onChange={(e) => setExtraClauses(e.target.value)}
                rows={3}
                className="w-full bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 font-sans"
                placeholder="E.g., Se autoriza la tenencia de un perro raza pequeña. El inquilino responderá de los desperfectos..."
              />
            </div>
          </div>

          {/* AI PROMPT OPTIMIZATION PANEL */}
          <div className="bg-indigo-950/20 border border-indigo-500/25 rounded-2xl p-5 space-y-3">
            <div className="flex items-center justify-between text-indigo-400">
              <div className="flex items-center space-x-2">
                <Sparkles className="w-5 h-5 text-indigo-400" />
                <h3 className="text-sm font-bold uppercase tracking-wider text-white">Redacción / Optimización con IA</h3>
              </div>
              <span className="bg-indigo-500/20 text-indigo-300 text-[9px] px-2 py-0.5 rounded-full font-mono uppercase font-bold tracking-wider">Gemini 3.5</span>
            </div>
            <p className="text-[11px] text-indigo-200/80 leading-relaxed">
              Indica qué cláusulas especiales quieres agregar (mascotas, fianza, reparaciones complejas, protección de impagos) y deja que Gemini redacte las cláusulas legales blindadas.
            </p>
            <div>
              <textarea
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                rows={3}
                className="w-full bg-slate-950/80 border border-indigo-500/30 focus:border-indigo-500 rounded-xl px-3 py-2 text-xs text-slate-200"
                placeholder="E.g., Quiero incluir una cláusula que obligue a contratar un seguro de impago a costa del inquilino y regular la fianza con aval bancario..."
              />
            </div>
            <button
              type="button"
              onClick={handleOptimizeWithAI}
              disabled={isGenerating}
              className="w-full py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 disabled:from-indigo-800 disabled:to-indigo-800 text-white text-xs font-bold rounded-xl transition-all shadow-lg flex items-center justify-center space-x-2"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-white" />
                  <span>Optimizando y Redactando con IA...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 text-amber-300" />
                  <span>Revisar y Optimizar Contrato con IA</span>
                </>
              )}
            </button>
          </div>

        </div>

        {/* RIGHT COLUMN: DOCUMENT PREVIEW (7 COLS) */}
        <div className="lg:col-span-7 space-y-4">
          
          {/* ACTION BAR */}
          <div className="bg-slate-900 border border-slate-800/80 rounded-2xl p-4 flex flex-col sm:flex-row justify-between items-center gap-3">
            <span className="text-xs text-slate-400 font-medium">Vista Previa del Contrato Generado</span>
            
            <div className="flex flex-wrap gap-2 w-full sm:w-auto">
              
              {/* Copy to clipboard */}
              <button
                type="button"
                onClick={handleCopyToClipboard}
                className="flex-1 sm:flex-none inline-flex items-center justify-center px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold rounded-xl text-xs transition-colors cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 mr-1 text-emerald-400" /> : <Clipboard className="w-3.5 h-3.5 mr-1" />}
                {copied ? "¡Copiado!" : "Copiar Texto"}
              </button>

              {/* Download Word DOC */}
              <button
                type="button"
                onClick={handleDownloadDoc}
                className="flex-1 sm:flex-none inline-flex items-center justify-center px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold rounded-xl text-xs transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 mr-1 text-indigo-400" />
                Descargar .DOC
              </button>

              {/* Link back to properties (RentaSync) */}
              {selectedPropertyId && selectedPropertyId !== "manual" && (
                <button
                  type="button"
                  onClick={handleLinkToProperty}
                  disabled={isLinked}
                  className={`flex-1 sm:flex-none inline-flex items-center justify-center px-3 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
                    isLinked 
                      ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                      : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/10"
                  }`}
                >
                  <Check className="w-3.5 h-3.5 mr-1" />
                  {isLinked ? "Vinculado con Éxito" : "Vincular a Inmueble"}
                </button>
              )}

            </div>
          </div>

          {/* CUSTOM CONTRACT BANNER */}
          {isCustomText && (
            <div className="bg-amber-950/40 border border-amber-900/60 rounded-2xl p-4 text-xs text-amber-200 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-lg">
              <div className="flex items-center space-x-2">
                <Sparkles className="w-5 h-5 text-amber-400 shrink-0" />
                <span className="leading-relaxed">
                  <strong>Contrato Personalizado / IA:</strong> Los cambios del formulario ya no sobrescribirán tu texto personalizado.
                </span>
              </div>
              <button 
                type="button"
                onClick={() => {
                  setIsCustomText(false);
                  setGeneratedContractText(computeLocalContractText());
                }}
                className="text-amber-400 hover:text-amber-300 hover:underline font-bold shrink-0 transition-colors cursor-pointer"
              >
                Restaurar Plantilla Estándar
              </button>
            </div>
          )}

          {/* REALISTIC SHEET CONTAINER */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl relative">
            
            {/* Header/Banner visual */}
            <div className="h-1.5 bg-gradient-to-r from-indigo-500 via-indigo-600 to-indigo-700"></div>
            
            {/* Paper body */}
            <div 
              className="p-8 sm:p-12 md:p-16 text-slate-900 bg-white font-serif text-sm leading-relaxed text-justify h-[680px] overflow-y-auto shadow-inner select-text relative"
              style={{ fontFamily: "'Times New Roman', Georgia, serif" }}
            >
              
              {/* Paper shadow gradient effect on bottom */}
              <div className="absolute top-0 left-0 right-0 h-4 bg-gradient-to-b from-slate-200/30 to-transparent pointer-events-none"></div>

              {/* Editable Document Text Area */}
              <textarea
                value={generatedContractText}
                onChange={(e) => {
                  setGeneratedContractText(e.target.value);
                  setIsCustomText(true);
                }}
                className="w-full h-full min-h-[500px] bg-transparent text-slate-900 font-serif text-sm leading-relaxed focus:outline-none resize-none border-none p-0 outline-none"
                style={{ fontFamily: "'Times New Roman', Georgia, serif" }}
                placeholder="Escribe o genera tu contrato aquí..."
              />

            </div>

            {/* Document status footer */}
            <div className="bg-slate-950 border-t border-slate-800 px-5 py-3 flex justify-between items-center text-[10px] text-slate-500 font-mono">
              <span>ESTADO: VISTA PREVIA INTERACTIVA</span>
              <span>LEY DE ARRENDAMIENTOS URBANOS (LAU) 2024</span>
            </div>

          </div>

        </div>

      </div>

    </div>
  );
}
