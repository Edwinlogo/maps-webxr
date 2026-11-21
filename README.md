# EarthXR · Globo 3D WebXR (Meta Quest 3)

Aplicación web minimalista al estilo Google Earth con **WebXR (VR & MR Passthrough)** y **Hand Tracking sin controles** para explorar el planeta Tierra en alta definición (`z=2..18`) desde **Meta Quest 3**.

- **URL privada (protegida con Cloudflare Access):** [https://maps.dcedwin.com](https://maps.dcedwin.com)

## Características

- **Globo 3D nítido estilo Google Earth:** satélite HD + vías y nombres de calles (`Esri World Imagery + Transportation + Places`), inclinación 3D automática/manual, brújula, zoom hacia el cursor y buscador global con OpenStreetMap Nominatim.
- **Google Map Tiles API opcional (en ⚙ Configuración):** permite conectar una API Key solo de **Map Tiles API** (sin llamar nunca a Geocoding API) para usar las capas satelitales y de calles de Google Maps.
- **Tablero 3D movible con paridad total con la versión 2D:** zoom `+ / −`, inclinación `3D / 2D`, brújula `N`, vista planeta completo, cambiar fondo (`Estrellas` ↔ `Realidad Passthrough`), y panel interactivo de `⚙ Configuración` integrado dentro de XR.
- **Sin controles (Hand Tracking en Meta Quest 3):**
  - **Pellizcar + mover (1 mano):** rota el planeta.
  - **Spread / Pinch-out (2 manos pellizcando):** separa las manos para acercar el zoom o júntalas para alejar.
  - **Mover tablero:** pellizca la barra superior (`⠿`) o inferior del tablero 3D y ubícalo donde prefieras.
- **Privacidad:** acceso personal protegido con **Cloudflare Access**.
