// src/sheets.js
// Módulo para interactuar con Google Sheets via Google Apps Script
// No requiere Google Cloud, Service Account ni credenciales.

require('dotenv').config();

const SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

if (!SCRIPT_URL) {
  console.error('❌ Falta GOOGLE_SCRIPT_URL en el archivo .env');
  process.exit(1);
}

// -----------------------------------------------
// Helper: llama al Apps Script publicado como web app
// -----------------------------------------------
async function llamarScript(method, payload) {
  try {
    const options = { method, redirect: 'follow' };

    let url = SCRIPT_URL;

    if (method === 'GET') {
      const params = new URLSearchParams(payload);
      url = `${SCRIPT_URL}?${params.toString()}`;
    } else {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(payload);
    }

    const res = await fetch(url, options);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    return await res.json();
  } catch (err) {
    throw new Error(`Error al contactar Apps Script: ${err.message}`);
  }
}

// -----------------------------------------------
// Obtiene todas las citas de la hoja
// -----------------------------------------------
async function getCitas() {
  try {
    const datos = await llamarScript('GET', { action: 'getCitas' });

    if (datos.error) throw new Error(datos.error);

    return datos.map(cita => ({
      ...cita,
      telefono: formatPhone(cita.telefono),
    }));
  } catch (error) {
    console.error('❌ Error al leer Google Sheets:', error.message);
    throw error;
  }
}

// -----------------------------------------------
// Actualiza el estado de confirmación de una cita
// -----------------------------------------------
async function actualizarConfirmacion(rowIndex, estado) {
  try {
    const resultado = await llamarScript('POST', {
      action: 'actualizarConfirmacion',
      rowIndex,
      estado,
    });

    if (resultado.error) throw new Error(resultado.error);

    console.log(`✅ Fila ${rowIndex} actualizada a: ${estado}`);
    return true;
  } catch (error) {
    console.error(`❌ Error actualizando fila ${rowIndex}:`, error.message);
    return false;
  }
}

// -----------------------------------------------
// Marca una cita como "ENVIADO"
// -----------------------------------------------
async function marcarComoEnviado(rowIndex) {
  return actualizarConfirmacion(rowIndex, 'ENVIADO');
}

// -----------------------------------------------
// Verifica / crea encabezados en la hoja
// -----------------------------------------------
async function verificarEstructura() {
  try {
    const resultado = await llamarScript('GET', { action: 'verificarEstructura' });
    if (resultado.error) throw new Error(resultado.error);
    console.log('✅ Estructura del Sheet verificada');
  } catch (error) {
    console.error('❌ Error verificando estructura:', error.message);
  }
}

// -----------------------------------------------
// Formatea el número de teléfono para WhatsApp
// WhatsApp Web.js necesita: 521XXXXXXXXXX@c.us
// -----------------------------------------------
function formatPhone(phone) {
  const codigoPais = process.env.COUNTRY_CODE || '57';
  let clean = phone.toString().replace(/[\s\-\(\)\+]/g, '');

  if (clean.startsWith('0')) clean = clean.substring(1);

  // Si el número no trae código de país, agregarlo
  if (!clean.startsWith(codigoPais)) {
    clean = codigoPais + clean;
  }

  return clean;
}

// -----------------------------------------------
// Agrega una sola cita nueva en Google Sheets
// -----------------------------------------------
async function agregarCita(cita) {
  try {
    const resultado = await llamarScript('POST', {
      action: 'agregarCita',
      nombre:   cita.nombre,
      telefono: cita.telefono,
      fecha:    cita.fecha,
      hora:     cita.hora,
      servicio: cita.servicio,
    });
    if (resultado.error) throw new Error(resultado.error);
    return true;
  } catch (error) {
    console.error('❌ Error agregando cita:', error.message);
    throw error;
  }
}

// -----------------------------------------------
// Agrega múltiples citas en bloque
// -----------------------------------------------
async function agregarCitas(citas) {
  try {
    const resultado = await llamarScript('POST', {
      action: 'agregarCitas',
      citas,
    });
    if (resultado.error) throw new Error(resultado.error);
    return resultado.count || citas.length;
  } catch (error) {
    console.error('❌ Error importando citas:', error.message);
    throw error;
  }
}

module.exports = {
  getCitas,
  actualizarConfirmacion,
  marcarComoEnviado,
  verificarEstructura,
  agregarCita,
  agregarCitas,
  formatPhone,
};
