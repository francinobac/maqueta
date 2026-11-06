'use strict';

// Datos públicos del proyecto: acá no van contraseñas ni la clave de acceso.
const CONFIG = {
  BROKER_URL: 'wss://TU-DEPLOYMENT.emqxsl.com:8084/mqtt',
  PREFIJO: 'escuela/maqueta1',          // igual que PREFIJO_TEMAS en config.h
  DOMINIO_OFICIAL: 'TU-USUARIO.github.io',
};

const TEMAS = {
  login: CONFIG.PREFIJO + '/login',
  respuesta: CONFIG.PREFIJO + '/login/respuesta',
  comando: CONFIG.PREFIJO + '/comando',
  estado: CONFIG.PREFIJO + '/estado',
  online: CONFIG.PREFIJO + '/online',
};
const ESPERA_RESPUESTA_MS = 8000;
const NOMBRES = {puerta: 'la puerta', ventana: 'la ventana'};

const $ = id => document.getElementById(id);

let cliente = null;       // conexión MQTT
let espOnline = null;     // null: todavía no se sabe
let sesion = null;        // {token, ses, vence}. Solo en memoria: se pierde al recargar.
let pendiente = null;     // comando de apertura que espera la clave
const pedidos = new Map();  // pedidos sin responder, por id

function ver(id) {
  ['login', 'acceso', 'panel'].forEach(s => $(s).hidden = s !== id);
}

/* ---------- Aviso de dominio (ayuda a reconocer copias; no es una protección) ---------- */

function revisarDominio() {
  $('dominioOficial').textContent = 'https://' + CONFIG.DOMINIO_OFICIAL;
  if (location.hostname !== CONFIG.DOMINIO_OFICIAL) {
    $('dominio').classList.add('peligro');
    $('dominio').firstElementChild.textContent =
      'Este no parece el sitio oficial (estás en ' + (location.hostname || 'un archivo local') + '). No escribas tus datos.';
  }
}

/* ---------- Conexión al broker ---------- */

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
  if (c) c.end(false);
  cerrarConfirmacion();
  for (const responder of pedidos.values()) responder({ok: false, mensaje: 'Desconectado.'});
  $('eventos').replaceChildren();
  ['puerta', 'ventana', 'luz'].forEach(id => $(id).textContent = '—');
  $('alerta').hidden = true;
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
}

/* ---------- Mensajes ---------- */

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

/* ---------- Clave y sesión ---------- */

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
  cerrarConfirmacion();
  $('errorAcceso').textContent = mensaje;
  ver('acceso');
}

function actualizarReloj() {
  if (!sesion) return;
  const s = Math.ceil((sesion.vence - Date.now()) / 1000);
  if (s <= 0) return terminarSesion('La sesión venció. Ingresá la clave de nuevo.');
  $('restante').textContent = 'La sesión vence en ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/* ---------- Estado y eventos ---------- */

function mostrarEstado(d) {
  $('puerta').textContent = d.puerta ? 'Abierta' : 'Cerrada';
  $('ventana').textContent = d.ventana ? 'Abierta' : 'Cerrada';
  $('luz').textContent = d.luz ? 'Prendida' : 'Apagada';

  const eventos = Array.isArray(d.eventos) ? d.eventos : [];
  $('eventos').replaceChildren(...eventos.map(e => {
    const fila = document.createElement('tr');
    if (e.a) fila.className = 'sospechoso';
    fila.insertCell().textContent = new Date(e.t * 1000).toLocaleString('es-AR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
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

/* ---------- Comandos ---------- */

async function enviarComando(elemento, accion, clave) {
  const datos = {token: sesion.token, elemento, accion};
  if (clave) datos.clave = clave;
  const r = await pedir(TEMAS.comando, datos);
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
  if (accion === 'abrir') {
    pendiente = {elemento, accion};
    $('confirmarTitulo').textContent = 'Abrir ' + NOMBRES[elemento];
    $('errorConfirmar').textContent = '';
    $('claveConfirmar').value = '';
    $('confirmar').showModal();
    return;
  }
  $('aviso').textContent = '';
  const r = await enviarComando(elemento, accion);
  if (r && !r.ok) $('aviso').textContent = r.mensaje;
}

async function confirmarApertura(ev) {
  ev.preventDefault();
  if (!pendiente || !sesion) return;
  const boton = ev.target.querySelector('button:not([type=button])');
  boton.disabled = true;
  const r = await enviarComando(pendiente.elemento, pendiente.accion, $('claveConfirmar').value);
  boton.disabled = false;
  $('claveConfirmar').value = '';
  if (!r) return;
  if (r.ok) cerrarConfirmacion();
  else $('errorConfirmar').textContent = r.mensaje;
}

function cerrarConfirmacion() {
  pendiente = null;
  if ($('confirmar').open) $('confirmar').close();
}

/* ---------- Inicio ---------- */

revisarDominio();
$('formLogin').addEventListener('submit', conectar);
$('formAcceso').addEventListener('submit', enviarClave);
$('formConfirmar').addEventListener('submit', confirmarApertura);
$('cancelarConfirmar').addEventListener('click', cerrarConfirmacion);
$('panel').addEventListener('click', alTocarPanel);
document.querySelectorAll('[data-salir]').forEach(b => b.addEventListener('click', salir));
setInterval(actualizarReloj, 1000);
