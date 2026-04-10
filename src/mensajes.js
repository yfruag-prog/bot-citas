// src/mensajes.js
// Gestión de plantillas de mensajes y lógica de envío

const moment = require('moment-timezone');
require('dotenv').config();

const TIMEZONE = process.env.TIMEZONE || 'America/Mexico_City';

/**
 * Reemplaza las variables en una plantilla de mensaje
 */
function formatearMensaje(plantilla, datos) {
  return plantilla
    .replace(/{nombre}/g, datos.nombre || '')
    .replace(/{dia}/g, datos.dia || datos.fecha || '')
    .replace(/{hora}/g, datos.hora || '')
    .replace(/{servicio}/g, datos.servicio || '');
}

/**
 * Obtiene el mensaje de confirmación de cita
 */
function getMensajeCita(cita) {
  const plantilla = process.env.MESSAGE_TEMPLATE ||
    'Hola {nombre} 👋, te recordamos que tienes una cita el *{dia}* a las *{hora}* para *{servicio}*. ¿Confirmas? Responde *SI* o *NO*.';

  const diaFormateado = formatearFecha(cita.fecha);

  return formatearMensaje(plantilla, {
    nombre: cita.nombre,
    dia: diaFormateado,
    hora: cita.hora,
    servicio: cita.servicio,
  });
}

/**
 * Obtiene el mensaje cuando el cliente confirma
 */
function getMensajeConfirmacion(cita) {
  const plantilla = process.env.CONFIRM_MESSAGE ||
    '✅ ¡Perfecto, {nombre}! Tu cita ha sido confirmada para el {dia} a las {hora}. ¡Te esperamos!';

  const diaFormateado = formatearFecha(cita.fecha);

  return formatearMensaje(plantilla, {
    nombre: cita.nombre,
    dia: diaFormateado,
    hora: cita.hora,
    servicio: cita.servicio,
  });
}

/**
 * Obtiene el mensaje cuando el cliente cancela
 */
function getMensajeCancelacion(cita) {
  const plantilla = process.env.CANCEL_MESSAGE ||
    '😔 Entendido, {nombre}. Hemos registrado tu cancelación. ¡Que tengas buen día!';

  const diaFormateado = formatearFecha(cita.fecha);

  return formatearMensaje(plantilla, {
    nombre: cita.nombre,
    dia: diaFormateado,
    hora: cita.hora,
    servicio: cita.servicio,
  });
}

/**
 * Mensaje cuando la respuesta no es clara
 */
function getMensajeNoEntendido() {
  return process.env.UNKNOWN_MESSAGE ||
    'Gracias por tu respuesta. Para confirmar tu cita responde *SI* o para cancelar responde *NO*.';
}

/**
 * Determina si una cita debe recibir recordatorio hoy
 */
function debeEnviarHoy(cita) {
  const diasAntes = parseInt(process.env.DAYS_BEFORE || '1');
  const hoy = moment().tz(TIMEZONE);
  const fechaCita = parsearFecha(cita.fecha);

  if (!fechaCita) return false;

  const diferencia = fechaCita.diff(hoy, 'days');
  return diferencia === diasAntes;
}

/**
 * Convierte texto de respuesta a intención (CONFIRMAR / CANCELAR / DESCONOCIDO)
 */
function interpretarRespuesta(texto) {
  const limpio = texto.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // quita acentos

  const confirmar = ['si', 'sí', 's', 'yes', 'ok', 'dale', 'confirmo', 'confirmado', 'va', 'ahi estoy', 'claro', '1'];
  const cancelar = ['no', 'n', 'cancel', 'cancelo', 'cancelar', 'no puedo', 'imposible', '2'];

  if (confirmar.some(p => limpio === p || limpio.startsWith(p + ' '))) return 'CONFIRMAR';
  if (cancelar.some(p => limpio === p || limpio.startsWith(p + ' '))) return 'CANCELAR';

  return 'DESCONOCIDO';
}

/**
 * Parsea una fecha en formato DD/MM/YYYY
 */
function parsearFecha(fechaStr) {
  const formatos = ['DD/MM/YYYY', 'D/M/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD', 'DD/MM/YY'];
  for (const formato of formatos) {
    const fecha = moment.tz(fechaStr, formato, TIMEZONE);
    if (fecha.isValid()) return fecha;
  }
  return null;
}

/**
 * Formatea una fecha para mostrar en el mensaje (ej: "lunes 14 de abril de 2025")
 */
function formatearFecha(fechaStr) {
  moment.locale('es');
  const fecha = parsearFecha(fechaStr);
  if (!fecha) return fechaStr;
  return fecha.format('dddd D [de] MMMM [de] YYYY');
}

module.exports = {
  getMensajeCita,
  getMensajeConfirmacion,
  getMensajeCancelacion,
  getMensajeNoEntendido,
  debeEnviarHoy,
  interpretarRespuesta,
  formatearFecha,
  parsearFecha,
};
