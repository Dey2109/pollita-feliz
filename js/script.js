// =====================================================================
// POLLITA FELIZ - script.js (versión corregida)
// Idea central: en el navegador NADA es secreto. Todo lo que ponga aquí
// lo puede leer cualquiera. Por eso ya no hay token de bot ni contraseña
// de admin: la seguridad real vive en Firebase Auth + reglas de Firestore.
// =====================================================================
import { db, auth, WORKER_URL } from './config.js';
import { collection, deleteDoc, doc, onSnapshot, query, orderBy, serverTimestamp, updateDoc, arrayUnion, arrayRemove, writeBatch, deleteField }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signInAnonymously, signInWithEmailAndPassword, signOut, onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// Quitamos cualquier "/" sobrante al final: con "…workers.dev/" + "/upload" salía "//upload" y daba 404.
const WORKER_BASE = WORKER_URL.replace(/\/+$/, '');
const $ = (id) => document.getElementById(id);
// Código del error de Firebase (ej. permission-denied) para ver la causa real en vez de un aviso genérico.
const cod = (e) => (e?.code ? ` (${e.code})` : '');
// localStorage puede lanzar error (modo privado, almacenamiento lleno): este envoltorio evita que eso rompa la página.
const ls = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento: seguimos */ } } };
// "Nuevo": lo que otras personas publicaron desde tu última visita. La fecha se guarda en ESTE navegador.
// 0 = primera visita: no se marca nada como nuevo (si no, absolutamente todo lo sería).
const VISITA_PREVIA = Number(ls.get('pf_ultima_visita')) || 0;
const guardarVisita = () => ls.set('pf_ultima_visita', String(Date.now()));
addEventListener('pagehide', guardarVisita);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') guardarVisita(); }); // en celular "pagehide" no siempre se dispara
const fmtFecha = (ms) => new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short', year: 'numeric' }).format(ms);
const esNuevo = (i) => VISITA_PREVIA > 0 && i.uid !== estado.user?.uid && (i.fecha?.toMillis?.() || 0) > VISITA_PREVIA;
const ITEMS_POR_PAGINA = 15;

// Un solo objeto de estado: así es fácil saber qué datos mueven la pantalla.
const estado = { user: null, items: [], imagenes: [], visibles: [], filtro: 'todo', busqueda: '', pagina: 1, tipoSubida: 'archivo', lbIdx: 0, subiendo: false, listo: false, foco: null, cola: [], titulo: '', orden: 'subida', seleccion: [] };

// Admin = usuario con correo/clave (no anónimo). OJO: esto solo cambia la UI;
// quien realmente manda es firestore.rules, que valida en el servidor.
const esAdmin = () => !!estado.user && !estado.user.isAnonymous;

// ---------- Utilidades seguras ----------
// Creamos nodos con textContent en vez de innerHTML: el texto del usuario
// nunca se interpreta como HTML, así que no hay XSS ni comillas que rompan atributos.
function el(tag, props = {}, ...hijos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v);
    }
    hijos.flat().filter(Boolean).forEach((h) => n.append(h));
    return n;
}
const icono = (clase) => el('i', { class: clase });

// Solo aceptamos URLs https; bloquea "javascript:" y similares.
function urlSegura(u) {
    try { const x = new URL(u); return x.protocol === 'https:' ? x.href : ''; } catch { return ''; }
}

// En Firestore guardamos el file_id de Telegram (permanente) dentro de una URL "de mentira":
// https://api.telegram.org/fid/<file_id>. Cumple las reglas (https) y no lleva ningún secreto.
// Para MOSTRAR un archivo la página NO habla con Telegram: usa el Worker, que es quien tiene el token
// y siempre pide una ruta fresca (las rutas de Telegram caducan).
const FID_BASE = 'https://api.telegram.org/fid/';
const urlTelegram = (fileId) => Promise.resolve(`${WORKER_BASE}/file/${encodeURIComponent(fileId)}`);
const urlMedia = (u) => urlSegura(u || '');
// Para file_id de Telegram arma la dirección del Worker; para otros links (Catbox, etc.) los deja como están.
const resolverMedia = (u) => (u || '').startsWith(FID_BASE) ? urlTelegram(u.slice(FID_BASE.length)) : Promise.resolve(urlMedia(u));

// ---------- Toasts ----------
function mostrarToast(msg, tipo = 'info', ms = 3000) {
    const cont = $('toast-container'); if (!cont) return;
    const iconos = { success: '✓', error: '✕', warning: '!', info: 'i' };
    const toast = el('div', { class: `toast ${tipo}` },
        el('span', { class: 'toast-icon', text: iconos[tipo] || 'i' }),
        el('span', { class: 'toast-message', text: msg }),
        el('button', { class: 'toast-close', text: '×' }));
    const cerrar = () => {
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 250);
    };
    toast.addEventListener('click', cerrar);
    cont.append(toast);
    if (ms > 0) setTimeout(cerrar, ms);
}

// ---------- Modales (reusan el HTML existente) ----------
function pedirTexto(titulo, tipoInput = 'password', placeholder = '', inicial = '') {
    return new Promise((resolve) => {
        const m = $('pin-modal'), inp = $('pin-modal-input');
        $('pin-modal-title').textContent = titulo;
        inp.type = tipoInput; inp.placeholder = placeholder; inp.value = inicial;
        // Le dice al navegador qué es este campo: así puede ofrecer tu correo y tu clave guardados, y no guarda un título como si fuera una contraseña.
        inp.autocomplete = tipoInput === 'password' ? 'current-password' : tipoInput === 'email' ? 'username' : 'off'; // "inicial" sirve para editar un texto que ya existe
        m.classList.add('active');
        setTimeout(() => { inp.focus(); inp.select(); }, 100);
        const fin = (valor) => { m.classList.remove('active'); resolve(valor); };
        $('pin-modal-confirm').onclick = () => fin(inp.value.trim());
        $('pin-modal-cancel').onclick = () => fin(null);
        inp.onkeydown = (e) => { if (e.key === 'Enter') fin(inp.value.trim()); };
    });
}
// Dentro de un <form>, Enter "envía" el formulario y la página se recargaría: lo frenamos (el valor se resuelve con los botones).
$('pin-form').addEventListener('submit', (e) => e.preventDefault());
function confirmar(titulo, mensaje, textoOk = 'Eliminar') {
    return new Promise((resolve) => {
        const m = $('confirm-modal');
        $('confirm-modal-title').textContent = titulo;
        $('confirm-modal-message').textContent = mensaje;
        $('confirm-modal-ok').textContent = textoOk; // antes siempre decía "Eliminar", aunque la acción fuera otra
        m.classList.add('active');
        const fin = (v) => { m.classList.remove('active'); resolve(v); };
        setTimeout(() => $('confirm-modal-cancel').focus(), 100); // el foco empieza en la opción segura
        $('confirm-modal-ok').onclick = () => fin(true);
        $('confirm-modal-cancel').onclick = () => fin(false);
    });
}

// ---------- Autenticación ----------
// Todo visitante entra como "anónimo": Firebase le da un uid único.
// Ese uid se guarda en cada publicación y las reglas dejan borrar solo al dueño.
onAuthStateChanged(auth, (user) => {
    if (!user) { signInAnonymously(auth).catch((err) => { console.error(err); mostrarToast('No se pudo iniciar sesión: ' + err.code, 'error', 6000); }); return; }
    estado.user = user;
    // Para comparar con el UID de las reglas: si eres admin, este UID debe ser EXACTAMENTE el que pusiste en firestore.rules.
    console.info('Sesión:', user.uid, user.isAnonymous ? '(anónima)' : '(con correo)');
    actualizarUIAdmin();
    mostrarPagina(); // re-dibuja para mostrar/ocultar botones de borrar
});

// Si la sesión anónima falló porque no había internet, se reintenta sola cuando vuelva la conexión
// (antes había que recargar la página a mano).
window.addEventListener('online', () => { if (!estado.user) signInAnonymously(auth).catch(() => {}); });

function actualizarUIAdmin() {
    const b = $('btn-admin'); if (!b) return;
    b.replaceChildren(icono(esAdmin() ? 'fas fa-crown' : 'fas fa-lock'));
    b.classList.toggle('admin-activo', esAdmin());
    b.title = esAdmin() ? 'Salir del modo admin' : 'Admin';
    b.setAttribute('aria-label', b.title); // los lectores de pantalla no leen el ícono, leen esto
    // La papelera solo existe para el admin; si sales del modo admin con ella abierta, volvemos a "Todo".
    const chip = $('filtro-papelera'); if (chip) chip.hidden = !esAdmin();
    if (!esAdmin() && estado.filtro === 'papelera') { estado.filtro = 'todo'; marcarFiltro(); }
}

$('btn-admin')?.addEventListener('click', async () => {
    if (esAdmin()) {
        if (await confirmar('Salir del modo admin', '¿Seguro que quieres salir?', 'Salir')) {
            await signOut(auth); // onAuthStateChanged nos vuelve a poner como anónimo
            mostrarToast('Modo admin desactivado', 'info');
        }
        return;
    }
    const correo = await pedirTexto('Correo de admin', 'email', 'correo@ejemplo.com');
    if (!correo) return;
    const clave = await pedirTexto('Contraseña de admin', 'password', 'Contraseña');
    if (!clave) return;
    try {
        await signInWithEmailAndPassword(auth, correo, clave); // se valida en el servidor
        mostrarToast('Modo admin activado', 'success');
    } catch { mostrarToast('Credenciales incorrectas', 'error'); }
});

// ---------- Firestore (tiempo real) ----------
const q = query(collection(db, 'galeria'), orderBy('fecha', 'desc'));
onSnapshot(q, (snap) => {
    $('loading-skeleton').style.display = 'none';
    estado.items = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    // Ya NO reiniciamos a la página 1: si alguien sube algo mientras miras la 3, te quedas en la 3.
    mostrarPagina();
    if (!estado.listo) { estado.listo = true; irAPublicacion(); } // si entraron por un enlace #p/<id>, vamos a esa publicación
}, (err) => {
    console.error(err);
    mostrarToast('Error al cargar la galería', 'error');
});

function detectarTipo(url, tipoDB) {
    const u = (url || '').toLowerCase();
    if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
    if (/vimeo\.com/.test(u)) return 'vimeo';
    if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/.test(u) || tipoDB === 'imagen') return 'imagen';
    if (/\.(mp4|webm|ogg|mov)(\?|$)/.test(u) || tipoDB === 'video') return 'video';
    return 'enlace';
}

// ---------- Paginación + tarjetas ----------
function mostrarPagina() {
    const grid = $('galeria-grid');
    // Primero filtramos (tipo + texto) y DESPUÉS paginamos, para que las páginas cuenten solo lo visible.
    const texto = estado.busqueda.toLowerCase();
    // "borrado" = soft delete: el documento sigue en Firestore pero está en la papelera (solo la ve el admin).
    const base = estado.items.filter((i) => estado.filtro === 'papelera' ? i.borrado === true : !i.borrado);
    estado.visibles = base.filter((i) => {
        const esImg = detectarTipo(i.url, i.tipo) === 'imagen';
        const okTipo = ['todo', 'papelera'].includes(estado.filtro) || (estado.filtro === 'imagen') === esImg;
        return okTipo && i.titulo.toLowerCase().includes(texto);
    });
    // Orden elegido: lo recién subido (como llega de Firestore), la fecha en que se tomó la foto, o lo más querido.
    const cuando = (i) => i.tomada ?? i.fecha?.toMillis?.() ?? Date.now(); // sin fecha de toma se usa la de subida
    if (estado.orden === 'foto') estado.visibles.sort((a, b) => cuando(b) - cuando(a));
    else if (estado.orden === 'queridas') estado.visibles.sort((a, b) => contarReacciones(b).total - contarReacciones(a).total || cuando(b) - cuando(a));
    // El lightbox navega solo entre las imágenes que se están viendo.
    estado.imagenes = estado.visibles.filter((i) => detectarTipo(i.url, i.tipo) === 'imagen');
    const total = Math.max(1, Math.ceil(estado.visibles.length / ITEMS_POR_PAGINA));
    estado.pagina = Math.min(estado.pagina, total); // por si se borró el último de la última página
    $('empty-state').style.display = estado.visibles.length ? 'none' : 'block';
    $('empty-state').textContent = base.length ? '🔍 Sin resultados.' : estado.filtro === 'papelera' ? '🗑️ La papelera está vacía.' : '🐣 Aún no hay nada. Sé el primero.';
    const ini = (estado.pagina - 1) * ITEMS_POR_PAGINA;
    grid.replaceChildren(...estado.visibles.slice(ini, ini + ITEMS_POR_PAGINA).map(crearTarjeta));
    $('pagina-info').textContent = `${estado.pagina} / ${total}`;
    $('btn-anterior').disabled = estado.pagina <= 1;
    $('btn-siguiente').disabled = estado.pagina >= total;
    $('paginacion').style.display = total > 1 ? 'flex' : 'none';
}
$('btn-anterior').addEventListener('click', () => { estado.pagina--; mostrarPagina(); });
$('btn-siguiente').addEventListener('click', () => { estado.pagina++; mostrarPagina(); });

// Observer: los videos cargan solo cuando están por entrar en pantalla (ahorra datos y memoria).
const observador = new IntersectionObserver((entradas) => {
    entradas.forEach((en) => { if (en.isIntersecting) { en.target.src = en.target.dataset.src; observador.unobserve(en.target); } });
}, { rootMargin: '200px' });

// "Fachada": miniatura + botón play (+ nombre del sitio). El reproductor real (pesado) se crea solo al tocarla.
function fachada(miniatura, crearReproductor, etiqueta) {
    const b = el('button', { class: 'facade', 'aria-label': 'Reproducir' }, icono('fas fa-play'),
        etiqueta ? el('span', { class: 'facade-label', text: etiqueta }) : null);
    // "miniatura" puede ser una URL o una promesa (las de Telegram hay que pedirlas con getFile).
    if (miniatura) Promise.resolve(miniatura).then((u) => { if (u) b.style.backgroundImage = `url("${u}")`; }).catch(() => {});
    b.addEventListener('click', () => b.replaceWith(crearReproductor()));
    return b;
}

// Tabla de proveedores: [patrón del link, función que devuelve la URL "embed" del reproductor].
// Cada web tiene su propia dirección de reproductor incrustable; por eso hay que traducir link -> embed.
// Para agregar otra web: añade una fila con su patrón y su URL de embed.
const EMBEDS = [
    [/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/,
        (m) => ({ src: `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1`, miniatura: `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` })],
    [/vimeo\.com\/(?:.*\/)?(\d+)/, (m) => ({ src: `https://player.vimeo.com/video/${m[1]}?autoplay=1` })],
    [/(?:dailymotion\.com\/video\/|dai\.ly\/)([a-z0-9]+)/i,
        (m) => ({ src: `https://www.dailymotion.com/embed/video/${m[1]}?autoplay=1`, miniatura: `https://www.dailymotion.com/thumbnail/video/${m[1]}` })],
    [/twitch\.tv\/videos\/(\d+)/, (m) => ({ src: `https://player.twitch.tv/?video=v${m[1]}&parent=${location.hostname}&autoplay=true` })],
    [/(?:clips\.twitch\.tv\/|twitch\.tv\/\w+\/clip\/)([\w-]+)/, (m) => ({ src: `https://clips.twitch.tv/embed?clip=${m[1]}&parent=${location.hostname}&autoplay=true` })],
    [/tiktok\.com\/.*\/video\/(\d+)/, (m) => ({ src: `https://www.tiktok.com/embed/v2/${m[1]}` })],
    [/streamable\.com\/(?:e\/)?(\w+)/, (m) => ({ src: `https://streamable.com/e/${m[1]}` })],
    [/drive\.google\.com\/file\/d\/([\w-]+)/, (m) => ({ src: `https://drive.google.com/file/d/${m[1]}/preview` })],
    [/loom\.com\/share\/(\w+)/, (m) => ({ src: `https://www.loom.com/embed/${m[1]}` })],
    [/instagram\.com\/(?:p|reel|tv)\/([\w-]+)/, (m) => ({ src: `https://www.instagram.com/p/${m[1]}/embed` })],
    [/facebook\.com\/(?:.+\/videos\/|watch|reel\/)|fb\.watch\//,
        (m, url) => ({ src: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false` })]
];
function embedDe(url) {
    for (const [patron, armar] of EMBEDS) { const m = url.match(patron); if (m) return armar(m, url); }
    return null;
}
const crearIframe = (src, desconocido = false) => {
    const f = el('iframe', { src, allow: 'autoplay; fullscreen; picture-in-picture', loading: 'lazy' });
    // Webs desconocidas: "sandbox" limita lo que la página incrustada puede hacer (p. ej. no puede redirigir tu sitio).
    if (desconocido) f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox');
    return f;
};

function crearMedia(item, tipo) {
    const error = () => el('div', { class: 'media-error' }, icono('fas fa-ban'), el('span', { text: 'No disponible' }));
    const esTg = item.url?.startsWith(FID_BASE);
    const url = esTg ? '' : urlMedia(item.url); // los de Telegram se resuelven más abajo, con una ruta fresca
    if (!esTg && !url) return error();
    if (tipo === 'video') { // archivo de video directo (.mp4, .webm...)
        // Con miniatura propia: se ve una imagen liviana y el video pesado solo se descarga al darle play.
        if (item.thumb) {
            const crearVideo = () => {
                const v = el('video', { controls: '', playsinline: '', autoplay: '' });
                v.addEventListener('error', () => v.replaceWith(error()));
                resolverMedia(item.url).then((u) => { v.src = u; }).catch(() => v.replaceWith(error()));
                return v;
            };
            return fachada(resolverMedia(item.thumb), crearVideo);
        }
        // Publicaciones viejas (sin miniatura): como antes, primer fotograma con "#t=0.1".
        const v = el('video', { controls: '', preload: 'metadata', playsinline: '' });
        v.addEventListener('error', () => v.replaceWith(error()));
        const listo = (u) => { v.dataset.src = u + '#t=0.1'; observador.observe(v); };
        if (esTg) resolverMedia(item.url).then(listo).catch(() => v.replaceWith(error())); else listo(url);
        return v;
    }
    if (tipo === 'imagen') {
        // La rejilla usa la miniatura (~480px) si existe; el archivo completo solo se baja en el lightbox.
        const img = el('img', { alt: item.titulo, loading: 'lazy' });
        img.addEventListener('error', () => img.replaceWith(error()));
        resolverMedia(item.thumb || item.url).then((u) => { if (u) img.src = u; else img.replaceWith(error()); }).catch(() => img.replaceWith(error()));
        return img;
    }
    // Cualquier otro link: primero buscamos un reproductor conocido...
    const emb = embedDe(url);
    if (emb) return fachada(emb.miniatura, () => crearIframe(emb.src), new URL(url).hostname.replace(/^www\./, ''));
    // ...y si la web no está en la tabla, intentamos incrustarla igual (click para cargar, dentro de un sandbox).
    // Algunas webs prohíben ser incrustadas: para eso cada tarjeta tiene el botón "Abrir original".
    return fachada(null, () => crearIframe(url, true), new URL(url).hostname.replace(/^www\./, ''));
}

// ---------- Reacciones con emojis ----------
// Cada persona tiene UNA reacción por publicación, guardada en el mapa "reac": { uid: tipo }.
// Guardamos un NOMBRE ("corazon"), no el emoji: así las reglas de Firestore comparan texto simple y nunca falla por un
// detalle invisible de Unicode. Los likes de antes (lista "likedBy") siguen contando como ❤️.
const REACCIONES = {
    corazon: { emoji: '❤️', texto: 'Me encanta' }, risa: { emoji: '😂', texto: 'Me divierte' }, sorpresa: { emoji: '😮', texto: 'Me sorprende' },
    triste: { emoji: '😢', texto: 'Me entristece' }, aplauso: { emoji: '👏', texto: 'Aplausos' }
};
function contarReacciones(item, uid) {
    const porUid = { ...(item.reac || {}) };
    for (const u of item.likedBy || []) if (!(u in porUid)) porUid[u] = 'corazon'; // los likes viejos cuentan como ❤️
    const porTipo = {};
    for (const t of Object.values(porUid)) if (t in REACCIONES) porTipo[t] = (porTipo[t] || 0) + 1;
    return { porTipo, total: Object.values(porTipo).reduce((a, b) => a + b, 0), mia: porUid[uid] in REACCIONES ? porUid[uid] : null };
}
async function reaccionar(item, tipo) {
    if (!estado.user) return;
    const uid = estado.user.uid, ref = doc(db, 'galeria', item.id);
    const { mia } = contarReacciones(item, uid);
    const likeViejo = (item.likedBy || []).includes(uid);
    try {
        // Un like viejo vive en OTRO campo (likedBy): se quita aparte, así cada escritura toca un solo campo y las reglas son simples.
        if (likeViejo) await updateDoc(ref, { likedBy: arrayRemove(uid) });
        if (mia === tipo) { if (!likeViejo) await updateDoc(ref, { [`reac.${uid}`]: deleteField() }); } // tocar la misma reacción otra vez la quita
        else await updateDoc(ref, { [`reac.${uid}`]: tipo });
    } catch (e) { console.error(e); mostrarToast('No se pudo registrar tu reacción' + cod(e), 'error'); }
}
const alternarLike = (item) => reaccionar(item, 'corazon'); // atajo F del lightbox

// Cierra la paleta abierta con pulsación larga cuando tocas fuera de ella.
document.addEventListener('click', (e) => document.querySelectorAll('.reac.abierto').forEach((r) => { if (!r.contains(e.target)) r.classList.remove('abierto'); }));

function crearReacciones(item) {
    const { porTipo, total, mia } = contarReacciones(item, estado.user?.uid);
    const top = Object.entries(porTipo).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => REACCIONES[t].emoji).join('');
    const cont = el('div', { class: 'reac' });
    // Botón principal: un toque = ❤️ (o quitar tu reacción). Muestra la tuya, o un corazón vacío.
    const btn = el('button', { type: 'button', class: 'like-btn' + (mia === 'corazon' ? ' liked' : mia ? ' reaccionado' : ''), 'aria-haspopup': 'true',
        title: mia ? `Tu reacción: ${REACCIONES[mia].texto}` : 'Reaccionar', 'aria-label': `Reaccionar (${total} reacciones)` },
        mia ? el('span', { class: 'reac-mia', text: REACCIONES[mia].emoji }) : icono('far fa-heart'),
        top ? el('span', { class: 'reac-resumen', text: top }) : null, el('span', { text: String(total) }));
    let timer = null, largo = false;
    btn.addEventListener('click', (e) => { if (largo) { largo = false; e.preventDefault(); return; } reaccionar(item, mia && mia !== 'corazon' ? mia : 'corazon'); });
    // En celular no existe "hover": una pulsación larga abre la paleta.
    btn.addEventListener('touchstart', () => { largo = false; timer = setTimeout(() => { largo = true; cont.classList.add('abierto'); }, 450); }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach((t) => btn.addEventListener(t, () => clearTimeout(timer), { passive: true }));
    btn.addEventListener('contextmenu', (e) => e.preventDefault()); // la pulsación larga no debe abrir el menú del navegador
    // La paleta se muestra con CSS al pasar el mouse o al enfocar con teclado (:hover / :focus-within): sin JS extra y accesible.
    const paleta = el('div', { class: 'reac-paleta', role: 'group', 'aria-label': 'Elige una reacción' },
        el('div', { class: 'reac-caja' }, ...Object.entries(REACCIONES).map(([t, r]) =>
            el('button', { type: 'button', class: 'reac-op', title: r.texto, 'aria-label': r.texto, 'aria-pressed': String(mia === t), text: r.emoji, onclick: () => reaccionar(item, t) }))));
    cont.append(btn, paleta);
    return cont;
}

// Botón de acción de tarjeta: "title" para el mouse y "aria-label" para lectores de pantalla.
const btnAccion = (clase, etiqueta, ico, onclick) =>
    el('button', { class: `card-btn ${clase}`, title: etiqueta, 'aria-label': etiqueta, onclick }, icono(ico));

function crearTarjeta(item) {
    const tipo = detectarTipo(item.url, item.tipo);
    const enPapelera = estado.filtro === 'papelera';
    const puedeGestionar = esAdmin() || item.uid === estado.user?.uid; // la UI solo muestra; las reglas son las que mandan
    const media = el('div', { class: 'card-media' },
        el('div', { class: 'card-badges' },
            esNuevo(item) ? el('span', { class: 'card-badge nuevo', text: 'Nuevo' }) : null, // el() ignora los null
            el('span', { class: 'card-badge', text: tipo === 'imagen' ? 'Imagen' : 'Video' })),
        crearMedia(item, tipo));
    if (tipo === 'imagen') {
        const abrir = () => abrirLightbox(estado.imagenes.findIndex((i) => i.id === item.id));
        media.addEventListener('click', abrir);
        // Accesible: se enfoca con Tab y se abre con Enter o Espacio, igual que con el mouse.
        media.setAttribute('role', 'button'); media.tabIndex = 0;
        media.setAttribute('aria-label', `Ver «${item.titulo}» en grande`);
        media.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); } });
    }

    const acciones = el('div', { class: 'card-actions' });
    if (enPapelera) {
        acciones.append(
            btnAccion('restore', 'Restaurar', 'fas fa-rotate-left', () => restaurar(item)),
            btnAccion('delete', 'Eliminar para siempre', 'fas fa-trash', () => eliminarDefinitivo(item)));
    } else {
        acciones.append(
            btnAccion('download', 'Descargar', 'fas fa-download', (e) => descargar(e, item, tipo)),
            btnAccion('share', 'Compartir', 'fas fa-share-nodes', () => compartir(item)));
        // Para videos de otras webs: abrir el original (por si esa web bloquea el reproductor incrustado).
        if (!['imagen', 'video'].includes(tipo)) {
            acciones.append(el('a', { class: 'card-btn', title: 'Abrir original', 'aria-label': 'Abrir original', href: urlMedia(item.url), target: '_blank', rel: 'noopener noreferrer' }, icono('fas fa-external-link-alt')));
        }
        if (puedeGestionar) {
            acciones.append(
                btnAccion('edit', 'Editar título', 'fas fa-pen', () => editarTitulo(item)),
                btnAccion('delete', 'Mover a la papelera', 'fas fa-trash', () => enviarAPapelera(item)));
        }
    }

    const btnLike = crearReacciones(item);
    // <article> en vez de <div>: es una unidad de contenido independiente, y los lectores de pantalla la anuncian como tal.
    return el('article', { class: 'card' + (enPapelera ? ' en-papelera' : ''), 'data-id': item.id, 'aria-label': item.titulo }, media, acciones,
        el('div', { class: 'card-title' }, el('span', { class: 'card-title-text', text: item.titulo }),
            item.tomada ? el('time', { class: 'card-fecha', datetime: new Date(item.tomada).toISOString(), text: fmtFecha(item.tomada) }) : null, // cuándo se tomó la foto
            btnLike));
}

// Editar título: reusa el modal de texto. Las reglas solo lo permiten al dueño o al admin.
async function editarTitulo(item) {
    const nuevo = await pedirTexto('Editar título', 'text', 'Título', item.titulo);
    if (nuevo === null || nuevo === '' || nuevo === item.titulo) return;
    if (nuevo.length > 50) return mostrarToast('El título puede tener hasta 50 caracteres', 'warning');
    try { await updateDoc(doc(db, 'galeria', item.id), { titulo: nuevo }); mostrarToast('Título actualizado', 'success'); }
    catch (e) { console.error(e); mostrarToast('No tienes permiso para editar esto' + cod(e), 'error'); }
}

// Papelera: "borrar" solo marca borrado:true (se puede deshacer). El borrado real es solo del admin y desde la papelera.
async function enviarAPapelera(item) {
    const msg = esAdmin() ? 'Irá a la papelera y podrás restaurarla.' : 'Se quitará de la galería.';
    if (!(await confirmar('Mover a la papelera', msg, 'Mover'))) return;
    try { await updateDoc(doc(db, 'galeria', item.id), { borrado: true }); mostrarToast('Movida a la papelera', 'success'); }
    catch (e) { console.error(e); mostrarToast('No tienes permiso para hacer esto' + cod(e), 'error'); }
}
async function restaurar(item) {
    try { await updateDoc(doc(db, 'galeria', item.id), { borrado: false }); mostrarToast('Publicación restaurada', 'success'); }
    catch (e) { console.error(e); mostrarToast('Solo el admin puede restaurar' + cod(e), 'error'); }
}
async function eliminarDefinitivo(item) {
    if (!(await confirmar('Eliminar para siempre', 'Esta acción no se puede deshacer.'))) return;
    try { await deleteDoc(doc(db, 'galeria', item.id)); mostrarToast('Eliminada para siempre', 'success'); }
    catch (e) { console.error(e); mostrarToast('Solo el admin puede eliminar para siempre' + cod(e), 'error'); }
}

// Enlace directo: https://tu-sitio/#p/<id>. El "#" no recarga la página ni viaja al servidor, solo lo lee este script.
async function compartir(item) {
    const link = `${location.origin}${location.pathname}#p/${item.id}`;
    // En celular (y en algunos navegadores) abre el menú nativo: WhatsApp, Telegram, correo...
    // Si no existe, o fallara, se copia el enlace como antes.
    if (navigator.share) {
        try { await navigator.share({ title: item.titulo, text: `«${item.titulo}» en Pollita Feliz`, url: link }); return; }
        catch (e) { if (e.name === 'AbortError') return; } // cerró el menú a propósito: no insistimos
    }
    try { await navigator.clipboard.writeText(link); mostrarToast('Enlace copiado', 'success'); }
    catch { window.prompt('Copia este enlace:', link); } // si el navegador no deja usar el portapapeles
}
const leerHash = () => (location.hash.match(/^#p\/([\w-]+)$/) || [])[1] || null;
function irAPublicacion(id = leerHash()) {
    const item = id && estado.items.find((i) => i.id === id && !i.borrado);
    if (!item) return;
    estado.filtro = 'todo'; estado.busqueda = ''; $('buscador').value = ''; marcarFiltro();
    mostrarPagina(); // primero para calcular "visibles", luego saltamos a la página que contiene la publicación
    estado.pagina = Math.floor(estado.visibles.findIndex((i) => i.id === id) / ITEMS_POR_PAGINA) + 1;
    mostrarPagina();
    if (detectarTipo(item.url, item.tipo) === 'imagen') abrirLightbox(estado.imagenes.findIndex((i) => i.id === id));
    else { // los videos no se abren en el lightbox: se centran en pantalla y destellan
        const card = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card?.classList.add('destacada'); setTimeout(() => card?.classList.remove('destacada'), 2500);
    }
}
window.addEventListener('hashchange', () => irAPublicacion());

async function descargar(e, item, tipo) {
    e.stopPropagation();
    const url = await resolverMedia(item.url).catch(() => '');
    if (!url) return mostrarToast('Archivo no disponible', 'error'); // evita abrir una pestaña en blanco
    if (tipo === 'youtube' || tipo === 'vimeo' || tipo === 'enlace') { window.open(url, '_blank', 'noopener'); return; }
    try {
        const blob = await (await fetch(url)).blob();
        const a = el('a', { href: URL.createObjectURL(blob), download: item.titulo.replace(/[^a-z0-9]/gi, '_') + '.' + (url.split('.').pop().split('?')[0] || 'bin') });
        document.body.append(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
        mostrarToast('Descarga iniciada', 'success');
    } catch { window.open(url, '_blank', 'noopener'); } // si CORS bloquea, abrimos el archivo directo
}

// ---------- Lightbox ----------
// Transición "la foto vuela": la miniatura de la tarjeta se agranda hasta el lightbox (y al revés al cerrar).
// Usa la View Transitions API: el navegador toma una "foto" del antes y del después y anima entre ambas.
// Si el navegador no la tiene, o la persona pidió menos movimiento, simplemente se abre sin animación.
const imgDeTarjeta = (id) => id ? document.querySelector(`[data-id="${CSS.escape(id)}"] .card-media img`) : null;
function conTransicion(origen, cambio, origenDespues = false) {
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return cambio();
    const html = document.documentElement;
    html.classList.add('vt'); // apaga el fundido normal del lightbox mientras dura la transición
    // Dos elementos no pueden tener el mismo view-transition-name a la vez: por eso el nombre se pone y se quita en el momento justo.
    if (origen && !origenDespues) origen.style.viewTransitionName = 'foto';
    const t = document.startViewTransition(() => {
        if (origen) origen.style.viewTransitionName = origenDespues ? 'foto' : '';
        cambio();
    });
    t.finished.finally(() => { html.classList.remove('vt'); if (origen) origen.style.viewTransitionName = ''; });
}
function abrirLightbox(i) {
    if (i < 0) return;
    estado.lbIdx = i; estado.foco = document.activeElement; // recordamos dónde estaba el foco para devolverlo al cerrar
    conTransicion(imgDeTarjeta(estado.imagenes[i].id), () => {
        pintarLightbox();
        $('lightbox').classList.add('active'); document.body.style.overflow = 'hidden';
        $('lightbox-close').focus();
    });
}
function cerrarLightbox() {
    // Si navegaste a una foto de otra página, su tarjeta no existe y se cierra sin animar.
    conTransicion(imgDeTarjeta(estado.imagenes[estado.lbIdx]?.id), () => {
        $('lightbox').classList.remove('active'); document.body.style.overflow = '';
        history.replaceState(null, '', location.pathname + location.search); // quita el #p/... de la dirección
        estado.foco?.focus?.();
    }, true);
}
function pintarLightbox() {
    const img = estado.imagenes[estado.lbIdx]; if (!img) return;
    $('lightbox-img').classList.remove('zoom'); // cada imagen empieza sin zoom
    $('lightbox-img').alt = img.titulo;
    history.replaceState(null, '', `#p/${img.id}`); // la dirección siempre apunta a la foto que estás viendo (se puede compartir)
    resolverMedia(img.url).then((u) => { if (estado.imagenes[estado.lbIdx] === img) $('lightbox-img').src = u; }).catch(() => mostrarToast('No se pudo cargar la imagen', 'error'));
    $('lightbox-titulo').textContent = img.titulo;
    $('lightbox-counter').textContent = `${estado.lbIdx + 1} / ${estado.imagenes.length}${img.tomada ? ` · ${fmtFecha(img.tomada)}` : ''}`;
}
// El módulo evita índices negativos al retroceder desde la primera imagen.
const moverLB = (d) => { const n = estado.imagenes.length; if (!n) return; estado.lbIdx = (estado.lbIdx + d + n) % n; pintarLightbox(); };
$('lightbox-close').addEventListener('click', cerrarLightbox);
$('lightbox-next').addEventListener('click', (e) => { e.stopPropagation(); moverLB(1); });
$('lightbox-prev').addEventListener('click', (e) => { e.stopPropagation(); moverLB(-1); });
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) cerrarLightbox(); });

// Zoom: clic en la imagen la amplía hacia el punto tocado; otro clic la reduce.
$('lightbox-img').addEventListener('click', (e) => {
    const im = e.currentTarget, r = im.getBoundingClientRect();
    im.style.transformOrigin = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
    im.classList.toggle('zoom');
});
// Swipe: deslizar más de 50px cambia de imagen (se ignora con zoom para no estorbar).
let toqueX = null;
$('lightbox').addEventListener('touchstart', (e) => { toqueX = e.touches[0].clientX; }, { passive: true });
$('lightbox').addEventListener('touchend', (e) => {
    if (toqueX === null || $('lightbox-img').classList.contains('zoom')) return;
    const dx = e.changedTouches[0].clientX - toqueX; toqueX = null;
    if (Math.abs(dx) > 50) moverLB(dx < 0 ? 1 : -1);
});

// UN solo listener de teclado: más fácil de razonar.
document.addEventListener('keydown', (e) => {
    const lbAbierto = $('lightbox').classList.contains('active');
    const ayudaAbierta = $('atajos-modal').classList.contains('active');
    const escribiendo = /^(input|textarea|select)$/i.test(e.target.tagName);
    if (e.key === 'Escape') { // cierra lo que esté más "arriba"
        if ($('editor-modal').classList.contains('active')) cerrarEditor();
        else if ($('pin-modal').classList.contains('active')) $('pin-modal-cancel').click();
        else if ($('confirm-modal').classList.contains('active')) $('confirm-modal-cancel').click();
        else if (ayudaAbierta) $('atajos-modal').classList.remove('active');
        else if ($('tutorial-modal').classList.contains('active')) cerrarTutorial();
        else if (lbAbierto) cerrarLightbox();
        else $('modal-subida').classList.remove('active');
    }
    if (lbAbierto && e.key === 'ArrowRight') moverLB(1);
    if (lbAbierto && e.key === 'ArrowLeft') moverLB(-1);
    // Atajos de una sola tecla. Solo si NO estás escribiendo en un campo y sin Ctrl/Alt/Cmd,
    // para no pisar los atajos del navegador (Ctrl+C copia texto, no el enlace).
    if (!escribiendo && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const img = lbAbierto ? estado.imagenes[estado.lbIdx] : null;
        if (e.key === '?') $('atajos-modal').classList.toggle('active');
        else if (e.key === '/') { e.preventDefault(); $('buscador').focus(); }
        else if (img && e.key.toLowerCase() === 'f') alternarLike(img);
        else if (img && e.key.toLowerCase() === 'c') compartir(img);
        else if (img && e.key.toLowerCase() === 'd') descargar({ stopPropagation() {} }, img, 'imagen'); // descargar() espera un evento: le pasamos uno de mentira
    }
    // Trampa de foco: con Tab el foco da vueltas entre los 3 botones y no se escapa a la página de atrás.
    if (lbAbierto && !ayudaAbierta && e.key === 'Tab') {
        const f = ['lightbox-close', 'lightbox-prev', 'lightbox-next'].map($);
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
});

// ---------- Subida ----------
// Subida directa: Telegram para archivos de hasta 20MB, Catbox para los más grandes.
async function comprimirImagen(file, maxW = 1920, q = 0.85) {
    if (file.type === 'image/gif') return file; // el canvas rompería la animación
    const bmp = await createImageBitmap(file);
    const esc = Math.min(1, maxW / bmp.width); // min(1,…) evita agrandar imágenes chicas
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * esc); c.height = Math.round(bmp.height * esc);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    return blob ? new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
}

// XMLHttpRequest (no fetch) porque fetch no reporta el progreso de subida.
function enviarConProgreso(url, formData, onProgress, headers = {}, ctl = {}) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        ctl.xhr = xhr; // quien llama puede guardar "ctl" y hacer ctl.xhr.abort() para cancelar la subida en curso
        xhr.open('POST', url);
        for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
        xhr.onerror = () => reject(new Error('Sin conexión'));
        xhr.onabort = () => reject(new Error('Cancelado'));
        xhr.onload = () => resolve(xhr.responseText); // quien llama revisa si la respuesta es válida
        xhr.send(formData);
    });
}

// Se sube al Worker (NO a Telegram directo): el Worker guarda el token y nos devuelve el file_id.
// Mandamos el "token de sesión" de Firebase para que el Worker sepa que quien sube es un usuario de ESTE sitio.
async function subirATelegram(file, onProgress, ctl = {}) {
    if (!auth.currentUser) throw new Error('Aún no hay sesión. Recarga la página.');
    const idToken = await auth.currentUser.getIdToken();
    const fd = new FormData();
    fd.append('file', file);
    let data;
    try { data = JSON.parse(await enviarConProgreso(`${WORKER_BASE}/upload`, fd, onProgress, { Authorization: `Bearer ${idToken}` }, ctl)); }
    catch { throw new Error('Respuesta inválida del servidor de subida'); }
    if (!data.fileId) throw new Error(data.error || 'No se obtuvo el file_id');
    return { url: FID_BASE + data.fileId, tipo: file.type.startsWith('image/') ? 'imagen' : 'video' };
}

async function subirACatbox(file, onProgress, ctl = {}) {
    const fd = new FormData();
    fd.append('reqtype', 'fileupload');
    fd.append('fileToUpload', file);
    const url = (await enviarConProgreso('https://catbox.moe/user/api.php', fd, onProgress, {}, ctl)).trim();
    if (!url.startsWith('https://')) throw new Error('Catbox no devolvió una URL válida');
    return { url, tipo: file.type.startsWith('image/') ? 'imagen' : 'video' };
}

// Telegram solo permite que un bot descargue archivos de hasta 20MB; lo más grande va a Catbox.
const subirArchivo = (file, p, ctl) => file.size <= 20 * 1024 * 1024 ? subirATelegram(file, p, ctl) : subirACatbox(file, p, ctl);

// Miniatura (~480px) de una imagen o de un fotograma de video. Se sube aparte y la rejilla usa ESTA:
// una foto de 4MB pasa a pesar ~40KB en la galería, y el original solo se baja al abrir el lightbox.
function fotogramaDeVideo(file) {
    return new Promise((resolve, reject) => {
        const v = document.createElement('video');
        const urlTmp = URL.createObjectURL(file);
        const limpiar = () => URL.revokeObjectURL(urlTmp);
        v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = urlTmp;
        v.onloadeddata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); }; // un poco adentro: el fotograma 0 suele ser negro
        v.onseeked = () => createImageBitmap(v).then((b) => { limpiar(); resolve(b); }).catch((e) => { limpiar(); reject(e); });
        v.onerror = () => { limpiar(); reject(new Error('No se pudo leer el video')); };
        setTimeout(() => { limpiar(); reject(new Error('Tiempo agotado')); }, 8000);
    });
}
async function subirMiniatura(file, ctl = {}) {
    if (file.type === 'image/gif') return null; // un GIF sin animar pierde la gracia: se usa el original
    const fuente = file.type.startsWith('image/') ? await createImageBitmap(file) : await fotogramaDeVideo(file);
    const esc = Math.min(1, 480 / fuente.width);
    const c = document.createElement('canvas');
    c.width = Math.round(fuente.width * esc); c.height = Math.round(fuente.height * esc);
    c.getContext('2d').drawImage(fuente, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    if (!blob) return null;
    return (await subirATelegram(new File([blob], 'miniatura.jpg', { type: 'image/jpeg' }), () => {}, ctl)).url;
}

/* ==== utilidades puras (no tocan la página: se pueden probar sin navegador) ==== */
// Huella digital (SHA-256) de un archivo: dos archivos idénticos dan SIEMPRE la misma huella.
// Archivos grandes: no se lee todo (200 MB en memoria sería pesado); se usa tamaño + primer y último MB.
async function huella(file) {
    const LIM = 20 * 1024 * 1024, MB = 1024 * 1024;
    const completo = file.size <= LIM;
    const datos = completo ? await file.arrayBuffer() : await new Blob([String(file.size), file.slice(0, MB), file.slice(-MB)]).arrayBuffer();
    const h = await crypto.subtle.digest('SHA-256', datos);
    return (completo ? '' : 'p:') + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Lee la fecha de captura (EXIF "DateTimeOriginal") de un JPEG. Un JPEG es una cadena de bloques ("marcadores"):
// buscamos el bloque APP1 que empieza con "Exif" y dentro, siguiendo punteros, la etiqueta 0x9003.
function leerExif(v) {
    if (v.getUint16(0) !== 0xFFD8) return null;                      // todo JPEG empieza con FFD8
    let o = 2;
    while (o + 4 < v.byteLength) {
        const marca = v.getUint16(o), largo = v.getUint16(o + 2);
        if (marca === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) { // bloque APP1 con la palabra "Exif"
            const t = o + 10;                                        // aquí empieza el encabezado TIFF; todos los punteros son relativos a este punto
            const le = v.getUint16(t) === 0x4949;                    // "II" = little-endian, "MM" = big-endian
            const u16 = (p) => v.getUint16(p, le), u32 = (p) => v.getUint32(p, le);
            const buscar = (ifd, etiqueta) => {                      // un IFD es una tabla: 2 bytes de cantidad + entradas de 12 bytes
                const n = u16(ifd);
                for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === etiqueta) return e; }
                return null;
            };
            const punt = buscar(t + u32(t + 4), 0x8769);             // etiqueta que apunta al sub-bloque "Exif"
            if (punt === null) return null;
            const ex = t + u32(punt + 8);
            const e = buscar(ex, 0x9003) ?? buscar(ex, 0x9004);      // fecha original de captura, o la de digitalización
            if (e === null) return null;
            const pos = t + u32(e + 8);
            let s = ''; for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(pos + i));   // "AAAA:MM:DD HH:MM:SS"
            const m = s.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)$/);
            const ms = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
            return ms && ms > Date.UTC(1990, 0, 1) && ms < Date.now() + 864e5 ? ms : null;   // descarta fechas absurdas (cámaras sin reloj ajustado)
        }
        if ((marca & 0xFF00) !== 0xFF00) break;                      // ya no son marcadores: no hay EXIF
        o += 2 + largo;
    }
    return null;
}

// Fecha en que se TOMÓ la foto o el video: EXIF si existe; si no, la fecha del archivo, pero solo si no es de "hace un momento"
// (una captura pegada del portapapeles dice "ahora", y eso no es cuándo se tomó nada).
async function fechaDeToma(file) {
    if (file.__tomada !== undefined) return file.__tomada; // un archivo ya editado: la edición borra el EXIF, así que la fecha se guardó antes
    try { if (file.type === 'image/jpeg') { const f = leerExif(new DataView(await file.slice(0, 131072).arrayBuffer())); if (f) return f; } }
    catch { /* EXIF dañado o cortado: seguimos con el respaldo */ }
    return Date.now() - file.lastModified > 5 * 60 * 1000 ? file.lastModified : null;
}

// ---- Geometría del editor de imágenes (rotar, voltear, recortar con zoom) ----
const acotar = (v, a, b) => Math.min(b, Math.max(a, v));
// "ed" = { rot: 0..3 (cuartos de vuelta), flip, aspecto (ancho/alto o null = el original), zoom (>=1), px, py (desplazamiento, como fracción del marco) }
function geometria(bmp, ed, W, H) {
    const impar = ed.rot % 2 === 1;
    const rw = impar ? bmp.height : bmp.width, rh = impar ? bmp.width : bmp.height;  // medidas de la imagen YA girada
    const s = Math.max(W / rw, H / rh) * ed.zoom;       // escala "cover": la imagen siempre llena el marco, sin dejar huecos
    return { rw, rh, s, mx: Math.max(0, (rw * s - W) / 2), my: Math.max(0, (rh * s - H) / 2) };  // cuánto se puede mover sin mostrar bordes vacíos
}
// Dibuja la imagen del editor dentro de un lienzo W x H, que es el marco del recorte. Sirve para la vista previa Y para exportar.
function renderizar(ctx, bmp, ed, W, H) {
    const g = geometria(bmp, ed, W, H);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2 + acotar(ed.px * W, -g.mx, g.mx), H / 2 + acotar(ed.py * H, -g.my, g.my));
    if (ed.flip) ctx.scale(-1, 1);       // las transformaciones se aplican EN ORDEN: voltear antes de girar hace que "voltear" sea siempre horizontal en pantalla
    ctx.rotate(ed.rot * Math.PI / 2);
    ctx.scale(g.s, g.s);
    ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    ctx.restore();
}
// Tamaño en píxeles del resultado: el marco más grande de esa proporción que cabe en la imagen, dividido por el zoom (sin agrandar nada).
function medidasExport(bmp, ed) {
    const impar = ed.rot % 2 === 1;
    const rw = impar ? bmp.height : bmp.width, rh = impar ? bmp.width : bmp.height;
    const A = ed.aspecto || rw / rh;
    let W = rw, H = rw / A;
    if (H > rh) { H = rh; W = rh * A; }
    W /= ed.zoom; H /= ed.zoom;
    const k = Math.min(1, 4096 / Math.max(W, H));   // tope de seguridad: nunca más de 4096 px por lado
    return [Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k))];
}
/* ==== fin utilidades puras ==== */

// ---------- Cola de subida ----------
// Cada archivo (o link) es un "trabajo" con su propio estado y su propia barra:
//   espera -> subiendo -> ok | error | cancelado | duplicado (necesita tu decisión)
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let ultimaPublicacion = 0; // las reglas exigen ~3s entre publicaciones (anti-spam)
const TEXTO_ESTADO = { espera: 'En espera', subiendo: 'Subiendo…', ok: 'Listo', error: 'Error', cancelado: 'Cancelado', duplicado: 'Duplicado' };

function crearJob(origen, indice) {
    return { ...origen, indice, estado: 'espera', progreso: 0, msg: '', ctl: {}, forzar: false,
        nombre: origen.link ? new URL(origen.link).hostname : `${origen.file.name} · ${(origen.file.size / 1048576).toFixed(1)} MB` };
}
const btnCola = (etiqueta, contenido, onclick) =>
    el('button', { type: 'button', class: 'cola-btn', title: etiqueta, 'aria-label': etiqueta, onclick }, contenido); // type="button": dentro de un <form> el valor por defecto sería "submit"

function botonesFila(job) {
    if (['espera', 'subiendo'].includes(job.estado)) return [btnCola('Cancelar', icono('fas fa-xmark'), () => cancelarJob(job))];
    if (['error', 'cancelado'].includes(job.estado)) return [btnCola('Reintentar', icono('fas fa-rotate-right'), () => reintentarJob(job))];
    if (job.estado === 'duplicado') return [
        btnCola('Subir igual', 'Subir igual', () => { job.forzar = true; reintentarJob(job); }),
        btnCola('Omitir', icono('fas fa-xmark'), () => cancelarJob(job))];
    return [];
}
function pintarFila(job) {
    if (!job.fila) {   // la fila se crea una vez; después solo se actualizan sus partes (pintar de nuevo cada % haría parpadear los botones)
        job.estadoEl = el('span', { class: 'cola-estado' });
        job.barra = el('div', { class: 'cola-barra-fill' });
        job.acciones = el('span', { class: 'cola-acciones' });
        job.fila = el('li', { class: 'cola-fila' },
            el('div', { class: 'cola-linea' }, el('span', { class: 'cola-nombre', text: job.nombre }), job.estadoEl, job.acciones),
            el('div', { class: 'cola-barra' }, job.barra));
        $('cola-subida').append(job.fila);
    }
    job.fila.dataset.estado = job.estado;
    job.barra.style.width = `${job.estado === 'ok' ? 100 : job.progreso}%`;
    job.estadoEl.textContent = job.estado === 'subiendo' ? `${job.progreso}%` : (job.msg || TEXTO_ESTADO[job.estado]);
    if (job.estadoBotones !== job.estado) { job.acciones.replaceChildren(...botonesFila(job)); job.estadoBotones = job.estado; }
}
function actualizarBoton() {
    const b = $('btn-submit');
    const fallidos = estado.cola.filter((j) => j.estado === 'error').length;
    b.disabled = estado.subiendo;
    if (estado.subiendo) b.textContent = `Subiendo ${estado.cola.filter((j) => j.estado === 'ok').length + 1}/${estado.cola.filter((j) => j.estado !== 'cancelado').length}…`;
    else b.textContent = fallidos ? `Reintentar fallidos (${fallidos})` : 'Publicar';
}
function limpiarCola() { estado.cola = []; $('cola-subida').replaceChildren(); $('previas').hidden = false; actualizarBoton(); }

function cancelarJob(job) {
    job.estado = 'cancelado'; job.msg = '';
    job.ctl.xhr?.abort();   // si estaba subiendo, corta la subida en curso
    pintarFila(job); actualizarBoton();
}
function reintentarJob(job) {
    job.estado = 'espera'; job.msg = ''; job.progreso = 0;
    pintarFila(job); actualizarBoton();
    if (!estado.subiendo) procesarCola();
}

async function subirJob(job) {
    const n = estado.cola.length;
    job.estado = 'subiendo'; job.progreso = 0; job.msg = ''; pintarFila(job);
    const abortado = () => job.estado === 'cancelado'; // la persona pudo cancelar mientras esperábamos algo asíncrono
    try {
        let url, tipo, thumb = null;
        if (job.link) { url = job.link; tipo = 'enlace'; }
        else {
            // 1) Huella y fecha de toma (se calculan una sola vez por archivo, aunque se reintente)
            if (!job.hash) { job.hash = await huella(job.file); job.tomada = await fechaDeToma(job.file); }
            if (abortado()) return;
            // 2) ¿Duplicado? Misma huella que una publicación existente o que otro archivo ya subido en esta tanda.
            if (!job.forzar) {
                const igual = estado.items.find((i) => i.hash === job.hash && !i.borrado)
                    || estado.cola.find((j) => j !== job && j.hash === job.hash && j.estado === 'ok');
                if (igual) { job.estado = 'duplicado'; job.msg = igual.titulo ? `Ya existe «${igual.titulo}»` : 'Repetido en esta tanda'; pintarFila(job); return; }
            }
            // 3) Subir
            const file = job.file.type.startsWith('image/') ? await comprimirImagen(job.file) : job.file;
            if (abortado()) return;
            ({ url, tipo } = await subirArchivo(file, (p) => { job.progreso = p; pintarFila(job); }, job.ctl));
            if (abortado()) return;
            thumb = await subirMiniatura(file, job.ctl).catch(() => null); // si falla la miniatura, se publica igual sin ella
            if (abortado()) return;
        }
        await esperar(Math.max(0, ultimaPublicacion + 3500 - Date.now())); // respeta el cooldown de las reglas
        if (abortado()) return;
        // writeBatch = dos escrituras atómicas: la publicación + la marca "última subida" de este usuario.
        const batch = writeBatch(db);
        batch.set(doc(collection(db, 'galeria')), {
            titulo: n > 1 ? `${estado.titulo} (${job.indice + 1})` : estado.titulo, url, tipo,
            uid: estado.user.uid, fecha: serverTimestamp(), likedBy: [],
            ...(thumb ? { thumb } : {}), ...(job.hash ? { hash: job.hash } : {}), ...(job.tomada ? { tomada: job.tomada } : {})
        });
        batch.set(doc(db, 'limites', estado.user.uid), { ultima: serverTimestamp() });
        await batch.commit();
        ultimaPublicacion = Date.now();
        job.estado = 'ok'; job.progreso = 100;
    } catch (err) {
        if (abortado()) return; // abort() hace fallar la subida a propósito: no es un error
        console.error(err); job.estado = 'error'; job.msg = err.message;
    }
    pintarFila(job);
}

async function procesarCola() {
    estado.subiendo = true; actualizarBoton();
    let job;
    while ((job = estado.cola.find((j) => j.estado === 'espera'))) await subirJob(job); // uno por uno: más estable
    estado.subiendo = false; actualizarBoton();
    const ok = estado.cola.filter((j) => j.estado === 'ok').length;
    const sinResolver = estado.cola.filter((j) => ['error', 'duplicado'].includes(j.estado)).length; // lo cancelado ya fue decisión tuya
    if (!sinResolver) {
        if (ok) mostrarToast(ok > 1 ? `${ok} publicados con éxito` : 'Publicado con éxito', 'success');
        $('modal-subida').classList.remove('active'); resetForm();
    } else mostrarToast(`Se publicaron ${ok} de ${estado.cola.length}. Revisa los que quedaron en la lista.`, 'warning');
}

$('form-subida').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (estado.subiendo) return; // evita doble clic = doble publicación
    const titulo = $('video-titulo').value.trim();
    if (!titulo) return mostrarToast('El título es obligatorio', 'warning');
    // Sin sesión no hay uid, y sin uid las reglas no dejarían guardar ni borrar.
    if (!estado.user) return mostrarToast('Aún no hay sesión. Recarga la página.', 'warning');
    estado.titulo = titulo;

    if (!estado.cola.length) {   // primera vez: armamos la cola con lo que hay en el formulario
        let origenes;
        if (estado.tipoSubida === 'link') {
            const link = urlSegura($('video-link').value.trim());
            if (!link) return mostrarToast('Pega un link https válido', 'warning');
            origenes = [{ link }];
        } else {
            const files = [...estado.seleccion]; // la selección propia (no el <input>): así puede incluir imágenes ya editadas
            if (!files.length) return mostrarToast('Selecciona al menos un archivo', 'warning');
            const grande = files.find((f) => !f.type.startsWith('image/') && f.size > 200 * 1024 * 1024);
            if (grande) return mostrarToast(`"${grande.name}" pesa más de 200MB`, 'warning');
            origenes = files.map((file) => ({ file }));
        }
        estado.cola = origenes.map(crearJob);
        estado.cola.forEach(pintarFila);
        $('previas').hidden = true; // ya están en la cola: no mostrarlos dos veces
    } else {                     // ya había cola: el botón funciona como "Reintentar fallidos"
        estado.cola.filter((j) => j.estado === 'error').forEach((j) => { j.estado = 'espera'; j.msg = ''; j.progreso = 0; pintarFila(j); });
    }
    await procesarCola();
});

function resetForm() {
    $('form-subida').reset();
    estado.seleccion = []; renderPrevias();
    limpiarCola();
    cambiarTab('archivo');
}

// ---------- Tabs, modal y drag & drop ----------
function cambiarTab(tipo) {
    estado.tipoSubida = tipo;
    if (!estado.subiendo) limpiarCola(); // otra pestaña = otra tanda: la cola anterior ya no aplica
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tipo === tipo));
    $('seccion-archivo').style.display = tipo === 'archivo' ? 'block' : 'none';
    $('seccion-link').style.display = tipo === 'link' ? 'block' : 'none';
    $('video-link').required = tipo === 'link';
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => cambiarTab(b.dataset.tipo)));

$('btn-abrir-modal').addEventListener('click', () => $('modal-subida').classList.add('active'));
$('btn-cerrar-modal').addEventListener('click', () => $('modal-subida').classList.remove('active'));
$('modal-subida').addEventListener('click', (e) => { if (e.target === $('modal-subida')) $('modal-subida').classList.remove('active'); });

const zona = $('drop-zone');
['dragenter', 'dragover'].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) => zona.addEventListener(ev, () => zona.classList.remove('dragover')));
$('video-archivo').addEventListener('change', (e) => {
    if (!estado.subiendo) limpiarCola(); // elegiste otros archivos: la cola anterior ya no aplica
    estado.seleccion = [...e.target.files]; // un FileList no se puede modificar; esta copia sí (para quitar o reemplazar por la versión editada)
    renderPrevias();
});

// Vista previa de lo elegido, ANTES de publicar: miniatura, nombre, y botones para editar (solo imágenes) o quitar.
function renderPrevias() {
    $('previas').querySelectorAll('img').forEach((i) => URL.revokeObjectURL(i.src)); // libera la memoria de las miniaturas anteriores
    const mb = estado.seleccion.reduce((t, f) => t + f.size, 0) / 1048576;
    $('file-name').textContent = estado.seleccion.length > 1 ? `${estado.seleccion.length} archivos (${mb.toFixed(2)}MB)` : estado.seleccion[0] ? `${estado.seleccion[0].name} (${mb.toFixed(2)}MB)` : '';
    $('previas').replaceChildren(...estado.seleccion.map((f, i) => {
        const esImg = f.type.startsWith('image/');
        return el('div', { class: 'previa' },
            esImg ? el('img', { src: URL.createObjectURL(f), alt: '' }) : el('span', { class: 'previa-video' }, icono('fas fa-film')),
            el('span', { class: 'previa-nombre', text: f.name }),
            esImg && f.type !== 'image/gif' ? btnCola('Editar imagen', icono('fas fa-crop-simple'), () => abrirEditor(i)) : null, // un GIF editado perdería la animación
            btnCola('Quitar', icono('fas fa-xmark'), () => { estado.seleccion.splice(i, 1); renderPrevias(); }));
    }));
}

// ---------- Filtros y búsqueda ----------
// Pinta el botón activo y avisa a los lectores de pantalla con aria-pressed.
function marcarFiltro() {
    document.querySelectorAll('.filtro').forEach((x) => {
        const on = x.dataset.filtro === estado.filtro;
        x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on));
    });
}
document.querySelectorAll('.filtro').forEach((b) => b.addEventListener('click', () => {
    estado.filtro = b.dataset.filtro; estado.pagina = 1;
    marcarFiltro(); mostrarPagina();
}));
marcarFiltro();
let temporizador;
$('buscador').addEventListener('input', (e) => { // debounce: espera a que dejes de teclear
    clearTimeout(temporizador);
    temporizador = setTimeout(() => { estado.busqueda = e.target.value.trim(); estado.pagina = 1; mostrarPagina(); }, 200);
});

// ---------- Pegar (Ctrl+V) o arrastrar archivos a CUALQUIER parte de la página ----------
// Abre el modal de subida con los archivos ya puestos; solo falta escribir el título.
function recibirArchivos(lista) {
    const files = [...lista].filter((f) => /^(image|video)\//.test(f.type));
    if (!files.length) return false;
    cambiarTab('archivo');
    const dt = new DataTransfer(); // un <input type="file"> solo acepta archivos a través de un DataTransfer
    files.forEach((f) => dt.items.add(f));
    $('video-archivo').files = dt.files;
    $('video-archivo').dispatchEvent(new Event('change')); // para que se actualice el texto "N archivos"
    $('modal-subida').classList.add('active');
    $('video-titulo').focus();
    return true;
}
document.addEventListener('paste', (e) => {
    if (/^(input|textarea)$/i.test(e.target.tagName)) return; // pegando texto en un campo: no interferir
    if (recibirArchivos(e.clipboardData?.files || [])) e.preventDefault();
});
const traeArchivos = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let arrastres = 0; // dragenter/dragleave se disparan por cada elemento hijo: contamos entradas y salidas
window.addEventListener('dragenter', (e) => { if (traeArchivos(e)) { arrastres++; document.body.classList.add('arrastrando'); } });
window.addEventListener('dragleave', (e) => { if (traeArchivos(e) && --arrastres <= 0) { arrastres = 0; document.body.classList.remove('arrastrando'); } });
window.addEventListener('dragover', (e) => { if (traeArchivos(e)) e.preventDefault(); }); // sin esto el navegador no permite soltar
window.addEventListener('drop', (e) => {
    arrastres = 0; document.body.classList.remove('arrastrando');
    if (traeArchivos(e)) { e.preventDefault(); recibirArchivos(e.dataTransfer.files); }
});

// ---------- Tema claro / oscuro ----------
// El tema inicial lo pone un mini script en el <head> (antes de pintar) para que no haya un destello del otro tema.
function aplicarTema(tema, guardar = true) {
    document.documentElement.dataset.tema = tema;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', tema === 'claro' ? '#F4F1E8' : '#121212'); // color de la barra del celular
    if (guardar) ls.set('pf_tema', tema);
    const b = $('btn-tema');
    if (b) { b.title = tema === 'claro' ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro'; b.setAttribute('aria-label', b.title); }
}
$('btn-tema').addEventListener('click', () => aplicarTema(document.documentElement.dataset.tema === 'claro' ? 'oscuro' : 'claro'));
aplicarTema(document.documentElement.dataset.tema || 'oscuro', false);

// ---------- Mini tutorial (solo la primera visita) y ayuda de atajos ----------
const abrirTutorial = () => { $('tutorial-modal').classList.add('active'); $('tutorial-ok').focus(); };
function cerrarTutorial() { $('tutorial-modal').classList.remove('active'); ls.set('pf_tutorial', '1'); } // "visto": no vuelve a salir solo
$('tutorial-ok').addEventListener('click', cerrarTutorial);
$('btn-tutorial').addEventListener('click', abrirTutorial);
$('btn-atajos').addEventListener('click', () => $('atajos-modal').classList.add('active'));
$('atajos-ok').addEventListener('click', () => $('atajos-modal').classList.remove('active'));
$('tutorial-modal').addEventListener('click', (e) => { if (e.target === $('tutorial-modal')) cerrarTutorial(); });
$('atajos-modal').addEventListener('click', (e) => { if (e.target === $('atajos-modal')) $('atajos-modal').classList.remove('active'); });
if (!ls.get('pf_tutorial')) setTimeout(abrirTutorial, 700); // un respiro para que cargue la galería antes

// ---------- Orden de la galería (se recuerda entre visitas) ----------
const ordenGuardado = ls.get('pf_orden');
if (['foto', 'queridas'].includes(ordenGuardado)) { estado.orden = ordenGuardado; $('orden').value = ordenGuardado; }
$('orden').addEventListener('change', (e) => { estado.orden = e.target.value; ls.set('pf_orden', estado.orden); estado.pagina = 1; mostrarPagina(); });

// ---------- Editor de imágenes: girar, voltear y recortar antes de publicar ----------
const ed = { bmp: null, file: null, indice: 0, rot: 0, flip: false, aspecto: null, zoom: 1, px: 0, py: 0 };
const CAJA = { ancho: 480, alto: 360 }; // el marco de la vista previa siempre cabe en esta caja
function pintarEditor() {
    const c = $('editor-canvas');
    const g = geometria(ed.bmp, ed, 1, 1), A = ed.aspecto || g.rw / g.rh;     // g.rw/g.rh: proporción de la imagen girada
    const [W, H] = A >= CAJA.ancho / CAJA.alto ? [CAJA.ancho, CAJA.ancho / A] : [CAJA.alto * A, CAJA.alto];
    c.width = Math.round(W); c.height = Math.round(H);
    renderizar(c.getContext('2d'), ed.bmp, ed, c.width, c.height);
}
async function abrirEditor(indice) {
    const file = estado.seleccion[indice];
    try { ed.bmp = await createImageBitmap(file); } catch { return mostrarToast('No se pudo abrir esta imagen para editarla', 'error'); }
    Object.assign(ed, { file, indice, rot: 0, flip: false, aspecto: null, zoom: 1, px: 0, py: 0 });
    $('ed-zoom').value = 1;
    document.querySelectorAll('.chip-ed').forEach((b) => b.classList.toggle('active', b.dataset.aspecto === '0'));
    $('editor-modal').classList.add('active'); pintarEditor(); $('ed-aplicar').focus();
}
function cerrarEditor() { $('editor-modal').classList.remove('active'); ed.bmp?.close?.(); ed.bmp = null; }
const cambiarEd = (cambios) => { Object.assign(ed, cambios); pintarEditor(); };
$('ed-izq').addEventListener('click', () => cambiarEd({ rot: (ed.rot + 3) % 4, px: 0, py: 0 }));
$('ed-der').addEventListener('click', () => cambiarEd({ rot: (ed.rot + 1) % 4, px: 0, py: 0 }));
$('ed-voltear').addEventListener('click', () => cambiarEd({ flip: !ed.flip }));
$('ed-zoom').addEventListener('input', (e) => cambiarEd({ zoom: Number(e.target.value) }));
document.querySelectorAll('.chip-ed').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.chip-ed').forEach((x) => x.classList.toggle('active', x === b));
    cambiarEd({ aspecto: Number(b.dataset.aspecto) || null, px: 0, py: 0 }); // "0" = proporción original
}));
// Arrastrar la imagen dentro del marco para elegir qué parte se queda.
let arrastre = null;
$('editor-canvas').addEventListener('pointerdown', (e) => { arrastre = { x: e.clientX, y: e.clientY }; e.target.setPointerCapture?.(e.pointerId); });
$('editor-canvas').addEventListener('pointermove', (e) => {
    if (!arrastre) return;
    const r = e.target.getBoundingClientRect(), g = geometria(ed.bmp, ed, e.target.width, e.target.height);
    ed.px = acotar(ed.px + (e.clientX - arrastre.x) / r.width, -g.mx / e.target.width, g.mx / e.target.width); // se guarda como fracción del marco
    ed.py = acotar(ed.py + (e.clientY - arrastre.y) / r.height, -g.my / e.target.height, g.my / e.target.height);
    arrastre = { x: e.clientX, y: e.clientY };
    pintarEditor();
});
['pointerup', 'pointercancel'].forEach((t) => $('editor-canvas').addEventListener(t, () => { arrastre = null; }));
$('ed-cancelar').addEventListener('click', cerrarEditor);
$('ed-aplicar').addEventListener('click', async () => {
    const [W, H] = medidasExport(ed.bmp, ed);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    renderizar(c.getContext('2d'), ed.bmp, ed, W, H); // mismo dibujo que la vista previa, pero al tamaño real
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) return mostrarToast('No se pudo aplicar la edición', 'error');
    const nuevo = new File([blob], `${ed.file.name.replace(/\.[^.]+$/, '')}-editada.jpg`, { type: 'image/jpeg', lastModified: ed.file.lastModified });
    nuevo.__tomada = await fechaDeToma(ed.file); // al exportar de nuevo se pierde el EXIF: guardamos la fecha de toma antes
    estado.seleccion[ed.indice] = nuevo; renderPrevias(); cerrarEditor();
    mostrarToast('Edición aplicada', 'success');
});

console.log('%cPollita Feliz', 'color:#e91e63;font-size:14px;font-weight:bold;');