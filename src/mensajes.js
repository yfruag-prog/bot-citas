// src/mensajes.js — Plantillas y lógica de mensajes (multi-tenant)

const moment = require('moment-timezone');

const DEFAULTS = {
  messageTemplate: 'Hola {nombre} 👋, te recordamos que tienes una cita agendada el *{dia}* a las *{hora}* para el servicio de *{servicio}*. ¿Confirmas tu asistencia? Responde *SI* para confirmar o *NO* para cancelar.',
  confirmMessage:  '✅ ¡Perfecto, {nombre}! Tu cita ha sido confirmada. Te esperamos el {dia} a las {hora}. Si necesitas cancelar o reagendar, contáctanos. ¡Hasta pronto!',
  cancelMessage:   '😔 Entendido, {nombre}. Hemos registrado tu cancelación. Si deseas reagendar, con gusto te ayudamos. ¡Que tengas buen día!',
  unknownMessage:  'Gracias por tu respuesta. Para confirmar tu cita responde *SI* o para cancelar responde *NO*.',
};

function formatearHora(horaStr) {
  const str = String(horaStr || '').trim();
  if (/AM|PM/i.test(str)) return str;
  const m1 = str.match(/^(\d{1,2}):(\d{2})/);
  if (m1) {
    let h = parseInt(m1[1]); const min = m1[2];
    const p = h >= 12 ? 'PM' : 'AM';
    if (h === 0) h = 12; else if (h > 12) h -= 12;
    return `${h}:${min} ${p}`;
  }
  const m2 = str.match(/(\d{2}):(\d{2}):\d{2}/);
  if (m2) {
    let h = parseInt(m2[1]); const min = m2[2];
    const p = h >= 12 ? 'PM' : 'AM';
    if (h === 0) h = 12; else if (h > 12) h -= 12;
    return `${h}:${min} ${p}`;
  }
  return str;
}

function parsearFecha(fechaStr, timezone) {
  const str = String(fechaStr || '').trim();
  if (!str) return null;

  // DD/MM/YYYY o D/M/YYYY (formato colombiano estándar)
  const mDMY = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mDMY) {
    const iso = `${mDMY[3]}-${mDMY[2].padStart(2,'0')}-${mDMY[1].padStart(2,'0')}`;
    const f = moment.tz(iso, 'YYYY-MM-DD', true, timezone);
    if (f.isValid()) return f;
  }

  // YYYY-MM-DD con posible sufijo T... (ISO 8601 de Apps Script)
  const mISO = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (mISO) {
    const f = moment.tz(`${mISO[1]}-${mISO[2]}-${mISO[3]}`, 'YYYY-MM-DD', true, timezone);
    if (f.isValid()) return f;
  }

  // DD-MM-YYYY
  const mDMY2 = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (mDMY2) {
    const iso = `${mDMY2[3]}-${mDMY2[2].padStart(2,'0')}-${mDMY2[1].padStart(2,'0')}`;
    const f = moment.tz(iso, 'YYYY-MM-DD', true, timezone);
    if (f.isValid()) return f;
  }

  // Fallback: cubrir Date.toString() "Wed Apr 15 2026 00:00:00 GMT-0500 ..." y otros
  const fallback = moment.tz(str, timezone);
  if (fallback.isValid()) return fallback;

  return null;
}

function formatearFecha(fechaStr, timezone) {
  moment.locale('es');
  const f = parsearFecha(fechaStr, timezone);
  return f ? f.format('dddd D [de] MMMM [de] YYYY') : fechaStr;
}

function formatearMensaje(plantilla, datos) {
  return plantilla
    .replace(/{nombre}/g,   datos.nombre   || '')
    .replace(/{dia}/g,      datos.dia      || '')
    .replace(/{hora}/g,     datos.hora     || '')
    .replace(/{servicio}/g, datos.servicio || '');
}

/**
 * Devuelve la interfaz de mensajes para un cliente específico.
 * @param {object} config  Objeto de configuración del cliente
 */
function crearMensajesInterface(config = {}) {
  const tz = config.timezone || 'America/Bogota';

  function vars(cita) {
    return {
      nombre:   cita.nombre,
      dia:      formatearFecha(cita.fecha, tz),
      hora:     formatearHora(cita.hora),
      servicio: cita.servicio,
    };
  }

  return {
    getMensajeCita(cita) {
      return formatearMensaje(config.messageTemplate || DEFAULTS.messageTemplate, vars(cita));
    },
    getMensajeConfirmacion(cita) {
      return formatearMensaje(config.confirmMessage || DEFAULTS.confirmMessage, vars(cita));
    },
    getMensajeCancelacion(cita) {
      return formatearMensaje(config.cancelMessage || DEFAULTS.cancelMessage, vars(cita));
    },
    getMensajeNoEntendido() {
      return config.unknownMessage || DEFAULTS.unknownMessage;
    },
    debeEnviarAhora(cita, ventanaMin = 16) {
      const dias  = parseInt(config.daysBefore ?? 1);
      const ahora = moment().tz(tz);
      const fecha = parsearFecha(cita.fecha, tz);
      if (!fecha) return false;

      // Construir datetime completo de la cita (fecha + hora)
      let citaDT = fecha.clone().startOf('day');
      if (cita.hora) {
        const mh = String(cita.hora).match(/^(\d{1,2}):(\d{2})/);
        if (mh) citaDT.hour(parseInt(mh[1])).minute(parseInt(mh[2])).second(0);
      }

      // Momento ideal de envío = cita - días de anticipación
      const envioIdeal = citaDT.clone().subtract(dias, 'days');

      // Enviar si el momento ideal cayó dentro de los últimos `ventanaMin` minutos
      const diffMin = ahora.diff(envioIdeal, 'minutes');
      return diffMin >= 0 && diffMin < ventanaMin;
    },
  };
}

function interpretarRespuesta(texto) {
  const s = texto.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const si  = ['si','s','yes','ok','dale','confirmo','confirmado','va','ahi estoy','claro','1'];
  const no  = ['no','n','cancel','cancelo','cancelar','no puedo','imposible','2'];
  if (si.some(p => s === p || s.startsWith(p + ' ')))  return 'CONFIRMAR';
  if (no.some(p => s === p || s.startsWith(p + ' ')))  return 'CANCELAR';
  return 'DESCONOCIDO';
}

module.exports = {
  crearMensajesInterface,
  interpretarRespuesta,
  formatearFecha,
  formatearHora,
  parsearFecha,
  DEFAULTS,
};
