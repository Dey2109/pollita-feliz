# 🎞️ Pollita Feliz

Galería compartida de fotos y videos con estética de cuarto oscuro. Sitio estático (HTML + CSS + JS, sin compilar).

## Estructura

```
PollitaF/
├── index.html          Página única: portada, galería, modales y lightbox
├── css/
│   └── style.css       Todo el diseño (variables de color al inicio)
├── js/
│   ├── config.js       Firebase, App Check y dirección del Worker (NO hay secretos)
│   └── script.js       Toda la lógica: Firestore, subidas, filtros, likes, papelera...
├── img/
│   ├── logo.png        Ícono de la pestaña
│   └── preview.png     Imagen que se ve al compartir el link (1200x630)
├── backend/            Lo que NO es la página: se pega en otros servicios
│   ├── worker.js       Servidor en Cloudflare: guarda el token de Telegram
│   └── firestore.rules Reglas de seguridad: se pegan en Firebase -> Firestore -> Reglas
├── .gitignore
└── README.md
```

## Dónde vive cada cosa
| Qué | Dónde | ¿Secreto? |
|---|---|---|
| Fotos y videos | Telegram (vía Worker) y Catbox (>20 MB) | No |
| Datos de cada publicación | Firebase Firestore | No |
| Token del bot y chat id | Cloudflare (Variables and Secrets) | **SÍ** |
| firebaseConfig, clave de App Check, URL del Worker | `js/config.js` | No (son públicos) |

**Regla de oro:** ningún secreto en este repositorio. Antes de cada commit: `git grep -n "botToken"` no debe devolver nada.

## Probar en local
1. Abrir con la extensión *Live Server* de VS Code (`http://127.0.0.1:5500`).
2. App Check imprime un *debug token* en la consola: registrarlo en Firebase -> App Check -> Apps -> Administrar tokens de depuración.

## Publicar
`git add .` -> `git commit -m "mensaje"` -> `git push`. GitHub Pages: Settings -> Pages -> rama `main`, carpeta `/ (root)`.

## Al cambiar algo del backend
- `backend/worker.js`: copiarlo en Cloudflare (Edit code) y *Deploy*.
- `backend/firestore.rules`: copiarlo en Firebase (con tu UID de admin) y *Publicar*.
