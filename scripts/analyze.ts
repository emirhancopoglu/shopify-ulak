// Kullanım: npm run analyze -- ornek.com.tr baska-magaza.com
import { analyzeStore } from "../src/lib/analyzer";
import { normalizeDomain } from "../src/lib/domains";

async function main() {
  for (const arg of process.argv.slice(2)) {
    const domain = normalizeDomain(arg);
    if (!domain) {
      console.log(`✗ geçersiz: ${arg}`);
      continue;
    }
    const t = Date.now();
    const r = await analyzeStore(domain);
    console.log(`\n=== ${domain} (${Date.now() - t} ms)`);
    console.dir(r, { depth: 3 });
  }
}

main();
