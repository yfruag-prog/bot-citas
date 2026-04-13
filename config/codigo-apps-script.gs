// =============================================
// CÓDIGO PARA GOOGLE APPS SCRIPT
// Instrucciones: Ver INSTRUCCIONES_GOOGLE.md
// =============================================

var NOMBRE_HOJA = 'Citas'; // Cambia si tu pestaña tiene otro nombre

// -----------------------------------------------
// Maneja peticiones GET (leer citas, verificar estructura)
// -----------------------------------------------
function doGet(e) {
  var action = e.parameter.action || 'getCitas';

  try {
    if (action === 'getCitas') {
      return responder(getCitas());
    }
    if (action === 'verificarEstructura') {
      return responder(verificarEstructura());
    }
    return responder({ error: 'Acción no reconocida: ' + action });
  } catch (err) {
    return responder({ error: err.message });
  }
}

// -----------------------------------------------
// Maneja peticiones POST (actualizar confirmación)
// -----------------------------------------------
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action;

    if (action === 'actualizarConfirmacion') {
      return responder(actualizarConfirmacion(data.rowIndex, data.estado));
    }
    return responder({ error: 'Acción no reconocida: ' + action });
  } catch (err) {
    return responder({ error: err.message });
  }
}

// -----------------------------------------------
// Lee todas las citas de la hoja
// -----------------------------------------------
function getCitas() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(NOMBRE_HOJA);

  if (!sheet) {
    return { error: 'No se encontró la hoja: ' + NOMBRE_HOJA };
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, 7).getValues();

  return values
    .map(function(row, index) {
      var fecha = row[2];
      var hora  = row[3];

      // Formatear fecha si Sheets la devuelve como objeto Date
      if (fecha instanceof Date && !isNaN(fecha)) {
        fecha = Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'dd/MM/yyyy');
      } else {
        fecha = String(fecha || '');
      }

      // Formatear hora — Sheets puede devolver un Date o un número (fracción del día)
      if (hora instanceof Date && !isNaN(hora)) {
        hora = Utilities.formatDate(hora, Session.getScriptTimeZone(), 'HH:mm');
      } else if (typeof hora === 'number') {
        // Fracción de día: 0.625 = 15:00
        var totalMin = Math.round(hora * 24 * 60);
        var hh = Math.floor(totalMin / 60) % 24;
        var mm = totalMin % 60;
        hora = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
      } else {
        hora = String(hora || '');
      }

      return {
        rowIndex:          index + 2,
        nombre:            String(row[0] || ''),
        telefono:          String(row[1] || ''),
        fecha:             fecha,
        hora:              hora,
        servicio:          String(row[4] || ''),
        confirmacion:      String(row[5] || ''),
        fechaConfirmacion: String(row[6] || '')
      };
    })
    .filter(function(c) {
      return c.nombre && c.telefono && c.fecha;
    });
}

// -----------------------------------------------
// Actualiza columnas F y G en la fila indicada
// -----------------------------------------------
function actualizarConfirmacion(rowIndex, estado) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(NOMBRE_HOJA);

  if (!sheet) {
    return { error: 'No se encontró la hoja: ' + NOMBRE_HOJA };
  }

  var tz   = Session.getScriptTimeZone();
  var ahora = Utilities.formatDate(new Date(), tz, 'dd/MM/yyyy HH:mm:ss');

  sheet.getRange(rowIndex, 6).setValue(estado);
  sheet.getRange(rowIndex, 7).setValue(ahora);

  return { success: true, rowIndex: rowIndex, estado: estado };
}

// -----------------------------------------------
// Verifica / crea encabezados si la hoja está vacía
// -----------------------------------------------
function verificarEstructura() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(NOMBRE_HOJA);

  if (!sheet) {
    sheet = ss.insertSheet(NOMBRE_HOJA);
  }

  var encabezados = sheet.getRange(1, 1, 1, 7).getValues()[0];

  if (!encabezados[0]) {
    sheet.getRange(1, 1, 1, 7).setValues([[
      'Nombre', 'Teléfono', 'Fecha', 'Hora', 'Servicio', 'Confirmación', 'Fecha Confirmación'
    ]]);
  }

  return { success: true, mensaje: 'Estructura verificada' };
}

// -----------------------------------------------
// Helper: devuelve JSON con cabeceras CORS
// -----------------------------------------------
function responder(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
