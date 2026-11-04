# Licencias de assets de terceros

Todos los assets 3D, texturas y HDRI de la escena son **CC0 1.0** (dominio
público): se pueden usar, modificar y redistribuir sin atribución obligatoria.
Igual se citan acá, por procedencia y por cortesía con los autores.

No están en git: se bajan con `node scripts/fetch-assets.mjs`, que verifica
el SHA-256 de cada archivo contra `apps/web/assets.manifest.json` y sólo baja
de `dl.polyhaven.org` y `static.poly.pizza`.

| Asset | Tipo | Autor(es) | Licencia | Fuente |
|---|---|---|---|---|
| Machine Shop 02 (`machine_shop_02`) | hdri | Sergej Majboroda | CC0-1.0 | https://polyhaven.com/a/machine_shop_02 |
| Concrete Floor Worn 001 (`concrete_floor_worn_001`) | texture | Dimitrios Savva, Rico Cilliers | CC0-1.0 | https://polyhaven.com/a/concrete_floor_worn_001 |
| Factory Wall (`factory_wall`) | texture | Rob Tuytel | CC0-1.0 | https://polyhaven.com/a/factory_wall |
| Corrugated Iron (`corrugated_iron`) | texture | Jenelle van Heerden, Dimitrios Savva | CC0-1.0 | https://polyhaven.com/a/corrugated_iron |
| Metal Tool Chest (`metal_tool_chest`) | model | Yann Kervran, John Hutcheson | CC0-1.0 | https://polyhaven.com/a/metal_tool_chest |
| Worn Metal Rack (`worn_metal_rack`) | model | Luca B | CC0-1.0 | https://polyhaven.com/a/worn_metal_rack |
| Barrel 03 (`barrel_03`) | model | Serhii Khromov | CC0-1.0 | https://polyhaven.com/a/barrel_03 |
| Wooden Crate 01 (`wooden_crate_01`) | model | James Ray Cock | CC0-1.0 | https://polyhaven.com/a/wooden_crate_01 |
| Hanging Industrial Lamp (`hanging_industrial_lamp`) | model | Kuutti Siitonen | CC0-1.0 | https://polyhaven.com/a/hanging_industrial_lamp |
| Industrial Storage Cart (`industrial_storage_cart`) | model | Jule Bielitz | CC0-1.0 | https://polyhaven.com/a/industrial_storage_cart |
| Hand Truck (`hand_truck`) | model | Mutanzom3D | CC0-1.0 | https://polyhaven.com/a/hand_truck |
| Power Box 01 (`power_box_01`) | model | Rico Cilliers, Yann Kervran | CC0-1.0 | https://polyhaven.com/a/power_box_01 |
| Overhead Crane (`overhead_crane`) | model | Timothy3D | CC0-1.0 | https://polyhaven.com/a/overhead_crane |
| Security Camera 02 (`security_camera_02`) | model | Garrison Gager, Yann Kervran | CC0-1.0 | https://polyhaven.com/a/security_camera_02 |
| Worker (`quaternius_worker`) | character | Quaternius | CC0-1.0 | https://poly.pizza/m/Yg2bQZO6Hj |

- Poly Haven: licencia CC0 de todo el sitio — https://polyhaven.com/license
- Quaternius (Worker, vía poly.pizza): marcado CC0 / Public Domain en la
  página del modelo, verificado el 2026-10-27.

Hecho en el repo (no de terceros): bobinas de acero, eslingas, cunas,
estantería de pallets y cajas, botonera colgante, baliza, carteles, paso
peatonal y cinta de demarcación (texturas generadas en runtime), vigas carril
y estructura de la nave.
