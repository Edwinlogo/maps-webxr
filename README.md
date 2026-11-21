# EarthXR · Globo 3D & Street View 360° (WebXR · Meta Quest 3)

Aplicación web inmersiva con **WebXR** y **Three.js** para explorar el planeta Tierra al estilo Google Earth y descender a **Street View 360°** real al acercarse a cualquier ubicación.

- **URL en vivo:** [https://maps.dcedwin.com](https://maps.dcedwin.com)

## Características

- **Globo 3D multi-resolución (estilo Google Earth):**
  - Motor de teselas *quadtree* con origen flotante (precisión submilimétrica desde 17,500 km en órbita hasta 220 m a nivel de calle, sin *z-fighting* en VR estereoscópico).
  - Capas intercambiables: **Híbrido (Satélite + Etiquetas)**, **Satélite (Esri World Imagery)** y **Calles (Carto Voyager)**.
  - Halo atmosférico Fresnel, capa de nubes dinámica y campo estelar 3D.
- **Street View 360° real con caminata panorámica:**
  - Detección automática de capturas equirectangulares 360° abiertas (**Panoramax**) al acercarse a cualquier ciudad del mundo, más soporte opcional para token de **Mapillary**.
  - Carga progresiva rápida (SD instantáneo → HD 4K) alineada al Norte geográfico real.
  - Flechas 3D flotantes sobre la calle para avanzar y retroceder entre panoramas conectados.
- **Diseñada para Meta Quest 3 (WebXR `immersive-vr`):**
  - Panel 3D espacial interactivo dentro de VR (destinos verificados 360°, capas, zoom, activar/salir de Street View).
  - Controladores Touch Plus con rayos láser, vibración háptica, agarre del globo con *Grip* (una mano rota, dos manos hacen zoom), *thumbsticks* y accesos directos (`A`, `B/Y`, `X`).

## Controles en Meta Quest 3

| Control | En el Planeta 3D | En Street View 360° |
| --- | --- | --- |
| **Stick Izquierdo** | Mover / rotar el planeta | Empujar adelante para avanzar en la calle |
| **Stick Derecho** | Arriba/Abajo: Zoom · Izq/Der: Rumbo | Izq/Der: Giro cómodo ±30° |
| **Gatillo (Trigger)** | Volar al punto / abrir pin 360° / usar panel VR | Seleccionar flecha 3D o botón del panel VR |
| **Grip (Lateral)** | Agarrar el planeta (2 manos = zoom pellizco) | — |
| **Botón A** | Activar Street View 360° cercano | — |
| **Botón B / Y** | Alejar vista | Volver al Planeta 3D |
| **Botón X** | Mostrar / recentrar panel VR | Mostrar / recentrar panel VR |

## Desarrollo local

```bash
npm install
npm run dev
```

## Compilación

```bash
npm run build
npm run deploy:bundle
```
