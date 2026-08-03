import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import * as XLSX from "xlsx";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lazy initialization of the Gemini API Client
let aiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("La clave GEMINI_API_KEY no está configurada. Por favor, añádela en la sección de Secrets.");
    }
    aiClient = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// Robust retry helper with exponential backoff and model fallback to handle 503 high demand
async function generateContentWithRetry(
  contents: any[],
  config: any,
  initialModel: string = "gemini-2.5-flash"
): Promise<any> {
  const modelsToTry = [initialModel, "gemini-2.5-flash"];
  let lastError: any = null;

  for (const modelName of modelsToTry) {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Gemini API] Attempting generateContent with ${modelName} (attempt ${attempt}/${maxRetries})...`);
        const ai = getGeminiClient();
        const response = await ai.models.generateContent({
          model: modelName,
          contents,
          config,
        });
        console.log(`[Gemini API] Success using model ${modelName} on attempt ${attempt}`);
        return response;
      } catch (err: any) {
        lastError = err;
        console.warn(`[Gemini API] Error with ${modelName} on attempt ${attempt}:`, err.message || err);
        
        // Wait with exponential backoff before next attempt within the same model
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 800 + Math.random() * 400;
          console.log(`[Gemini API] Retrying in ${delay.toFixed(0)}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    console.log(`[Gemini API] Model ${modelName} failed all ${maxRetries} attempts. Trying fallback model if available...`);
  }

  throw lastError || new Error("No se pudo conectar con los modelos de IA de Gemini tras varios intentos.");
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Middleware for JSON payloads
  app.use(express.json({ limit: "10mb" }));

  // API Route: Extract tax declaration details using Gemini 3.5 Flash
  app.post("/api/extract", async (req, res) => {
    try {
      const { 
        text1, fileData1, mimeType1, 
        text2, fileData2, mimeType2,
        propertiesFileData, propertiesFileMime, propertiesFileName 
      } = req.body;
      
      if (!text1 && (!fileData1 || !mimeType1) && !text2 && (!fileData2 || !mimeType2) && (!propertiesFileData || !propertiesFileMime)) {
        res.status(400).json({ error: "Debe proporcionar al menos un documento: Declaración 1, Declaración 2 o Listado de Inmuebles." });
        return;
      }

      const systemPrompt = `Eres un experto fiscal de la Agencia Tributaria Española (AEAT).
Tu tarea es analizar la declaración de la renta de España (IRPF) (que puede ser del Contribuyente 1, del Contribuyente 2 o conjunta) y/o el documento de listado de inmuebles adjunto (que puede ser en formato texto, un documento PDF oficial o un listado Excel parseado) de uno o dos contribuyentes (pareja/cónyuges) y extraer TODA la información relevante sobre sus rentas del trabajo y sus inmuebles arrendados.

REGLAS DE EXTRACCIÓN SENSATAS:
1. Identifica al Contribuyente Principal (User 1) y al Cónyuge (User 2) si existe en los documentos. Si se encuentra información del cónyuge (User 2), establece hasPartner = true y extrae su nombre, DNI, ingresos brutos y netos de trabajo. Si no se menciona cónyuge, establece hasPartner = false.
2. Si se proporciona un archivo de inmuebles adicional (que puede ser texto parseado de un Excel, un PDF o CSV), este suele contener datos desglosados y más detallados sobre los inmuebles (tales como dirección, referencia catastral, inquilinos, DNI del inquilino, renta mensual, precio de adquisición o gastos de comunidad, IBI, seguros, etc.). Cruza y combina la información de todos los archivos proporcionados de forma inteligente. Si un inmueble se menciona en varios de los documentos adjuntos, consolídalo en un solo objeto sin duplicarlo, quedándote con los datos más detallados y completos de cada campo (por ejemplo, si en la declaración aparece el importe de alquiler total y en el listado de inmuebles aparecen los inquilinos con sus NIFs y gastos, combínalos!).
3. Extrae la información detallada de cada inmueble arrendado:
   - Dirección completa (address).
   - Referencia catastral (cadastralReference).
   - Propietario (owner): puede ser 'user1', 'user2' o 'both' (si se comparte).
   - Porcentajes de titularidad (ownershipPercentageUser1 y ownershipPercentageUser2) basados en el texto o documento. Si es de 'user1' es 100 y 0, si es de 'user2' es 0 y 100, si es compartido suele ser 50 y 50.
   - Nombre de los inquilinos (tenantName): Extrae los nombres de TODOS los inquilinos/arrendatarios de ese inmueble. Si hay varios en el documento, concaténalos todos separados por comas (ej. 'Juan Pérez García, María López Fernández').
   - NIF/DNI de los inquilinos (tenantDni): Extrae los DNI/NIF de TODOS los inquilinos de ese inmueble. Si hay varios en el documento, concaténalos todos separados por comas en el mismo orden que los nombres (ej. '12345678Z, 87654321X').
   - Cuantía de alquiler percibido anual o mensual (monthlyRent): Extrae la cantidad exactamente tal como aparece escrita físicamente en el documento para ese inmueble. Si es anual, divídelo por 12 para calcular el alquiler mensual estimado.
   - Precio de compra del inmueble / valor de adquisición (purchasePrice). Si no se detalla, haz una estimación sensata basada en las amortizaciones o pon un valor estimado razonable (e.g., 150000).
   - Porcentaje del valor catastral correspondiente al suelo (landValuePercent): suele oscilar entre 20% y 30%. Si no se especifica, por defecto pon 25.
   - Importe de amortización anual (amortizationAmount): usa el del texto o estima el 3% del valor de construcción.
   - Gastos deducibles como comunidad, IBI, seguros, reparaciones, etc. desglosados anuales o consolidados. Extrae los valores tal como aparecen escritos.
   - CRITICAL: Si el inmueble es de titularidad compartida (owner = 'both' o porcentajes < 100%) y los importes financieros correspondientes (alquiler, gastos, amortización, precio de compra) que aparecen en la declaración están prorrateados al porcentaje de participación (ej. 50%), DEBES calcular y devolver los importes normalizados al 100% de la capacidad de ese inmueble (es decir, el valor total absoluto del inmueble entero). La aplicación gestionará el inmueble al 100% y aplicará los repartos después de forma interna.
4. Devuelve un objeto JSON estructurado que siga el esquema exacto proporcionado.`;

      const contents: any[] = [{ text: systemPrompt }];

      // 1. Process and add Tax return 1 file if present
      if (fileData1 && mimeType1) {
        contents.push({ text: "--- DOCUMENTO 1: DECLARACIÓN RENTA USUARIO 1 (PDF) ---" });
        contents.push({
          inlineData: {
            mimeType: mimeType1,
            data: fileData1
          }
        });
      } else if (text1) {
        contents.push({ text: `--- DOCUMENTO 1: TEXTO RENTA USUARIO 1 ---\n\n${text1}` });
      }

      // 2. Process and add Tax return 2 file if present
      if (fileData2 && mimeType2) {
        contents.push({ text: "--- DOCUMENTO 2: DECLARACIÓN RENTA USUARIO 2 (PDF) ---" });
        contents.push({
          inlineData: {
            mimeType: mimeType2,
            data: fileData2
          }
        });
      } else if (text2) {
        contents.push({ text: `--- DOCUMENTO 2: TEXTO RENTA USUARIO 2 ---\n\n${text2}` });
      }

      // 3. Process and add Properties file if present
      if (propertiesFileData && propertiesFileMime) {
        const isExcel = propertiesFileMime.includes("sheet") || 
                        propertiesFileMime.includes("excel") || 
                        propertiesFileMime.includes("spreadsheetml") ||
                        (propertiesFileName && (propertiesFileName.toLowerCase().endsWith(".xlsx") || propertiesFileName.toLowerCase().endsWith(".xls")));
        
        if (isExcel) {
          try {
            console.log(`[Excel Parser] Parsing properties spreadsheet ${propertiesFileName}`);
            const buffer = Buffer.from(propertiesFileData, "base64");
            const workbook = XLSX.read(buffer, { type: "buffer" });
            const sheetTexts: string[] = [];
            for (const sheetName of workbook.SheetNames) {
              const worksheet = workbook.Sheets[sheetName];
              const csv = XLSX.utils.sheet_to_csv(worksheet);
              sheetTexts.push(`Hoja: ${sheetName}\n${csv}`);
            }
            const excelText = sheetTexts.join("\n\n---\n\n");
            contents.push({ text: `--- DOCUMENTO 3: DATOS DE INMUEBLES (EXCEL PARSEADO A CSV) ---\n\n${excelText}` });
          } catch (excelErr: any) {
            console.error("Error parsing Excel on server:", excelErr);
            contents.push({ text: `[Error leyendo Excel: ${excelErr.message}]` });
          }
        } else if (propertiesFileMime === "application/pdf") {
          contents.push({ text: "--- DOCUMENTO 3: DATOS DE INMUEBLES (PDF) ---" });
          contents.push({
            inlineData: {
              mimeType: "application/pdf",
              data: propertiesFileData
            }
          });
        } else {
          // Plain Text/CSV properties file
          const plainText = Buffer.from(propertiesFileData, "base64").toString("utf-8");
          contents.push({ text: `--- DOCUMENTO 3: DATOS DE INMUEBLES (TEXTO/CSV) ---\n\n${plainText}` });
        }
      }

      const response = await generateContentWithRetry(
        contents,
        {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              user1: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING, description: "Nombre completo del Contribuyente 1" },
                  dni: { type: Type.STRING, description: "DNI o NIF del Contribuyente 1" },
                  brutoTrabajo: { type: Type.NUMBER, description: "Rendimientos íntegros del trabajo anuales (bruto) de User 1" },
                  netoTrabajo: { type: Type.NUMBER, description: "Rendimiento neto de trabajo anual de User 1" }
                },
                required: ["name", "dni", "brutoTrabajo", "netoTrabajo"]
              },
              user2: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING, description: "Nombre completo del Contribuyente 2 (Cónyuge)" },
                  dni: { type: Type.STRING, description: "DNI o NIF del Contribuyente 2" },
                  brutoTrabajo: { type: Type.NUMBER, description: "Rendimientos íntegros del trabajo anuales (bruto) de User 2" },
                  netoTrabajo: { type: Type.NUMBER, description: "Rendimiento neto de trabajo anual de User 2" },
                  hasPartner: { type: Type.BOOLEAN, description: "Indica si se ha detectado cónyuge o pareja en el documento" }
                },
                required: ["name", "dni", "brutoTrabajo", "netoTrabajo", "hasPartner"]
              },
              properties: {
                type: Type.ARRAY,
                description: "Lista de todos los inmuebles arrendados detectados",
                items: {
                  type: Type.OBJECT,
                  properties: {
                    address: { type: Type.STRING, description: "Dirección o emplazamiento del inmueble" },
                    cadastralReference: { type: Type.STRING, description: "Referencia Catastral (20 caracteres)" },
                    owner: { type: Type.STRING, description: "Quién es el dueño: 'user1', 'user2' o 'both'" },
                    ownershipPercentageUser1: { type: Type.NUMBER, description: "Porcentaje de propiedad del Contribuyente 1 (0-100)" },
                    ownershipPercentageUser2: { type: Type.NUMBER, description: "Porcentaje de propiedad del Contribuyente 2 / Cónyuge (0-100)" },
                    tenantName: { type: Type.STRING, description: "Nombres completos de TODOS los inquilinos, separados por comas (ej. 'Juan Pérez, María Gómez')" },
                    tenantDni: { type: Type.STRING, description: "NIF/DNI de TODOS los inquilinos, en el mismo orden y separados por comas (ej. '12345678Z, 87654321X')" },
                    monthlyRent: { type: Type.NUMBER, description: "Importe del alquiler mensual (si es anual, divídelo entre 12)" },
                    purchasePrice: { type: Type.NUMBER, description: "Precio de compra o coste de adquisición del inmueble" },
                    landValuePercent: { type: Type.NUMBER, description: "Porcentaje catastral asignado al suelo (habitualmente entre 20% y 30%). Por defecto 25" },
                    amortizationAmount: { type: Type.NUMBER, description: "Importe de amortización deducible anual (usar el del texto o estimar el 3% del valor de construcción)" },
                    expensesCommunity: { type: Type.NUMBER, description: "Gastos anuales estimados de comunidad" },
                    expensesIBI: { type: Type.NUMBER, description: "Gastos anuales estimados de IBI (Impuesto de Bienes Inmuebles)" },
                    expensesInsurance: { type: Type.NUMBER, description: "Gastos anuales de seguro de hogar / impago" },
                    expensesRepairs: { type: Type.NUMBER, description: "Gastos anuales de mantenimiento o reparaciones" }
                  },
                  required: ["address", "cadastralReference", "owner", "tenantName", "tenantDni", "monthlyRent", "purchasePrice", "landValuePercent", "amortizationAmount"]
                }
              }
            },
            required: ["user1", "user2", "properties"]
          }
        },
        "gemini-2.5-flash"
      );

      const textOutput = response.text;
      if (!textOutput) {
        throw new Error("No se pudo obtener una respuesta válida del modelo Gemini.");
      }

      const parsedData = JSON.parse(textOutput);
      res.json(parsedData);
    } catch (error: any) {
      console.error("Extraction error:", error);
      res.status(500).json({ error: error.message || "Error al procesar los documentos." });
    }
  });

  // API Route: Extract details from a receipt/invoice photo or PDF using Gemini 3.5 Flash
  app.post("/api/extract-invoice", async (req, res) => {
    try {
      const { fileData, mimeType } = req.body;
      
      if (!fileData || !mimeType) {
        res.status(400).json({ error: "Debe proporcionar el archivo de factura o recibo (imagen o PDF) codificado en Base64." });
        return;
      }

      const systemPrompt = `Eres un experto fiscal de la Agencia Tributaria Española (AEAT).
Tu tarea es analizar la imagen o PDF de una factura, recibo o comprobante de un gasto relacionado con una propiedad en alquiler, y extraer de forma extremadamente precisa la información necesaria para integrarla en la contabilidad fiscal del propietario.

Debes categorizar el gasto de forma inteligente de acuerdo con las siguientes categorías oficiales españolas de IRPF:
- 'repairs' (reparaciones y conservación de la vivienda: fontanero, pintor, averías, reformas de mantenimiento).
- 'ibi' (tributos y recargos: IBI, tasa de basuras, vados, etc.).
- 'insurance' (primas de contratos de seguro: hogar, responsabilidad civil, seguro de impago de alquiler).
- 'community' (gastos de comunidad: cuotas ordinarias y extraordinarias de la comunidad de propietarios).
- 'maintenance' (servicios de mantenimiento de instalaciones, limpieza, suministros de agua, luz, gas, calefacción si los abona el propietario).
- 'other' (cualquier otro gasto deducible: honorarios de la inmobiliaria o gestoría por el contrato, intereses de préstamos de compra, etc.).

Devuelve los importes como números decimales y las fechas en formato YYYY-MM-DD.`;

      const contents: any[] = [
        { text: systemPrompt },
        { text: "--- DOCUMENTO DE RECIBO/FACTURA ---" },
        {
          inlineData: {
            mimeType: mimeType,
            data: fileData
          }
        }
      ];

      const response = await generateContentWithRetry(
        contents,
        {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              amount: { type: Type.NUMBER, description: "Importe total del recibo o factura con decimales (float)." },
              date: { type: Type.STRING, description: "Fecha de emisión del recibo/factura en formato YYYY-MM-DD." },
              nif: { type: Type.STRING, description: "NIF/CIF o DNI del emisor o proveedor de la factura." },
              description: { type: Type.STRING, description: "Concepto o nombre del proveedor de forma resumida." },
              category: { 
                type: Type.STRING, 
                description: "Categoría fiscal exacta del gasto. Debe ser una de las siguientes opciones: 'repairs', 'ibi', 'insurance', 'community', 'maintenance', 'other'." 
              }
            },
            required: ["amount", "date", "description", "category"]
          }
        },
        "gemini-2.5-flash"
      );

      const textOutput = response.text;
      if (!textOutput) {
        throw new Error("No se pudo obtener una respuesta del modelo Gemini para la factura.");
      }

      const parsedData = JSON.parse(textOutput);
      res.json(parsedData);
    } catch (error: any) {
      console.error("Invoice extraction error:", error);
      res.status(500).json({ error: error.message || "Error al procesar la factura con Gemini." });
    }
  });

  // API Route: Generate and Optimize rental contract clauses with Gemini 3.5 Flash
  app.post("/api/optimize-contract", async (req, res) => {
    try {
      const { contractContext, customPrompt } = req.body;
      if (!customPrompt) {
        res.status(400).json({ error: "Debe proporcionar condiciones de contrato y prompts de optimización." });
        return;
      }

      console.log("[server] Optimizing contract with Gemini AI...");
      
      const response = await generateContentWithRetry(
        [{ text: customPrompt }],
        {
          responseMimeType: "text/plain",
        },
        "gemini-2.5-flash"
      );

      const contractText = response.text;
      if (!contractText) {
        throw new Error("No se pudo generar el texto del contrato.");
      }

      res.json({ text: contractText });
    } catch (error: any) {
      console.error("Contract optimization error:", error);
      res.status(500).json({ error: error.message || "Error al optimizar el contrato con Gemini." });
    }
  });

  // Health route
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // Serve static assets or use Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
