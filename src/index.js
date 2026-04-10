// src/index.js
// Bot principal de WhatsApp para confirmación de citas

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');
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

// HTML compartido: botón de cambiar número
const htmlBotonCambiar = `
  <form method="POST" action="/cambiar-numero" style="margin-top:32px"
        onsubmit="return confirm('¿Seguro que quieres desconectar el número actual y vincular uno nuevo? El bot dejará de funcionar unos segundos.')">
    <button type="submit"
      style="background:#ef4444;color:#fff;border:none;padding:12px 28px;
             font-size:15px;border-radius:8px;cursor:pointer">
      🔄 Cambiar número de WhatsApp
    </button>
  </form>`;

const servidorQR = http.createServer(async (req, res) => {
  // ── Acción: cambiar número ──────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/cambiar-numero') {
    // Redirigir al usuario de inmediato para que vea la pantalla de carga
    res.writeHead(302, { 'Location': '/' });
    res.end();

    // Desconectar después de que el redirect llegue al navegador
    setTimeout(async () => {
      console.log('\n🔄 Cambiando número de WhatsApp desde el panel web...');
      botConectado = false;
      qrDataUrl = null;
      citasPendientes.clear();
      try {
        await client.logout();           // cierra sesión y borra .wwebjs_auth/
      } catch (err) {
        // Si ya estaba desconectado, igual reiniciamos
        console.warn('Logout error (ignorado):', err.message);
        client.initialize();
      }
    }, 400);
    return;
  }

  // ── Estado JSON ─────────────────────────────────────────────────────────
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ conectado: botConectado }));
    return;
  }

  // ── Páginas HTML ────────────────────────────────────────────────────────
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

  if (botConectado) {
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Bot WhatsApp</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0fff4">
  <h1 style="color:#22c55e">✅ WhatsApp Conectado</h1>
  <p>El bot está activo y funcionando correctamente.</p>
  ${htmlBotonCambiar}
</body></html>`);
    return;
  }

  if (!qrDataUrl) {
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Bot WhatsApp - QR</title>
<meta http-equiv="refresh" content="5">
</head>
<body style="font-family:sans-serif;text-align:center;padding:60px">
  <h2>⏳ Generando QR...</h2>
  <p>La página se actualizará sola en unos segundos.</p>
  ${htmlBotonCambiar}
</body></html>`);
    return;
  }

  res.end(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <title>Bot WhatsApp - Escanea el QR</title>
  <meta http-equiv="refresh" content="30">
</head>
<body style="font-family:sans-serif;text-align:center;padding:40px">
  <h1>📱 Escanea el QR con WhatsApp</h1>
  <p style="color:#555">WhatsApp &rarr; Dispositivos vinculados &rarr; Vincular dispositivo</p>
  <img src="${qrDataUrl}" style="width:280px;border:1px solid #ddd;border-radius:12px;padding:12px">
  <p style="color:#aaa;font-size:13px">Se recarga automáticamente cada 30 s &bull; El QR expira cada ~20 s</p>
  ${htmlBotonCambiar}
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
    console.log(`   ℹ️  No hay cita pendiente para ${numero}`);
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
  console.log('🔄 Reiniciando para mostrar nuevo QR...');
  client.initialize();
});

// =============================================
// FUNCIONES PRINCIPALES
// =============================================

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
        const whatsappId = `${cita.telefono}@c.us`;
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

      const whatsappId = `${cita.telefono}@c.us`;
      const mensaje = getMensajeCita(cita);

      try {
        // Verificar que el número existe en WhatsApp
        const numberId = await client.getNumberId(cita.telefono);

        if (!numberId) {
          console.log(`   ⚠️  Número no encontrado en WhatsApp: ${cita.telefono} (${cita.nombre})`);
          await actualizarConfirmacion(cita.rowIndex, 'NUMERO_INVALIDO');
          continue;
        }

        await client.sendMessage(whatsappId, mensaje);
        await marcarComoEnviado(cita.rowIndex);

        // Guardar en memoria para manejar respuestas
        citasPendientes.set(whatsappId, cita);

        enviados++;
        console.log(`   ✉️  Mensaje enviado a ${cita.nombre} (${cita.telefono})`);

        // Esperar 2 segundos entre mensajes para evitar spam
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
