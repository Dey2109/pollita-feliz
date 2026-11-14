// =====================================================================
// cripto.js — cifrado de los álbumes privados
// Todo corre en el NAVEGADOR con WebCrypto (la criptografía incluida en Chrome, Firefox y Safari).
// Ningún secreto (frase, PIN, llave) sale de aquí: a Firebase y Telegram solo llegan datos ya cifrados.
//
// Esquema, en una frase: una llave maestra aleatoria cifra los archivos; esa llave se guarda "envuelta"
// (cifrada) con una llave derivada de tu frase o PIN, y otra copia con la clave de recuperación.
//   frase/PIN --PBKDF2--> llave de envoltura --AES-GCM--> [llave maestra] --AES-GCM--> archivos y metadatos
// =====================================================================
const enc = new TextEncoder(), dec = new TextDecoder();

// PBKDF2 hace el cálculo "lento a propósito": cada intento de adivinar una frase cuesta ~0,5 s en vez de microsegundos.
export const ITER_FRASE = 600000;   // recomendación de OWASP (2023) para PBKDF2-SHA256
export const ITER_RECUP = 100000;   // la clave de recuperación ya es aleatoria de 128 bits: no necesita tanto estiramiento

export const aleatorio = (n) => crypto.getRandomValues(new Uint8Array(n));

// Base64 "seguro para URL" (sin + / =): así los datos cifrados caben en campos de texto de Firestore.
export function aB64(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); // por trozos: un archivo grande no cabe en un solo String.fromCharCode
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const deB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// Base32 de Crockford: sin I, L, O, U para no confundir letras con números al copiar un código a mano.
const ALF = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function aBase32(bytes) {
    let bits = 0, val = 0, out = '';
    for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += ALF[(val >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += ALF[(val << (5 - bits)) & 31];
    return out;
}
export const nuevoCodigo = () => aBase32(aleatorio(16));                  // 128 bits -> 26 caracteres
export const agrupar = (c, n = 4) => (c.match(new RegExp(`.{1,${n}}`, 'g')) || []).join('-');   // ABCD-EFGH-...
// Acepta el código como lo escriba la gente: minúsculas, con guiones o espacios, O por 0, I o L por 1.
export const normalizarCodigo = (s) => String(s).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
export const CODIGO_VALIDO = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Reglas mínimas para el secreto. (Los textos se devuelven en español: la interfaz los traduce.)
export function validarSecreto(s, metodo) {
    if (metodo === 'pin') {
        if (!/^\d{6,12}$/.test(s)) return 'El PIN debe tener entre 6 y 12 dígitos';
        if (/^(\d)\1+$/.test(s) || '01234567890123456789'.includes(s) || '98765432109876543210'.includes(s)) return 'Elige un PIN menos obvio (nada de 123456 ni 000000)';
        return null;
    }
    if (s.length < 10) return 'La frase debe tener al menos 10 caracteres';
    if (new Set(s).size < 5) return 'Usa una frase con más variedad de caracteres';
    return null;
}

// ---------- Llaves ----------
export async function derivar(secreto, sal, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(secreto.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']); // NFKC: la misma frase escrita con otro teclado da la misma llave
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: sal, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export const claveMaestraNueva = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

// ---------- AES-GCM: cifra Y garantiza que nadie modificó el contenido ----------
// "aad" (datos asociados) liga el cifrado a un contexto, p. ej. "<álbum>:meta": un archivo cifrado para un lugar
// falla al descifrarse en otro, así que nadie puede cambiar piezas de sitio sin que se note.
export async function cifrarBytes(clave, datos, aad) {
    const iv = aleatorio(12);   // un valor único por cada cifrado: repetirlo con la misma llave rompería la seguridad
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, clave, datos);
    return { iv, ct };
}
export async function descifrarBytes(clave, iv, ct, aad) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, clave, ct));
}
export async function cifrarJSON(clave, obj, aad) {
    const { iv, ct } = await cifrarBytes(clave, enc.encode(JSON.stringify(obj)), aad);
    return { iv: aB64(iv), ct: aB64(ct) };
}
export async function descifrarJSON(clave, caja, aad) {
    return JSON.parse(dec.decode(await descifrarBytes(clave, deB64(caja.iv), deB64(caja.ct), aad)));
}

// ---------- Envolver la llave maestra ----------
async function envolver(mk, kek, aad) {
    const { iv, ct } = await cifrarBytes(kek, new Uint8Array(await crypto.subtle.exportKey('raw', mk)), aad);
    return { iv: aB64(iv), ct: aB64(ct) };
}
async function desenvolver(caja, kek, aad) {
    const raw = await descifrarBytes(kek, deB64(caja.iv), deB64(caja.ct), aad);
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);   // al abrirla ya no se puede exportar: en memoria solo sirve para cifrar y descifrar
}

// Crea un álbum nuevo: devuelve el código, la clave de recuperación (¡se muestra UNA vez!), el documento listo para guardar y la llave.
export async function crearAlbumCripto(nombre, secreto, metodo) {
    const id = nuevoCodigo(), recup = nuevoCodigo(), mk = await claveMaestraNueva();
    const sal = aleatorio(16), salR = aleatorio(16);
    const [kek, kekR] = await Promise.all([derivar(secreto, sal, ITER_FRASE), derivar(recup, salR, ITER_RECUP)]);
    const doc = {
        metodo, kdf: { iter: ITER_FRASE, salt: aB64(sal) },
        env: await envolver(mk, kek, `${id}:env`),
        rec: { iter: ITER_RECUP, salt: aB64(salR), ...(await envolver(mk, kekR, `${id}:rec`)) },
        nombre: await cifrarJSON(mk, { nombre }, `${id}:nombre`)
    };
    return { id, recup, doc, mk };
}

// Abre un álbum con la frase/PIN, o con la clave de recuperación. Si el secreto no es el correcto, AES-GCM lo detecta
// (la "etiqueta de autenticación" no cuadra) y se lanza SECRETO_INCORRECTO: no hace falta guardar ninguna contraseña para comparar.
export async function abrirAlbumCripto(id, d, secreto, esRecuperacion = false) {
    const parte = esRecuperacion ? d.rec : d.env;
    const sal = deB64(esRecuperacion ? d.rec.salt : d.kdf.salt), iter = esRecuperacion ? d.rec.iter : d.kdf.iter;
    if (!(iter >= 100000 && iter <= 5000000)) throw new Error('PARAMETROS_INVALIDOS');   // un documento manipulado no puede pedirnos un cálculo infinito
    const secretoNorm = esRecuperacion ? normalizarCodigo(secreto) : secreto;
    try { return await desenvolver(parte, await derivar(secretoNorm, sal, iter), `${id}:${esRecuperacion ? 'rec' : 'env'}`); }
    catch { throw new Error('SECRETO_INCORRECTO'); }
}