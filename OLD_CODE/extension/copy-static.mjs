// extension/copy-static.mjs
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// __dirname is /.../extension
const from = (p) => path.join(__dirname, p);
const to = (p) => path.join(__dirname, "dist", p);

// Ensure dist/ exists
fs.mkdirSync(to(""), { recursive: true });

// Copy manifest.json
fs.cpSync(from("manifest.json"), to("manifest.json"));

// Copy public/ recursively
fs.cpSync(from("public"), to("public"), { recursive: true });
