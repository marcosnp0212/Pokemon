# Mi colección Pokémon

App web sin build (HTML + JavaScript con módulos nativos, cero dependencias) para
gestionar tu colección de cartas Pokémon con **precios automáticos en € (Cardmarket)**.

- **Frontend** estático en GitHub Pages → accesible desde cualquier dispositivo.
- **Tus datos** viven como JSON en este repo (`data/collection.json`) → con historial completo.
- **Precios** los calcula un trabajador en GitHub Actions (cron diario) cruzando dos fuentes.

---

## Diseño de precios (lo importante)

No existe ninguna API gratuita de Cardmarket con 0 % de error. La causa raíz es de
**granularidad**: una misma carta tiene varias impresiones (normal, reverse, holo…) que en
Cardmarket son productos distintos, y las APIs gratis no siempre las distinguen bien.

En vez de buscar la API perfecta, este proyecto convierte datos imperfectos en datos
**transparentes y corregibles**:

1. **La variante es la unidad de precio.** Cada carta se guarda como `(cardId, variante)`.
2. **Dos fuentes independientes:** [TCGdex](https://tcgdex.dev) y [pokemontcg.io](https://pokemontcg.io).
   Se cruzan y, si concuerdan, la confianza es **alta**; si divergen, se marca **aviso** en vez
   de mostrar un número falso con seguridad.
3. **Confianza visible** en cada carta (Alta / Media / Baja) + iconos de aviso ⚠ con explicación.
4. **Detección del bug conocido de TCGdex** (precios idénticos entre variantes) → se marca y degrada.
5. **Enlace directo a Cardmarket** (↗) para verificar en un clic.
6. **Override manual** por carta: escribe un precio a mano y gana al automático. La red de seguridad
   que hace aceptable cualquier fuente imperfecta.

| Variante | Fuente fiable | Notas |
|---|---|---|
| Normal | pokemontcg + TCGdex | consenso de las dos |
| Holo | pokemontcg + TCGdex (`*-holo`) | consenso de las dos |
| Reverse Holo | **solo pokemontcg** (`reverseHolo*`) | TCGdex no distingue reverse → no se usa |
| 1ª Edición / Promo | pokemontcg | TCGdex marcada no fiable |

---

## Puesta en marcha (≈10 min)

### 1. Crear el repositorio
1. Crea un repo **público** en GitHub (p. ej. `pokemon-collection`).
   > En el plan gratuito, GitHub Pages exige repo público. Mantén el repo sin tu nombre real
   > si no quieres asociar tu colección a tu identidad.
2. Sube todos los archivos a la raíz del repo (proyecto plano, sin carpetas; el workflow se crea aparte).

### 2. Activar GitHub Pages
1. Repo → **Settings → Pages**.
2. *Source*: **Deploy from a branch**, rama `main`, carpeta `/ (root)`. Guarda.
3. En 1-2 min tendrás la URL: `https://TU-USUARIO.github.io/pokemon-collection/`.

### 3. (Opcional pero recomendado) API key de pokemontcg.io
1. Regístrate en https://dev.pokemontcg.io/ y copia tu API key (gratis, sube el límite a 20.000/día).
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**.
3. Nombre: `POKEMONTCG_API_KEY` · Valor: tu key.
   > Sin key también funciona (límite menor). El secret nunca se expone en la web.

### 4. Token para editar la colección desde la web
La app escribe en `data/collection.json` con un token tuyo:
1. GitHub → **Settings (de tu cuenta) → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. *Repository access*: **Only select repositories** → este repo.
3. *Permissions → Repository permissions → Contents*: **Read and write**.
4. Genera y **copia** el token (`github_pat_...`).
5. Abre tu web, pulsa **⚙ Ajustes**, rellena *owner / repo / branch / token*, **Probar conexión** y **Guardar**.
   > El token se guarda **solo en el navegador** (localStorage), nunca en el repo. Tendrás que
   > introducirlo en cada dispositivo desde el que quieras *editar*. Para solo *ver*, igualmente
   > hace falta porque la colección se lee con la API; si prefieres lectura sin token, ver nota abajo.

### 5. Lanzar el primer cálculo de precios
- Repo → pestaña **Actions → “Actualizar precios” → Run workflow**.
- A partir de ahí corre solo cada día a las 05:00 UTC. También puedes lanzarlo a mano cuando quieras.

---

## Uso diario
- **Añadir carta:** busca por nombre, elige variante / estado / cantidad, *Añadir*.
- **Precio dudoso:** si ves ⚠ o confianza Baja, pulsa ↗ para ver Cardmarket y, si quieres, fija el
  precio en la casilla **Manual**.
- **Recargar:** trae los últimos precios calculados.

## Notas y límites
- JSON como base de datos: perfecto para cientos / pocos miles de cartas.
- GitHub Pages cachea; los cambios pueden tardar 1-2 min en verse (la app añade `?t=` para mitigarlo).
- Actions en repos públicos es gratis e ilimitado.

## Probar en local
```bash
# sirve la carpeta (los módulos ES necesitan http, no file://)
python3 -m http.server 8000
# abre http://localhost:8000
```

## Estructura
```
index.html              frontend (shell + estilos)
app.js                  lógica de la UI
github.js               leer/escribir colección vía API de GitHub
tcgdex.js               búsqueda de cartas
variants.js             variantes + mapeo de campos de precio (compartido)
update-prices.mjs       trabajador de precios (Actions)
test-prices.mjs         tests de la lógica de consenso
collection.json         tu colección
prices.json             precios generados (no editar a mano)
.github/workflows/update-prices.yml   cron diario
```
