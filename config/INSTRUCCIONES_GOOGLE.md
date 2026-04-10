# Conectar el bot con Google Sheets (sin Cloud Console)

Solo necesitas una cuenta de Google normal. No se requiere tarjeta de crédito, API keys ni Cloud Console.

---

## Paso 1: Crea tu Google Sheet

1. Ve a [sheets.google.com](https://sheets.google.com) con tu cuenta de Google
2. Crea una hoja nueva
3. En la primera pestaña (hoja), asegúrate de que se llame **Citas** (o cambia `NOMBRE_HOJA` en el script)

La estructura de columnas esperada es:

| A (Nombre) | B (Teléfono) | C (Fecha) | D (Hora) | E (Servicio) | F (Confirmación) | G (Fecha Confirmación) |
|------------|--------------|-----------|----------|--------------|------------------|------------------------|
| Juan López | 5512345678   | 15/04/2025| 10:00    | Corte de pelo|                  |                        |

> El bot crea los encabezados automáticamente si la hoja está vacía.

---

## Paso 2: Abre el editor de Apps Script

1. En tu Google Sheet, haz clic en el menú **Extensiones** → **Apps Script**
2. Se abre una nueva pestaña con el editor de código

---

## Paso 3: Pega el código del bot

1. Borra todo el contenido del archivo `Código.gs`
2. Abre el archivo `config/codigo-apps-script.gs` de este proyecto
3. Copia todo su contenido y pégalo en el editor de Apps Script
4. Haz clic en **Guardar** (ícono de disquete o `Ctrl+S`)

---

## Paso 4: Publica el script como aplicación web

1. Haz clic en el botón **Implementar** (esquina superior derecha) → **Nueva implementación**
2. En "Tipo", selecciona **Aplicación web**
3. Configura:
   - **Ejecutar como:** Yo (tu cuenta de Google)
   - **Quién tiene acceso:** Cualquier persona
4. Haz clic en **Implementar**
5. Google te pedirá que autorices el acceso — acepta con tu cuenta

> En la pantalla final verás la **URL de la aplicación web**. Cópiala, se ve así:
> `https://script.google.com/macros/s/AKfycby.../exec`

https://script.google.com/macros/s/AKfycbwHpaTwp6LVdUoSsyT6uZ-cSXoA5NTR0ufK8S4RLaPbV23CjpksnLru31Iw9zuWcx7j7w/exec

---

## Paso 5: Configura el archivo .env

1. Copia `.env.example` y renómbralo a `.env`:
   ```bash
   cp .env.example .env
   ```
2. Pega la URL del paso anterior en `GOOGLE_SCRIPT_URL`:
   ```
   GOOGLE_SCRIPT_URL=https://script.google.com/macros/s/TU_ID_AQUI/exec
   ```

---

## Paso 6: Desinstala googleapis (ya no se necesita)

Si ya tenías instaladas las dependencias anteriores, ejecuta:

```bash
npm uninstall googleapis
npm install
```

---

## Formatos de teléfono aceptados (México)

- `5512345678` (10 dígitos) → el bot agrega el código de país automáticamente
- `525512345678` (con código de país)
- `+525512345678` (con +)

---

## Estados en columna Confirmación

| Valor           | Significado                              |
|-----------------|------------------------------------------|
| *(vacío)*       | Pendiente de enviar                      |
| `ENVIADO`       | Mensaje enviado, esperando respuesta     |
| `CONFIRMADO`    | Cliente confirmó asistencia ✅           |
| `CANCELADO`     | Cliente canceló ❌                       |
| `NUMERO_INVALIDO` | Número no encontrado en WhatsApp      |

---

## Si actualizas el código del script

Cada vez que cambies el código en Apps Script debes hacer una **nueva implementación**:
1. **Implementar** → **Gestionar implementaciones**
2. Edita la implementación activa → **Nueva versión** → **Implementar**

La URL no cambia.
