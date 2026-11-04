// =====================================================================
// worker.js — el "servidor" de Pollita Feliz (corre gratis en Cloudflare)
//
// Por qué existe: el token del bot de Telegram es una CONTRASEÑA. Todo lo que está en tu página
// (HTML, JS, config.js) lo puede leer cualquiera con F12 o desde GitHub, así que ahí no puede vivir.
// Este Worker es un programa que corre en los servidores de Cloudflare: el token vive aquí, como
// "secreto" (nadie lo puede ver ni descargar), y tu página solo le pide cosas al Worker.
//
// Variables (Cloudflare -> tu Worker -> Settings -> Variables and Secrets):
//   BOT_TOKEN            (Secreto)  el token de @BotFather
//   CHAT_ID              (Secreto)  el chat o canal donde el bot guarda los archivos
//   ALLOWED_ORIGIN       (Texto)    desde dónde se acepta usar el Worker. Varias separadas por coma.
//                                   Ej: https://tuusuario.github.io,http://127.0.0.1:5500
//   FIREBASE_PROJECT_ID  (Texto)    pollita-feliz
// =====================================================================

const MAX_BYTES = 20 * 1024 * 1024;   // un bot de Telegram solo puede DESCARGAR archivos de hasta 20 MB
// Lista blanca: lo que no esté aquí se rechaza (así nadie usa tu canal para guardar cualquier cosa).
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' };
// Telegram no devuelve el tipo correcto al descargar, así que lo deducimos de la extensión de la ruta.
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

const json = (obj, status, headers) =>
    new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });

// ---------- ¿Quien sube es un usuario de ESTE sitio? ----------
// Firebase le da a cada visitante un "token de sesión" (un JWT firmado por Google). El Worker comprueba
// la firma con las claves públicas de Google: así un desconocido que encuentre la dirección del Worker no puede subir.
let clavesCache = null; // las claves de Google cambian poco: se guardan 1 hora para no pedirlas en cada subida
async function clavesGoogle() {
    if (clavesCache && clavesCache.hasta > Date.now()) return clavesCache.keys;
    const { keys } = await (await fetch(JWKS_URL)).json();
    clavesCache = { keys, hasta: Date.now() + 3600 * 1000 };
    return keys;
}
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function verificarSesion(token, proyecto) {
    const [h, p, firma] = (token || '').split('.');
    if (!firma) throw new Error('token mal formado');
    const cabecera = JSON.parse(new TextDecoder().decode(b64url(h)));
    const datos = JSON.parse(new TextDecoder().decode(b64url(p)));
    if (cabecera.alg !== 'RS256') throw new Error('algoritmo no permitido');
    const jwk = (await clavesGoogle()).find((k) => k.kid === cabecera.kid);
    if (!jwk) throw new Error('clave desconocida');
    const clave = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const firmaOk = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', clave, b64url(firma), new TextEncoder().encode(`${h}.${p}`));
    // Además de la firma: que sea para ESTE proyecto, que no haya vencido y que tenga un usuario.
    if (!firmaOk || datos.aud !== proyecto || datos.iss !== `https://securetoken.google.com/${proyecto}`
        || datos.exp < Date.now() / 1000 || !datos.sub) throw new Error('sesión inválida');
    return datos;
}

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        const permitidos = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
        const origen = req.headers.get('Origin');
        // CORS: el navegador solo deja que una página lea respuestas de otro sitio si éste lo autoriza con estas cabeceras.
        const cors = {
            'Access-Control-Allow-Origin': permitidos.includes(origen) ? origen : (permitidos[0] || 'null'),
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
            'Vary': 'Origin'
        };
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors }); // "permiso previo" del navegador

        if (req.method === 'POST' && url.pathname === '/upload') return subir(req, env, cors, permitidos.includes(origen));
        const m = url.pathname.match(/^\/file\/([\w-]+)$/);
        if (req.method === 'GET' && m) return ver(req, env, cors, m[1]);
        return new Response('No encontrado', { status: 404, headers: cors });
    }
};

// ---------- SUBIR: POST /upload  (campo "file" + cabecera Authorization: Bearer <token de Firebase>) ----------
async function subir(req, env, cors, origenOk) {
    if (!origenOk) return json({ error: 'Origen no permitido' }, 403, cors);
    try { await verificarSesion((req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), env.FIREBASE_PROJECT_ID); }
    catch { return json({ error: 'Sesión no válida' }, 401, cors); }

    let form; try { form = await req.formData(); } catch { return json({ error: 'Formulario inválido' }, 400, cors); }
    const file = form.get('file');
    if (!(file instanceof File)) return json({ error: 'Falta el archivo' }, 400, cors);
    const ext = EXT[file.type];
    if (!ext) return json({ error: 'Tipo de archivo no permitido' }, 415, cors);
    if (file.size > MAX_BYTES) return json({ error: 'El archivo pesa más de 20MB' }, 413, cors);

    // Aquí sí se usa el token: solo existe dentro del Worker.
    const fd = new FormData();
    fd.append('chat_id', env.CHAT_ID);
    fd.append('document', file, `archivo.${ext}`);
    fd.append('disable_notification', 'true');
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: fd });
    const data = await r.json().catch(() => ({}));
    const fileId = data.result?.document?.file_id;
    if (!data.ok || !fileId) return json({ error: 'Telegram rechazó el archivo' }, 502, cors);
    return json({ fileId }, 200, cors); // el file_id no caduca: es lo único que guarda tu base de datos
}

// ---------- VER: GET /file/<file_id> ----------
// La ruta de descarga de Telegram caduca, así que el Worker pide una NUEVA cada vez y entrega el archivo.
// Tu página usa directamente esta dirección en <img> y <video>, sin saber nada del token.
async function ver(req, env, cors, fileId) {
    const info = await (await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`)).json().catch(() => ({}));
    if (!info.ok) return new Response('No encontrado', { status: 404, headers: cors });
    const ruta = info.result.file_path;
    // Reenviamos "Range" para que los videos permitan adelantar y retroceder.
    const origenArchivo = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${ruta}`,
        { headers: req.headers.has('Range') ? { Range: req.headers.get('Range') } : {} });
    const h = new Headers(cors);
    h.set('Content-Type', MIME[ruta.split('.').pop().toLowerCase()] || 'application/octet-stream');
    h.set('Cache-Control', 'public, max-age=2592000'); // un file_id siempre es el mismo archivo: el navegador puede guardarlo 30 días
    h.set('Accept-Ranges', 'bytes');
    for (const k of ['Content-Length', 'Content-Range']) if (origenArchivo.headers.has(k)) h.set(k, origenArchivo.headers.get(k));
    return new Response(origenArchivo.body, { status: origenArchivo.status, headers: h });
}
