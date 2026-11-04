// =====================================================================
// POLLITA FELIZ - script.js (versión corregida)
// Idea central: en el navegador NADA es secreto. Todo lo que ponga aquí
// lo puede leer cualquiera. Por eso ya no hay token de bot ni contraseña
// de admin: la seguridad real vive en Firebase Auth + reglas de Firestore.
// =====================================================================
import { db, auth, WORKER_URL } from './config.js';
import { collection, deleteDoc, doc, onSnapshot, query, orderBy, serverTimestamp, updateDoc, arrayUnion, arrayRemove, writeBatch }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signInAnonymously, signInWithEmailAndPassword, signOut, onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const $ = (id) => document.getElementById(id);
const ITEMS_POR_PAGINA = 15;

// Un solo objeto de estado: así es fácil saber qué datos mueven la pantalla.
const estado = { user: null, items: [], imagenes: [], visibles: [], filtro: 'todo', busqueda: '', pagina: 1, tipoSubida: 'archivo', lbIdx: 0, subiendo: false, listo: false, foco: null };

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
const urlTelegram = (fileId) => Promise.resolve(`${WORKER_URL}/file/${encodeURIComponent(fileId)}`);
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
        inp.type = tipoInput; inp.placeholder = placeholder; inp.value = inicial; // "inicial" sirve para editar un texto que ya existe
        m.classList.add('active');
        setTimeout(() => { inp.focus(); inp.select(); }, 100);
        const fin = (valor) => { m.classList.remove('active'); resolve(valor); };
        $('pin-modal-confirm').onclick = () => fin(inp.value.trim());
        $('pin-modal-cancel').onclick = () => fin(null);
        inp.onkeydown = (e) => { if (e.key === 'Enter') fin(inp.value.trim()); };
    });
}
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

// Likes: guardamos en cada publicación la lista "likedBy" de uids. Un uid = un like.
async function alternarLike(item, yaLeGusta) {
    if (!estado.user) return;
    try {
        await updateDoc(doc(db, 'galeria', item.id), { likedBy: yaLeGusta ? arrayRemove(estado.user.uid) : arrayUnion(estado.user.uid) });
    } catch { mostrarToast('No se pudo registrar el me gusta', 'error'); }
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
            btnAccion('share', 'Copiar enlace a esta publicación', 'fas fa-link', () => compartir(item)));
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

    const likes = item.likedBy || [];
    const meGusta = likes.includes(estado.user?.uid);
    const btnLike = el('button', { class: 'like-btn' + (meGusta ? ' liked' : ''), title: 'Me gusta', 'aria-label': `Me gusta (${likes.length})`, 'aria-pressed': String(meGusta), onclick: () => alternarLike(item, meGusta) },
        icono(meGusta ? 'fas fa-heart' : 'far fa-heart'), el('span', { text: String(likes.length) }));
    // <article> en vez de <div>: es una unidad de contenido independiente, y los lectores de pantalla la anuncian como tal.
    return el('article', { class: 'card' + (enPapelera ? ' en-papelera' : ''), 'data-id': item.id, 'aria-label': item.titulo }, media, acciones,
        el('div', { class: 'card-title' }, el('span', { class: 'card-title-text', text: item.titulo }), btnLike));
}

// Editar título: reusa el modal de texto. Las reglas solo lo permiten al dueño o al admin.
async function editarTitulo(item) {
    const nuevo = await pedirTexto('Editar título', 'text', 'Título', item.titulo);
    if (nuevo === null || nuevo === '' || nuevo === item.titulo) return;
    if (nuevo.length > 50) return mostrarToast('El título puede tener hasta 50 caracteres', 'warning');
    try { await updateDoc(doc(db, 'galeria', item.id), { titulo: nuevo }); mostrarToast('Título actualizado', 'success'); }
    catch { mostrarToast('No tienes permiso para editar esto', 'error'); }
}

// Papelera: "borrar" solo marca borrado:true (se puede deshacer). El borrado real es solo del admin y desde la papelera.
async function enviarAPapelera(item) {
    const msg = esAdmin() ? 'Irá a la papelera y podrás restaurarla.' : 'Se quitará de la galería.';
    if (!(await confirmar('Mover a la papelera', msg, 'Mover'))) return;
    try { await updateDoc(doc(db, 'galeria', item.id), { borrado: true }); mostrarToast('Movida a la papelera', 'success'); }
    catch { mostrarToast('No tienes permiso para hacer esto', 'error'); }
}
async function restaurar(item) {
    try { await updateDoc(doc(db, 'galeria', item.id), { borrado: false }); mostrarToast('Publicación restaurada', 'success'); }
    catch { mostrarToast('Solo el admin puede restaurar', 'error'); }
}
async function eliminarDefinitivo(item) {
    if (!(await confirmar('Eliminar para siempre', 'Esta acción no se puede deshacer.'))) return;
    try { await deleteDoc(doc(db, 'galeria', item.id)); mostrarToast('Eliminada para siempre', 'success'); }
    catch { mostrarToast('Solo el admin puede eliminar para siempre', 'error'); }
}

// Enlace directo: https://tu-sitio/#p/<id>. El "#" no recarga la página ni viaja al servidor, solo lo lee este script.
async function compartir(item) {
    const link = `${location.origin}${location.pathname}#p/${item.id}`;
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
function abrirLightbox(i) {
    if (i < 0) return;
    estado.lbIdx = i; estado.foco = document.activeElement; // recordamos dónde estaba el foco para devolverlo al cerrar
    pintarLightbox();
    $('lightbox').classList.add('active'); document.body.style.overflow = 'hidden';
    $('lightbox-close').focus();
}
function cerrarLightbox() {
    $('lightbox').classList.remove('active'); document.body.style.overflow = '';
    history.replaceState(null, '', location.pathname + location.search); // quita el #p/... de la dirección
    estado.foco?.focus?.();
}
function pintarLightbox() {
    const img = estado.imagenes[estado.lbIdx]; if (!img) return;
    $('lightbox-img').classList.remove('zoom'); // cada imagen empieza sin zoom
    $('lightbox-img').alt = img.titulo;
    history.replaceState(null, '', `#p/${img.id}`); // la dirección siempre apunta a la foto que estás viendo (se puede compartir)
    resolverMedia(img.url).then((u) => { if (estado.imagenes[estado.lbIdx] === img) $('lightbox-img').src = u; }).catch(() => mostrarToast('No se pudo cargar la imagen', 'error'));
    $('lightbox-titulo').textContent = img.titulo;
    $('lightbox-counter').textContent = `${estado.lbIdx + 1} / ${estado.imagenes.length}`;
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
    if (e.key === 'Escape') { // cierra lo que esté más "arriba"
        if ($('pin-modal').classList.contains('active')) $('pin-modal-cancel').click();
        else if ($('confirm-modal').classList.contains('active')) $('confirm-modal-cancel').click();
        else if (lbAbierto) cerrarLightbox();
        else $('modal-subida').classList.remove('active');
    }
    if (lbAbierto && e.key === 'ArrowRight') moverLB(1);
    if (lbAbierto && e.key === 'ArrowLeft') moverLB(-1);
    // Trampa de foco: con Tab el foco da vueltas entre los 3 botones y no se escapa a la página de atrás.
    if (lbAbierto && e.key === 'Tab') {
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
function enviarConProgreso(url, formData, onProgress, headers = {}) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
        xhr.onerror = () => reject(new Error('Sin conexión'));
        xhr.onload = () => resolve(xhr.responseText); // quien llama revisa si la respuesta es válida
        xhr.send(formData);
    });
}

// Se sube al Worker (NO a Telegram directo): el Worker guarda el token y nos devuelve el file_id.
// Mandamos el "token de sesión" de Firebase para que el Worker sepa que quien sube es un usuario de ESTE sitio.
async function subirATelegram(file, onProgress) {
    if (!auth.currentUser) throw new Error('Aún no hay sesión. Recarga la página.');
    const idToken = await auth.currentUser.getIdToken();
    const fd = new FormData();
    fd.append('file', file);
    let data;
    try { data = JSON.parse(await enviarConProgreso(`${WORKER_URL}/upload`, fd, onProgress, { Authorization: `Bearer ${idToken}` })); }
    catch { throw new Error('Respuesta inválida del servidor de subida'); }
    if (!data.fileId) throw new Error(data.error || 'No se obtuvo el file_id');
    return { url: FID_BASE + data.fileId, tipo: file.type.startsWith('image/') ? 'imagen' : 'video' };
}

async function subirACatbox(file, onProgress) {
    const fd = new FormData();
    fd.append('reqtype', 'fileupload');
    fd.append('fileToUpload', file);
    const url = (await enviarConProgreso('https://catbox.moe/user/api.php', fd, onProgress)).trim();
    if (!url.startsWith('https://')) throw new Error('Catbox no devolvió una URL válida');
    return { url, tipo: file.type.startsWith('image/') ? 'imagen' : 'video' };
}

// Telegram solo permite que un bot descargue archivos de hasta 20MB; lo más grande va a Catbox.
const subirArchivo = (file, p) => file.size <= 20 * 1024 * 1024 ? subirATelegram(file, p) : subirACatbox(file, p);

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
async function subirMiniatura(file) {
    if (file.type === 'image/gif') return null; // un GIF sin animar pierde la gracia: se usa el original
    const fuente = file.type.startsWith('image/') ? await createImageBitmap(file) : await fotogramaDeVideo(file);
    const esc = Math.min(1, 480 / fuente.width);
    const c = document.createElement('canvas');
    c.width = Math.round(fuente.width * esc); c.height = Math.round(fuente.height * esc);
    c.getContext('2d').drawImage(fuente, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    if (!blob) return null;
    return (await subirATelegram(new File([blob], 'miniatura.jpg', { type: 'image/jpeg' }), () => {})).url;
}

function setProgreso(p) {
    $('progress-container').style.display = p === null ? 'none' : 'block';
    $('progress-bar').style.width = `${p ?? 0}%`;
    $('progress-text').textContent = `${p ?? 0}%`;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let ultimaPublicacion = 0; // las reglas exigen ~3s entre publicaciones (anti-spam)

$('form-subida').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (estado.subiendo) return; // evita doble clic = doble publicación
    const titulo = $('video-titulo').value.trim();
    if (!titulo) return mostrarToast('El título es obligatorio', 'warning');
    // Sin sesión no hay uid, y sin uid las reglas no dejarían guardar ni borrar.
    if (!estado.user) return mostrarToast('Aún no hay sesión. Recarga la página.', 'warning');

    // Armamos una lista de "trabajos": un link, o uno o varios archivos.
    let trabajos;
    if (estado.tipoSubida === 'link') {
        const link = urlSegura($('video-link').value.trim());
        if (!link) return mostrarToast('Pega un link https válido', 'warning');
        trabajos = [{ link }];
    } else {
        const files = [...$('video-archivo').files];
        if (!files.length) return mostrarToast('Selecciona al menos un archivo', 'warning');
        const grande = files.find((f) => !f.type.startsWith('image/') && f.size > 200 * 1024 * 1024);
        if (grande) return mostrarToast(`"${grande.name}" pesa más de 200MB`, 'warning');
        trabajos = files.map((file) => ({ file }));
    }

    estado.subiendo = true;
    $('btn-submit').disabled = true;
    const n = trabajos.length;
    let ok = 0;
    // Uno por uno (no en paralelo): más estable y la barra de progreso tiene sentido.
    for (const [i, t] of trabajos.entries()) {
        $('btn-submit').textContent = n > 1 ? `Subiendo ${i + 1}/${n}...` : 'Subiendo...';
        try {
            let url, tipo, thumb = null;
            if (t.link) { url = t.link; tipo = 'enlace'; }
            else {
                const file = t.file.type.startsWith('image/') ? await comprimirImagen(t.file) : t.file;
                setProgreso(0);
                ({ url, tipo } = await subirArchivo(file, setProgreso));
                thumb = await subirMiniatura(file).catch(() => null); // si falla la miniatura, se publica igual sin ella
            }
            await esperar(Math.max(0, ultimaPublicacion + 3500 - Date.now())); // respeta el cooldown de las reglas
            // writeBatch = dos escrituras atómicas: la publicación + la marca "última subida" de este usuario.
            const batch = writeBatch(db);
            batch.set(doc(collection(db, 'galeria')), {
                titulo: n > 1 ? `${titulo} (${i + 1})` : titulo, url, tipo,
                uid: estado.user.uid, fecha: serverTimestamp(), likedBy: [], ...(thumb ? { thumb } : {})
            });
            batch.set(doc(db, 'limites', estado.user.uid), { ultima: serverTimestamp() });
            await batch.commit();
            ultimaPublicacion = Date.now();
            ok++;
        } catch (err) {
            console.error(err);
            mostrarToast(`Error en el archivo ${i + 1}: ${err.message}`, 'error');
        }
    }
    estado.subiendo = false;
    $('btn-submit').disabled = false; $('btn-submit').textContent = 'Publicar';
    setProgreso(null);
    if (ok === n) { mostrarToast(n > 1 ? `${n} publicados con éxito` : 'Publicado con éxito', 'success'); $('modal-subida').classList.remove('active'); resetForm(); }
    else if (ok > 0) mostrarToast(`Se publicaron ${ok} de ${n}`, 'warning'); // el formulario se queda para reintentar
});

function resetForm() {
    $('form-subida').reset();
    $('file-name').textContent = '';
    setProgreso(null);
    cambiarTab('archivo');
}

// ---------- Tabs, modal y drag & drop ----------
function cambiarTab(tipo) {
    estado.tipoSubida = tipo;
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
    const fs = [...e.target.files];
    const mb = fs.reduce((t, f) => t + f.size, 0) / 1048576;
    $('file-name').textContent = fs.length > 1 ? `${fs.length} archivos (${mb.toFixed(2)}MB)` : fs[0] ? `${fs[0].name} (${mb.toFixed(2)}MB)` : '';
});

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

console.log('%cPollita Feliz', 'color:#e91e63;font-size:14px;font-weight:bold;');
