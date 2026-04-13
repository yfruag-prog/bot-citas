// src/clientes.js — CRUD de clientes (persistencia en JSON)

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data', 'clientes.json');

const DEFAULTS = {
  sheetName:       'Citas',
  countryCode:     '57',
  timezone:        'America/Bogota',
  daysBefore:      1,
  sendHour:        '09:00',
  messageTemplate: 'Hola {nombre} 👋, te recordamos que tienes una cita agendada el *{dia}* a las *{hora}* para el servicio de *{servicio}*. ¿Confirmas tu asistencia? Responde *SI* para confirmar o *NO* para cancelar.',
  confirmMessage:  '✅ ¡Perfecto, {nombre}! Tu cita ha sido confirmada. Te esperamos el {dia} a las {hora}. Si necesitas cancelar o reagendar, contáctanos. ¡Hasta pronto!',
  cancelMessage:   '😔 Entendido, {nombre}. Hemos registrado tu cancelación. Si deseas reagendar, con gusto te ayudamos. ¡Que tengas buen día!',
  unknownMessage:  'Gracias por tu respuesta. Para confirmar tu cita responde *SI* o para cancelar responde *NO*.',
};

function ensureDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cargarClientes() {
  try {
    ensureDir();
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return []; }
}

function guardar(clientes) {
  ensureDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(clientes, null, 2), 'utf8');
}

function obtenerCliente(id) {
  return cargarClientes().find(c => c.id === id) || null;
}

function obtenerClientePorUsuario(usuario) {
  return cargarClientes().find(c => c.usuario === usuario) || null;
}

function crearCliente(datos) {
  const clientes = cargarClientes();
  if (clientes.some(c => c.usuario === datos.usuario)) {
    throw new Error(`Ya existe un cliente con el usuario "${datos.usuario}"`);
  }
  const nuevo = {
    id:              crypto.randomBytes(6).toString('hex'),
    nombre:          datos.nombre          || '',
    usuario:         datos.usuario         || '',
    password:        datos.password        || '',
    googleScriptUrl: datos.googleScriptUrl || '',
    ...DEFAULTS,
    // Override defaults only for keys that exist in DEFAULTS
    ...Object.fromEntries(Object.entries(datos).filter(([k]) => k in DEFAULTS)),
    createdAt: new Date().toISOString(),
  };
  clientes.push(nuevo);
  guardar(clientes);
  return nuevo;
}

function actualizarCliente(id, datos) {
  const clientes = cargarClientes();
  const idx = clientes.findIndex(c => c.id === id);
  if (idx === -1) return null;
  if (datos.usuario && clientes.some(c => c.usuario === datos.usuario && c.id !== id)) {
    throw new Error(`Ya existe un cliente con el usuario "${datos.usuario}"`);
  }
  clientes[idx] = { ...clientes[idx], ...datos, id };
  guardar(clientes);
  return clientes[idx];
}

function eliminarCliente(id) {
  const clientes = cargarClientes();
  const idx = clientes.findIndex(c => c.id === id);
  if (idx === -1) return false;
  clientes.splice(idx, 1);
  guardar(clientes);
  return true;
}

module.exports = {
  DEFAULTS,
  cargarClientes,
  obtenerCliente,
  obtenerClientePorUsuario,
  crearCliente,
  actualizarCliente,
  eliminarCliente,
};
