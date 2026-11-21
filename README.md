# EarthXR · Google Maps 3D & Street View 360° (WebXR · Meta Quest 3)

Aplicación web inmersiva con **WebXR** y **Three.js** para explorar el planeta Tierra al estilo Google Earth con **Google Maps** (Satélite, Híbrido, Calles y líneas azules de cobertura Street View) y entrar en **Google Street View 360° en cualquier calle del mundo**.

- **URL en vivo:** [https://maps.dcedwin.com](https://maps.dcedwin.com)

## Activar Google Maps + Street View en cualquier calle

EarthXR usa la API oficial **Google Maps Platform — Map Tiles API** (`tile.googleapis.com`):

1. En [Google Cloud Console](https://console.cloud.google.com/google/maps-apis/api-list), habilita **Map Tiles API** (opcional: **Geocoding API** para búsquedas de direcciones de Google).
2. Crea una **API Key** en *Credentials*.
3. Elige cómo conectarla:
   - **Recomendado para Meta Quest 3 (sin escribir la clave en el visor):** en Cloudflare Dashboard → **Workers & Pages** → **`maps-webxr`** → **Settings** → **Variables and Secrets** → agrega un **Secret** llamado `GOOGLE_MAPS_API_KEY` con tu clave.
   - **Prueba instantánea en navegador:** pulsa **Conectar Google Maps** (o **⚙**) dentro de `https://maps.dcedwin.com`, pega tu clave y pulsa **Validar y Guardar**.

> Si aún no has configurado una clave de Google Maps, la app funciona automáticamente con respaldo abierto (Esri + Panoramax).

## Controles en Meta Quest 3

| Control | En el Planeta 3D | En Street View 360° |
| --- | --- | --- |
| **Stick Izquierdo** | Mover / rotar el planeta | Empujar adelante para caminar por la calle |
| **Stick Derecho** | Arriba/Abajo: Zoom · Izq/Der: Rumbo | Izq/Der: Giro cómodo ±30° |
| **Gatillo (Trigger)** | Al acercarte (`<= 4 km`) o con **Clic Calle: ON**, apunta a **cualquier calle** para entrar directo en Street View 360° | Seleccionar flecha 3D con nombre de calle o botón del panel VR |
| **Grip (Lateral)** | Agarrar el planeta (2 manos = zoom pellizco) | — |
| **Botón A** | Entrar a Street View 360° en la calle actual | — |
| **Botón B / Y** | Alejar vista | Volver al Planeta 3D |
| **Botón X** | Mostrar / recentrar panel VR | Mostrar / recentrar panel VR |

## Desarrollo local

```bash
npm install
npm run dev
```
