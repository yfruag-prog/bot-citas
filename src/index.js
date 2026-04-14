// src/index.js — Bot citas multi-tenant

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode-terminal');
const QRCode  = require('qrcode');
const http    = require('http');
const crypto  = require('crypto');
const cron    = require('node-cron');

const {
  cargarClientes, obtenerCliente, obtenerClientePorUsuario,
  crearCliente, actualizarCliente, eliminarCliente, DEFAULTS,
} = require('./clientes');
const { crearSheetsInterface }  = require('./sheets');
const { crearMensajesInterface, interpretarRespuesta } = require('./mensajes');

const QR_PORT = parseInt(process.env.QR_PORT) || 3000;

// ── Runtime por cliente ───────────────────────────────────────────────────────
// Map<clienteId, { client, qrDataUrl, conectado, citasPendientes, cronJob }>
const instancias = new Map();

// ── Sesiones ──────────────────────────────────────────────────────────────────
// Map<token, { expiry, role:'admin'|'client', clientId? }>
const sesiones = new Map();

function crearSesion(role, clientId = null) {
  const token = crypto.randomBytes(32).toString('hex');
  sesiones.set(token, { expiry: Date.now() + 8 * 3600_000, role, clientId });
  return token;
}

function obtenerSesion(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const s = sesiones.get(token);
  if (!s || Date.now() > s.expiry) { sesiones.delete(token); return null; }
  return s;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const [k, ...v] = p.trim().split('=');
    if (k) out[k.trim()] = v.join('=').trim();
  });
  return out;
}

function credencialesAdmin(user, pass) {
  const u = process.env.ADMIN_USER     || 'admin';
  const p = process.env.ADMIN_PASSWORD || 'admin123';
  try {
    return crypto.timingSafeEqual(Buffer.from(user || ''), Buffer.from(u)) &&
           crypto.timingSafeEqual(Buffer.from(pass || ''), Buffer.from(p));
  } catch { return false; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parsearBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw))));
  });
}
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function redir(res, url) { res.writeHead(302, { Location: url }); res.end(); }
function html(res, content) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(content); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function convertirFecha(s) {
  const m = (s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}
function parsearCSV(texto) {
  const lineas = texto.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').map(l=>l.trim()).filter(Boolean);
  if (lineas.length < 2) return [];
  return lineas.slice(1).map(linea => {
    const cols = []; let dentro = false, campo = '';
    for (const ch of linea) {
      if (ch === '"') { dentro = !dentro; }
      else if (ch === ',' && !dentro) { cols.push(campo.trim()); campo = ''; }
      else campo += ch;
    }
    cols.push(campo.trim());
    return { nombre: cols[0]||'', telefono: cols[1]||'', fecha: cols[2]||'', hora: cols[3]||'', servicio: cols[4]||'' };
  }).filter(c => c.nombre && c.telefono && c.fecha);
}

// ── CSS compartido ────────────────────────────────────────────────────────────
const css = `<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
/* Sticky-footer: body es columna, el contenido principal crece */
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;color:#0f172a;line-height:1.5;display:flex;flex-direction:column;min-height:100vh}
a{color:inherit}
/* Nav */
.nav{background:#0f172a;padding:0 24px;display:flex;align-items:center;height:56px;gap:20px;position:sticky;top:0;z-index:10;flex-wrap:nowrap;overflow-x:auto;flex-shrink:0}
.nav-brand{color:#fff;font-weight:700;font-size:15px;white-space:nowrap}
.nav-link{color:#94a3b8;text-decoration:none;font-size:14px;padding:18px 0;border-bottom:2px solid transparent;transition:color .15s;white-space:nowrap}
.nav-link:hover{color:#e2e8f0}
.nav-link.active{color:#fff;border-bottom-color:#3b82f6}
.nav-end{margin-left:auto;flex-shrink:0}
/* Botones */
.btn{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;text-decoration:none;transition:filter .15s;white-space:nowrap}
.btn:hover{filter:brightness(1.1)}
.btn-primary{background:#3b82f6;color:#fff}
.btn-success{background:#16a34a;color:#fff}
.btn-danger{background:#ef4444;color:#fff}
.btn-ghost{background:transparent;color:#64748b;font-size:13px;padding:6px 0}
.btn-sm{padding:6px 14px;font-size:13px}
/* Layout — flex:1 empuja el footer al fondo */
.container{max-width:980px;margin:0 auto;padding:28px 20px;flex:1;width:100%}
.page-center{display:flex;align-items:center;justify-content:center;flex:1;padding:24px}
/* Tarjetas */
.card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}
/* Alertas */
.alert{padding:12px 16px;border-radius:8px;font-size:14px;margin-bottom:16px}
.alert-warn{background:#fef9c3;border:1px solid #fde047}
.alert-ok{background:#dcfce7;border:1px solid #86efac;color:#15803d}
.alert-err{background:#fee2e2;border:1px solid #fca5a5;color:#b91c1c}
/* Tabla */
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:14px;min-width:600px}
thead tr{background:#f8fafc}
th{padding:11px 14px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
td{padding:11px 14px;border-top:1px solid #f1f5f9;vertical-align:middle}
tbody tr:hover td{background:#f8fafc}
/* Formularios */
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
label{display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:5px}
input,select,textarea{width:100%;padding:10px 13px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none;transition:border-color .2s;background:#fff;font-family:inherit}
input:focus,select:focus,textarea:focus{border-color:#3b82f6}
textarea{resize:vertical}
.field{display:flex;flex-direction:column}
.field.full{grid-column:1/-1}
/* Footer */
.footer{text-align:center;padding:22px 20px;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;flex-shrink:0}
.footer a{color:#64748b;text-decoration:none}
.footer a:hover{color:#0f172a;text-decoration:underline}
/* Responsive tabla → tarjetas */
@media(max-width:680px){
  .tbl-wrap{overflow-x:visible}
  table,thead,tbody,th,td,tr{display:block}
  thead{display:none}
  tbody tr{border:1px solid #e2e8f0;border-radius:10px;margin-bottom:10px;background:#fff;overflow:hidden}
  tbody tr:hover td{background:#fff}
  td{display:flex;align-items:center;padding:10px 14px;border-top:1px solid #f1f5f9;font-size:13px;gap:10px}
  td:first-child{border-top:none}
  td::before{content:attr(data-label);color:#94a3b8;font-size:11px;font-weight:700;min-width:80px;text-transform:uppercase;letter-spacing:.05em;flex-shrink:0}
}
@media(max-width:600px){
  .nav{padding:0 14px;gap:12px}
  .container{padding:16px 14px}
  .page-center{padding:16px}
  .form-grid{grid-template-columns:1fr}
}
</style>`;

const htmlFooter = `<footer class="footer">
  © ${new Date().getFullYear()} <a href="https://yfrua.com" target="_blank" rel="noopener">yfrua.com</a>
  &nbsp;·&nbsp; Desarrollado por <strong>Yeferson Rua</strong>
  &nbsp;·&nbsp; Todos los derechos reservados
</footer>`;

// ── Badges ────────────────────────────────────────────────────────────────────
function badgeEstado(estado) {
  const M = {
    '':                ['#e2e8f0','#475569','Sin enviar'],
    'ENVIADO':         ['#dbeafe','#1d4ed8','Esperando respuesta'],
    'CONFIRMADO':      ['#dcfce7','#15803d','Confirmado ✓'],
    'CANCELADO':       ['#fee2e2','#b91c1c','Cancelado'],
    'NUMERO_INVALIDO': ['#ffedd5','#c2410c','Número inválido'],
  };
  const [bg,co,lb] = M[estado] || ['#e2e8f0','#475569', estado||'Sin enviar'];
  return `<span class="badge" style="background:${bg};color:${co}">${lb}</span>`;
}
function badgeWA(clienteId) {
  const i = instancias.get(clienteId);
  if (!i)            return `<span class="badge" style="background:#e2e8f0;color:#475569">Sin iniciar</span>`;
  if (i.conectado)   return `<span class="badge" style="background:#dcfce7;color:#15803d">Conectado ✓</span>`;
  if (i.qrDataUrl)   return `<span class="badge" style="background:#fef9c3;color:#92400e">Esperando QR</span>`;
  return             `<span class="badge" style="background:#fee2e2;color:#b91c1c">Desconectado</span>`;
}

// ── Nav ───────────────────────────────────────────────────────────────────────
function navAdmin(activa) {
  return `<nav class="nav">
  <span class="nav-brand">🤖 Bot Citas</span>
  <span style="color:#f59e0b;font-size:11px;font-weight:700;letter-spacing:.08em">ADMIN</span>
  <a href="/admin" class="nav-link${activa==='dash'?' active':''}">Dashboard</a>
  <a href="/admin/clientes" class="nav-link${activa==='clientes'?' active':''}">Clientes</a>
  <form method="POST" action="/logout" class="nav-end" style="display:flex">
    <button type="submit" class="btn btn-ghost">Cerrar sesión</button>
  </form>
</nav>`;
}
function navCliente(activa, nombre) {
  return `<nav class="nav">
  <span class="nav-brand">🤖 ${escHtml(nombre)}</span>
  <a href="/" class="nav-link${activa==='estado'?' active':''}">Estado</a>
  <a href="/citas" class="nav-link${activa==='citas'?' active':''}">Citas</a>
  <a href="/nueva-cita" class="nav-link${activa==='nueva'?' active':''}">Nueva cita</a>
  <a href="/importar" class="nav-link${activa==='importar'?' active':''}">Importar</a>
  <a href="/configuracion" class="nav-link${activa==='config'?' active':''}">Config</a>
  <form method="POST" action="/logout" class="nav-end" style="display:flex">
    <button type="submit" class="btn btn-ghost">Cerrar sesión</button>
  </form>
</nav>`;
}

// ── Render: Login ─────────────────────────────────────────────────────────────
function renderLogin(error = '') {
  return `<!DOCTYPE html><html lang="es"><head>
  <meta charset="utf-8"><title>Bot Citas — Acceso</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">${css}
  <style>
    /* El <main> crece para empujar el footer al fondo */
    .login-main{flex:1;display:flex;align-items:center;justify-content:center;padding:32px 16px}
    .box{background:#fff;border-radius:16px;padding:40px 36px;width:100%;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,.1)}
    .box-logo{font-size:40px;text-align:center;margin-bottom:8px}
    .box h1{font-size:22px;font-weight:700;text-align:center;margin-bottom:4px}
    .box .sub{color:#64748b;text-align:center;font-size:14px;margin-bottom:28px}
    .btn-in{width:100%;padding:13px;background:#0f172a;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:6px;transition:background .2s}
    .btn-in:hover{background:#1e293b}
    @media(max-width:480px){
      .login-main{padding:20px 0;align-items:flex-start}
      .box{border-radius:0;padding:32px 20px;box-shadow:none;border-bottom:1px solid #e2e8f0}
    }
  </style>
</head><body>
  <main class="login-main">
    <div class="box">
      <div class="box-logo">🤖</div>
      <h1>Bot Citas</h1>
      <p class="sub">Panel de administración</p>
      ${error ? `<div class="alert alert-err">${escHtml(error)}</div>` : ''}
      <form method="POST" action="/login">
        <div class="field" style="margin-bottom:14px">
          <label for="lu">Usuario</label>
          <input type="text" id="lu" name="user" required autofocus autocomplete="username">
        </div>
        <div class="field" style="margin-bottom:6px">
          <label for="lp">Contraseña</label>
          <input type="password" id="lp" name="pass" required autocomplete="current-password">
        </div>
        <button type="submit" class="btn-in">Ingresar</button>
      </form>
    </div>
  </main>
${htmlFooter}</body></html>`;
}

// ── Render: Admin Dashboard ───────────────────────────────────────────────────
function renderAdminDashboard(clientes) {
  const filas = clientes.length === 0
    ? `<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:32px">No hay clientes — <a href="/admin/clientes/nuevo">Crear el primero</a></td></tr>`
    : clientes.map(c => `<tr>
        <td data-label="Nombre"><strong>${escHtml(c.nombre)}</strong><br><small style="color:#94a3b8">${escHtml(c.usuario)}</small></td>
        <td data-label="WhatsApp">${badgeWA(c.id)}</td>
        <td data-label="Google Sheet">${c.googleScriptUrl ? '<span style="color:#16a34a">✓ Configurado</span>' : '<span style="color:#ef4444">Sin configurar</span>'}</td>
        <td data-label="Creado">${new Date(c.createdAt||0).toLocaleDateString('es')}</td>
        <td data-label="Acciones" style="display:flex;gap:8px;flex-wrap:wrap">
          <a href="/admin/clientes/${c.id}" class="btn btn-primary btn-sm">Editar</a>
          <form method="POST" action="/admin/clientes/${c.id}/eliminar" style="margin:0"
                onsubmit="return confirm('¿Eliminar cliente ${escHtml(c.nombre)}? No se puede deshacer.')">
            <button class="btn btn-danger btn-sm">Eliminar</button>
          </form>
        </td>
      </tr>`).join('');

  return `<!DOCTYPE html><html lang="es"><head>
  <meta charset="utf-8"><title>Admin — Bot Citas</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">${css}
</head><body>
  ${navAdmin('dash')}
  <div class="container">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:24px">
      <h1 style="font-size:20px;font-weight:700">Clientes (${clientes.length})</h1>
      <a href="/admin/clientes/nuevo" class="btn btn-primary">+ Nuevo cliente</a>
    </div>
    <div class="card tbl-wrap">
      <table><thead><tr><th>Nombre / Usuario</th><th>WhatsApp</th><th>Google Sheet</th><th>Creado</th><th>Acciones</th></tr></thead>
      <tbody>${filas}</tbody></table>
    </div>
  </div>
${htmlFooter}</body></html>`;
}

// ── Render: Admin Formulario Cliente ─────────────────────────────────────────
function renderAdminFormCliente(cliente, flash = '') {
  const es = !!cliente;
  const c  = cliente || {};
  const [ft, fm] = flash ? flash.split('|') : [];
  const alerta   = fm ? `<div class="alert alert-${ft}">${escHtml(fm)}</div>` : '';
  const titulo   = es ? `Editar: ${escHtml(c.nombre)}` : 'Nuevo cliente';
  const action   = es ? `/admin/clientes/${c.id}` : '/admin/clientes/nuevo';
  const timezones = ['America/Bogota','America/Mexico_City','America/Lima','America/Santiago','America/Argentina/Buenos_Aires','America/Caracas','America/Guayaquil'];

  return `<!DOCTYPE html><html lang="es"><head>
  <meta charset="utf-8"><title>Admin — ${titulo}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">${css}
</head><body>
  ${navAdmin('clientes')}
  <div class="container" style="max-width:780px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap">
      <a href="/admin/clientes" class="btn btn-ghost" style="font-size:20px;padding:0;line-height:1">←</a>
      <h1 style="font-size:20px;font-weight:700">${titulo}</h1>
      ${es ? badgeWA(c.id) : ''}
    </div>
    ${alerta}
    <form method="POST" action="${action}">
      <div class="card" style="padding:24px;margin-bottom:16px">
        <p style="font-size:12px;font-weight:700;color:#94a3b8;margin-bottom:14px;letter-spacing:.08em">ACCESO AL PANEL</p>
        <div class="form-grid">
          <div class="field"><label>Nombre del negocio *</label><input type="text" name="nombre" value="${escHtml(c.nombre||'')}" required placeholder="Ej: Peluquería María"></div>
          <div class="field"><label>Usuario *</label><input type="text" name="usuario" value="${escHtml(c.usuario||'')}" required placeholder="ej: maria" autocomplete="off"></div>
          <div class="field full"><label>${es ? 'Nueva contraseña (vacío = sin cambios)' : 'Contraseña *'}</label>
            <input type="password" name="password" ${es?'':'required'} placeholder="${es?'Sin cambios':'Contraseña'}" autocomplete="new-password"></div>
        </div>
      </div>
      <div class="card" style="padding:24px;margin-bottom:16px">
        <p style="font-size:12px;font-weight:700;color:#94a3b8;margin-bottom:14px;letter-spacing:.08em">GOOGLE SHEETS</p>
        <div class="form-grid">
          <div class="field full"><label>URL del Apps Script *</label>
            <input type="url" name="googleScriptUrl" value="${escHtml(c.googleScriptUrl||'')}" required placeholder="https://script.google.com/macros/s/..."></div>
          <div class="field"><label>Nombre de la hoja</label><input type="text" name="sheetName" value="${escHtml(c.sheetName||'Citas')}" placeholder="Citas"></div>
          <div class="field"><label>Código de país</label><input type="text" name="countryCode" value="${escHtml(c.countryCode||'57')}" placeholder="57"></div>
        </div>
      </div>
      <div class="card" style="padding:24px;margin-bottom:16px">
        <p style="font-size:12px;font-weight:700;color:#94a3b8;margin-bottom:14px;letter-spacing:.08em">RECORDATORIOS</p>
        <div class="form-grid">
          <div class="field"><label>Hora de envío</label><input type="time" name="sendHour" value="${escHtml(c.sendHour||'09:00')}"></div>
          <div class="field"><label>Días de anticipación</label>
            <select name="daysBefore">
              ${[0,1,2,3].map(n=>`<option value="${n}" ${(parseInt(c.daysBefore)||1)===n?'selected':''}>${n===0?'Mismo día':`${n} día${n>1?'s':''} antes`}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Zona horaria</label>
            <select name="timezone">
              ${timezones.map(tz=>`<option value="${tz}" ${(c.timezone||'America/Bogota')===tz?'selected':''}>${tz}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button type="submit" class="btn btn-primary">${es ? 'Guardar cambios' : 'Crear cliente'}</button>
        <a href="/admin/clientes" class="btn btn-ghost">Cancelar</a>
        ${es ? `<form method="POST" action="/admin/clientes/${c.id}/wa/reset" style="margin:0;margin-left:auto"
                     onsubmit="return confirm('¿Desconectar WhatsApp de este cliente?')">
                  <button class="btn btn-danger btn-sm">🔌 Desconectar WhatsApp</button>
                </form>` : ''}
      </div>
    </form>
  </div>
${htmlFooter}</body></html>`;
}

// ── Helper: parsea DD/MM/YYYY a número comparable para ordenar ───────────────
function fechaSort(fechaStr) {
  const m = (fechaStr || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 99999999;
  return parseInt(`${m[3]}${m[2].padStart(2,'0')}${m[1].padStart(2,'0')}`);
}

// ── Render: Cliente — Dashboard con Calendario ────────────────────────────────
function renderClienteDashboard(cliente, inst, citas) {
  const hoy     = new Date();
  const hoyStr  = `${String(hoy.getDate()).padStart(2,'0')}/${String(hoy.getMonth()+1).padStart(2,'0')}/${hoy.getFullYear()}`;
  const citasHoy   = citas.filter(c => c.fecha === hoyStr);
  const pendientes = citas.filter(c => !c.confirmacion || c.confirmacion === '');

  // Estadísticas rápidas
  const stats = [
    { label:'Total citas',  valor: citas.length,      color:'#3b82f6', bg:'#eff6ff', icon:'📋' },
    { label:'Hoy',          valor: citasHoy.length,    color:'#8b5cf6', bg:'#f5f3ff', icon:'📅' },
    { label:'Pendientes',   valor: pendientes.length,  color:'#f59e0b', bg:'#fffbeb', icon:'⏳' },
  ].map(s => `<div class="card" style="padding:18px 20px;display:flex;align-items:center;gap:14px;flex:1;min-width:130px">
    <div style="font-size:28px;line-height:1">${s.icon}</div>
    <div>
      <div style="font-size:26px;font-weight:800;color:${s.color};line-height:1">${s.valor}</div>
      <div style="font-size:12px;color:#64748b;margin-top:2px">${s.label}</div>
    </div>
  </div>`).join('');

  // Normalizar fechas a DD/MM/YYYY con ceros antes de serializar
  function normFecha(f) {
    const m = (f || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? `${m[1].padStart(2,'0')}/${m[2].padStart(2,'0')}/${m[3]}` : (f || '');
  }

  // Serializar citas para el calendario JS
  const citasJS = JSON.stringify(citas.map(c => ({
    fecha: normFecha(c.fecha), hora: c.hora || '', nombre: c.nombre || '',
    servicio: c.servicio || '', estado: c.confirmacion || '',
  })));

  return `<!DOCTYPE html><html lang="es"><head>
  <meta charset="utf-8"><title>${escHtml(cliente.nombre)} — Dashboard</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="60">${css}
  <style>
    .wa-bar{display:flex;align-items:center;gap:10px;background:#fff;border-radius:10px;padding:12px 18px;box-shadow:0 1px 4px rgba(0,0,0,.07);flex-wrap:wrap;margin-bottom:20px}
    .wa-dot{width:10px;height:10px;border-radius:50%;background:#16a34a;flex-shrink:0;box-shadow:0 0 0 3px #dcfce7}
    /* Layout principal: calendario + panel lado a lado */
    .dash-layout{display:grid;grid-template-columns:1fr 320px;gap:16px;margin-top:20px;align-items:start}
    @media(max-width:780px){.dash-layout{grid-template-columns:1fr}}
    /* Calendario */
    .cal-wrap{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:hidden}
    .cal-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #f1f5f9}
    .cal-title{font-size:16px;font-weight:700;text-transform:capitalize;color:#0f172a}
    .cal-nav{background:none;border:none;cursor:pointer;padding:4px 12px;border-radius:8px;font-size:20px;color:#475569;transition:background .15s}
    .cal-nav:hover{background:#f1f5f9}
    .cal-grid{display:grid;grid-template-columns:repeat(7,1fr)}
    .cal-dn{text-align:center;padding:8px 2px;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;background:#f8fafc;border-bottom:1px solid #f1f5f9}
    .cal-day{min-height:80px;padding:5px 5px 3px;border-top:1px solid #f1f5f9;border-right:1px solid #f1f5f9;cursor:default;transition:background .1s;box-sizing:border-box}
    .cal-day:nth-child(7n){border-right:none}
    .cal-day.empty{background:#fafafa}
    .cal-day.has-ev{cursor:pointer}
    .cal-day.has-ev:hover{background:#f0f7ff}
    .cal-day.selected{background:#eff6ff;outline:2px solid #3b82f6;outline-offset:-2px}
    .cal-day.today .cal-num{background:#3b82f6;color:#fff;border-radius:50%}
    .cal-day.past{opacity:.5}
    .cal-num{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;font-size:13px;font-weight:600;color:#374151}
    /* Pills dentro del día */
    .cal-ev{font-size:10px;border-radius:3px;padding:1px 5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;line-height:1.5}
    .cal-ev.pendiente{background:#dbeafe;color:#1d4ed8}
    .cal-ev.enviado{background:#e0e7ff;color:#4338ca}
    .cal-ev.confirmado{background:#dcfce7;color:#15803d}
    .cal-ev.cancelado{background:#fee2e2;color:#b91c1c}
    .cal-more{font-size:10px;color:#94a3b8;margin-top:1px;padding-left:3px}
    /* Puntos móvil */
    .cal-dots{display:none;gap:3px;flex-wrap:wrap;padding:3px 1px}
    .cal-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
    @media(max-width:540px){
      .cal-day{min-height:52px;padding:3px}
      .cal-num{width:20px;height:20px;font-size:11px}
      .cal-ev,.cal-more{display:none}
      .cal-dots{display:flex}
    }
    /* Panel lateral de citas del día */
    .day-panel{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:hidden;position:sticky;top:16px}
    .day-panel-head{padding:14px 16px;border-bottom:1px solid #f1f5f9;background:#f8fafc}
    .day-panel-title{font-size:14px;font-weight:700;color:#0f172a;margin:0}
    .day-panel-sub{font-size:12px;color:#64748b;margin-top:2px}
    .day-panel-empty{padding:32px 16px;text-align:center;color:#94a3b8;font-size:13px}
    .day-item{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #f8fafc;transition:background .1s}
    .day-item:last-child{border-bottom:none}
    .day-item:hover{background:#f8fafc}
    .day-hour{font-size:13px;font-weight:700;color:#3b82f6;min-width:44px;flex-shrink:0}
    .day-info{flex:1;min-width:0}
    .day-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#0f172a}
    .day-svc{font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .day-badge{font-size:10px;padding:2px 7px;border-radius:20px;font-weight:600;flex-shrink:0}
  </style>
</head><body>${navCliente('estado',cliente.nombre)}
  <div class="container">
    <div class="wa-bar">
      <span class="wa-dot"></span>
      <span style="font-size:14px;font-weight:600;color:#15803d">WhatsApp conectado</span>
      <span style="color:#94a3b8;font-size:13px;margin-left:4px">· El bot está activo</span>
      <form method="POST" action="/cambiar-numero" style="margin-left:auto"
            onsubmit="return confirm('¿Desconectar número y vincular uno nuevo?')">
        <button class="btn btn-danger btn-sm">🔄 Cambiar número</button>
      </form>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:4px">${stats}</div>
    <div class="dash-layout">
      <!-- Calendario -->
      <div class="cal-wrap">
        <div class="cal-head">
          <button class="cal-nav" onclick="cambiarMes(-1)">&#8249;</button>
          <span class="cal-title" id="cal-titulo"></span>
          <button class="cal-nav" onclick="cambiarMes(1)">&#8250;</button>
        </div>
        <div class="cal-grid">
          ${['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(d=>`<div class="cal-dn">${d}</div>`).join('')}
        </div>
        <div class="cal-grid" id="cal-celdas"></div>
      </div>
      <!-- Panel citas del día -->
      <div class="day-panel" id="day-panel">
        <div class="day-panel-head">
          <div class="day-panel-title" id="day-panel-title">Selecciona un día</div>
          <div class="day-panel-sub" id="day-panel-sub">Toca un día con citas para ver el detalle</div>
        </div>
        <div id="day-panel-list"><div class="day-panel-empty">📅 Ningún día seleccionado</div></div>
      </div>
    </div>
  </div>
  <script>
    const CITAS = ${citasJS};
    const HOY   = new Date();
    let mes = HOY.getMonth(), anio = HOY.getFullYear();
    let selKey = null;

    function fechaKey(d,m,a){ return String(d).padStart(2,'0')+'/'+String(m+1).padStart(2,'0')+'/'+a; }

    function claseEv(estado){
      const e = (estado||'').toUpperCase();
      if(e==='CONFIRMADO') return 'confirmado';
      if(e==='CANCELADO')  return 'cancelado';
      if(e==='ENVIADO')    return 'enviado';
      return 'pendiente';
    }
    const colEv   = {pendiente:'#3b82f6',enviado:'#818cf8',confirmado:'#16a34a',cancelado:'#ef4444'};
    const bgBadge = {pendiente:'#dbeafe',enviado:'#e0e7ff',confirmado:'#dcfce7',cancelado:'#fee2e2'};
    const txBadge = {pendiente:'#1d4ed8',enviado:'#4338ca',confirmado:'#15803d',cancelado:'#b91c1c'};
    const lblEv   = {pendiente:'Sin enviar',enviado:'Esperando',confirmado:'Confirmado ✓',cancelado:'Cancelado'};

    function renderCal(){
      const hoy1 = new Date(HOY.getFullYear(),HOY.getMonth(),HOY.getDate());
      const titulo = new Date(anio,mes,1).toLocaleDateString('es',{month:'long',year:'numeric'});
      document.getElementById('cal-titulo').textContent = titulo.charAt(0).toUpperCase()+titulo.slice(1);

      const primer  = new Date(anio,mes,1).getDay();
      const offset  = primer===0 ? 6 : primer-1;
      const diasMes = new Date(anio,mes+1,0).getDate();
      const grid    = document.getElementById('cal-celdas');
      grid.innerHTML = '';

      for(let i=0;i<offset;i++){
        const el=document.createElement('div'); el.className='cal-day empty'; grid.appendChild(el);
      }

      for(let d=1;d<=diasMes;d++){
        const fk       = fechaKey(d,mes,anio);
        const citasDia = CITAS.filter(c=>c.fecha===fk);
        const diaDate  = new Date(anio,mes,d);
        const esPasado = diaDate < hoy1;
        const esHoy    = diaDate.getTime()===hoy1.getTime();

        const el = document.createElement('div');
        el.className = 'cal-day'
          + (citasDia.length ? ' has-ev' : '')
          + (esHoy           ? ' today'  : '')
          + (esPasado && !esHoy ? ' past' : '')
          + (selKey===fk     ? ' selected' : '');

        const num = document.createElement('span');
        num.className='cal-num'; num.textContent=d; el.appendChild(num);

        // Pills — máx 2 en escritorio
        const max=2;
        citasDia.slice(0,max).forEach(c=>{
          const ev=document.createElement('span');
          ev.className='cal-ev '+claseEv(c.estado);
          ev.textContent=(c.hora?c.hora+' ':'')+c.nombre;
          ev.title=c.nombre+' — '+c.servicio+(c.hora?' ('+c.hora+')':'');
          el.appendChild(ev);
        });
        if(citasDia.length>max){
          const more=document.createElement('span');
          more.className='cal-more';
          more.textContent='+'+(citasDia.length-max)+' más';
          el.appendChild(more);
        }

        // Puntos móvil
        if(citasDia.length){
          const dots=document.createElement('div'); dots.className='cal-dots';
          citasDia.slice(0,5).forEach(c=>{
            const dot=document.createElement('span');
            dot.className='cal-dot'; dot.style.background=colEv[claseEv(c.estado)];
            dots.appendChild(dot);
          });
          el.appendChild(dots);
        }

        if(citasDia.length){
          el.addEventListener('click',()=>mostrarPanel(fk,citasDia,esHoy));
        }
        grid.appendChild(el);
      }
    }

    function mostrarPanel(fecha,citas,esHoy){
      selKey=fecha;
      renderCal(); // re-render para marcar selected
      const [d,m,a]=fecha.split('/');
      const fechaLarga=new Date(a,m-1,d).toLocaleDateString('es',{weekday:'long',day:'numeric',month:'long'});
      const label=fechaLarga.charAt(0).toUpperCase()+fechaLarga.slice(1);
      document.getElementById('day-panel-title').textContent=label+(esHoy?' (hoy)':'');
      document.getElementById('day-panel-sub').textContent=citas.length+' cita'+(citas.length!==1?'s':'')+' agendada'+(citas.length!==1?'s':'');
      const sorted=[...citas].sort((a,b)=>(a.hora||'').localeCompare(b.hora||''));
      const lista=document.getElementById('day-panel-list');
      lista.innerHTML=sorted.map(c=>{
        const cls=claseEv(c.estado);
        return \`<div class="day-item">
          <span class="day-hour">\${c.hora||'--:--'}</span>
          <div class="day-info">
            <div class="day-name">\${c.nombre}</div>
            <div class="day-svc">\${c.servicio||'—'}</div>
          </div>
          <span class="day-badge" style="background:\${bgBadge[cls]};color:\${txBadge[cls]}">\${lblEv[cls]}</span>
        </div>\`;
      }).join('');
      // En móvil, hacer scroll al panel
      if(window.innerWidth<780) document.getElementById('day-panel').scrollIntoView({behavior:'smooth',block:'start'});
    }

    function cambiarMes(delta){
      mes+=delta; selKey=null;
      if(mes<0){mes=11;anio--;} if(mes>11){mes=0;anio++;}
      document.getElementById('day-panel-title').textContent='Selecciona un día';
      document.getElementById('day-panel-sub').textContent='Toca un día con citas para ver el detalle';
      document.getElementById('day-panel-list').innerHTML='<div class="day-panel-empty">📅 Ningún día seleccionado</div>';
      renderCal();
    }

    renderCal();
    // Abrir automáticamente el día de hoy si tiene citas
    (function(){
      const hoyKey=fechaKey(HOY.getDate(),HOY.getMonth(),HOY.getFullYear());
      const citasHoy=CITAS.filter(c=>c.fecha===hoyKey);
      if(citasHoy.length) mostrarPanel(hoyKey,citasHoy,true);
    })();
  </script>
${htmlFooter}</body></html>`;
}

// ── Render: Cliente — Estado WhatsApp (QR / Cargando) ────────────────────────
function renderClienteEstado(cliente, inst) {
  const botonCambiar = `<form method="POST" action="/cambiar-numero" style="margin-top:10px"
      onsubmit="return confirm('¿Desconectar número actual y vincular uno nuevo?')">
    <button class="btn btn-danger" style="width:100%;justify-content:center">🔄 Cambiar número</button>
  </form>`;

  if (!inst?.qrDataUrl) return `<!DOCTYPE html><html lang="es"><head>
  <meta charset="utf-8"><title>${escHtml(cliente.nombre)} — Conectando</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="5">${css}
</head><body>${navCliente('estado',cliente.nombre)}
  <div class="page-center"><div class="card" style="padding:40px 32px;text-align:center;max-width:420px;width:100%">
    <div style="font-size:48px;margin-bottom:12px">⏳</div>
    <h2 style="font-size:20px;margin-bottom:8px">Generando QR...</h2>
    <p style="color:#64748b;margin-bottom:24px">La página se actualizará en unos segundos.</p>
    ${botonCambiar}
  </div></div>
${htmlFooter}</body></html>`;

  return `<!DOCTYPE html><html lang="es"><head>
  <meta charset="utf-8"><title>${escHtml(cliente.nombre)} — Escanea QR</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="30">${css}
  <style>.qr-img{width:260px;max-width:100%;border:1px solid #e2e8f0;border-radius:12px;padding:12px;background:#fff}</style>
</head><body>${navCliente('estado',cliente.nombre)}
  <div class="page-center"><div class="card" style="padding:36px 32px;text-align:center;max-width:420px;width:100%">
    <div style="font-size:40px;margin-bottom:12px">📱</div>
    <h1 style="font-size:20px;margin-bottom:6px">Escanea el QR con WhatsApp</h1>
    <p style="color:#64748b;font-size:14px;margin-bottom:20px">WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${inst.qrDataUrl}" class="qr-img" alt="QR">
    <p style="color:#94a3b8;font-size:12px;margin-top:14px">Se recarga cada 30 s · El QR expira cada ~20 s</p>
    <div style="margin-top:16px">${botonCambiar}</div>
  </div></div>
${htmlFooter}</body></html>`;
}

// ── Render: Cliente — Citas ───────────────────────────────────────────────────
function renderClienteCitas(citas, cliente, inst) {
  // Ordenar ascendente: fecha más cercana primero, luego por hora
  const sorted = [...citas].sort((a, b) => {
    const df = fechaSort(a.fecha) - fechaSort(b.fecha);
    return df !== 0 ? df : (a.hora || '').localeCompare(b.hora || '');
  });
  citas = sorted;

  const conectado = inst?.conectado;
  const pend = citas.filter(c => !c.confirmacion || c.confirmacion === '').length;
  const filas = citas.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:32px">No hay citas — <a href="/nueva-cita">Agregar una</a></td></tr>`
    : citas.map(c => {
        const btn = (!c.confirmacion || c.confirmacion === '') && conectado
          ? `<form method="POST" action="/enviar-cita" style="margin:0">
               <input type="hidden" name="rowIndex" value="${c.rowIndex}">
               <button onclick="return confirm('¿Enviar mensaje a ${escHtml(c.nombre)}?')" class="btn btn-primary btn-sm">Enviar</button>
             </form>` : '';
        return `<tr>
          <td data-label="Nombre">${escHtml(c.nombre)}</td>
          <td data-label="Teléfono">${escHtml(c.telefono)}</td>
          <td data-label="Fecha" style="white-space:nowrap">${escHtml(c.fecha)}</td>
          <td data-label="Hora">${escHtml(c.hora)}</td>
          <td data-label="Servicio">${escHtml(c.servicio)}</td>
          <td data-label="Estado">${badgeEstado(c.confirmacion)}</td>
          <td data-label="Acción">${btn}</td>
        </tr>`;
      }).join('');

  return `<!DOCTYPE html><html lang="es"><head>
  <meta charset="utf-8"><title>${escHtml(cliente.nombre)} — Citas</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="30">${css}
</head><body>${navCliente('citas',cliente.nombre)}
  <div class="container">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <h1 style="font-size:20px;font-weight:700">📋 Citas <span style="color:#94a3b8;font-weight:400">(${citas.length})</span></h1>
        <a href="/nueva-cita" class="btn btn-primary btn-sm">+ Nueva</a>
        <a href="/importar" class="btn btn-ghost btn-sm">📥 Importar</a>
      </div>
      ${pend > 0 && conectado ? `<form method="POST" action="/enviar-todo"
          onsubmit="return confirm('¿Enviar a los ${pend} contacto(s) sin enviar?')">
          <button class="btn btn-success">📤 Enviar a los ${pend} pendientes</button>
        </form>` : ''}
    </div>
    ${!conectado ? `<div class="alert alert-warn">⚠️ WhatsApp no está conectado — <a href="/">Conectar →</a></div>` : ''}
    <div class="card tbl-wrap">
      <table><thead><tr><th>Nombre</th><th>Teléfono</th><th>Fecha</th><th>Hora</th><th>Servicio</th><th>Estado</th><th>Acción</th></tr></thead>
      <tbody>${filas}</tbody></table>
    </div>
    <p style="color:#94a3b8;font-size:12px;margin-top:10px">Se actualiza automáticamente cada 30 s</p>
  </div>
${htmlFooter}</body></html>`;
}

// ── Render: Cliente — Nueva Cita ──────────────────────────────────────────────
function renderClienteNuevaCita(cliente, flash = '') {
  const [ft,fm] = flash ? flash.split('|') : [];
  return `<!DOCTYPE html><html lang="es"><head>
  <meta charset="utf-8"><title>${escHtml(cliente.nombre)} — Nueva cita</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">${css}
</head><body>${navCliente('nueva',cliente.nombre)}
  <div class="container" style="max-width:680px">
    <h1 style="font-size:20px;font-weight:700;margin-bottom:20px">➕ Nueva cita</h1>
    ${fm ? `<div class="alert alert-${ft}">${escHtml(fm)}</div>` : ''}
    <div class="card" style="padding:28px 24px">
      <form method="POST" action="/nueva-cita">
        <div class="form-grid">
          <div class="field"><label>Nombre completo *</label><input type="text" name="nombre" required placeholder="Ej: María García"></div>
          <div class="field"><label>Teléfono *</label><input type="tel" name="telefono" required placeholder="Ej: 3001234567"></div>
          <div class="field"><label>Fecha *</label><input type="date" name="fecha" required></div>
          <div class="field"><label>Hora *</label><input type="time" name="hora" required></div>
          <div class="field full"><label>Servicio *</label><input type="text" name="servicio" required placeholder="Ej: Corte de cabello"></div>
        </div>
        <div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap">
          <button type="submit" class="btn btn-primary">Guardar cita</button>
          <a href="/citas" class="btn btn-ghost">Cancelar</a>
        </div>
      </form>
    </div>
  </div>
${htmlFooter}</body></html>`;
}

// ── Render: Cliente — Importar ────────────────────────────────────────────────
function renderClienteImportar(cliente, flash = '') {
  const [ft,fm] = flash ? flash.split('|') : [];
  return `<!DOCTYPE html><html lang="es"><head>
  <meta charset="utf-8"><title>${escHtml(cliente.nombre)} — Importar</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">${css}
  <style>.example{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;font-family:monospace;font-size:12px;color:#475569;white-space:pre;overflow-x:auto}</style>
  <script>function leer(e){const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>document.getElementById('csv').value=ev.target.result;r.readAsText(f,'UTF-8');}</script>
</head><body>${navCliente('importar',cliente.nombre)}
  <div class="container" style="max-width:720px">
    <h1 style="font-size:20px;font-weight:700;margin-bottom:8px">📥 Importar citas desde CSV</h1>
    <p style="color:#64748b;font-size:14px;margin-bottom:20px">Descarga la plantilla, llénala y pégala aquí, o selecciona el archivo.</p>
    ${fm ? `<div class="alert alert-${ft}">${escHtml(fm)}</div>` : ''}
    <div class="card" style="padding:28px 24px">
      <p style="font-size:13px;font-weight:600;color:#475569;margin-bottom:8px">Formato esperado:</p>
      <div class="example">Nombre,Teléfono,Fecha,Hora,Servicio
María García,3001234567,25/04/2026,10:00,Corte de cabello</div>
      <a href="/plantilla.csv" class="btn btn-ghost btn-sm" style="margin:10px 0;display:inline-flex">⬇ Descargar plantilla</a>
      <form method="POST" action="/importar" style="margin-top:8px">
        <div style="margin-bottom:12px"><label>Seleccionar archivo CSV</label>
          <input type="file" accept=".csv,text/csv" onchange="leer(event)" style="border:none;background:transparent;padding:8px 0">
        </div>
        <div style="margin-bottom:18px"><label for="csv">O pegar contenido CSV</label>
          <textarea id="csv" name="csv" rows="8" placeholder="Nombre,Teléfono,Fecha,Hora,Servicio&#10;..."></textarea>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button type="submit" class="btn btn-success">Importar citas</button>
          <a href="/citas" class="btn btn-ghost">Cancelar</a>
        </div>
      </form>
    </div>
  </div>
${htmlFooter}</body></html>`;
}

// ── Render: Cliente — Configuración ──────────────────────────────────────────
function renderClienteConfiguracion(cliente, flash = '') {
  const [ft,fm] = flash ? flash.split('|') : [];
  const c = cliente;
  return `<!DOCTYPE html><html lang="es"><head>
  <meta charset="utf-8"><title>${escHtml(c.nombre)} — Configuración</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">${css}
</head><body>${navCliente('config',c.nombre)}
  <div class="container" style="max-width:760px">
    <h1 style="font-size:20px;font-weight:700;margin-bottom:20px">⚙️ Configuración</h1>
    ${fm ? `<div class="alert alert-${ft}">${escHtml(fm)}</div>` : ''}
    <form method="POST" action="/configuracion">
      <div class="card" style="padding:24px;margin-bottom:16px">
        <p style="font-size:12px;font-weight:700;color:#94a3b8;margin-bottom:14px;letter-spacing:.08em">RECORDATORIOS</p>
        <div class="form-grid">
          <div class="field"><label>Hora de envío</label><input type="time" name="sendHour" value="${escHtml(c.sendHour||'09:00')}"></div>
          <div class="field"><label>Días de anticipación</label>
            <select name="daysBefore">
              ${[0,1,2,3].map(n=>`<option value="${n}" ${(parseInt(c.daysBefore)||1)===n?'selected':''}>${n===0?'Mismo día':`${n} día${n>1?'s':''} antes`}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div class="card" style="padding:24px;margin-bottom:16px">
        <p style="font-size:12px;font-weight:700;color:#94a3b8;margin-bottom:4px;letter-spacing:.08em">MENSAJES</p>
        <p style="font-size:12px;color:#94a3b8;margin-bottom:16px">Variables disponibles: {nombre} {dia} {hora} {servicio}</p>
        <div style="display:flex;flex-direction:column;gap:16px">
          <div class="field"><label>Mensaje de recordatorio</label><textarea name="messageTemplate" rows="4">${escHtml(c.messageTemplate||DEFAULTS.messageTemplate)}</textarea></div>
          <div class="field"><label>Cuando confirman</label><textarea name="confirmMessage" rows="3">${escHtml(c.confirmMessage||DEFAULTS.confirmMessage)}</textarea></div>
          <div class="field"><label>Cuando cancelan</label><textarea name="cancelMessage" rows="3">${escHtml(c.cancelMessage||DEFAULTS.cancelMessage)}</textarea></div>
          <div class="field"><label>Respuesta no entendida</label><textarea name="unknownMessage" rows="2">${escHtml(c.unknownMessage||DEFAULTS.unknownMessage)}</textarea></div>
        </div>
      </div>
      <button type="submit" class="btn btn-primary">Guardar cambios</button>
    </form>
  </div>
${htmlFooter}</body></html>`;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const servidor = http.createServer(async (req, res) => {
  const rawUrl = req.url || '/';
  const url    = rawUrl.split('?')[0];
  const flash  = new URLSearchParams(rawUrl.split('?')[1] || '').get('flash') || '';

  // Públicas
  if (url === '/login' && req.method === 'GET')  { html(res, renderLogin()); return; }
  if (url === '/login' && req.method === 'POST') {
    const { user = '', pass = '' } = await parsearBody(req);
    if (credencialesAdmin(user, pass)) {
      const token = crearSesion('admin');
      res.writeHead(302, { Location: '/admin', 'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=28800` });
      res.end(); return;
    }
    const cliente = obtenerClientePorUsuario(user);
    if (cliente && cliente.password === pass) {
      const token = crearSesion('client', cliente.id);
      res.writeHead(302, { Location: '/', 'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=28800` });
      res.end(); return;
    }
    html(res, renderLogin('Usuario o contraseña incorrectos')); return;
  }
  if (url === '/logout' && req.method === 'POST') {
    const t = parseCookies(req).session;
    if (t) sesiones.delete(t);
    res.writeHead(302, { Location: '/login', 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0' });
    res.end(); return;
  }

  const sesion = obtenerSesion(req);
  if (!sesion) { redir(res, '/login'); return; }

  if (sesion.role === 'admin') { await handleAdmin(req, res, url, flash); return; }

  const cliente = obtenerCliente(sesion.clientId);
  if (!cliente) {
    const t = parseCookies(req).session; if (t) sesiones.delete(t);
    redir(res, '/login'); return;
  }
  await handleCliente(req, res, url, flash, cliente);
});

// ── Admin Routes ──────────────────────────────────────────────────────────────
async function handleAdmin(req, res, url, flash) {
  const m = url.match(/^\/admin\/clientes\/([^/]+)(\/.*)?$/);

  if ((url === '/admin' || url === '/admin/clientes') && req.method === 'GET') {
    html(res, renderAdminDashboard(cargarClientes())); return;
  }
  if (url === '/admin/clientes/nuevo' && req.method === 'GET') {
    html(res, renderAdminFormCliente(null, flash)); return;
  }
  if (url === '/admin/clientes/nuevo' && req.method === 'POST') {
    const body = await parsearBody(req);
    try {
      const nuevo = crearCliente(body);
      inicializarInstancia(nuevo);
      redir(res, '/admin');
    } catch (err) {
      redir(res, `/admin/clientes/nuevo?flash=err|${encodeURIComponent(err.message)}`);
    }
    return;
  }
  if (m && !m[2] && req.method === 'GET') {
    const c = obtenerCliente(m[1]);
    if (!c) { redir(res, '/admin'); return; }
    html(res, renderAdminFormCliente(c, flash)); return;
  }
  if (m && !m[2] && req.method === 'POST') {
    const id = m[1]; const body = await parsearBody(req);
    if (!body.password) delete body.password;
    try {
      actualizarCliente(id, body);
      reiniciarCron(id);
      redir(res, `/admin/clientes/${id}?flash=ok|Cambios guardados`);
    } catch (err) {
      redir(res, `/admin/clientes/${id}?flash=err|${encodeURIComponent(err.message)}`);
    }
    return;
  }
  if (m && m[2] === '/eliminar' && req.method === 'POST') {
    await destruirInstancia(m[1]);
    eliminarCliente(m[1]);
    redir(res, '/admin'); return;
  }
  if (m && m[2] === '/wa/reset' && req.method === 'POST') {
    await reiniciarWA(m[1]);
    redir(res, `/admin/clientes/${m[1]}?flash=ok|WhatsApp reiniciado`); return;
  }
  redir(res, '/admin');
}

// ── Client Routes ─────────────────────────────────────────────────────────────
async function handleCliente(req, res, url, flash, cliente) {
  const inst   = instancias.get(cliente.id);
  const sheets = () => crearSheetsInterface(cliente.googleScriptUrl, cliente.countryCode);

  if (url === '/' && req.method === 'GET') {
    if (inst?.conectado) {
      try { html(res, renderClienteDashboard(cliente, inst, await sheets().getCitas())); }
      catch { html(res, renderClienteDashboard(cliente, inst, [])); }
    } else {
      html(res, renderClienteEstado(cliente, inst));
    }
    return;
  }

  if (url === '/citas' && req.method === 'GET') {
    try { html(res, renderClienteCitas(await sheets().getCitas(), cliente, inst)); }
    catch (e) { html(res, `<p style="padding:24px">Error: ${escHtml(e.message)} — <a href="/citas">Reintentar</a></p>`); }
    return;
  }
  if (url === '/status') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ conectado: inst?.conectado || false })); return;
  }
  if (url === '/plantilla.csv') {
    const csv = 'Nombre,Teléfono,Fecha,Hora,Servicio\r\nEjemplo,3001234567,25/04/2026,10:00,Servicio\r\n';
    res.writeHead(200, {'Content-Type':'text/csv;charset=utf-8','Content-Disposition':'attachment;filename="plantilla-citas.csv"'});
    res.end('\uFEFF' + csv); return;
  }
  if (url === '/nueva-cita' && req.method === 'GET') { html(res, renderClienteNuevaCita(cliente, flash)); return; }
  if (url === '/nueva-cita' && req.method === 'POST') {
    const b = await parsearBody(req);
    if (!b.nombre || !b.telefono || !b.fecha || !b.hora || !b.servicio) {
      redir(res, '/nueva-cita?flash=err|Todos los campos son obligatorios'); return;
    }
    try {
      await sheets().agregarCita({ nombre: b.nombre, telefono: b.telefono, fecha: convertirFecha(b.fecha), hora: b.hora, servicio: b.servicio });
      redir(res, `/nueva-cita?flash=ok|Cita de ${encodeURIComponent(b.nombre)} guardada`);
    } catch (e) { redir(res, `/nueva-cita?flash=err|${encodeURIComponent(e.message)}`); }
    return;
  }
  if (url === '/importar' && req.method === 'GET') { html(res, renderClienteImportar(cliente, flash)); return; }
  if (url === '/importar' && req.method === 'POST') {
    const { csv = '' } = await parsearBody(req);
    if (!csv.trim()) { redir(res, '/importar?flash=err|Sin contenido CSV'); return; }
    const citas = parsearCSV(csv);
    if (!citas.length) { redir(res, '/importar?flash=err|Sin filas válidas (verifica el formato)'); return; }
    try {
      const n = await sheets().agregarCitas(citas);
      redir(res, `/importar?flash=ok|${n} cita(s) importadas`);
    } catch (e) { redir(res, `/importar?flash=err|${encodeURIComponent(e.message)}`); }
    return;
  }
  if (url === '/configuracion' && req.method === 'GET') { html(res, renderClienteConfiguracion(cliente, flash)); return; }
  if (url === '/configuracion' && req.method === 'POST') {
    const b = await parsearBody(req);
    const campos = ['sendHour','daysBefore','messageTemplate','confirmMessage','cancelMessage','unknownMessage'];
    try {
      actualizarCliente(cliente.id, Object.fromEntries(campos.map(k => [k, b[k]||''])));
      reiniciarCron(cliente.id);
      redir(res, '/configuracion?flash=ok|Configuración guardada');
    } catch (e) { redir(res, `/configuracion?flash=err|${encodeURIComponent(e.message)}`); }
    return;
  }
  if (url === '/cambiar-numero' && req.method === 'POST') {
    redir(res, '/'); setTimeout(() => reiniciarWA(cliente.id), 400); return;
  }
  if (url === '/enviar-todo' && req.method === 'POST') {
    redir(res, '/citas');
    if (!inst?.conectado) return;
    setTimeout(async () => {
      try {
        const citas = await sheets().getCitas();
        const pend  = citas.filter(c => !c.confirmacion || c.confirmacion === '');
        let n = 0;
        for (const cita of pend) {
          try { await enviarMensajeACita(cliente.id, cita, sheets()); n++; await sleep(2000); }
          catch (e) { console.error(`[${cliente.id}] Error enviando ${cita.nombre}:`, e.message); }
        }
        console.log(`[${cliente.id}] Envío masivo: ${n}/${pend.length}`);
      } catch (e) { console.error(`[${cliente.id}] Error envío masivo:`, e.message); }
    }, 200);
    return;
  }
  if (url === '/enviar-cita' && req.method === 'POST') {
    const { rowIndex } = await parsearBody(req);
    const ri = parseInt(rowIndex);
    redir(res, '/citas');
    if (!inst?.conectado || isNaN(ri)) return;
    setTimeout(async () => {
      try {
        const cita = (await sheets().getCitas()).find(c => c.rowIndex === ri);
        if (cita) await enviarMensajeACita(cliente.id, cita, sheets());
      } catch (e) { console.error(`[${cliente.id}] Error envío individual:`, e.message); }
    }, 200);
    return;
  }
  redir(res, '/');
}

// ── WhatsApp: gestión de instancias ──────────────────────────────────────────
function inicializarInstancia(clienteConfig) {
  const id = clienteConfig.id;
  if (instancias.has(id)) return instancias.get(id);

  const inst = { client: null, qrDataUrl: null, conectado: false, citasPendientes: new Map(), cronJob: null };
  instancias.set(id, inst);

  const wa = new Client({
    authStrategy: new LocalAuth({ clientId: `citas-${id}` }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-accelerated-2d-canvas','--no-first-run','--no-zygote','--disable-gpu'] },
  });
  inst.client = wa;

  wa.on('qr', async qr => {
    console.log(`\n📱 [${id}] QR generado`);
    qrcode.generate(qr, { small: true });
    try { inst.qrDataUrl = await QRCode.toDataURL(qr); } catch (e) { console.error(`[${id}] QR img error:`, e.message); }
  });

  wa.on('ready', async () => {
    inst.conectado = true; inst.qrDataUrl = null;
    console.log(`\n✅ [${id}] WhatsApp conectado`);
    const cfg = obtenerCliente(id); if (!cfg) return;
    try {
      const sh = crearSheetsInterface(cfg.googleScriptUrl, cfg.countryCode);
      await sh.verificarEstructura().catch(() => {});
      await cargarCitasPendientesInst(id, sh);
    } catch (e) {
      console.warn(`[${id}] Sin Google Sheet configurado — citasPendientes vacío:`, e.message);
    }
    iniciarCron(id);
  });

  wa.on('message', async msg => {
    try {
      console.log(`[${id}] 📨 RAW msg.from=${msg.from} fromMe=${msg.fromMe} isGroup=${msg.from.endsWith('@g.us')} body="${msg.body?.trim()?.substring(0,30)}"`);
      // Ignorar grupos y mensajes vacíos
      if (msg.fromMe || msg.from.endsWith('@g.us') || !msg.body?.trim()) return;
      const cfg = obtenerCliente(id); if (!cfg) return;
      const inst2 = instancias.get(id);
      console.log(`[${id}] 📋 citasPendientes.size=${inst2?.citasPendientes?.size} keys=[${[...(inst2?.citasPendientes?.keys()||[])].join(', ')}]`);
      let sh = null;
      try { sh = crearSheetsInterface(cfg.googleScriptUrl, cfg.countryCode); } catch {}
      await manejarMensaje(id, msg, cfg, sh);
    } catch (e) {
      console.error(`[${id}] Error procesando mensaje:`, e.message);
    }
  });

  wa.on('disconnected', reason => {
    console.log(`⚠️ [${id}] Desconectado: ${reason}`);
    inst.conectado = false; inst.qrDataUrl = null;
    if (inst.cronJob) { inst.cronJob.stop(); inst.cronJob = null; }
    if (reason !== 'LOGOUT') {
      setTimeout(() => wa.initialize().catch(e => console.error(`[${id}] Error reiniciando:`, e.message)), 2000);
    }
  });

  wa.initialize().catch(e => console.error(`[${id}] Error iniciando:`, e.message));
  return inst;
}

async function destruirInstancia(id) {
  const inst = instancias.get(id); if (!inst) return;
  if (inst.cronJob) inst.cronJob.stop();
  try { await inst.client.destroy(); } catch {}
  instancias.delete(id);
}

async function reiniciarWA(id) {
  const inst = instancias.get(id); if (!inst) return;
  inst.conectado = false; inst.qrDataUrl = null; inst.citasPendientes.clear();
  if (inst.cronJob) { inst.cronJob.stop(); inst.cronJob = null; }
  try { await inst.client.logout(); } catch {}
  setTimeout(() => inst.client.initialize().catch(e => console.error(`[${id}] Error reiniciando:`, e.message)), 3000);
}

function reiniciarCron(id) {
  const inst = instancias.get(id);
  if (!inst?.conectado) return;
  if (inst.cronJob) { inst.cronJob.stop(); inst.cronJob = null; }
  iniciarCron(id);
}

function iniciarCron(id) {
  const inst = instancias.get(id); if (!inst) return;
  if (inst.cronJob) inst.cronJob.stop();
  const cfg = obtenerCliente(id); if (!cfg) return;
  const [hh, mm] = (cfg.sendHour || '09:00').split(':');
  inst.cronJob = cron.schedule(`${parseInt(mm)} ${parseInt(hh)} * * *`, async () => {
    const c = obtenerCliente(id); if (!c || !inst.conectado) return;
    console.log(`\n[${id}] Enviando recordatorios programados...`);
    try {
      const sh  = crearSheetsInterface(c.googleScriptUrl, c.countryCode);
      const msg = crearMensajesInterface(c);
      const hoy = (await sh.getCitas()).filter(x => (!x.confirmacion || x.confirmacion === '') && msg.debeEnviarHoy(x));
      let n = 0;
      for (const cita of hoy) {
        try { await enviarMensajeACita(id, cita, sh); n++; await sleep(2000); }
        catch (e) { console.error(`[${id}] Cron error ${cita.nombre}:`, e.message); }
      }
      console.log(`[${id}] Recordatorios enviados: ${n}/${hoy.length}`);
    } catch (e) { console.error(`[${id}] Cron error:`, e.message); }
  }, { timezone: cfg.timezone || 'America/Bogota' });
}

// ── Lógica de negocio ─────────────────────────────────────────────────────────
async function enviarMensajeACita(clienteId, cita, sh) {
  const inst = instancias.get(clienteId); if (!inst?.client) throw new Error('WA no disponible');
  const cfg  = obtenerCliente(clienteId);
  const msg  = crearMensajesInterface(cfg);
  const nid  = await inst.client.getNumberId(cita.telefono);
  if (!nid) { await sh.actualizarConfirmacion(cita.rowIndex, 'NUMERO_INVALIDO'); throw new Error(`Número no encontrado: ${cita.telefono}`); }
  // Usar @c.us porque msg.from siempre llega en ese formato (nid._serialized puede ser @lid en versiones nuevas de WA)
  const waId = `${cita.telefono}@c.us`;
  await inst.client.sendMessage(nid._serialized, msg.getMensajeCita(cita));
  inst.citasPendientes.set(waId, cita);
  console.log(`   [${clienteId}] ✉️ Enviado a ${cita.nombre} — waId guardado: ${waId} (total pendientes: ${inst.citasPendientes.size})`);
  try { await sh.marcarComoEnviado(cita.rowIndex); }
  catch (e) { console.error(`[${clienteId}] Error marcando enviado en Sheet:`, e.message); }
}

async function cargarCitasPendientesInst(clienteId, sh) {
  const inst = instancias.get(clienteId); if (!inst) return;
  try {
    const citas = await sh.getCitas();
    let n = 0;
    for (const c of citas.filter(x => x.confirmacion === 'ENVIADO')) {
      const waId = `${c.telefono}@c.us`;
      inst.citasPendientes.set(waId, c); n++;
    }
    if (n) console.log(`[${clienteId}] ${n} cita(s) pendiente(s) cargada(s)`);
  } catch (e) { console.error(`[${clienteId}] Error cargando pendientes:`, e.message); }
}

async function manejarMensaje(clienteId, msg, cfg, sh) {
  const inst = instancias.get(clienteId); if (!inst) return;
  const texto = msg.body.trim();
  console.log(`[${clienteId}] 📩 ${msg.from}: "${texto}"`);

  const cita = inst.citasPendientes.get(msg.from);
  if (!cita) {
    console.log(`[${clienteId}] ℹ️ Sin cita pendiente para: ${msg.from}`);
    if (inst.citasPendientes.size > 0) {
      console.log(`[${clienteId}] 📋 IDs en espera: ${[...inst.citasPendientes.keys()].join(' | ')}`);
    }
    return;
  }

  const m   = crearMensajesInterface(cfg);
  const int = interpretarRespuesta(texto);

  async function actualizarSheet(rowIndex, estado) {
    if (!sh) { console.warn(`[${clienteId}] Sin Sheets — no se actualizó fila ${rowIndex}`); return; }
    try { await sh.actualizarConfirmacion(rowIndex, estado); }
    catch (e) { console.error(`[${clienteId}] Error actualizando Sheet:`, e.message); }
  }

  if (int === 'CONFIRMAR') {
    await inst.client.sendMessage(msg.from, m.getMensajeConfirmacion(cita));
    await actualizarSheet(cita.rowIndex, 'CONFIRMADO');
    inst.citasPendientes.delete(msg.from);
    console.log(`[${clienteId}] ✅ Confirmada: ${cita.nombre}`);
  } else if (int === 'CANCELAR') {
    await inst.client.sendMessage(msg.from, m.getMensajeCancelacion(cita));
    await actualizarSheet(cita.rowIndex, 'CANCELADO');
    inst.citasPendientes.delete(msg.from);
    console.log(`[${clienteId}] ❌ Cancelada: ${cita.nombre}`);
  } else {
    await inst.client.sendMessage(msg.from, m.getMensajeNoEntendido());
    console.log(`[${clienteId}] ❓ No entendido de ${cita.nombre}`);
  }
}

// ── Arranque ──────────────────────────────────────────────────────────────────
servidor.listen(QR_PORT, () => {
  console.log(`🌐 Servidor activo en el puerto ${QR_PORT}`);
  console.log(`   Admin: http://<IP>:${QR_PORT}/login\n`);
});

const clientes = cargarClientes();
console.log(`🔄 Inicializando ${clientes.length} cliente(s)...`);
for (const c of clientes) inicializarInstancia(c);
