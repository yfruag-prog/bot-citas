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
  for (const fmt of ['DD/MM/YYYY','D/M/YYYY','DD-MM-YYYY','YYYY-MM-DD','DD/MM/YY']) {
    const f = moment.tz(fechaStr, fmt, timezone);
    if (f.isValid()) return f;
  }
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
    debeEnviarHoy(cita) {
      const dias = parseInt(config.daysBefore ?? 1);
      const hoy = moment().tz(tz);
      const fecha = parsearFecha(cita.fecha, tz);
      if (!fecha) return false;
      return fecha.diff(hoy, 'days') === dias;
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
