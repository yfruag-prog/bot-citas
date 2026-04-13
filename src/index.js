// src/index.js
// Bot principal de WhatsApp para confirmación de citas

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');
const crypto = require('crypto');
const cron = require('node-cron');
const moment = require('moment-timezone');

const { getCitas, actualizarConfirmacion, marcarComoEnviado, verificarEstructura, agregarCita, agregarCitas } = require('./sheets');
const {
  getMensajeCita,
  getMensajeConfirmacion,
  getMensajeCancelacion,
  getMensajeNoEntendido,
  debeEnviarHoy,
  interpretarRespuesta,
} = require('./mensajes');

const TIMEZONE = process.env.TIMEZONE || 'America/Mexico_City';
const QR_PORT = process.env.QR_PORT || 3000;

// Mapa en memoria: teléfono → datos de la cita (para respuestas automáticas)
const citasPendientes = new Map();

// =============================================
// SERVIDOR WEB PARA VER EL QR POR NAVEGADOR
// =============================================

let qrDataUrl = null;   // QR como imagen base64
let botConectado = false;

// ── Sesiones ──────────────────────────────────────────────────────────────

const sesiones = new Map(); // token → expiry timestamp

function crearSesion() {
  const token = crypto.randomBytes(32).toString('hex');
  sesiones.set(token, Date.now() + 8 * 60 * 60 * 1000); // 8 horas
  return token;
}

function sesionValida(req) {
  const token = parseCookies(req).session;
  if (!token) return false;
  const expiry = sesiones.get(token);
  if (!expiry || Date.now() > expiry) { sesiones.delete(token); return false; }
  return true;
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(par => {
    const [k, ...v] = par.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}

function credencialesValidas(user, pass) {
  const u = process.env.PANEL_USER     || 'admin';
  const p = process.env.PANEL_PASSWORD || 'admin123';
  // Comparación en tiempo constante para evitar timing attacks
  try {
    const okU = crypto.timingSafeEqual(Buffer.from(user), Buffer.from(u));
    const okP = crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(p));
    return okU && okP;
  } catch { return false; }
}

// ── CSS compartido ────────────────────────────────────────────────────────
const css = `<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;color:#0f172a;line-height:1.5}
a{color:inherit}
/* Nav */
.nav{background:#0f172a;padding:0 24px;display:flex;align-items:center;height:56px;gap:20px;position:sticky;top:0;z-index:10}
.nav-brand{color:#fff;font-weight:700;font-size:15px;white-space:nowrap}
.nav-link{color:#94a3b8;text-decoration:none;font-size:14px;padding:18px 0;border-bottom:2px solid transparent;transition:color .15s}
.nav-link:hover{color:#e2e8f0}
.nav-link.active{color:#fff;border-bottom-color:#3b82f6}
.nav-end{margin-left:auto}
/* Botones */
.btn{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;text-decoration:none;transition:filter .15s;white-space:nowrap}
.btn:hover{filter:brightness(1.1)}
.btn-primary{background:#3b82f6;color:#fff}
.btn-success{background:#16a34a;color:#fff}
.btn-danger{background:#ef4444;color:#fff}
.btn-ghost{background:transparent;color:#64748b;font-size:13px;padding:6px 0}
.btn-sm{padding:6px 14px;font-size:13px}
/* Layout */
.container{max-width:980px;margin:0 auto;padding:28px 20px}
.page-center{display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 56px);padding:24px}
/* Card */
.card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
/* Badge */
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:500;white-space:nowrap}
/* Alerta */
.alert{padding:12px 16px;border-radius:8px;font-size:14px;margin-bottom:16px}
.alert-warn{background:#fef9c3;border:1px solid #fde047}
/* Tabla */
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:14px;min-width:640px}
thead tr{background:#f8fafc}
th{padding:11px 14px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
td{padding:11px 14px;border-top:1px solid #f1f5f9;vertical-align:middle}
tbody tr:hover td{background:#f8fafc}
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
  .nav{padding:0 14px;gap:14px}
  .container{padding:16px 14px}
  .page-center{padding:16px}
  .btn{padding:9px 16px}
  .stack-mobile{flex-direction:column;align-items:stretch}
  .stack-mobile .btn{justify-content:center}
}
</style>`;

function renderLogin(error = '') {
  return `<!DOCTYPE html>
<html lang="es"><head>
  <meta charset="utf-8">
  <title>Bot Citas — Acceso</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${css}
  <style>
    body{display:flex;align-items:center;justify-content:center;min-height:100vh}
    .login{background:#fff;border-radius:16px;padding:40px 36px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,.1)}
    .login h1{font-size:22px;text-align:center;margin-bottom:4px}
    .login .sub{color:#64748b;text-align:center;font-size:14px;margin-bottom:28px}
    .field{margin-bottom:16px}
    label{display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:6px}
    input[type=text],input[type=password]{width:100%;padding:11px 14px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:15px;outline:none;transition:border-color .2s}
    input:focus{border-color:#3b82f6}
    .btn-login{width:100%;padding:12px;background:#0f172a;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;margin-top:4px;transition:background .2s}
    .btn-login:hover{background:#1e293b}
    .err{background:#fee2e2;color:#b91c1c;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px}
    @media(max-width:440px){.login{padding:28px 18px;border-radius:0;min-height:100vh;justify-content:center;display:flex;flex-direction:column}}
  </style>
</head>
<body>
  <div class="login">
    <h1>🤖 Bot Citas</h1>
    <p class="sub">Panel de administración</p>
    ${error ? `<div class="err">${escHtml(error)}</div>` : ''}
    <form method="POST" action="/login">
      <div class="field">
        <label for="u">Usuario</label>
        <input type="text" id="u" name="user" required autofocus autocomplete="username">
      </div>
      <div class="field">
        <label for="p">Contraseña</label>
        <input type="password" id="p" name="pass" required autocomplete="current-password">
      </div>
      <button type="submit" class="btn-login">Ingresar</button>
    </form>
  </div>
</body></html>`;
}

// ── Helpers del servidor web ──────────────────────────────────────────────

function parsearBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw))));
  });
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function badgeEstado(estado) {
  const cfg = {
    '':                ['#e2e8f0','#475569','Sin enviar'],
    'ENVIADO':         ['#dbeafe','#1d4ed8','Esperando respuesta'],
    'CONFIRMADO':      ['#dcfce7','#15803d','Confirmado ✓'],
    'CANCELADO':       ['#fee2e2','#b91c1c','Cancelado'],
    'NUMERO_INVALIDO': ['#ffedd5','#c2410c','Número inválido'],
  };
  const [bg, color, label] = cfg[estado] || ['#e2e8f0','#475569', estado || 'Sin enviar'];
  return `<span class="badge" style="background:${bg};color:${color}">${label}</span>`;
}

function htmlNav(activa) {
  return `<nav class="nav">
  <span class="nav-brand">🤖 Bot Citas</span>
  <a href="/" class="nav-link${activa === 'estado' ? ' active' : ''}">Estado</a>
  <a href="/citas" class="nav-link${activa === 'citas' ? ' active' : ''}">Citas</a>
  <a href="/nueva-cita" class="nav-link${activa === 'nueva-cita' ? ' active' : ''}">Nueva cita</a>
  <a href="/importar" class="nav-link${activa === 'importar' ? ' active' : ''}">Importar</a>
  <form method="POST" action="/logout" class="nav-end" style="display:flex">
    <button type="submit" class="btn btn-ghost">Cerrar sesión</button>
  </form>
</nav>`;
}

const htmlBotonCambiar = `
  <form method="POST" action="/cambiar-numero" style="margin-top:20px"
        onsubmit="return confirm('¿Seguro que quieres desconectar el número actual y vincular uno nuevo?')">
    <button type="submit" class="btn btn-danger">
      🔄 Cambiar número de WhatsApp
    </button>
  </form>`;

function renderCitasPage(citas) {
  const pendientesCount = citas.filter(c => !c.confirmacion || c.confirmacion === '').length;

  const filas = citas.length === 0
    ? '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:32px">No hay citas registradas</td></tr>'
    : citas.map(cita => {
        const sinEnviar = !cita.confirmacion || cita.confirmacion === '';
        const btnEnviar = sinEnviar && botConectado
          ? `<form method="POST" action="/enviar-cita" style="margin:0">
               <input type="hidden" name="rowIndex" value="${cita.rowIndex}">
               <button type="submit"
                 onclick="return confirm('¿Enviar mensaje a ${escHtml(cita.nombre)}?')"
                 class="btn btn-primary btn-sm">
                 Enviar
               </button>
             </form>`
          : '';
        return `<tr>
          <td data-label="Nombre">${escHtml(cita.nombre)}</td>
          <td data-label="Teléfono">${escHtml(cita.telefono)}</td>
          <td data-label="Fecha" style="white-space:nowrap">${escHtml(cita.fecha)}</td>
          <td data-label="Hora">${escHtml(cita.hora)}</td>
          <td data-label="Servicio">${escHtml(cita.servicio)}</td>
          <td data-label="Estado">${badgeEstado(cita.confirmacion)}</td>
          <td data-label="Acción">${btnEnviar}</td>
        </tr>`;
      }).join('');

  const alertaDesconectado = !botConectado
    ? `<div class="alert alert-warn">
         ⚠️ WhatsApp no está conectado — <a href="/">Conectar →</a>
       </div>`
    : '';

  const btnEnviarTodo = pendientesCount > 0 && botConectado
    ? `<form method="POST" action="/enviar-todo"
           onsubmit="return confirm('¿Enviar mensaje a los ${pendientesCount} contacto(s) sin enviar?')">
         <button type="submit" class="btn btn-success">
           📤 Enviar a los ${pendientesCount} pendientes
         </button>
       </form>`
    : '';

  return `<!DOCTYPE html>
<html lang="es"><head>
  <meta charset="utf-8">
  <title>Bot Citas — Citas</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="30">
  ${css}
</head>
<body>
  ${htmlNav('citas')}
  <div class="container">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px">
      <h1 style="font-size:20px;font-weight:700">
        📋 Citas <span style="color:#94a3b8;font-weight:400">(${citas.length})</span>
      </h1>
      ${btnEnviarTodo}
    </div>
    ${alertaDesconectado}
    <div class="card tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Teléfono</th>
            <th>Fecha</th>
            <th>Hora</th>
            <th>Servicio</th>
            <th>Estado</th>
            <th>Acción</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </div>
    <p style="color:#94a3b8;font-size:12px;margin-top:10px">Se actualiza automáticamente cada 30 s</p>
  </div>
</body></html>`;
}

// ── CSV parser (sin dependencias externas) ────────────────────────────────
function parsearCSV(texto) {
  const lineas = texto.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n').map(l => l.trim()).filter(Boolean);
  if (lineas.length < 2) return [];
  // Ignora la primera línea (encabezado)
  return lineas.slice(1).map(linea => {
    // Separar por coma respetando comillas dobles
    const cols = [];
    let dentro = false, campo = '';
    for (let i = 0; i < linea.length; i++) {
      const ch = linea[i];
      if (ch === '"') { dentro = !dentro; }
      else if (ch === ',' && !dentro) { cols.push(campo.trim()); campo = ''; }
      else { campo += ch; }
    }
    cols.push(campo.trim());
    return {
      nombre:   cols[0] || '',
      telefono: cols[1] || '',
      fecha:    cols[2] || '',
      hora:     cols[3] || '',
      servicio: cols[4] || '',
    };
  }).filter(c => c.nombre && c.telefono && c.fecha);
}

// ── Formulario nueva cita ─────────────────────────────────────────────────
function renderNuevaCita(flash = '') {
  const [tipo, msg] = flash ? flash.split('|') : [];
  const alerta = msg
    ? `<div class="alert ${tipo === 'ok' ? 'alert-ok' : 'alert-err'}">${escHtml(msg)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="es"><head>
  <meta charset="utf-8">
  <title>Bot Citas — Nueva cita</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${css}
  <style>
    .alert-ok{background:#dcfce7;border:1px solid #86efac;color:#15803d}
    .alert-err{background:#fee2e2;border:1px solid #fca5a5;color:#b91c1c}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    @media(max-width:560px){.form-grid{grid-template-columns:1fr}}
    label{display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:5px}
    input,select{width:100%;padding:10px 13px;border:1.5px solid #e2e8f0;border-radius:8px;
                 font-size:14px;outline:none;transition:border-color .2s;background:#fff}
    input:focus,select:focus{border-color:#3b82f6}
    .field{display:flex;flex-direction:column}
    .field.full{grid-column:1/-1}
  </style>
</head>
<body>
  ${htmlNav('nueva-cita')}
  <div class="container" style="max-width:680px">
    <h1 style="font-size:20px;font-weight:700;margin-bottom:20px">➕ Nueva cita</h1>
    ${alerta}
    <div class="card" style="padding:28px 24px">
      <form method="POST" action="/nueva-cita">
        <div class="form-grid">
          <div class="field">
            <label for="nc-nombre">Nombre completo *</label>
            <input type="text" id="nc-nombre" name="nombre" required placeholder="Ej: María García">
          </div>
          <div class="field">
            <label for="nc-tel">Teléfono *</label>
            <input type="tel" id="nc-tel" name="telefono" required placeholder="Ej: 3001234567">
          </div>
          <div class="field">
            <label for="nc-fecha">Fecha *</label>
            <input type="text" id="nc-fecha" name="fecha" required placeholder="DD/MM/YYYY"
                   pattern="\\d{1,2}/\\d{1,2}/\\d{4}" title="Formato: DD/MM/YYYY">
          </div>
          <div class="field">
            <label for="nc-hora">Hora *</label>
            <input type="time" id="nc-hora" name="hora" required>
          </div>
          <div class="field full">
            <label for="nc-servicio">Servicio *</label>
            <input type="text" id="nc-servicio" name="servicio" required placeholder="Ej: Corte de cabello">
          </div>
        </div>
        <div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap">
          <button type="submit" class="btn btn-primary">Guardar cita</button>
          <a href="/citas" class="btn btn-ghost">Cancelar</a>
        </div>
      </form>
    </div>
  </div>
</body></html>`;
}

// ── Importar CSV ──────────────────────────────────────────────────────────
function renderImportar(flash = '') {
  const [tipo, msg] = flash ? flash.split('|') : [];
  const alerta = msg
    ? `<div class="alert ${tipo === 'ok' ? 'alert-ok' : 'alert-err'}">${escHtml(msg)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="es"><head>
  <meta charset="utf-8">
  <title>Bot Citas — Importar</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${css}
  <style>
    .alert-ok{background:#dcfce7;border:1px solid #86efac;color:#15803d}
    .alert-err{background:#fee2e2;border:1px solid #fca5a5;color:#b91c1c}
    label{display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:5px}
    textarea{width:100%;padding:12px 14px;border:1.5px solid #e2e8f0;border-radius:8px;
             font-size:13px;font-family:monospace;outline:none;resize:vertical;
             transition:border-color .2s;background:#fff}
    textarea:focus{border-color:#3b82f6}
    .example{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;
             padding:12px 14px;font-family:monospace;font-size:12px;
             color:#475569;white-space:pre;overflow-x:auto}
  </style>
  <script>
    function leerArchivo(e){
      const f = e.target.files[0];
      if(!f) return;
      const r = new FileReader();
      r.onload = ev => { document.getElementById('csv-data').value = ev.target.result; };
      r.readAsText(f, 'UTF-8');
    }
  </script>
</head>
<body>
  ${htmlNav('importar')}
  <div class="container" style="max-width:720px">
    <h1 style="font-size:20px;font-weight:700;margin-bottom:8px">📥 Importar citas desde CSV</h1>
    <p style="color:#64748b;font-size:14px;margin-bottom:20px">
      Descarga la plantilla, llénala y pégala aquí, o selecciona el archivo directamente.
    </p>
    ${alerta}
    <div class="card" style="padding:28px 24px;margin-bottom:16px">
      <div style="margin-bottom:18px">
        <p style="font-size:13px;font-weight:600;color:#475569;margin-bottom:8px">Formato esperado (CSV):</p>
        <div class="example">Nombre,Teléfono,Fecha,Hora,Servicio
María García,3001234567,25/04/2026,10:00,Corte de cabello
Carlos López,3109876543,25/04/2026,11:30,Consulta médica</div>
        <a href="/plantilla.csv" class="btn btn-ghost btn-sm" style="margin-top:10px;display:inline-flex">
          ⬇ Descargar plantilla
        </a>
      </div>
      <form method="POST" action="/importar">
        <div style="margin-bottom:14px">
          <label for="csv-file">Seleccionar archivo CSV</label>
          <input type="file" id="csv-file" accept=".csv,text/csv"
                 onchange="leerArchivo(event)"
                 style="width:100%;padding:8px 0;font-size:14px;border:none;background:transparent">
        </div>
        <div style="margin-bottom:18px">
          <label for="csv-data">O pega el contenido CSV aquí</label>
          <textarea id="csv-data" name="csv" rows="10"
                    placeholder="Nombre,Teléfono,Fecha,Hora,Servicio&#10;María García,3001234567,25/04/2026,10:00,Corte de cabello"></textarea>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button type="submit" class="btn btn-success">Importar citas</button>
          <a href="/citas" class="btn btn-ghost">Cancelar</a>
        </div>
      </form>
    </div>
  </div>
</body></html>`;
}

const servidorQR = http.createServer(async (req, res) => {
  // ── GET /login ────────────────────────────────────────────────────────────
  if (req.url === '/login' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderLogin());
    return;
  }

  // ── POST /login ───────────────────────────────────────────────────────────
  if (req.url === '/login' && req.method === 'POST') {
    const { user = '', pass = '' } = await parsearBody(req);
    if (credencialesValidas(user, pass)) {
      const token = crearSesion();
      res.writeHead(302, {
        'Location': '/',
        'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=28800`,
      });
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLogin('Usuario o contraseña incorrectos'));
    }
    res.end();
    return;
  }

  // ── POST /logout ──────────────────────────────────────────────────────────
  if (req.url === '/logout' && req.method === 'POST') {
    const token = parseCookies(req).session;
    if (token) sesiones.delete(token);
    res.writeHead(302, {
      'Location': '/login',
      'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0',
    });
    res.end();
    return;
  }

  // ── Guard: requiere sesión activa ─────────────────────────────────────────
  if (!sesionValida(req)) {
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return;
  }

  // ── POST /cambiar-numero ──────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/cambiar-numero') {
    res.writeHead(302, { 'Location': '/' });
    res.end();
    setTimeout(async () => {
      console.log('\n🔄 Cambiando número de WhatsApp desde el panel web...');
      botConectado = false;
      qrDataUrl = null;
      citasPendientes.clear();
      try {
        await client.logout();
      } catch (err) {
        console.warn('Logout error (ignorado):', err.message);
      }
      setTimeout(() => {
        console.log('🔄 Reiniciando cliente para generar nuevo QR...');
        client.initialize().catch(err => console.error('Error al reiniciar:', err.message));
      }, 3000);
    }, 400);
    return;
  }

  // ── POST /enviar-todo ─────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/enviar-todo') {
    res.writeHead(302, { 'Location': '/citas' });
    res.end();
    if (!botConectado) return;
    setTimeout(async () => {
      try {
        console.log('\n📤 Envío manual (todos los pendientes) desde panel web...');
        const citas = await getCitas();
        const pendientes = citas.filter(c => !c.confirmacion || c.confirmacion === '');
        let enviados = 0;
        for (const cita of pendientes) {
          try {
            await enviarMensajeACita(cita);
            enviados++;
            await sleep(2000);
          } catch (err) {
            console.error(`   ❌ Error enviando a ${cita.nombre}:`, err.message);
          }
        }
        console.log(`📊 Envío manual completado: ${enviados}/${pendientes.length}\n`);
      } catch (err) {
        console.error('Error en envío masivo:', err.message);
      }
    }, 200);
    return;
  }

  // ── POST /enviar-cita ─────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/enviar-cita') {
    const body = await parsearBody(req);
    const rowIndex = parseInt(body.rowIndex);
    res.writeHead(302, { 'Location': '/citas' });
    res.end();
    if (!botConectado || isNaN(rowIndex)) return;
    setTimeout(async () => {
      try {
        const citas = await getCitas();
        const cita = citas.find(c => c.rowIndex === rowIndex);
        if (!cita) { console.error(`Cita rowIndex ${rowIndex} no encontrada`); return; }
        await enviarMensajeACita(cita);
        console.log(`📤 Envío individual desde panel web: ${cita.nombre}\n`);
      } catch (err) {
        console.error('Error en envío individual:', err.message);
      }
    }, 200);
    return;
  }

  // ── GET /plantilla.csv ───────────────────────────────────────────────────
  if (req.url === '/plantilla.csv') {
    const plantilla = 'Nombre,Teléfono,Fecha,Hora,Servicio\r\nEjemplo Cliente,3001234567,25/04/2026,10:00,Corte de cabello\r\n';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="plantilla-citas.csv"',
    });
    res.end('\uFEFF' + plantilla); // BOM para que Excel lo abra bien
    return;
  }

  // ── GET /nueva-cita ───────────────────────────────────────────────────────
  if (req.url.startsWith('/nueva-cita') && req.method === 'GET') {
    const flash = new URLSearchParams(req.url.split('?')[1] || '').get('flash') || '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderNuevaCita(flash));
    return;
  }

  // ── POST /nueva-cita ──────────────────────────────────────────────────────
  if (req.url === '/nueva-cita' && req.method === 'POST') {
    const { nombre = '', telefono = '', fecha = '', hora = '', servicio = '' } = await parsearBody(req);
    if (!nombre || !telefono || !fecha || !hora || !servicio) {
      res.writeHead(302, { 'Location': '/nueva-cita?flash=err|Todos los campos son obligatorios' });
      res.end();
      return;
    }
    try {
      await agregarCita({ nombre, telefono, fecha, hora, servicio });
      res.writeHead(302, { 'Location': `/nueva-cita?flash=ok|Cita de ${nombre} guardada correctamente` });
    } catch (err) {
      res.writeHead(302, { 'Location': `/nueva-cita?flash=err|Error al guardar: ${encodeURIComponent(err.message)}` });
    }
    res.end();
    return;
  }

  // ── GET /importar ─────────────────────────────────────────────────────────
  if (req.url.startsWith('/importar') && req.method === 'GET') {
    const flash = new URLSearchParams(req.url.split('?')[1] || '').get('flash') || '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderImportar(flash));
    return;
  }

  // ── POST /importar ────────────────────────────────────────────────────────
  if (req.url === '/importar' && req.method === 'POST') {
    const { csv = '' } = await parsearBody(req);
    if (!csv.trim()) {
      res.writeHead(302, { 'Location': '/importar?flash=err|No se recibió contenido CSV' });
      res.end();
      return;
    }
    const citas = parsearCSV(csv);
    if (citas.length === 0) {
      res.writeHead(302, { 'Location': '/importar?flash=err|No se encontraron filas válidas (verifica el formato)' });
      res.end();
      return;
    }
    try {
      const total = await agregarCitas(citas);
      res.writeHead(302, { 'Location': `/importar?flash=ok|${total} cita(s) importadas correctamente` });
    } catch (err) {
      res.writeHead(302, { 'Location': `/importar?flash=err|Error al importar: ${encodeURIComponent(err.message)}` });
    }
    res.end();
    return;
  }

  // ── GET /status ───────────────────────────────────────────────────────────
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ conectado: botConectado }));
    return;
  }

  // ── GET /citas ────────────────────────────────────────────────────────────
  if (req.url === '/citas') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    try {
      const citas = await getCitas();
      res.end(renderCitasPage(citas));
    } catch (err) {
      res.end(`<p>Error al cargar citas: ${escHtml(err.message)}</p><a href="/citas">Reintentar</a>`);
    }
    return;
  }

  // ── GET / ─────────────────────────────────────────────────────────────────
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

  if (botConectado) {
    res.end(`<!DOCTYPE html>
<html lang="es"><head>
  <meta charset="utf-8">
  <title>Bot Citas — Estado</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${css}
</head>
<body>
  ${htmlNav('estado')}
  <div class="page-center">
    <div class="card" style="padding:40px 32px;text-align:center;max-width:420px;width:100%">
      <div style="font-size:48px;margin-bottom:12px">✅</div>
      <h1 style="font-size:22px;color:#16a34a;margin-bottom:8px">WhatsApp Conectado</h1>
      <p style="color:#64748b;margin-bottom:24px">El bot está activo y funcionando correctamente.</p>
      <div style="display:flex;flex-direction:column;gap:10px;align-items:center">
        <a href="/citas" class="btn btn-primary" style="width:100%;justify-content:center">📋 Ver citas</a>
        ${htmlBotonCambiar}
      </div>
    </div>
  </div>
</body></html>`);
    return;
  }

  if (!qrDataUrl) {
    res.end(`<!DOCTYPE html>
<html lang="es"><head>
  <meta charset="utf-8">
  <title>Bot Citas — Conectando</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="5">
  ${css}
</head>
<body>
  ${htmlNav('estado')}
  <div class="page-center">
    <div class="card" style="padding:40px 32px;text-align:center;max-width:420px;width:100%">
      <div style="font-size:48px;margin-bottom:12px">⏳</div>
      <h2 style="font-size:20px;margin-bottom:8px">Generando QR...</h2>
      <p style="color:#64748b;margin-bottom:24px">La página se actualizará sola en unos segundos.</p>
      ${htmlBotonCambiar}
    </div>
  </div>
</body></html>`);
    return;
  }

  res.end(`<!DOCTYPE html>
<html lang="es"><head>
  <meta charset="utf-8">
  <title>Bot Citas — Escanea el QR</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="30">
  ${css}
  <style>
    .qr-img{width:260px;max-width:100%;border:1px solid #e2e8f0;border-radius:12px;padding:12px;background:#fff}
  </style>
</head>
<body>
  ${htmlNav('estado')}
  <div class="page-center">
    <div class="card" style="padding:36px 32px;text-align:center;max-width:420px;width:100%">
      <div style="font-size:40px;margin-bottom:12px">📱</div>
      <h1 style="font-size:20px;margin-bottom:6px">Escanea el QR con WhatsApp</h1>
      <p style="color:#64748b;font-size:14px;margin-bottom:20px">
        WhatsApp → Dispositivos vinculados → Vincular dispositivo
      </p>
      <img src="${qrDataUrl}" class="qr-img" alt="QR WhatsApp">
      <p style="color:#94a3b8;font-size:12px;margin-top:14px">Se recarga cada 30 s · El QR expira cada ~20 s</p>
      <div style="margin-top:16px">${htmlBotonCambiar}</div>
    </div>
  </div>
</body></html>`);
});

servidorQR.listen(QR_PORT, () => {
  console.log(`🌐 Servidor QR activo en el puerto ${QR_PORT}`);
  console.log(`   Accede desde el navegador con: http://<IP_DEL_SERVIDOR>:${QR_PORT}\n`);
});

// =============================================
// INICIALIZAR CLIENTE WHATSAPP
// =============================================
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'bot-citas' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ],
  },
});

// =============================================
// EVENTOS DEL CLIENTE
// =============================================

// Mostrar QR para escanear
client.on('qr', async (qr) => {
  console.log('\n📱 Escanea este QR con tu WhatsApp:\n');
  qrcode.generate(qr, { small: true });
  console.log('\n💡 Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo\n');

  // Generar también como imagen para el servidor web
  try {
    qrDataUrl = await QRCode.toDataURL(qr);
    console.log(`🌐 QR disponible en el navegador: http://<IP_DEL_SERVIDOR>:${QR_PORT}\n`);
  } catch (err) {
    console.error('Error generando QR para web:', err.message);
  }
});

// Conexión establecida
client.on('ready', async () => {
  botConectado = true;
  qrDataUrl = null;
  console.log('\n✅ WhatsApp conectado correctamente!');
  console.log('🤖 Bot de citas activo\n');

  // Verificar estructura del Sheet
  await verificarEstructura();

  // Cargar citas pendientes en memoria
  await cargarCitasPendientes();

  // Programar envío automático según la hora configurada
  programarEnvios();

  console.log('⏰ Programador de envíos activo');
  console.log('📋 Esperando mensajes de clientes...\n');
});

// Manejar mensajes entrantes
client.on('message', async (msg) => {
  const numero = msg.from; // formato: 521XXXXXXXXXX@c.us
  const texto = msg.body?.trim() || '';

  // Ignorar mensajes de grupos
  if (msg.isGroupMsg) return;

  // Ignorar mensajes vacíos
  if (!texto) return;

  console.log(`📩 Mensaje recibido de ${numero}: "${texto}"`);

  // Buscar si este número tiene una cita pendiente de confirmación
  const cita = citasPendientes.get(numero);

  if (!cita) {
    // No hay cita pendiente para este número, ignorar silenciosamente
    console.log(`   ℹ️  Sin cita pendiente para: ${numero}`);
    if (citasPendientes.size > 0) {
      console.log(`   📋 IDs en espera: ${[...citasPendientes.keys()].join(' | ')}`);
    }
    return;
  }

  // Interpretar la respuesta
  const intencion = interpretarRespuesta(texto);
  console.log(`   🔍 Intención detectada: ${intencion}`);

  if (intencion === 'CONFIRMAR') {
    // ✅ Confirmar cita
    const mensajeRespuesta = getMensajeConfirmacion(cita);
    await client.sendMessage(numero, mensajeRespuesta);
    await actualizarConfirmacion(cita.rowIndex, 'CONFIRMADO');
    citasPendientes.delete(numero);
    console.log(`   ✅ Cita confirmada para ${cita.nombre}`);

  } else if (intencion === 'CANCELAR') {
    // ❌ Cancelar cita
    const mensajeRespuesta = getMensajeCancelacion(cita);
    await client.sendMessage(numero, mensajeRespuesta);
    await actualizarConfirmacion(cita.rowIndex, 'CANCELADO');
    citasPendientes.delete(numero);
    console.log(`   ❌ Cita cancelada para ${cita.nombre}`);

  } else {
    // ❓ Respuesta no entendida
    const mensajeRespuesta = getMensajeNoEntendido();
    await client.sendMessage(numero, mensajeRespuesta);
    console.log(`   ❓ Respuesta no entendida de ${cita.nombre}`);
  }
});

// Manejar desconexión
client.on('disconnected', (reason) => {
  console.log('⚠️  WhatsApp desconectado:', reason);
  botConectado = false;
  qrDataUrl = null;
  // LOGOUT lo maneja el POST handler con su propio delay; aquí solo atendemos caídas inesperadas
  if (reason !== 'LOGOUT') {
    console.log('🔄 Reiniciando para mostrar nuevo QR...');
    setTimeout(() => {
      client.initialize().catch(err => console.error('Error al reiniciar:', err.message));
    }, 2000);
  }
});

// =============================================
// FUNCIONES PRINCIPALES
// =============================================

/**
 * Envía el mensaje de recordatorio a una sola cita
 */
async function enviarMensajeACita(cita) {
  const numberId = await client.getNumberId(cita.telefono);
  if (!numberId) {
    await actualizarConfirmacion(cita.rowIndex, 'NUMERO_INVALIDO');
    throw new Error(`Número no encontrado en WhatsApp: ${cita.telefono}`);
  }
  // Usar el ID canónico que WhatsApp asigna, así msg.from siempre coincide
  const whatsappId = numberId._serialized;
  await client.sendMessage(whatsappId, getMensajeCita(cita));
  await marcarComoEnviado(cita.rowIndex);
  citasPendientes.set(whatsappId, cita);
  console.log(`   ✉️  Mensaje enviado a ${cita.nombre} — ID WhatsApp: ${whatsappId}`);
}

/**
 * Carga en memoria las citas que ya tienen estado ENVIADO
 * (para continuar manejando respuestas si el bot se reinicia)
 */
async function cargarCitasPendientes() {
  try {
    const citas = await getCitas();
    let cargadas = 0;

    for (const cita of citas) {
      if (cita.confirmacion === 'ENVIADO') {
        // Usar el mismo ID canónico que usa WhatsApp para que msg.from coincida
        const numberId = await client.getNumberId(cita.telefono);
        const whatsappId = numberId ? numberId._serialized : `${cita.telefono}@c.us`;
        citasPendientes.set(whatsappId, cita);
        cargadas++;
      }
    }

    if (cargadas > 0) {
      console.log(`📋 ${cargadas} cita(s) pendiente(s) cargada(s) en memoria`);
    }
  } catch (error) {
    console.error('❌ Error cargando citas pendientes:', error.message);
  }
}

/**
 * Envía mensajes de confirmación a las citas del día/mañana
 */
async function enviarRecordatorios() {
  console.log('\n📤 Iniciando envío de recordatorios...');

  try {
    const citas = await getCitas();
    let enviados = 0;
    let omitidos = 0;

    for (const cita of citas) {
      // Solo enviar si:
      // 1. La cita corresponde al día programado
      // 2. No tiene confirmación previa (vacío o solo fue enviado anteriormente)
      const sinConfirmar = !cita.confirmacion || cita.confirmacion === '';
      const esHoy = debeEnviarHoy(cita);

      if (!esHoy) { omitidos++; continue; }
      if (!sinConfirmar) {
        console.log(`   ⏭️  ${cita.nombre} ya tiene estado: ${cita.confirmacion}`);
        continue;
      }

      try {
        await enviarMensajeACita(cita);
        enviados++;
        await sleep(2000);
      } catch (err) {
        console.error(`   ❌ Error enviando a ${cita.nombre}:`, err.message);
      }
    }

    console.log(`\n📊 Resumen: ${enviados} enviados, ${omitidos} no correspondían a hoy\n`);

  } catch (error) {
    console.error('❌ Error en envío de recordatorios:', error.message);
  }
}

/**
 * Programa el cron job para envío automático
 */
function programarEnvios() {
  const horaConfig = process.env.SEND_HOUR || '09:00';
  const [hora, minuto] = horaConfig.split(':');

  // Formato cron: minuto hora * * * (cada día a la hora configurada)
  const cronExpression = `${minuto} ${hora} * * *`;

  console.log(`⏰ Recordatorios programados para las ${horaConfig} (${TIMEZONE})`);

  cron.schedule(cronExpression, async () => {
    const ahora = moment().tz(TIMEZONE).format('DD/MM/YYYY HH:mm');
    console.log(`\n⏰ Ejecutando envío programado: ${ahora}`);
    await enviarRecordatorios();
  }, {
    timezone: TIMEZONE,
  });

  // También permitir envío manual con comando
  console.log('💡 Para enviar manualmente ahora, escribe: node src/index.js --send-now\n');
}

// Envío manual si se pasa el flag --send-now
if (process.argv.includes('--send-now')) {
  console.log('🚀 Modo envío manual activado');
  client.on('ready', async () => {
    await sleep(2000);
    await enviarRecordatorios();
  });
}

// =============================================
// UTILS
// =============================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================
// INICIAR
// =============================================

console.log('🤖 Iniciando Bot de Citas WhatsApp...');
console.log('📱 Conectando con WhatsApp Web...\n');

client.initialize();
