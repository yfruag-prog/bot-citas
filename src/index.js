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

const { getCitas, actualizarConfirmacion, marcarComoEnviado, verificarEstructura } = require('./sheets');
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

function renderLogin(error = '') {
  return `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <title>Bot Citas - Acceso</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="font-family:sans-serif;margin:0;background:#f8fafc;
             display:flex;align-items:center;justify-content:center;min-height:100vh">
  <div style="background:#fff;padding:40px;border-radius:12px;
              box-shadow:0 2px 8px rgba(0,0,0,.1);width:100%;max-width:360px">
    <h1 style="margin:0 0 6px;font-size:22px;text-align:center">🤖 Bot Citas</h1>
    <p style="color:#64748b;text-align:center;margin:0 0 28px;font-size:14px">Panel de administración</p>
    ${error ? `<p style="background:#fee2e2;color:#b91c1c;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px">${error}</p>` : ''}
    <form method="POST" action="/login">
      <label style="font-size:13px;color:#475569;font-weight:600">Usuario</label>
      <input type="text" name="user" required autofocus
        style="display:block;width:100%;box-sizing:border-box;margin:6px 0 16px;
               padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:15px">
      <label style="font-size:13px;color:#475569;font-weight:600">Contraseña</label>
      <input type="password" name="pass" required
        style="display:block;width:100%;box-sizing:border-box;margin:6px 0 24px;
               padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:15px">
      <button type="submit"
        style="width:100%;background:#1e293b;color:#fff;border:none;padding:12px;
               border-radius:8px;font-size:15px;cursor:pointer">
        Ingresar
      </button>
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
  return `<span style="background:${bg};color:${color};padding:3px 10px;border-radius:999px;font-size:12px;white-space:nowrap">${label}</span>`;
}

function htmlNav(activa) {
  return `<nav style="background:#1e293b;padding:12px 24px;display:flex;align-items:center;gap:24px">
  <span style="color:#fff;font-weight:700">🤖 Bot Citas</span>
  <a href="/" style="color:${activa === 'estado' ? '#fff' : '#94a3b8'};text-decoration:none;font-size:14px">Estado</a>
  <a href="/citas" style="color:${activa === 'citas' ? '#fff' : '#94a3b8'};text-decoration:none;font-size:14px">Citas</a>
  <form method="POST" action="/logout" style="margin-left:auto">
    <button type="submit" style="background:transparent;color:#64748b;border:none;
            font-size:13px;cursor:pointer;padding:0">Cerrar sesión</button>
  </form>
</nav>`;
}

const htmlBotonCambiar = `
  <form method="POST" action="/cambiar-numero" style="margin-top:20px"
        onsubmit="return confirm('¿Seguro que quieres desconectar el número actual y vincular uno nuevo?')">
    <button type="submit"
      style="background:#ef4444;color:#fff;border:none;padding:10px 24px;
             font-size:14px;border-radius:8px;cursor:pointer">
      🔄 Cambiar número de WhatsApp
    </button>
  </form>`;

function renderCitasPage(citas) {
  const pendientesCount = citas.filter(c => !c.confirmacion || c.confirmacion === '').length;

  const filas = citas.length === 0
    ? '<tr><td colspan="7" style="padding:24px;text-align:center;color:#94a3b8">No hay citas registradas</td></tr>'
    : citas.map(cita => {
        const sinEnviar = !cita.confirmacion || cita.confirmacion === '';
        const btnEnviar = sinEnviar && botConectado
          ? `<form method="POST" action="/enviar-cita" style="margin:0">
               <input type="hidden" name="rowIndex" value="${cita.rowIndex}">
               <button type="submit"
                 onclick="return confirm('¿Enviar mensaje a ${escHtml(cita.nombre)}?')"
                 style="background:#2563eb;color:#fff;border:none;padding:5px 12px;
                        border-radius:6px;cursor:pointer;font-size:13px">
                 Enviar
               </button>
             </form>`
          : '';
        return `<tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:10px 12px">${escHtml(cita.nombre)}</td>
          <td style="padding:10px 12px">${escHtml(cita.telefono)}</td>
          <td style="padding:10px 12px;white-space:nowrap">${escHtml(cita.fecha)}</td>
          <td style="padding:10px 12px">${escHtml(cita.hora)}</td>
          <td style="padding:10px 12px">${escHtml(cita.servicio)}</td>
          <td style="padding:10px 12px">${badgeEstado(cita.confirmacion)}</td>
          <td style="padding:10px 12px">${btnEnviar}</td>
        </tr>`;
      }).join('');

  const alertaDesconectado = !botConectado
    ? `<div style="background:#fef9c3;border:1px solid #fde047;padding:12px 16px;
                   border-radius:8px;margin-bottom:16px">
         ⚠️ WhatsApp no está conectado — <a href="/">Conectar →</a>
       </div>`
    : '';

  const btnEnviarTodo = pendientesCount > 0 && botConectado
    ? `<form method="POST" action="/enviar-todo" style="display:inline-block"
           onsubmit="return confirm('¿Enviar mensaje a los ${pendientesCount} contacto(s) sin enviar?')">
         <button type="submit"
           style="background:#16a34a;color:#fff;border:none;padding:10px 22px;
                  font-size:14px;border-radius:8px;cursor:pointer">
           📤 Enviar a los ${pendientesCount} pendientes
         </button>
       </form>`
    : '';

  return `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <title>Bot Citas - Citas</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="30">
</head>
<body style="font-family:sans-serif;margin:0;background:#f8fafc">
  ${htmlNav('citas')}
  <div style="max-width:960px;margin:0 auto;padding:24px">
    <div style="display:flex;align-items:center;justify-content:space-between;
                flex-wrap:wrap;gap:12px;margin-bottom:20px">
      <h1 style="margin:0;font-size:20px">
        📋 Citas <span style="color:#94a3b8;font-weight:normal">(${citas.length})</span>
      </h1>
      ${btnEnviarTodo}
    </div>
    ${alertaDesconectado}
    <div style="background:#fff;border-radius:10px;overflow:auto;
                box-shadow:0 1px 3px rgba(0,0,0,.08)">
      <table style="width:100%;border-collapse:collapse;font-size:14px;min-width:700px">
        <thead>
          <tr style="background:#f1f5f9;text-align:left">
            <th style="padding:12px">Nombre</th>
            <th style="padding:12px">Teléfono</th>
            <th style="padding:12px">Fecha</th>
            <th style="padding:12px">Hora</th>
            <th style="padding:12px">Servicio</th>
            <th style="padding:12px">Estado</th>
            <th style="padding:12px">Acción</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </div>
    <p style="color:#94a3b8;font-size:12px;margin-top:10px">Se actualiza automáticamente cada 30 s</p>
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
<html><head><meta charset="utf-8"><title>Bot WhatsApp</title></head>
<body style="font-family:sans-serif;margin:0;background:#f8fafc">
  ${htmlNav('estado')}
  <div style="text-align:center;padding:60px 20px">
    <h1 style="color:#22c55e">✅ WhatsApp Conectado</h1>
    <p style="color:#64748b">El bot está activo y funcionando correctamente.</p>
    <a href="/citas"
       style="display:inline-block;padding:10px 22px;background:#2563eb;color:#fff;
              border-radius:8px;text-decoration:none;font-size:15px">
      📋 Ver citas
    </a>
    ${htmlBotonCambiar}
  </div>
</body></html>`);
    return;
  }

  if (!qrDataUrl) {
    res.end(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8"><title>Bot WhatsApp - QR</title>
  <meta http-equiv="refresh" content="5">
</head>
<body style="font-family:sans-serif;margin:0;background:#f8fafc">
  ${htmlNav('estado')}
  <div style="text-align:center;padding:60px 20px">
    <h2>⏳ Generando QR...</h2>
    <p style="color:#64748b">La página se actualizará sola en unos segundos.</p>
    ${htmlBotonCambiar}
  </div>
</body></html>`);
    return;
  }

  res.end(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <title>Bot WhatsApp - Escanea el QR</title>
  <meta http-equiv="refresh" content="30">
</head>
<body style="font-family:sans-serif;margin:0;background:#f8fafc">
  ${htmlNav('estado')}
  <div style="text-align:center;padding:40px 20px">
    <h1>📱 Escanea el QR con WhatsApp</h1>
    <p style="color:#555">WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${qrDataUrl}" style="width:280px;border:1px solid #ddd;border-radius:12px;padding:12px">
    <p style="color:#aaa;font-size:13px">Se recarga cada 30 s · El QR expira cada ~20 s</p>
    ${htmlBotonCambiar}
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
