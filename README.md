# EarthXR · Globo 3D & Street View 360° (WebXR · Meta Quest 3)

Aplicación web minimalista con **WebXR (VR & MR Passthrough)** y **Hand Tracking sin controles** para explorar la Tierra en 3D y sumergirte en **Street View 360°** desde **Meta Quest 3**.

- **URL privada (protegida con Cloudflare Access):** [https://maps.dcedwin.com](https://maps.dcedwin.com)

## Características principales

- **Por defecto 100% libre (sin tarjeta):** Globo satelital (Esri + Carto) + **Panoramax + Mapillary** para Street View 360° y búsquedas con OpenStreetMap Nominatim.
- **Google Map Tiles API opcional (en ⚙ Configuración):** permite conectar una API Key solo de **Map Tiles API** (sin llamar nunca a Geocoding API) para usar mapas de Google, líneas azules 360° y Street View en cualquier calle.
- **Sin controles (Hand Tracking en Meta Quest 3):**
  - **Pellizcar + mover (1 mano):** rota el planeta o gira la vista 360° en Street View.
  - **Spread / Pinch-out (2 manos pellizcando):** separa las manos para acercar el zoom o júntalas para alejar.
  - **Pellizco corto (tap):** selecciona botones del panel, flechas en la calle o pines 360°.
  - **Tablero 3D movible:** pellizca la barra superior (`⠿`) o inferior del panel flotante y colócalo donde quieras en el espacio.
- **Modo Realidad (Passthrough) ↔ Estrellas:** alterna en vivo desde el tablero 3D (o en la web) entre ver tu habitación real con el planeta flotando o el fondo espacial de estrellas.
- **Privacidad:** protegido mediante **Cloudflare Access** para uso personal.
