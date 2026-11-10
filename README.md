# Invitación de boda — Starlin & Reneisy

Invitación web con confirmación de asistencia (RSVP), pases QR y panel administrativo.
Frontend estático + funciones serverless en `api/` (Vercel) + Supabase como base de datos.

## Páginas
| Página | Uso |
| --- | --- |
| `index.html` | Invitación pública (`/?guest=<token>`) |
| `admin.html` | Resumen de respuestas y capacidad |
| `invitados.html` | Alta, edición, enlaces y envío por WhatsApp |
| `invitaciones.html` | Agrupar parejas/familias, regenerar enlaces, pases QR |
| `cortejo.html` | Cortejo y participantes: quién tiene cada papel el día de la boda (padres que participan, padrinos, chambelanes, damas de honor, niña del cartel, anillos…) |
| `mesas.html` | 12 mesas de 10 lugares: organización automática y movimiento con clic o arrastrando |
| `recepcion.html` | Escaneo de QR y registro de entradas |

## Variables de entorno (Vercel)
| Variable | Obligatoria | Notas |
| --- | --- | --- |
| `SUPABASE_URL` | sí | |
| `SUPABASE_SERVICE_ROLE_KEY` | sí | solo en el servidor |
| `ADMIN_PASSWORD` | sí | usa una clave larga (≥ 16 caracteres) |
| `RECEPTION_PASS_KEY` | sí | mínimo 16 caracteres |
| `ADMIN_SESSION_SECRET` | recomendada | ≥ 32 caracteres; si falta se usa la service key |

## Base de datos
Ejecuta en el SQL Editor de Supabase, en orden, los archivos de `migrations/` (001 → 014).
La 010 corrige la separación de grupos con personas eliminadas, protege las
confirmaciones de quienes ya entraron y sincroniza el teléfono. La 011 crea el módulo de mesas y la 012 añade las secciones de las mesas y la marca de familia cercana
(ejecútala antes de desplegar esa versión) la 013 añade el parentesco de los familiares y la 014 el cortejo
(ejecuta cada una antes de desplegar la versión que la usa).

## Mesas
Son 12 mesas de 10 lugares (el límite lo garantiza la base de datos). Cada mesa tiene una sección:

| Mesa | Sección |
| --- | --- |
| 1 | Familia cercana de la novia |
| 2 | Familia cercana del novio |
| 3 y 4 | Familiares de la novia |
| 5 y 6 | Familiares del novio |
| 7 | Participantes de la boda |
| 8 y 9 | Iglesia |
| 10 | Amigos de la novia |
| 11 y 12 | Amigos (los compañeros se sientan aquí) |

La sección de cada mesa se cambia con el lápiz de la mesa. En la ficha de un invitado de la categoría
"Familiares" se puede indicar el **parentesco** (madre, padre o hermano/a; el lado sale de su lista: "Madre de la novia",
"Padre del novio"…). Quien tiene parentesco cuenta como **familia cercana**; para otros familiares cercanos
(abuelos, tíos…) hay una casilla "Familia cercana". En la lista de "Sin mesa" la familia cercana aparece
con madre y padre primero y luego los hermanos.

La organización automática solo sienta a quienes no tienen mesa y mantiene juntas a las parejas y
familias (una invitación = una mesa, salvo que no quepan). Cada invitación va a la mesa de su sección
(categoría y lado predominantes); si esa se llena, pasa a la sección más parecida y avisa cuando
queda fuera de la suya. Iglesia, participantes y amigos no ocupan mesas de familia mientras haya otro lugar.
La lista de "Sin mesa" separa a los invitados por categoría, en el mismo orden que las mesas (familia cercana, familiares,
participantes, iglesia, amigos; cada grupo bajo una sola sección), con botones para ver solo una categoría.
Se mueve a un invitado tocándolo y luego tocando la mesa, o arrastrándolo; por defecto se mueve con su grupo.

## Cortejo y participantes
La página **Cortejo** organiza los papeles del día de la boda. Cada papel tiene su tarjeta con las personas que
lo llevan; una misma persona puede tener **varios papeles** (por ejemplo, la niña que anuncia a la novia con el
cartel y también lleva los anillos). Vienen seis papeles: Padres que participan, Padrinos, Chambelanes, Damas de
honor, Niña del cartel y Portador(a) de los anillos; se pueden crear, renombrar, reordenar y eliminar (hasta 40).

- **Por papel** y **por persona**: la segunda vista muestra de un vistazo todo lo que hace cada quien.
- Avisa de los *participantes sin papel* (categoría "Participantes" sin ningún papel) y de quienes tienen un papel
  pero respondieron que **no asistirán**.
- Los papeles se ven también en las tarjetas de **Invitados** y junto al nombre en **Mesas**. Tener un papel no
  cambia la categoría ni la mesa de la persona. Se puede imprimir.

## Desarrollo
```bash
npm ci
node dev-server.js   # usa data/*.json si no hay Supabase configurado
npm test
```
