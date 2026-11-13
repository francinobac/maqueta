'use strict';

// Datos públicos del proyecto: acá no van contraseñas ni la clave de acceso.
const CONFIG = {
  BROKER_URL: 'wss://p1f312f1.ala.us-east-1.emqxsl.com:8084/mqtt',   // con puerto y ruta
  PREFIJO: 'escuela/maqueta1',          // igual que PREFIJO_TEMAS en config.h
  DOMINIO_OFICIAL: 'https://francinobac.github.io/maqueta/',
};

const TEMAS = {
  login: CONFIG.PREFIJO + '/login',
  respuesta: CONFIG.PREFIJO + '/login/respuesta',
  comando: CONFIG.PREFIJO + '/comando',
  estado: CONFIG.PREFIJO + '/estado',
  online: CONFIG.PREFIJO + '/online',
};
const ESPERA_RESPUESTA_MS = 15000;
const ALERTAS = {
  sensor: 'Falla del sensor de presencia: no recibe eco',
};
const CAMPOS = ['puerta', 'ventana', 'luz', 'modo', 'distancia', 'presencia', 'senal', 'broker'];

const $ = id => document.getElementById(id);

let cliente = null;       // conexión MQTT
let espOnline = null;     // null: todavía no se sabe
let sesion = null;        // {token, ses, vence}. Solo en memoria: se pierde al recargar.
let ultimoRssi = null;    // señal Wi-Fi del ESP32, del último estado
const pedidos = new Map();  // pedidos sin responder, por id

function ver(id) {
  ['login', 'acceso', 'panel'].forEach(s => $(s).hidden = s !== id);
}

// Aviso de dominio (ayuda a reconocer copias; no es una protección)

function revisarDominio() {
  $('dominioOficial').textContent = 'https://' + CONFIG.DOMINIO_OFICIAL;
  if (location.hostname !== CONFIG.DOMINIO_OFICIAL) {
    $('dominio').classList.add('peligro');
    $('dominio').firstElementChild.textContent =
      'Este no parece el sitio oficial (estás en ' + (location.hostname || 'un archivo local') + '). No escribas tus datos.';
  }
}

// Conexión al broker

function conectar(ev) {
  ev.preventDefault();
  $('error').textContent = '';
  if (typeof mqtt === 'undefined') {
    $('error').textContent = 'No se pudo cargar la librería MQTT. Revisá tu conexión.';
    return;
  }
  let yaConecto = false;
  const c = mqtt.connect(CONFIG.BROKER_URL, {
    username: $('usuario').value,
    password: $('clave').value,
    clientId: 'web-' + idAzar(),
    clean: true,
    protocolVersion: 4,
    connectTimeout: 10000,
    reconnectPeriod: 3000,
  });
  cliente = c;
  $('clave').value = '';

  c.on('connect', () => {
    yaConecto = true;
    c.subscribe([TEMAS.respuesta, TEMAS.estado, TEMAS.online], {qos: 1});
    mostrarConexion();
    if (!sesion) ver('acceso');
  });
  c.on('message', (tema, datos) => {
    if (c === cliente) alRecibir(tema, datos);   // ignora lo que llegue después de desconectar
  });
  c.on('error', e => {
    // 4 y 5 son los rechazos de usuario o permisos del protocolo MQTT 3.1.1.
    if (e.code === 4 || e.code === 5) desconectar('Usuario o contraseña del broker incorrectos.');
  });
  c.on('close', () => {
    if (c !== cliente) return;
    if (!yaConecto) desconectar('No se pudo conectar con el broker.');
    else { espOnline = null; mostrarConexion(); }
  });
}

function desconectar(mensaje) {
  const c = cliente;
  cliente = null;
  sesion = null;
  espOnline = null;
  ultimoRssi = null;
  if (c) c.end(false);
  for (const responder of pedidos.values()) responder({ok: false, mensaje: 'Desconectado.'});
  $('eventos').replaceChildren();
  CAMPOS.forEach(id => { $(id).textContent = '—'; $(id).className = ''; });
  $('lectura').textContent = '';
  marcarModo(null);
  $('alerta').hidden = true;
  $('alertasMaqueta').hidden = true;
  $('conexion').hidden = true;
  $('claveAcceso').value = '';
  $('errorAcceso').textContent = '';
  $('aviso').textContent = '';
  $('error').textContent = mensaje || '';
  ver('login');
}

function salir() {
  // El ESP32 invalida el token: cerrar la pestaña sola no alcanzaría.
  if (sesion && cliente) publicar(TEMAS.comando, {id: idAzar(), token: sesion.token, accion: 'salir'});
  desconectar();
}

function mostrarConexion() {
  const chip = $('conexion');
  chip.hidden = false;
  if (!cliente || !cliente.connected) { chip.textContent = 'Sin conexión con el broker'; chip.className = 'chip mal'; }
  else if (espOnline === null) { chip.textContent = 'ESP32: esperando datos…'; chip.className = 'chip'; }
  else if (espOnline) { chip.textContent = 'ESP32: conectado'; chip.className = 'chip ok'; }
  else { chip.textContent = 'ESP32: desconectado (el estado puede ser viejo)'; chip.className = 'chip mal'; }
  document.querySelectorAll('[data-elemento]').forEach(b => b.disabled = espOnline !== true);
  $('broker').textContent = espOnline === null ? '—' : espOnline ? 'Conectado' : 'Desconectado';
  mostrarCalidad();
}

// Mensajes

function alRecibir(tema, datos) {
  const texto = datos.toString();
  if (tema === TEMAS.online) {
    espOnline = texto === '1';
    mostrarConexion();
    return;
  }
  let d;
  try { d = JSON.parse(texto); } catch (e) { return; }
  if (tema === TEMAS.estado) mostrarEstado(d);
  else if (tema === TEMAS.respuesta && pedidos.has(d.id)) pedidos.get(d.id)(d);
}

function publicar(tema, datos) {
  cliente.publish(tema, JSON.stringify(datos), {qos: 1, retain: false});
}

// Publica y espera la respuesta con el mismo id en login/respuesta.
function pedir(tema, datos) {
  return new Promise(resolver => {
    if (!cliente || !cliente.connected) return resolver({ok: false, mensaje: 'Sin conexión con el broker.'});
    if (espOnline === false) return resolver({ok: false, mensaje: 'El ESP32 está desconectado.'});
    const id = idAzar();
    const fin = respuesta => {
      clearTimeout(reloj);
      pedidos.delete(id);
      resolver(respuesta);
    };
    const reloj = setTimeout(() => fin({ok: false, mensaje: 'El ESP32 no respondió.'}), ESPERA_RESPUESTA_MS);
    pedidos.set(id, fin);
    publicar(tema, {id, ...datos});
  });
}

function idAzar() {
  return Math.random().toString(36).slice(2, 10);
}

// Clave y sesión

async function enviarClave(ev) {
  ev.preventDefault();
  const boton = ev.target.querySelector('button');
  boton.disabled = true;
  $('errorAcceso').textContent = '';
  const r = await pedir(TEMAS.login, {clave: $('claveAcceso').value});
  boton.disabled = false;
  $('claveAcceso').value = '';
  if (!r.ok) {
    $('errorAcceso').textContent = r.mensaje;
    return;
  }
  sesion = {token: r.token, ses: r.ses, vence: Date.now() + r.vence * 1000};
  $('aviso').textContent = '';
  actualizarReloj();
  ver('panel');
}

function terminarSesion(mensaje) {
  sesion = null;
  $('errorAcceso').textContent = mensaje;
  ver('acceso');
}

function actualizarReloj() {
  if (!sesion) return;
  const s = Math.ceil((sesion.vence - Date.now()) / 1000);
  if (s <= 0) return terminarSesion('La sesión venció. Ingresá la clave de nuevo.');
  $('restante').textContent = 'La sesión vence en ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// Estado y eventos

function hora(segundos) {
  return new Date(segundos * 1000).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

// Rangos de RSSI explicados en REDES.md.
function calidadSenal(rssi) {
  if (rssi >= -67) return ['Buena', 'buena'];
  if (rssi >= -75) return ['Media', 'regular'];
  return ['Mala', 'mala'];
}

function mostrarPresencia(d) {
  $('distancia').textContent = typeof d.dist === 'number' ? d.dist + ' cm' : 'Sin eco';
  $('presencia').textContent = d.pres ? 'Sí' : 'No';
  $('presencia').className = d.pres ? 'buena' : '';
  let detalle = d.lectura ? 'Última lectura: ' + hora(d.lectura) + '. ' : '';
  if (d.umbral) detalle += 'Hay presencia a menos de ' + d.umbral + ' cm.';
  $('lectura').textContent = detalle;

  const alertas = (Array.isArray(d.alertas) ? d.alertas : []).map(a => ALERTAS[a]).filter(Boolean);
  $('alertasMaqueta').hidden = alertas.length === 0;
  $('alertasMaqueta').textContent = alertas.map(a => '⚠ ' + a).join('\n');
}

function mostrarRed(d) {
  const red = d.red || {};
  if (typeof red.rssi === 'number') ultimoRssi = red.rssi;
  mostrarCalidad();
}

// Solo se muestra con el ESP32 conectado: si no, el dato sería viejo.
function mostrarCalidad() {
  const [texto, clase] = espOnline === true && ultimoRssi !== null ? calidadSenal(ultimoRssi) : ['—', ''];
  $('senal').textContent = texto;
  $('senal').className = clase;
}

// Resalta el botón del modo actual de la luz.
function marcarModo(modo) {
  document.querySelectorAll('[data-accion="manual"], [data-accion="auto"]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.accion === modo));
  });
}

function mostrarEstado(d) {
  $('puerta').textContent = d.puerta ? 'Abierta' : 'Cerrada';
  $('ventana').textContent = d.ventana ? 'Abierta' : 'Cerrada';
  $('luz').textContent = d.luz ? 'Encendida' : 'Apagada';
  $('modo').textContent = d.modo === 'auto' ? 'Automático' : 'Manual';
  marcarModo(d.modo === 'auto' ? 'auto' : 'manual');
  mostrarPresencia(d);
  mostrarRed(d);

  const eventos = Array.isArray(d.eventos) ? d.eventos : [];
  $('eventos').replaceChildren(...eventos.map(e => {
    const fila = document.createElement('tr');
    if (e.a) fila.className = 'sospechoso';
    fila.insertCell().textContent = hora(e.t);
    fila.insertCell().textContent = e.r;
    return fila;
  }));
  const sospechosos = eventos.filter(e => e.a).length;
  $('alerta').hidden = sospechosos === 0;
  $('alerta').textContent = 'Atención: hay ' + sospechosos + ' evento(s) sospechoso(s) en la lista. Si no fuiste vos, cambiá la contraseña del broker y la clave de acceso.';

  // Si el ESP32 ya no tiene nuestra sesión, venció o alguien más inició otra.
  if (sesion && d.ses !== sesion.ses) {
    terminarSesion('El ESP32 cerró esta sesión: venció, se reinició o alguien inició otra. Si no fuiste vos, cambiá la contraseña del broker y la clave de acceso.');
  }
}

// Comandos

async function enviarComando(elemento, accion, extra) {
  const r = await pedir(TEMAS.comando, {token: sesion.token, elemento, accion, ...extra});
  if (r.fin) {
    terminarSesion(r.mensaje);
    return null;
  }
  return r;
}

async function alTocarPanel(ev) {
  const boton = ev.target.closest('[data-elemento]');
  if (!boton || !sesion) return;
  const {elemento, accion} = boton.dataset;
  $('aviso').textContent = '';
  const r = await enviarComando(elemento, accion);
  if (r && !r.ok) $('aviso').textContent = r.mensaje;
}

// Inicio

revisarDominio();
$('formLogin').addEventListener('submit', conectar);
$('formAcceso').addEventListener('submit', enviarClave);
$('panel').addEventListener('click', alTocarPanel);
document.querySelectorAll('[data-salir]').forEach(b => b.addEventListener('click', salir));
setInterval(actualizarReloj, 1000);
