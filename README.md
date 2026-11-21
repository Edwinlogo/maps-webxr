# EarthXR · Globo 3D & Vista 360° (WebXR · Meta Quest 3)

Aplicación web minimalista al estilo Google Earth con **WebXR (VR & MR Passthrough)** y **Hand Tracking sin controles** para explorar el planeta Tierra en alta definición (`z=2..18`) y sumergirte en **Vista 360°** desde **Meta Quest 3**.

- **URL privada (protegida con Cloudflare Access):** [https://maps.dcedwin.com](https://maps.dcedwin.com)

## Características principales

- **Globo 3D nítido estilo Google Earth:** motor de teselas multi-resolución con inclinación 3D automática, satélite de alta definición + vías y nombres de calles (`Esri World Imagery + Transportation + Places`), brújula, inclinación con clic derecho y zoom hacia el cursor.
- **Vista 360° libre por defecto (sin tarjeta):** combina **Panoramax + Mapillary** y búsquedas con OpenStreetMap Nominatim.
- **Google Map Tiles API opcional (en ⚙ Configuración):** permite conectar una API Key solo de **Map Tiles API** (sin llamar nunca a Geocoding API) para habilitar mapas de Google y **Google Street View** oficial.
- **Sin controles (Hand Tracking en Meta Quest 3):**
  - **Pellizcar + mover (1 mano):** rota el planeta o gira la Vista 360°.
  - **Spread / Pinch-out (2 manos pellizcando):** separa las manos para acercar el zoom o júntalas para alejar.
  - **Tablero 3D movible:** pellizca la barra superior (`⠿`) o inferior del panel flotante y colócalo donde quieras en el espacio.
- **Modo Realidad (Passthrough) ↔ Estrellas:** alterna en vivo desde el tablero 3D entre tu entorno real y el cielo estrellado.
- **Privacidad:** acceso personal protegido mediante **Cloudflare Access**.
