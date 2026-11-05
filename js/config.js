// =====================================================================
// config.js — configuración de Pollita Feliz
//
// REGLA DE ORO: aquí NO hay ningún secreto. Todo lo que ves es público por diseño
// (identificadores, no contraseñas), así que es seguro subir este archivo a GitHub.
// El token del bot de Telegram vive SOLO en Cloudflare (ver worker.js).
// =====================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// 1) Tu proyecto de Firebase (Configuración del proyecto -> General -> Tus apps -> Config).
const firebaseConfig = {
    apiKey: "AIzaSyDIMkW4HVyv00iKKa-WGuP3ThW5RhmGv14",
    authDomain: "pollita-feliz.firebaseapp.com",   // verifica que coincida con el tuyo
    projectId: "pollita-feliz",
    appId: "1:1082030692312:web:ff2d57bb91a8624e4dc4ad"
};

// Un appId válido es "1:números:web:" + SOLO dígitos y letras de la a a la f.
if (!/^1:\d+:web:[0-9a-f]+$/.test(firebaseConfig.appId)) {
    console.warn("⚠️ El appId de config.js tiene caracteres inválidos. Cópialo de nuevo desde Firebase.");
}

const app = initializeApp(firebaseConfig);

// 2) App Check (Fraud Defense). Pega el ID de tu clave (Google Cloud -> Fraud Defense -> Claves).
// Es público: solo funciona en los dominios que registraste en la clave.
const APPCHECK_SITE_KEY = "6LeLeQouAAAAALzNwJmg3KT4s1X-ybIaIqAgkxsF";
// Dominios donde reCAPTCHA SÍ funciona (los que registraste en la clave). En cualquier otro sitio
// (tu computadora, por ejemplo) se usa el token de depuración que imprime la consola.
const SITIOS_REGISTRADOS = ["dey2109.github.io"];

if (APPCHECK_SITE_KEY && !APPCHECK_SITE_KEY.startsWith("PEGA_")) {
    if (!SITIOS_REGISTRADOS.includes(location.hostname)) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(APPCHECK_SITE_KEY),
        isTokenAutoRefreshEnabled: true
    });
}

export const db = getFirestore(app);
export const auth = getAuth(app);

// 3) Dirección de tu Worker de Cloudflare (sin "/" al final). Es pública: no es un secreto.
export const WORKER_URL = "https://pollita-feliz.josedavid7142.workers.dev".replace(/\/+$/, "");
