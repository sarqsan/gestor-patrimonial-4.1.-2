export interface SampleTaxDeclaration {
  id: string;
  title: string;
  description: string;
  rawText: string;
}

export const SAMPLE_DECLARATIONS: SampleTaxDeclaration[] = [
  {
    id: "individual_juan",
    title: "Declaración Individual - Juan García (Propietario 1)",
    description: "Declaración individual de Juan con 1 piso de alquiler en Madrid y rendimiento del trabajo de 36.200€ brutos.",
    rawText: `MINISTERIO DE HACIENDA - AGENCIA TRIBUTARIA
DECLARACIÓN DEL IMPUESTO SOBRE LA RENTA DE LAS PERSONAS FÍSICAS (IRPF)
EJERCICIO FISCAL: 2024
MODALIDAD: INDIVIDUAL

DATOS DEL CONTRIBUYENTE:
Primer Apellido: GARCÍA
Segundo Apellido: GARCÍA
Nombre: JUAN
NIF / DNI: 12345678A
Estado Civil: Casado

DATOS DEL CÓNYUGE:
Primer Apellido: LÓPEZ
Segundo Apellido: RUIZ
Nombre: MARÍA
NIF / DNI: 87654321K

RENDIMIENTOS DEL TRABAJO:
- Rendimientos íntegros (Sueldo Bruto anual): 36.200,00 €
- Cotizaciones a la Seguridad Social: 2.100,00 €
- Retenciones de IRPF practicadas: 5.400,00 €
- Rendimiento neto de trabajo: 31.800,00 €

RENDIMIENTOS DEL CAPITAL INMOBILIARIO (ALQUILERES):
Inmueble Arrendado Destinado a Vivienda:
- Emplazamiento: Calle de Alcalá 140, 3ºB, 28009 Madrid
- Referencia Catastral: 9872301VK4797S0003TR
- Ingresos íntegros del alquiler (Renta bruta percibida): 11.400,00 € (Representa 950,00 € mensuales)
- NIF del Arrendatario (Inquilino): 87654321B
- Nombre del Arrendatario: CARLOS MENDOZA SOLER
- Gastos deducibles de administración, comunidad y seguro: 1.250,00 €
- Gastos de reparaciones y conservación: 450,00 €
- Valor de adquisición del inmueble (Precio de compra): 180.000,00 €
- Porcentaje del valor del suelo en el catastro: 25 % (Valor construcción computable: 135.000,00 €)
- Amortización del inmueble (3% sobre coste de construcción): 4.050,00 €
- Rendimiento neto del capital inmobiliario: 5.650,00 €
- Reducción aplicable del 60% por arrendamiento de vivienda habitual: 3.390,00 €
- Rendimiento neto reducido final: 2.260,00 €`
  },
  {
    id: "pareja_conjunta",
    title: "Declaración Conjunta - Juan y María (Pareja)",
    description: "Declaración conjunta que incluye 3 inmuebles: uno de Juan, uno de María y otro comprado al 50% por ambos.",
    rawText: `MINISTERIO DE HACIENDA - AGENCIA TRIBUTARIA
DECLARACIÓN DEL IMPUESTO SOBRE LA RENTA DE LAS PERSONAS FÍSICAS (IRPF)
EJERCICIO FISCAL: 2024
MODALIDAD: CONJUNTA

DATOS DEL PRIMER DECLARANTE (CONTRIBUYENTE 1):
Nombre completo: JUAN GARCÍA GARCÍA
NIF / DNI: 12345678A
Sueldo bruto anual del trabajo (Contribuyente 1): 36.200,00 €
Sueldo neto anual del trabajo (Contribuyente 1): 31.800,00 €

DATOS DEL SEGUNDO DECLARANTE (CONTRIBUYENTE 2 / CÓNYUGE):
Nombre completo: MARÍA LÓPEZ RUIZ
NIF / DNI: 87654321K
Sueldo bruto anual del trabajo (Contribuyente 2): 29.500,00 €
Sueldo neto anual del trabajo (Contribuyente 2): 25.100,00 €

INVENTARIO DE INMUEBLES URBANOS EN ARRENDAMIENTO:

INMUEBLE 1:
- Dirección: Calle de Alcalá 140, 3ºB, Madrid
- Referencia Catastral: 9872301VK4797S0003TR
- Titularidad: 100% JUAN GARCÍA GARCÍA
- Nombre del Inquilino: CARLOS MENDOZA SOLER
- NIF Inquilino: 87654321B
- Cuantía de alquiler percibido: 11.400,00 € (950 €/mes)
- Precio de compra del inmueble: 180.000,00 €
- Porcentaje de amortización: 3% sobre valor de edificación (75% del precio de compra)
- Importe amortización calculada: 4.050,00 €
- Gastos deducibles (Comunidad, IBI, Seguros): 1.500,00 €

INMUEBLE 2:
- Dirección: Avenida de la Constitución 12, Sevilla
- Referencia Catastral: 1234502SF8821N0012UY
- Titularidad: 50% JUAN GARCÍA GARCÍA y 50% MARÍA LÓPEZ RUIZ
- Nombre del Inquilino: LUCÍA BELMONTE PÉREZ
- NIF Inquilino: 76543210C
- Cuantía de alquiler percibido: 8.400,00 € (700 €/mes)
- Precio de compra del inmueble: 140.000,00 €
- Porcentaje de amortización: 3% sobre edificación (70% del valor de adquisición)
- Importe amortización calculada: 2.940,00 €
- Gastos deducibles (Comunidad, IBI, Seguros): 1.100,00 €

INMUEBLE 3:
- Dirección: Carrer de Mallorca 245, Barcelona
- Referencia Catastral: 3498112BC3829F0001AZ
- Titularidad: 100% MARÍA LÓPEZ RUIZ
- Nombre del Inquilino: MARC SOLER TORRES
- NIF Inquilino: 11223344D
- Cuantía de alquiler percibido: 14.400,00 € (1.200 €/mes)
- Precio de compra del inmueble: 250.000,00 €
- Porcentaje de amortización: 3% sobre edificación (80% del valor de adquisición)
- Importe amortización calculada: 6.000,00 €
- Gastos deducibles (Comunidad, IBI, Seguros): 2.200,00 €`
  }
];
