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
Ejecuta en el SQL Editor de Supabase, en orden, los archivos de `migrations/` (001 → 010).
La 010 corrige la separación de grupos con personas eliminadas, protege las
confirmaciones de quienes ya entraron y sincroniza el teléfono.

## Desarrollo
```bash
npm ci
node dev-server.js   # usa data/*.json si no hay Supabase configurado
npm test
```
