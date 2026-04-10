# Bot WhatsApp - Confirmación de Citas

Bot que lee citas desde Google Sheets, envía mensajes de confirmación por WhatsApp y registra las respuestas automáticamente.

No requiere Google Cloud Console ni Service Account. Funciona con una cuenta de Google normal a través de Google Apps Script.

---

## Funcionalidades

- Conexión a WhatsApp escaneando un QR (igual que WhatsApp Web)
- Lee citas directamente de tu Google Sheet
- Envía mensajes personalizados con nombre, fecha, hora y servicio
- Responde automáticamente cuando el cliente confirma o cancela
- Registra el estado en el Sheet en tiempo real
- Envío automático programado a la hora que configures
- Guarda la sesión de WhatsApp (no necesitas escanear el QR cada vez que reinicias)

---

## Requisitos

- Node.js 18 o superior (`node --version` para verificar)
- Una cuenta de Google (Gmail normal)
- Un número de WhatsApp activo para vincular el bot

---

## Instalación local

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar Google Sheets

Sigue los pasos en [`config/INSTRUCCIONES_GOOGLE.md`](config/INSTRUCCIONES_GOOGLE.md). En resumen:

1. Crea un Google Sheet con las columnas: **Nombre / Teléfono / Fecha / Hora / Servicio**
2. En el Sheet: **Extensiones → Apps Script** → pega el contenido de `config/codigo-apps-script.gs`
3. Publica el script como aplicación web (**Implementar → Nueva implementación**)
4. Copia la URL que te genera (`https://script.google.com/macros/s/.../exec`)

### 3. Crear el archivo .env

```bash
cp .env.example .env
```

Edita `.env` con tus datos mínimos:

```env
GOOGLE_SCRIPT_URL=https://script.google.com/macros/s/TU_ID/exec
SHEET_NAME=Citas
SEND_HOUR=09:00
DAYS_BEFORE=1
TIMEZONE=America/Mexico_City
```

### 4. Iniciar el bot

```bash
npm start
```

La primera vez aparece un QR en la terminal. Escanéalo desde WhatsApp:
> WhatsApp → menú (tres puntos) → Dispositivos vinculados → Vincular dispositivo

La sesión queda guardada en la carpeta `.wwebjs_auth/`. Las siguientes veces que inicies el bot no necesitas escanear el QR.

---

## Estructura del Google Sheet

| A (Nombre) | B (Teléfono) | C (Fecha) | D (Hora) | E (Servicio) | F (Confirmación) | G (Fecha Confirmación) |
|------------|--------------|-----------|----------|--------------|------------------|------------------------|
| Juan López | 5512345678   | 15/04/2025| 10:00    | Corte        |                  |                        |

- La **Fecha** debe estar en formato `DD/MM/YYYY`
- El **Teléfono** puede ser de 10 dígitos (México): el bot agrega el código de país automáticamente
- Las columnas **F** y **G** las llena el bot, no las edites a mano mientras el bot está corriendo

---

## Uso diario

### Envío automático

El bot envía recordatorios cada día a la hora configurada en `SEND_HOUR`. Por defecto, envía el día anterior a la cita (`DAYS_BEFORE=1`). Cambia a `0` para enviar el mismo día de la cita.

### Enviar recordatorios ahora (manual)

```bash
node src/index.js --send-now
```

---

## Cambiar el número de WhatsApp

El bot vincula el número que escaneó el QR. Para cambiar a otro número:

1. Detén el bot (`Ctrl+C` o `pm2 stop bot-citas` en el servidor)
2. Borra la sesión guardada:
   ```bash
   rm -rf .wwebjs_auth/
   ```
3. Inicia el bot de nuevo:
   ```bash
   npm start
   ```
4. Escanea el QR con el **nuevo número** de WhatsApp

> Cada número de WhatsApp puede estar vinculado en un solo lugar a la vez (igual que WhatsApp Web).

---

## Despliegue en Hostinger VPS

Para que el bot corra 24/7 en tu servidor Hostinger, sigue estos pasos.

### Requisitos en el servidor

- Plan VPS de Hostinger (cualquier plan funciona)
- Sistema operativo: Ubuntu 22.04 o 20.04

### 1. Conectarte al servidor

```bash
ssh root@TU_IP_HOSTINGER
```

### 2. Instalar Node.js 18

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # debe mostrar v18.x o superior
```

### 3. Instalar dependencias del sistema para Chromium

WhatsApp Web.js usa Chromium internamente. Necesita estas librerías:

```bash
sudo apt-get install -y \
  ca-certificates fonts-liberation \
  libappindicator3-1 libasound2 libatk-bridge2.0-0 libatk1.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
  libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
  libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 \
  libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
  libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 \
  libxtst6 lsb-release wget xdg-utils
```

### 4. Instalar PM2 (gestor de procesos)

PM2 mantiene el bot corriendo y lo reinicia si falla:

```bash
npm install -g pm2
```

### 5. Subir el proyecto al servidor

Opción A — clonar desde git (recomendado):
```bash
git clone TU_REPOSITORIO /home/bot-citas
cd /home/bot-citas
```

Opción B — subir archivos con SCP desde tu PC:
```bash
scp -r ./whatsapp root@TU_IP:/home/bot-citas
```

### 6. Instalar dependencias del proyecto

```bash
cd /home/bot-citas
npm install
```

### 7. Crear el archivo .env en el servidor

```bash
cp .env.example .env
nano .env
```

Pega tu configuración (especialmente `GOOGLE_SCRIPT_URL`) y guarda con `Ctrl+O` → `Enter` → `Ctrl+X`.

### 8. Escanear el QR por primera vez

Antes de usar PM2, inicia el bot una sola vez para escanear el QR:

```bash
node src/index.js
```

Cuando aparezca el QR en la terminal, escanéalo con tu WhatsApp. Cuando veas `✅ WhatsApp conectado correctamente!`, detén el bot con `Ctrl+C`.

> La sesión queda guardada en `.wwebjs_auth/`. No necesitas repetir esto salvo que cambies de número.

### 9. Iniciar con PM2

```bash
pm2 start src/index.js --name bot-citas
pm2 save
pm2 startup   # sigue las instrucciones que aparecen para que inicie al reiniciar el servidor
```

### Comandos útiles de PM2

```bash
pm2 status              # ver estado del bot
pm2 logs bot-citas      # ver logs en tiempo real
pm2 restart bot-citas   # reiniciar el bot
pm2 stop bot-citas      # detener el bot
```

### Cambiar de número en el servidor

```bash
pm2 stop bot-citas
rm -rf .wwebjs_auth/
node src/index.js       # escanea el QR con el nuevo número
# Ctrl+C cuando veas "WhatsApp conectado"
pm2 start bot-citas
```

---

## Personalizar mensajes

Edita el archivo `.env`:

```env
MESSAGE_TEMPLATE=Hola {nombre} 👋, tienes cita el *{dia}* a las *{hora}* para *{servicio}*. ¿Confirmas? Responde *SI* o *NO*.
CONFIRM_MESSAGE=✅ ¡Perfecto, {nombre}! Cita confirmada para el {dia} a las {hora}. ¡Te esperamos!
CANCEL_MESSAGE=😔 Entendido, {nombre}. Cancelación registrada. ¡Que tengas buen día!
UNKNOWN_MESSAGE=Para confirmar responde *SI*, para cancelar responde *NO*.
```

Variables disponibles: `{nombre}`, `{dia}`, `{hora}`, `{servicio}`

---

## Palabras que reconoce el bot

**Para confirmar:** sí, si, s, yes, ok, dale, confirmo, confirmado, va, claro, 1

**Para cancelar:** no, n, cancel, cancelo, cancelar, 2

Cualquier otra respuesta activa el mensaje de "no entendido".

---

## Estructura del proyecto

```
whatsapp/
├── src/
│   ├── index.js          # Bot principal (WhatsApp + lógica de citas)
│   ├── sheets.js         # Comunicación con Google Sheets via Apps Script
│   └── mensajes.js       # Plantillas de mensajes y lógica de fechas
├── config/
│   ├── codigo-apps-script.gs    # Código que pegas en Google Apps Script
│   └── INSTRUCCIONES_GOOGLE.md  # Guía paso a paso para configurar el Sheet
├── .wwebjs_auth/         # Sesión de WhatsApp (se crea automáticamente, no subir a git)
├── .env.example          # Plantilla de configuración
├── .env                  # Tu configuración real (no subir a git)
└── package.json
```

---

## Solución de problemas

**El bot pide QR de nuevo al reiniciar**
- La sesión se perdió. Borra `.wwebjs_auth/` y escanea de nuevo.

**"Error al contactar Apps Script"**
- Verifica que `GOOGLE_SCRIPT_URL` en `.env` sea la URL correcta de tu implementación
- Asegúrate de que el Apps Script está publicado con acceso "Cualquier persona"

**"Número no encontrado en WhatsApp"**
- El número existe en el Sheet pero no tiene WhatsApp activo
- Verifica el formato del teléfono (para México: 10 dígitos sin código de país)

**El bot no responde a mensajes de clientes**
- Solo responde si el número tiene una cita con estado `ENVIADO` en el Sheet
- El estado lo asigna el bot cuando envía el recordatorio

**Chromium no inicia en el servidor**
- Asegúrate de haber instalado todas las librerías del Paso 3
- El bot usa modo headless, no necesita interfaz gráfica
