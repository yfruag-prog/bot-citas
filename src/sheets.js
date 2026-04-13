// src/sheets.js — Interfaz con Google Sheets via Apps Script (multi-tenant)

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
      return datos.map(c => ({ ...c, telefono: formatPhone(c.telefono, codigoPais) }));
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
