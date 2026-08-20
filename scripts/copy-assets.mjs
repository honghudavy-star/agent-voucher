import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const assets = resolve(root, "assets");
await mkdir(resolve(assets, "vendor"), { recursive: true });
await cp(resolve(root, "node_modules/@tabler/core/dist/css/tabler.min.css"), resolve(assets, "vendor/tabler.min.css"));
await cp(resolve(root, "node_modules/htmx.org/dist/htmx.min.js"), resolve(assets, "vendor/htmx.min.js"));
await cp(resolve(root, "public/app.css"), resolve(assets, "app.css"));
await cp(resolve(root, "public/app.js"), resolve(assets, "app.js"));
