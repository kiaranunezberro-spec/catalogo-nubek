# Catálogo Nubek

Capa pública de la tienda Nubek para Cloudflare Workers.

La tienda, el carrito, las cuentas y la base de datos continúan funcionando en el sitio administrable de Nubek. Este Worker publica la misma tienda desde una dirección de Cloudflare sin mostrar `chatgpt.site`.

## Publicar

Cloudflare detecta `wrangler.jsonc` y ejecuta:

```bash
npm install
npm run deploy
```

## Edición

Los cambios de productos y contenido se realizan desde el panel privado del sitio original de Nubek. Cloudflare mostrará esos cambios automáticamente.
