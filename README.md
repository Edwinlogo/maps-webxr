# EarthXR · Globo 3D WebXR para Meta Quest 3

Aplicación WebXR estilo **Google Earth** diseñada para **Meta Quest 3** y escritorio, hospedada en **`https://maps.dcedwin.com`** con protección de acceso mediante **Cloudflare Access**.

## Características principales
- **Interfaz 2D responsiva y multitáctil:** adaptada a móvil, tablet y escritorio con campo de visión adaptable en pantalla vertical, zoom táctil con dos dedos (juntar / separar dedos igual que en apps de mapas) y zoom progresivo al pulsar (iniciando a nivel de continente).
- **Globo 3D HD estilo Google Earth:** teselas multiresolución (`z=2..18`) con satélite HD, vías y nombres de lugares, sin desenfoque al acercarse a ciudades.
- **Globo 3D movible en el espacio:** reubica libremente el planeta en 3D (izquierda, derecha, arriba, abajo, cerca o lejos) mediante la barra `⠿` debajo del globo, el botón `✋ Mover globo` del tablero 3D, el botón **Grip** de los mandos Touch Plus o `Alt + arrastrar` en escritorio.
- **Efecto de sombra dinámica en el suelo:** proyecta una sombra suave sobre el piso real del usuario (`y = 0`, `local-floor`) en modo Passthrough y sobre el suelo virtual en modo Espacio, adaptando su tamaño y nitidez según la altura del globo.
- **Inclinación configurable al acercarse hasta 90° (horizontal paralelo al piso):** ajusta en Configuración (`0°` a `90°`) el ángulo automático al hacer zoom, incluyendo presets rápidos (`0° 2D`, `35°`, `65°`, `90° Horizontal piso`).
- **Panel de control 3D movible con paridad completa:** zoom (`+`/`−`), inclinación `3D/2D`, brújula en vivo, planeta completo (`🌍`), `✋ Mover globo`, cambiar fondo (`✦ Estrellas` ↔ `👁 Realidad / Passthrough`) y vista integrada de `⚙ Configuración`.
- **Seguimiento de manos sin mandos (`hand-tracking`):** pellizcar + mover para rotar el planeta, abrir/cerrar dos manos (*spread / pinch-out*) para zoom y agarre espacial del tablero y el globo.
- **Google Map Tiles API opcional:** configurable desde `⚙ Configuración` sin activar nunca Geocoding API (el buscador usa OpenStreetMap Nominatim gratuito).
- **Acceso personal seguro:** protegido en el borde con **Cloudflare Access** (One-Time PIN).

## Desarrollo local
```bash
npm install
npm run dev
```

## Compilación
```bash
npm run build
```
