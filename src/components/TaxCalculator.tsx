import React from "react";
import { AppState } from "../types";
import { 
  Calculator, 
  Percent, 
  HelpCircle, 
  ArrowUpRight, 
  Sliders, 
  CheckCircle,
  Lightbulb,
  DollarSign
} from "lucide-react";

interface TaxCalculatorProps {
  state: AppState;
}

export default function TaxCalculator({ state }: TaxCalculatorProps) {
  const { user1, user2, properties } = state;
  const activeYear = state.currentYear || 2026;
  const yearlyProfile = state.yearlyProfiles?.[activeYear];
  const activeUser1 = yearlyProfile?.user1 || user1;
  const activeUser2 = yearlyProfile?.user2 || user2;

  // 1. Calculate values for User 1
  let brutoAlquilerU1 = 0;
  let gastosU1 = 0;
  let amortizacionU1 = 0;

  // 2. Calculate values for User 2
  let brutoAlquilerU2 = 0;
  let gastosU2 = 0;
  let amortizacionU2 = 0;

  properties.forEach((prop) => {
    let brutoAlquiler = 0;
    let totalGastos = 0;
    let amort = 0;

    if (activeYear === 2025) {
      // For 2025, use default/extracted values from the tax return
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

    const pct1 = prop.ownershipPercentageUser1 / 100;
    const pct2 = prop.ownershipPercentageUser2 / 100;

    brutoAlquilerU1 += brutoAlquiler * pct1;
    gastosU1 += totalGastos * pct1;
    amortizacionU1 += amort * pct1;

    if (user2.hasPartner) {
      brutoAlquilerU2 += brutoAlquiler * pct2;
      gastosU2 += totalGastos * pct2;
      amortizacionU2 += amort * pct2;
    }
  });

  // Neto calculations (Neto = Bruto - Gastos - Amortizacion)
  const netoAlquilerU1 = Math.max(0, brutoAlquilerU1 - gastosU1 - amortizacionU1);
  const reduccionU1 = netoAlquilerU1 * 0.60;
  const imponibleAlquilerU1 = netoAlquilerU1 - reduccionU1;

  const netoAlquilerU2 = Math.max(0, brutoAlquilerU2 - gastosU2 - amortizacionU2);
  const reduccionU2 = netoAlquilerU2 * 0.60;
  const imponibleAlquilerU2 = netoAlquilerU2 - reduccionU2;

  // Joint calculations
  const brutoAlquilerConjunto = brutoAlquilerU1 + brutoAlquilerU2;
  const totalGastosConjunto = gastosU1 + gastosU2;
  const amortizacionConjunta = amortizacionU1 + amortizacionU2;
  const netoAlquilerConjunto = Math.max(0, brutoAlquilerConjunto - totalGastosConjunto - amortizacionConjunta);
  const reduccionConjunta = netoAlquilerConjunto * 0.60;
  const imponibleAlquilerConjunto = netoAlquilerConjunto - reduccionConjunta;

  // Work inputs
  const brutoTrabajoU1 = activeUser1.brutoTrabajo;
  const netoTrabajoU1 = activeUser1.netoTrabajo;
  
  const brutoTrabajoU2 = user2.hasPartner ? activeUser2.brutoTrabajo : 0;
  const netoTrabajoU2 = user2.hasPartner ? activeUser2.netoTrabajo : 0;

  const brutoTrabajoConjunto = brutoTrabajoU1 + brutoTrabajoU2;
  const netoTrabajoConjunto = netoTrabajoU1 + netoTrabajoU2;

  // Base imponible general estimate
  const baseImponibleU1 = netoTrabajoU1 + imponibleAlquilerU1;
  const baseImponibleU2 = netoTrabajoU2 + imponibleAlquilerU2;
  const baseImponibleConjuntaSeparada = baseImponibleU1 + baseImponibleU2;

  // Joint filing includes a 3.400 € deduction in Spain for married couples
  const deduccionMatrimonioConjunta = 3400;
  const baseImponibleConjuntaReal = Math.max(0, (netoTrabajoConjunto + imponibleAlquilerConjunto) - deduccionMatrimonioConjunta);

  // Estimate general Spanish taxes (simplified marginal scale)
  const estimateTax = (base: number) => {
    if (base <= 12450) return base * 0.19;
    if (base <= 20200) return 12450 * 0.19 + (base - 12450) * 0.24;
    if (base <= 35200) return 12450 * 0.19 + 7750 * 0.24 + (base - 20200) * 0.30;
    if (base <= 60000) return 12450 * 0.19 + 7750 * 0.24 + 15000 * 0.30 + (base - 35200) * 0.37;
    return 12450 * 0.19 + 7750 * 0.24 + 15000 * 0.30 + 24800 * 0.37 + (base - 60000) * 0.45;
  };

  const cuotaU1 = estimateTax(baseImponibleU1);
  const cuotaU2 = user2.hasPartner ? estimateTax(baseImponibleU2) : 0;
  const totalCuotaSeparada = cuotaU1 + cuotaU2;

  const totalCuotaConjunta = user2.hasPartner ? estimateTax(baseImponibleConjuntaReal) : cuotaU1;

  const convieneConjunta = totalCuotaConjunta < totalCuotaSeparada;
  const diferenciaAhorro = Math.abs(totalCuotaSeparada - totalCuotaConjunta);

  return (
    <div id="tax-calculator-root" className="space-y-8 animate-fade-in text-slate-100">
      
      {/* HEADER SECTION */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Simulador Fiscal e Impuestos (IRPF {activeYear})</h1>
          <p className="text-sm text-slate-400 mt-1">
            Simulador del Modelo 100 de IRPF para estimar deducciones, la reducción por alquiler habitual y optimizar tu declaración.
          </p>
        </div>
      </div>

      {/* INTELLIGENT RECOMMENDATION CARD */}
      {user2.hasPartner && (
        <div className={`p-6 rounded-2xl border flex flex-col md:flex-row items-start md:items-center space-y-4 md:space-y-0 md:space-x-4 shadow-xl ${
          convieneConjunta 
            ? "bg-indigo-950/20 border-indigo-500/40 text-indigo-200"
            : "bg-emerald-950/20 border-emerald-500/40 text-emerald-200"
        }`}>
          <div className={`p-3 rounded-xl shrink-0 ${
            convieneConjunta ? "bg-indigo-600/20 text-indigo-400" : "bg-emerald-600/20 text-emerald-400"
          }`}>
            <Lightbulb className="w-6 h-6 animate-pulse" />
          </div>
          <div className="flex-1">
            <h4 className="text-sm font-bold text-white uppercase font-mono tracking-wider">💡 Recomendación de Optimización Fiscal</h4>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              De acuerdo con las rentas del trabajo e ingresos de alquiler integrados, os conviene realizar la declaración {" "}
              <strong className="text-white font-black uppercase text-xs">{convieneConjunta ? "CONJUNTA" : "INDIVIDUAL (por separado)"}</strong>.
              Este régimen optimiza los tramos de renta marginal y reduce el impacto tributario.
            </p>
            <div className="mt-2.5 inline-flex items-center text-xs font-bold font-mono">
              <span>Ahorro fiscal anual estimado:</span>
              <span className={`ml-1.5 text-sm font-black underline ${convieneConjunta ? "text-indigo-400" : "text-emerald-400"}`}>
                {diferenciaAhorro.toLocaleString("es-ES", { maximumFractionDigits: 2 })} €
              </span>
            </div>
          </div>
        </div>
      )}

      {/* WORKSHEET TABLE SPREADSHEET */}
      <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 shadow-lg overflow-x-auto">
        <h3 className="text-md font-bold text-white flex items-center mb-6">
          <Calculator className="w-5 h-5 text-indigo-400 mr-2" />
          Desglose Fiscal Consolidado (IRPF Modelo 100)
        </h3>

        <table className="w-full text-left text-xs font-sans min-w-[700px]">
          <thead>
            <tr className="border-b border-slate-700/80 text-slate-400 font-mono text-[9px] uppercase tracking-wider">
              <th className="py-3 px-2">Concepto Imponible</th>
              <th className="py-3 px-2 text-right">{user1.name.split(" ")[0]} (U1)</th>
              {user2.hasPartner && (
                <>
                  <th className="py-3 px-2 text-right">{user2.name.split(" ")[0]} (U2)</th>
                  <th className="py-3 px-2 text-right bg-slate-900/30">Declaración Conjunta</th>
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 font-medium">
            
            {/* INMUEBLES */}
            <tr>
              <td className="py-3.5 px-2 text-slate-200 font-semibold">(+) Ingresos Brutos de Alquiler</td>
              <td className="py-3.5 px-2 text-right text-slate-300">{brutoAlquilerU1.toLocaleString("es-ES")} €</td>
              {user2.hasPartner && (
                <>
                  <td className="py-3.5 px-2 text-right text-slate-300">{brutoAlquilerU2.toLocaleString("es-ES")} €</td>
                  <td className="py-3.5 px-2 text-right text-white font-bold bg-slate-900/20">{brutoAlquilerConjunto.toLocaleString("es-ES")} €</td>
                </>
              )}
            </tr>

            <tr className="text-slate-400">
              <td className="py-3 px-2 pl-4">(-) Gastos Deducibles (IBI, Seguro, Comunidad)</td>
              <td className="py-3 px-2 text-right text-red-400">-{gastosU1.toLocaleString("es-ES")} €</td>
              {user2.hasPartner && (
                <>
                  <td className="py-3 px-2 text-right text-red-400">-{gastosU2.toLocaleString("es-ES")} €</td>
                  <td className="py-3 px-2 text-right text-red-400 bg-slate-900/20">-{totalGastosConjunto.toLocaleString("es-ES")} €</td>
                </>
              )}
            </tr>

            <tr className="text-slate-400">
              <td className="py-3 px-2 pl-4">(-) Amortización Deducible (3% Construcción)</td>
              <td className="py-3 px-2 text-right text-red-400">-{amortizacionU1.toLocaleString("es-ES")} €</td>
              {user2.hasPartner && (
                <>
                  <td className="py-3 px-2 text-right text-red-400">-{amortizacionU2.toLocaleString("es-ES")} €</td>
                  <td className="py-3 px-2 text-right text-red-400 bg-slate-900/20">-{amortizacionConjunta.toLocaleString("es-ES")} €</td>
                </>
              )}
            </tr>

            <tr className="bg-slate-900/10 font-bold">
              <td className="py-3 px-2 text-slate-200">(=) Rendimiento Neto Capital Inmobiliario</td>
              <td className="py-3 px-2 text-right text-indigo-300">{netoAlquilerU1.toLocaleString("es-ES")} €</td>
              {user2.hasPartner && (
                <>
                  <td className="py-3 px-2 text-right text-indigo-300">{netoAlquilerU2.toLocaleString("es-ES")} €</td>
                  <td className="py-3 px-2 text-right text-indigo-300 bg-slate-900/20">{netoAlquilerConjunto.toLocaleString("es-ES")} €</td>
                </>
              )}
            </tr>

            <tr className="text-slate-400">
              <td className="py-3 px-2 pl-4">(-) Reducción del 60% por Arrendamiento Habitual</td>
              <td className="py-3 px-2 text-right text-emerald-400">-{reduccionU1.toLocaleString("es-ES")} €</td>
              {user2.hasPartner && (
                <>
                  <td className="py-3 px-2 text-right text-emerald-400">-{reduccionU2.toLocaleString("es-ES")} €</td>
                  <td className="py-3 px-2 text-right text-emerald-400 bg-slate-900/20">-{reduccionConjunta.toLocaleString("es-ES")} €</td>
                </>
              )}
            </tr>

            <tr className="bg-slate-900/20 font-black">
              <td className="py-3.5 px-2 text-slate-100 font-extrabold">(=) Rendimiento Neto Reducido Integrable</td>
              <td className="py-3.5 px-2 text-right text-emerald-400">{imponibleAlquilerU1.toLocaleString("es-ES")} €</td>
              {user2.hasPartner && (
                <>
                  <td className="py-3.5 px-2 text-right text-emerald-400">{imponibleAlquilerU2.toLocaleString("es-ES")} €</td>
                  <td className="py-3.5 px-2 text-right text-emerald-400 bg-slate-900/30">{imponibleAlquilerConjunto.toLocaleString("es-ES")} €</td>
                </>
              )}
            </tr>

            {/* TRABAJO */}
            <tr className="border-t border-slate-700/60 font-semibold">
              <td className="py-3.5 px-2 text-slate-200">(+) Rendimiento Neto de Trabajo</td>
              <td className="py-3.5 px-2 text-right text-slate-300">{netoTrabajoU1.toLocaleString("es-ES")} €</td>
              {user2.hasPartner && (
                <>
                  <td className="py-3.5 px-2 text-right text-slate-300">{netoTrabajoU2.toLocaleString("es-ES")} €</td>
                  <td className="py-3.5 px-2 text-right text-white font-bold bg-slate-900/20">{netoTrabajoConjunto.toLocaleString("es-ES")} €</td>
                </>
              )}
            </tr>

            {/* INTEGRACIÓN */}
            <tr className="border-t-2 border-slate-700 font-black text-sm bg-slate-900/40">
              <td className="py-4 px-2 text-white">Base Imponible General Estimada</td>
              <td className="py-4 px-2 text-right text-indigo-300">{baseImponibleU1.toLocaleString("es-ES")} €</td>
              {user2.hasPartner && (
                <>
                  <td className="py-4 px-2 text-right text-pink-300">{baseImponibleU2.toLocaleString("es-ES")} €</td>
                  <td className="py-4 px-2 text-right text-emerald-400 bg-slate-900/60">{baseImponibleConjuntaReal.toLocaleString("es-ES")} €</td>
                </>
              )}
            </tr>

            {/* ESTIMATED CUOTA */}
            <tr className="font-bold border-t border-slate-700">
              <td className="py-3.5 px-2 text-slate-300">Estimación Cuota de IRPF (Carga Fiscal)</td>
              <td className="py-3.5 px-2 text-right text-red-300">{cuotaU1.toLocaleString("es-ES", { maximumFractionDigits: 2 })} €</td>
              {user2.hasPartner && (
                <>
                  <td className="py-3.5 px-2 text-right text-red-300">{cuotaU2.toLocaleString("es-ES", { maximumFractionDigits: 2 })} €</td>
                  <td className="py-3.5 px-2 text-right text-red-300 bg-slate-900/40 font-black">{totalCuotaConjunta.toLocaleString("es-ES", { maximumFractionDigits: 2 })} €</td>
                </>
              )}
            </tr>

          </tbody>
        </table>

        <div className="mt-6 p-4 bg-slate-900/40 border border-slate-800 rounded-xl text-[11px] text-slate-400 leading-normal space-y-1.5 font-mono">
          <div>* Los gastos registrados manualmente en la sección de <strong>Gastos de Alquiler</strong> se integran automáticamente en la base imponible reduciendo tu cuota de IRPF.</div>
          {user2.hasPartner && (
            <>
              <div>* La declaración Conjunta aplica una reducción fiscal fija de <strong>3.400 €</strong> por unidad familiar.</div>
            </>
          )}
          <div>* La estimación de cuota de IRPF se calcula utilizando las escalas de gravamen general estatal y autonómica simplificadas de España.</div>
        </div>
      </div>

    </div>
  );
}
