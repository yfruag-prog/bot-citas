// src/sheets.js — Interfaz con Google Sheets via Apps Script (multi-tenant)

// Normaliza cualquier formato de fecha a DD/MM/YYYY
function normalizarFecha(f) {
  const str = String(f || '').trim();
  if (!str) return '';
  // Ya es DD/MM/YYYY o D/M/YYYY
  const mDMY = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mDMY) return `${mDMY[1].padStart(2,'0')}/${mDMY[2].padStart(2,'0')}/${mDMY[3]}`;
  // ISO 8601: 2026-04-15 o 2026-04-15T05:00:00.000Z
  const mISO = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mISO) return `${mISO[3]}/${mISO[2]}/${mISO[1]}`;
  // Date.toString(): "Wed Apr 15 2026 00:00:00 GMT-0500 ..."
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }
  return str;
}

function formatPhone(phone, codigoPais = '57') {
  let clean = String(phone).replace(/[\s\-\(\)\+]/g, '');
  if (clean.startsWith('0')) clean = clean.substring(1);
  if (!clean.startsWith(codigoPais)) clean = codigoPais + clean;
  return clean;
}

/**
 * Devuelve un objeto con todos los métodos del Sheet para un cliente específico.
 * @param {string} scriptUrl  URL del Apps Script publicado
 * @param {string} codigoPais Código de país para formatear teléfonos (ej: '57')
 */
function crearSheetsInterface(scriptUrl, codigoPais = '57') {
  if (!scriptUrl) throw new Error('El cliente no tiene configurado un Google Script URL');

  async function llamar(method, payload) {
    try {
      const options = { method, redirect: 'follow' };
      let url = scriptUrl;
      if (method === 'GET') {
        url = `${scriptUrl}?${new URLSearchParams(payload).toString()}`;
      } else {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(payload);
      }
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      throw new Error(`Error al contactar Apps Script: ${err.message}`);
    }
  }

  return {
    async getCitas() {
      const datos = await llamar('GET', { action: 'getCitas' });
      if (datos.error) throw new Error(datos.error);
      return datos.map(c => ({ ...c, telefono: formatPhone(c.telefono, codigoPais), fecha: normalizarFecha(c.fecha) }));
    },

    async actualizarConfirmacion(rowIndex, estado) {
      const r = await llamar('POST', { action: 'actualizarConfirmacion', rowIndex, estado });
      if (r.error) throw new Error(r.error);
      return true;
    },

    async marcarComoEnviado(rowIndex) {
      return this.actualizarConfirmacion(rowIndex, 'ENVIADO');
    },

    async verificarEstructura() {
      const r = await llamar('GET', { action: 'verificarEstructura' });
      if (r.error) throw new Error(r.error);
    },

    async agregarCita(cita) {
      const r = await llamar('POST', { action: 'agregarCita', ...cita });
      if (r.error) throw new Error(r.error);
      return true;
    },

    async agregarCitas(citas) {
      const r = await llamar('POST', { action: 'agregarCitas', citas });
      if (r.error) throw new Error(r.error);
      return r.count || citas.length;
    },
  };
}

module.exports = { crearSheetsInterface, formatPhone };
