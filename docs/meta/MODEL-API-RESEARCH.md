# Meta Model API — qué sirve para Sentinel (investigación)

Consultado el **2026-11-02** en la doc oficial `dev.meta.ai`. Las páginas no
muestran fecha ni versión. Todo lo que dice "no documentado" se verifica en la
primera llamada autorizada, no se supone.

Fuentes:
- Ficha del modelo: https://dev.meta.ai/models/sam-3-1
- SAM: https://dev.meta.ai/docs/sam/overview · /docs/sam/segmenting · /docs/sam/reading-segmentation
- Segmentación de medios: https://dev.meta.ai/docs/media-segmentation/
- Modelos y modos de datos: https://dev.meta.ai/docs/models
- Precios y límites: https://dev.meta.ai/docs/pricing-rate-limits
- Errores: https://dev.meta.ai/docs/error-handling
- Responses API: https://dev.meta.ai/docs/protocols/responses

## SAM 3.1: las 12 preguntas

| # | Pregunta | Respuesta (doc oficial) |
|---|---|---|
| 1 | ¿Está disponible? ¿Por qué API? | Sí, en Meta Model API, por la **Responses API**. Comparte key, envelope y billing con el resto de los modelos. Que esté habilitado **para esta cuenta** no está verificado: se ve en la primera llamada (403/404 ⇒ no). |
| 2 | Identificador | `sam-3.1`. La ficha de precios usa `sam-3-1` como slug; las muestras de código y la tabla de límites usan `sam-3.1`. |
| 3 | Endpoint | `POST https://api.meta.ai/v1/responses` |
| 4 | Autenticación | `Authorization: Bearer <key>`. Las muestras leen `MODEL_API_KEY`. Compatible con clientes OpenAI SDK (`baseURL` = `https://api.meta.ai/v1`). |
| 5 | Formatos de entrada | `input_image` con `image_url`: una URL pública **o una data URL base64**. Formatos y tamaño máximo de imagen: no documentados. El tope general de medios inline es 50 MB. |
| 6 | ¿Imagen o video? | Las dos cosas. Video con `input_video` (URL o `file_id`), MP4/MOV con H.264/H.265/MPEG-4, hasta 15.000 frames por request. |
| 7 | Tipos de prompt | Una frase nominal por request (por ejemplo `person`), **o** cajas o puntos (positivos y negativos) por objeto, hasta 16 objetos. Las dos clases no se mezclan en un mismo request. Las coordenadas del prompt llevan `w`/`h` del medio: si la proporción no coincide, devuelve 400. |
| 8 | Qué devuelve | Texto con tokens especiales en `output_text`, una línea por frame: `<0f>0<\|box;x1=;y1=;x2=;y2=;w=;h=[;c=]\|><\|mask;x=0;y=0;data=H,W,<enc>payload\|>,1<…>`. Las cajas vienen en píxeles de la fuente. La máscara viene en base85 (`~` sin pérdida, `!` one_bit). El id del objeto es estable dentro de la respuesta. La confianza `c` (0–1) sólo aparece con `metadata.include_confidence="true"`. Cero coincidencias = `output_text` vacío (no es error). |
| 9 | Precio | **US$2,50 cada 1.000 imágenes** (US$0,0025 por imagen) y US$0,20 cada 1.000 frames de video, con un mínimo de 50 frames por request de video. |
| 10 | Límites | 3.000 RPM por equipo, sin TPM. Concurrencia: no documentada. Body de un request background: hasta 1 MiB. `store=true` con base64 grande puede dar 413. |
| 11 | Privacidad | **Standard mode:** "your content is not used to train Meta models". **Contributor mode:** "may be used to train future Meta models" a cambio de un precio menor. La Responses API **guarda las respuestas por defecto** (`store: true`); no está documentado cuánto tiempo. Usamos `store: false` y nunca un id `-contributor`. |
| 12 | ¿Sirve para nuestro caso? | Para **encontrar y delimitar al operario renderizado**, sí, en principio. La escena es 3D sintética, así que no está garantizado que funcione igual que con fotos reales: hay que probarlo. Para decidir si hay peligro o si se puede arrancar, **no**: eso lo resuelve nuestra regla determinista. |

Además: no hay parámetro de umbral, `stream` es opcional y los errores
400/401/402/403/404/413 no se reintentan. La doc de errores recomienda
reintentar 429/500/503, pero **nosotros no reintentamos**: es una regla del repo.

## Qué resuelve SAM y qué resolvemos nosotros

| Necesidad | Quién la resuelve |
|---|---|
| ¿Hay una persona en el frame? ¿Dónde está? | **SAM 3.1** (caja + máscara a partir del prompt `person`) |
| ¿Esa persona pisa la zona? | **Regla nuestra**: punto de apoyo (centro del borde inferior de la caja) contra el polígono de la zona calibrado sobre la imagen de CAM-01 (`zone-rule.ts`) |
| ¿El resultado es fresco y de esta cámara? | `PerceptionGateway` (TTL de frescura, cámara conectada, frame válido) |
| ¿Se puede arrancar? | `VirtualPLC` (sólo `NO_RISK_OBSERVED` fresco + autorización humana nueva) |
| ¿Es seguro? | **Nadie en esta demo.** `NO_RISK_OBSERVED` significa que el modelo no vio a nadie en la zona en ese frame; no es una garantía. La seguridad industrial real es independiente. |
| Seguimiento temporal | SAM sobre video da identidad estable por clip. En la demo usamos un frame por pedido de arranque; el video queda para P1/P2. |

Riesgo conocido de la regla: si el operario queda tapado (por ejemplo, las
piernas detrás de la mesa), el borde inferior de la caja sube. Se mide en la
primera prueba con la verdad del simulador al lado y no se maquilla.

## Alternativas verificadas

| Modelo | Qué aporta | Costo por prueba (estimado) | Rol propuesto |
|---|---|---|---|
| `sam-3.1` | Cajas y máscaras en píxeles: geometría que se puede auditar | US$0,0025 por imagen | **Principal** |
| `muse-spark-1.3` (Standard) | Entiende imágenes (texto + imagen → texto), 1M de contexto. Precio: US$1,25/M input, US$4,25/M output | Menos de US$0,01 por imagen 1280×720 con respuesta corta. **Estimado**: la doc no publica cuántos tokens cuenta una imagen | Opcional, P1: explicación en lenguaje natural del frame y aviso para el reloj simulado, con la decisión ya tomada. **Comunica, no decide**: no cambia el estado ni el PLC |
| `muse-wonder-1.0` | Más capaz, pero en preview | US$4/M input, US$20/M output | No: caro y en preview |
| Muse Spark Open / Glimmer (pesos abiertos) | Corren fuera de la API (por ejemplo en Baseten). Son elegibles para el bonus "Best Build on Meta Open Weight Models" | Depende del proveedor | P2: no hay tiempo de integrarlos bien antes del 4/11 |

**Recomendación: SAM 3.1 como percepción, y la regla de zona más el PLC como
decisión.** Aporta una capacidad real y demostrable: el modelo localiza al
operario en píxeles reales del render y el sistema muestra la caja, el punto de
apoyo y el polígono. Eso además lo aleja de un "simple image analyzer", que el
reglamento menciona como anti-proyecto. Muse Spark como explicador queda
como P1 si la primera prueba de SAM sale bien y queda tiempo.
