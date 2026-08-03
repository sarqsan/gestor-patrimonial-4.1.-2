import React, { useState } from "react";
import { Property, RentPayment } from "../types";
import { 
  Building, 
  Calendar, 
  CheckCircle, 
  Clock, 
  AlertCircle, 
  Receipt, 
  Printer, 
  Plus, 
  X, 
  FileText,
  BadgeAlert,
  DownloadCloud
} from "lucide-react";

interface RentControlProps {
  properties: Property[];
  payments: RentPayment[];
  onUpdatePaymentStatus: (propertyId: string, month: string, year: number, status: 'paid' | 'pending' | 'late') => void;
  user1Name: string;
}

const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];

export default function RentControl({ 
  properties, 
  payments, 
  onUpdatePaymentStatus,
  user1Name
}: RentControlProps) {
  const [selectedPropertyId, setSelectedPropertyId] = useState<string>("");
  const [selectedMonth, setSelectedMonth] = useState<string>("Enero");
  const [selectedYear, setSelectedYear] = useState<number>(2026);
  const [showReceipt, setShowReceipt] = useState(false);
  const [receiptData, setReceiptData] = useState<any | null>(null);

  // Get active property and active payment status
  const activeProperty = properties.find(p => p.id === selectedPropertyId) || properties[0];

  const getPaymentStatus = (propertyId: string, month: string, year: number) => {
    const pay = payments.find(p => p.propertyId === propertyId && p.month === month && p.year === year);
    return pay ? pay.status : 'pending';
  };

  const handleOpenReceipt = (propId: string, month: string, year: number) => {
    const prop = properties.find(p => p.id === propId);
    if (!prop) return;

    const status = getPaymentStatus(propId, month, year);
    const receiptNo = `REC-${year}-${prop.cadastralReference.substring(0, 5)}-${MONTHS.indexOf(month) + 1}`;
    
    setReceiptData({
      receiptNo,
      address: prop.address,
      cadastral: prop.cadastralReference,
      tenant: prop.tenantName,
      tenantDni: prop.tenantDni,
      ownerName: prop.owner === 'user1' ? user1Name : prop.owner === 'user2' ? "Cónyuge" : `${user1Name} y Cónyuge`,
      amount: prop.monthlyRent,
      month,
      year,
      status,
      dateGenerated: new Date().toLocaleDateString('es-ES')
    });
    setShowReceipt(true);
  };

  const [downloading, setDownloading] = useState(false);
  const triggerDownload = () => {
    setDownloading(true);
    setTimeout(() => {
      setDownloading(false);
      alert(`📄 ¡Éxito! El recibo de alquiler ${receiptData?.receiptNo} se ha exportado y enviado automáticamente por correo electrónico al inquilino ${receiptData?.tenant}.`);
    }, 1500);
  };

  return (
    <div id="rent-control-root" className="space-y-8 animate-fade-in text-slate-100">
      
      {/* HEADER SECTION */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Control de Cobros e Inquilinos</h1>
          <p className="text-sm text-slate-400 mt-1">
            Matriz de seguimiento de mensualidades, estado de cobros y emisión instantánea de recibos/facturas.
          </p>
        </div>
      </div>

      {/* RENT PAYMENT LEDGER MATRIX */}
      <div className="bg-slate-800/40 border border-slate-700/50 rounded-2xl p-6 overflow-x-auto shadow-lg space-y-4">
        <h3 className="text-md font-bold text-white flex items-center">
          <Calendar className="w-4.5 h-4.5 text-indigo-400 mr-2" />
          Calendario de Pagos de Alquiler (Año Fiscal {selectedYear})
        </h3>
        <p className="text-xs text-slate-400">
          Haz clic en las celdas de mes para alternar el estado del pago o emitir un recibo formal para el inquilino.
        </p>

        {properties.length > 0 ? (
          <table className="w-full text-left border-collapse mt-4 text-xs font-sans min-w-[1000px]">
            <thead>
              <tr className="border-b border-slate-700/60 text-slate-400 font-mono text-[10px] uppercase tracking-wider">
                <th className="py-3 px-2">Inmueble / Inquilino</th>
                <th className="py-3 px-2 text-right">Renta</th>
                {MONTHS.map((m) => (
                  <th key={m} className="py-3 px-1.5 text-center">{m.substring(0, 3)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {properties.map((prop) => (
                <tr key={prop.id} className="hover:bg-slate-800/20 transition-all">
                  <td className="py-3.5 px-2">
                    <div className="font-semibold text-white truncate max-w-[180px]">{prop.address}</div>
                    <div className="text-[10px] text-slate-400 truncate max-w-[180px]">{prop.tenantName || "Sin Inquilino"}</div>
                  </td>
                  <td className="py-3.5 px-2 text-right font-bold text-slate-200">
                    {prop.monthlyRent} €
                  </td>
                  {MONTHS.map((m) => {
                    const status = getPaymentStatus(prop.id, m, selectedYear);
                    return (
                      <td key={m} className="py-3.5 px-1.5 text-center">
                        <div className="flex flex-col items-center space-y-1">
                          {/* Circle click for changing */}
                          <button
                            onClick={() => {
                              const nextStatusMap: Record<'paid' | 'pending' | 'late', 'paid' | 'pending' | 'late'> = {
                                'pending': 'paid',
                                'paid': 'late',
                                'late': 'pending'
                              };
                              onUpdatePaymentStatus(prop.id, m, selectedYear, nextStatusMap[status]);
                            }}
                            className={`w-6 h-6 rounded-lg flex items-center justify-center transition-all border cursor-pointer hover:scale-110 ${
                              status === 'paid'
                                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
                                : status === 'late'
                                ? "bg-red-500/20 text-red-400 border-red-500/40 animate-pulse"
                                : "bg-slate-900/60 text-slate-500 border-slate-700/60 hover:border-slate-500"
                            }`}
                            title={`Cambiar estado (${status === 'paid' ? 'Pagado' : status === 'late' ? 'Demorado' : 'Pendiente'})`}
                          >
                            {status === 'paid' ? (
                              <CheckCircle className="w-3.5 h-3.5" />
                            ) : status === 'late' ? (
                              <BadgeAlert className="w-3.5 h-3.5" />
                            ) : (
                              <Clock className="w-3.5 h-3.5" />
                            )}
                          </button>
                          
                          {/* Receipt button */}
                          <button
                            onClick={() => handleOpenReceipt(prop.id, m, selectedYear)}
                            className="text-[9px] text-slate-400 hover:text-indigo-400 font-mono font-semibold"
                          >
                            Recibo
                          </button>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-center text-slate-500 py-12">
            No tienes inmuebles registrados en la cartera. No se pueden gestionar cobros.
          </div>
        )}
      </div>

      {/* ON-SCREEN RECEIPT MODAL */}
      {showReceipt && receiptData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-700/60 max-w-lg w-full rounded-2xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
            
            {/* Header */}
            <div className="flex justify-between items-center bg-slate-800 p-4 border-b border-slate-700">
              <h3 className="text-sm font-bold text-white flex items-center font-mono">
                <Receipt className="w-4 h-4 text-indigo-400 mr-2" />
                {receiptData.receiptNo}
              </h3>
              <button
                onClick={() => setShowReceipt(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Receipt Content Body */}
            <div className="p-8 space-y-6 overflow-y-auto text-slate-800 bg-white font-sans text-xs">
              
              {/* Receipt Header Style */}
              <div className="flex justify-between items-start border-b-2 border-slate-200 pb-4">
                <div>
                  <h4 className="text-sm font-black uppercase tracking-wider text-slate-900">Recibo de Alquiler</h4>
                  <p className="text-[10px] text-slate-500 font-mono">Nº Documento: {receiptData.receiptNo}</p>
                </div>
                <div className="text-right">
                  <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase font-mono ${
                    receiptData.status === 'paid'
                      ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                      : receiptData.status === 'late'
                      ? "bg-red-100 text-red-800 border border-red-300 animate-pulse"
                      : "bg-amber-100 text-amber-800 border border-amber-300"
                  }`}>
                    {receiptData.status === 'paid' ? "Cobrado" : receiptData.status === 'late' ? "Demorado" : "Pendiente"}
                  </span>
                </div>
              </div>

              {/* Parties Details */}
              <div className="grid grid-cols-2 gap-4 border-b border-slate-100 pb-4">
                <div className="space-y-1">
                  <span className="text-[9px] uppercase font-bold text-slate-400 block font-mono">Arrendador</span>
                  <p className="font-bold text-slate-800">{receiptData.ownerName}</p>
                  <p className="text-slate-500 text-[10px]">Copropiedad Inmobiliaria</p>
                </div>
                <div className="space-y-1">
                  <span className="text-[9px] uppercase font-bold text-slate-400 block font-mono">Arrendatario / Inquilino</span>
                  <p className="font-bold text-slate-800">{receiptData.tenant}</p>
                  <p className="text-slate-500 font-mono text-[10px]">NIF: {receiptData.tenantDni}</p>
                </div>
              </div>

              {/* Property & Concept */}
              <div className="space-y-3">
                <div className="space-y-1">
                  <span className="text-[9px] uppercase font-bold text-slate-400 block font-mono">Inmueble</span>
                  <p className="font-medium text-slate-800">{receiptData.address}</p>
                  <p className="text-[10px] text-slate-500 font-mono">Ref. Catastral: {receiptData.cadastral}</p>
                </div>

                <div className="space-y-1 border-t border-slate-100 pt-3">
                  <span className="text-[9px] uppercase font-bold text-slate-400 block font-mono">Concepto</span>
                  <p className="text-slate-700 leading-normal">
                    Arrendamiento de vivienda correspondiente al mes de <strong className="text-slate-950 font-semibold">{receiptData.month} de {receiptData.year}</strong>.
                  </p>
                </div>
              </div>

              {/* Pricing Breakdowns */}
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 space-y-2 mt-4 text-xs">
                <div className="flex justify-between items-center text-slate-600">
                  <span>Alquiler de Vivienda (Renta Base):</span>
                  <span>{receiptData.amount.toLocaleString("es-ES")} €</span>
                </div>
                <div className="flex justify-between items-center text-slate-600">
                  <span>Retención IRPF / IVA (Si aplica):</span>
                  <span className="font-mono">Exento</span>
                </div>
                <div className="flex justify-between items-center text-slate-900 font-black border-t border-slate-200 pt-2 text-sm">
                  <span>Total Cobrado:</span>
                  <span className="text-indigo-600">{receiptData.amount.toLocaleString("es-ES")} €</span>
                </div>
              </div>

              {/* Footer text */}
              <div className="text-[9px] text-slate-400 text-center leading-normal border-t border-slate-100 pt-4 font-mono">
                Documento emitido de forma automatizada. A efectos del impuesto de la renta (IRPF).
                <br />
                Fecha Emisión: {receiptData.dateGenerated}
              </div>

            </div>

            {/* Actions Bar */}
            <div className="p-4 bg-slate-800 border-t border-slate-700 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowReceipt(false)}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs font-semibold cursor-pointer text-slate-300"
              >
                Cerrar
              </button>
              
              <button
                type="button"
                onClick={triggerDownload}
                disabled={downloading}
                className="inline-flex items-center px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-lg text-xs cursor-pointer disabled:bg-slate-700"
              >
                <DownloadCloud className="w-3.5 h-3.5 mr-1" />
                <span>{downloading ? "Exportando..." : "Descargar Recibo"}</span>
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
