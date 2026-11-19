import fs from "node:fs";
import path from "node:path";

/**
 * .env dosyasını yükler. Next.js bunu kendisi yapar; worker ve betikler (tsx) için gerekli.
 * Ortamda zaten tanımlı değişkenlerin üzerine yazmaz. Birden çok kez çağrılması zararsızdır.
 */
let loaded = false;
export function loadDotEnv() {
  if (loaded) return;
  loaded = true;
  for (const name of [".env.local", ".env"]) {
    const file = path.join(process.cwd(), name);
    if (fs.existsSync(file)) process.loadEnvFile(file);
  }
}
