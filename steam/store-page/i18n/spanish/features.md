<!-- Spanish translation of steam/store-page/features.md (neutral Spanish for Spain and Latin America). The English file is the source of truth; update this when it changes. -->

# Funciones de VPuppet

## Seguimiento (webcam normal, Google MediaPipe, todo en local)

- **Rostro:** los 52 blendshapes de ARKit (todos salvo `tongueOut`), rotación de la cabeza y mirada.
- **Perfect sync:** los modelos con expresiones nombradas según ARKit se controlan 1:1 por nombre (se detecta con 40 o más de las 52). Los demás modelos reciben los presets de VRM derivados de los blendshapes: parpadeo (ambos ojos y cada ojo por separado), las cinco vocales `aa` `ih` `ou` `ee` `oh` y alegría / ira / tristeza / sorpresa / relajación (happy / angry / sad / surprised / relaxed, desactivables).
- **La mirada** controla el look-at del modelo (por huesos o por expresiones).
- **Ganancia y curva por blendshape,** editables en vivo junto a los valores originales y de salida.
- **Calibrar** (`C`) captura tu rostro neutro, el ángulo de la cabeza y la mirada.
- **Suavizado:** un solo control deslizante; los parpadeos y la mandíbula siguen siendo rápidos con cualquier valor.
- **Parte superior del cuerpo:** columna, pecho, hombros, clavículas y brazos, con una auténtica articulación de bisagra en el codo (0–150°), giro del brazo limitado e inclinación y giro del torso limitados por separado.
- **Manos y dedos:** cada articulación de los dedos, resuelta como ángulos anatómicos y limitada a su rango; oposición del pulgar; las manos se siguen en su propio proceso en paralelo con la pose; ambas manos se buscan en todo el fotograma, en cada fotograma.
- **Gestos:** puño, palma abierta, señalar, paz, pulgar arriba, OK y cuernos, por cada mano, con histéresis para que no parpadeen.
- **Modos:** FACE, +BODY, +HANDS; modelo de pose LITE / FULL, intercambiable en vivo.

## Salida

- **Cámara virtual** «VPuppet Virtual Camera» para Zoom, Meet, Discord, FaceTime, OBS y otras apps de cámara: 1280×720 o 1920×1080 a 30 fps. Los fondos lisos se envían como color de croma (verde por defecto); los entornos 3D se envían tal como se renderizan.
  - macOS 12.3+: extensión de cámara CoreMediaIO dentro de la app.
  - Windows 10/11: cámara DirectShow (una solicitud de administrador para registrarla).
  - Linux: un dispositivo v4l2loopback.
- **Protocolo VMC** sobre OSC/UDP: todos los huesos humanoides, la raíz y los blendshapes; los modelos con perfect sync también envían los 13 presets de VRM 0.x para que los receptores que solo entienden presets vean igualmente un rostro en movimiento. Funciona con VSeeFace, Warudo, VNyan, VMC4U y otros receptores, en local o por la red local.
- **Vista de captura** (`H`): toda la interfaz oculta, para una captura de ventana limpia en OBS.
- Fondos transparentes, de color sólido (presets de croma) o de imagen.

## Física

- **Solver de tela por huesos** sobre los propios spring bones del VRM: las cadenas vecinas (anillos de falda, capas, flequillos) se enlazan en una malla para que los paneles se muevan juntos.
- **Colisionadores del cuerpo generados a partir del esqueleto** y ajustados a la malla, junto con los propios colisionadores del modelo; colisiones por segmentos de barrido para que las extremidades rápidas no atraviesen la tela.
- Selector OFF / STIFF / NORMAL, controles por cadena y por colisionador, guardados por modelo.

## Movimiento y controles de actuación

- **Clips de animación:** animaciones idle en bucle (respirar, mirar alrededor, hablar, brazos cruzados) y emotes (asentir, negar con la cabeza, celebrar, ira, llorar, bailar, sentarse, beber, saludar, aplaudir, señalar, encogerse de hombros, pensar, reverencia), superpuestos al seguimiento en vivo y con las expresiones faciales aún seguidas.
- **Importa los tuyos:** clips FBX / GLB; los rigs de Mixamo, Unreal-mannequin / UAL y VRoid se detectan por los nombres de los huesos; retargeting a VRM 0.x y 1.0.
- **Atajos:** emotes y expresiones (alternar, activar o mantener) en el teclado, el gamepad o con gestos de la mano; teclas globales del sistema opcionales; selector en pantalla (`G` / RB del gamepad); asignaciones por modelo.
- **Lip sync por micrófono:** FALLBACK (mueve la boca cuando no se sigue el rostro), BLEND o AUDIO; desactivado por defecto.

## Escenas

- **Entornos 3D:** Studio Cyclorama, Cosy Room, Moor at Dusk, Night Clearing, Neon Grid, Concrete Hall (estudio fotográfico, habitación acogedora, páramo al anochecer, claro nocturno, cuadrícula de neón, sala de cemento), todos procedurales (sin descargar recursos).
- **Escenas propias:** tu propio `.glb` / `.gltf` con un cielo equirrectangular `.hdr` / `.exr` (iluminación basada en imagen).
- Presets de luz (scene, key, rim, soft), intensidad, balance de blancos, niebla, sombra en el suelo, balanceo en reposo, profundidad de campo opcional; calidad LOW / HIGH.
- Encuadre de busto / medio cuerpo / cuerpo entero que se adapta al tamaño del avatar.

## Biblioteca y app

- **Biblioteca de modelos** en la pantalla de inicio: miniaturas de busto, versión de VRM, cobertura de perfect sync, número de triángulos, favoritos, búsqueda, orden, cambio de nombre; los modelos se deduplican y se copian a la carpeta propia de la app.
- **Licencia visible:** los términos del autor de cada VRM se muestran en lenguaje sencillo con una insignia (solo el autor, solo con licencia, CC0, uso comercial permitido, uso comercial individual, uso personal, sin términos). Es información, no DRM.
- **Revisión de modelos:** al cargar se señalan problemas comunes de creación (cara en la parte trasera de la cabeza, huesos que faltan, expresiones vacías).
- VRM 0.x y 1.0.
- Navegación con teclado y gamepad en toda la app (`Tab`, modo menú del gamepad).
- macOS 12.3+, Windows 10/11, Linux.

## Código abierto

- Código fuente con licencia MIT en GitHub (`<GITHUB_URL>`). La versión de Steam es la compilación firmada, con actualizaciones automáticas y soporte.
